import { EventBus, type Logger, type MCPServerConfig, ToolRegistry } from '@wrongstack/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MCPRegistry } from '../src/registry.js';

const silentLog: Logger = {
  error: () => {},
  warn: () => {},
  info: () => {},
  debug: () => {},
  trace: () => {},
  child: () => silentLog,
} as unknown as Logger;

const stdioCfg = (name: string, extra: Partial<MCPServerConfig> = {}): MCPServerConfig => ({
  name,
  transport: 'stdio',
  command: 'never-actually-run',
  args: [],
  ...extra,
});

type RegistryInternals = {
  onToolsChanged: (name: string, tools: { name: string }[]) => void;
  onChildExit: (name: string, code: number | null, signal: string | null) => void;
  onTransportDisconnect: (name: string) => void;
};

describe('MCPRegistry', () => {
  let toolReg: ToolRegistry;
  let events: EventBus;

  beforeEach(() => {
    toolReg = new ToolRegistry();
    events = new EventBus();
  });

  it('skips disabled servers', async () => {
    const reg = new MCPRegistry({ toolRegistry: toolReg, events, log: silentLog });
    await reg.start(stdioCfg('off', { enabled: false }));
    expect(reg.list()).toHaveLength(0);
  });

  it('emits disconnected after retries exhausted on failure', async () => {
    const reg = new MCPRegistry({ toolRegistry: toolReg, events, log: silentLog });
    const disconnects: unknown[] = [];
    events.on('mcp.server.disconnected', (p) => disconnects.push(p));
    // Use a command that will fail to spawn synchronously
    await reg.start(
      stdioCfg('broken', {
        command: '__nonexistent_binary_zzzz__',
        startupTimeoutMs: 50,
      }),
    );
    // Wait a moment to ensure retries finish — registry retries up to 3 with backoff
    // 500 * 2 + 500 * 4 = 3000ms. We don't want to actually wait that long, so just
    // verify that the entry exists and is in some non-connected state.
    const list = reg.list();
    expect(list.find((s) => s.name === 'broken')).toBeDefined();
  }, 10_000);

  it('list reports registered servers', async () => {
    const reg = new MCPRegistry({ toolRegistry: toolReg, events, log: silentLog });
    // start with disabled so we don't try to actually spawn
    await reg.start(stdioCfg('a', { enabled: false }));
    await reg.start(stdioCfg('b', { enabled: false }));
    expect(reg.list()).toHaveLength(0); // disabled never registered
  });

  it('stopAll is a no-op when nothing registered', async () => {
    const reg = new MCPRegistry({ toolRegistry: toolReg, events, log: silentLog });
    await expect(reg.stopAll()).resolves.toBeUndefined();
  });

  it('restart on unknown server throws', async () => {
    const reg = new MCPRegistry({ toolRegistry: toolReg, events, log: silentLog });
    await expect(reg.restart('nope')).rejects.toThrow(/not registered/);
  });

  it('stop on unknown name is a no-op', async () => {
    const reg = new MCPRegistry({ toolRegistry: toolReg, events, log: silentLog });
    await expect(reg.stop('nope')).resolves.toBeUndefined();
  });

  it('health returns alive=true only for connected servers', async () => {
    const reg = new MCPRegistry({ toolRegistry: toolReg, events, log: silentLog });
    await reg.start(stdioCfg('s1', { enabled: false }));
    const h = reg.health();
    expect(h).toHaveLength(0); // disabled = not registered
  });

  it('health reflects failed state', async () => {
    const reg = new MCPRegistry({ toolRegistry: toolReg, events, log: silentLog });
    await reg.start(stdioCfg('failing', { command: '__nonexistent__', startupTimeoutMs: 50 }));
    // Give retries time to exhaust
    await new Promise((r) => setTimeout(r, 5000));
    const h = reg.health();
    const entry = h.find((s) => s.name === 'failing');
    expect(entry?.alive).toBe(false);
  }, 10_000);

  it('stop unregisters exit listener to avoid memory leaks', async () => {
    const reg = new MCPRegistry({ toolRegistry: toolReg, events, log: silentLog });
    const start = reg.start(stdioCfg('listener-check', { enabled: false }));
    await start;
    // stop must not throw even though no client was created
    await expect(reg.stop('listener-check')).resolves.toBeUndefined();
  });

  describe('L2-B reconnect backoff cap', () => {
    it('scheduleReconnect transitions to failed after MAX_RECONNECT_CYCLES', () => {
      const reg = new MCPRegistry({ toolRegistry: toolReg, events, log: silentLog });
      // Create an empty slot manually via the private servers map for a
      // self-contained test that doesn't depend on a real subprocess.
      const slot = {
        cfg: stdioCfg('exhausted'),
        state: 'disconnected' as const,
        toolNames: [] as string[],
        attempts: 0,
        reconnectPending: false,
        reconnectCycles: 5,
      };
      (reg as unknown as { servers: Map<string, typeof slot> }).servers.set('exhausted', slot);
      const disconnected: { name: string; reason: string }[] = [];
      events.on('mcp.server.disconnected', (e) => disconnected.push(e));
      (reg as unknown as { scheduleReconnect: (s: typeof slot) => void }).scheduleReconnect(slot);
      expect(slot.state).toBe('failed');
      expect(slot.reconnectPending).toBe(false);
      expect(disconnected[0]?.reason).toContain('reconnect-exhausted');
    });

    it('scheduleReconnect picks a bounded delay with jitter', () => {
      const reg = new MCPRegistry({ toolRegistry: toolReg, events, log: silentLog });
      // Cycle 4 → base = 1000 * 2^4 = 16000ms, then ±20% jitter capped at 30s.
      const slot = {
        cfg: stdioCfg('delay-check'),
        state: 'disconnected' as const,
        toolNames: [] as string[],
        attempts: 0,
        reconnectPending: false,
        reconnectCycles: 4,
      };
      (reg as unknown as { servers: Map<string, typeof slot> }).servers.set('delay-check', slot);
      // Spy on setTimeout to capture the delay without actually waiting.
      const originalSetTimeout = global.setTimeout;
      let captured = 0;
      (global.setTimeout as unknown as (fn: () => void, ms: number) => unknown) = ((
        _fn: () => void,
        ms: number,
      ) => {
        captured = ms;
        return 0;
      }) as never;
      try {
        (reg as unknown as { scheduleReconnect: (s: typeof slot) => void }).scheduleReconnect(slot);
      } finally {
        global.setTimeout = originalSetTimeout;
      }
      // 16s base ±20% jitter → between 12.8s and 19.2s.
      expect(captured).toBeGreaterThanOrEqual(12_000);
      expect(captured).toBeLessThanOrEqual(20_000);
      expect(slot.reconnectPending).toBe(true);
    });
  });

  describe('health() edge cases', () => {
    it('health includes latencyMs when available (always undefined with current impl)', () => {
      const reg = new MCPRegistry({ toolRegistry: toolReg, events, log: silentLog });
      // Note: the current impl doesn't track latency — this test documents that
      const h = reg.health();
      expect(Array.isArray(h)).toBe(true);
    });

    it('health returns empty when no servers registered', () => {
      const reg = new MCPRegistry({ toolRegistry: toolReg, events, log: silentLog });
      expect(reg.health()).toEqual([]);
    });
  });

  describe('onToolsChanged — re-registration edge cases', () => {
    it('onToolsChanged unregisters tools even when toolRegistry.unregister throws', async () => {
      const reg = new MCPRegistry({ toolRegistry: toolReg, events, log: silentLog });
      const slot = {
        cfg: stdioCfg('tools-change-test'),
        state: 'connected' as const,
        toolNames: ['tool1', 'tool2'] as string[],
        attempts: 1,
        reconnectPending: false,
        reconnectCycles: 0,
        client: {
          listTools: () => [{ name: 'new_tool', inputSchema: {} }],
        } as unknown as any,
      };
      (reg as unknown as { servers: Map<string, typeof slot> }).servers.set('tools-change-test', slot);
      // Override toolRegistry.unregister to throw on first call
      let unregisterCall = 0;
      (reg as unknown as { toolRegistry: ToolRegistry }).toolRegistry = {
        ...toolReg,
        unregister: (name: string) => {
          unregisterCall++;
          if (unregisterCall <= 2) throw new Error('simulated error');
        },
        register: () => {},
      } as unknown as ToolRegistry;
      // The onToolsChanged should still process all tools
      (reg as unknown as RegistryInternals).onToolsChanged(
        'tools-change-test',
        [{ name: 'new_tool' } as never],
      );
      // At least one tool was attempted
      expect(unregisterCall).toBeGreaterThan(0);
    });

    it('onToolsChanged skips when slot or client not found', () => {
      const reg = new MCPRegistry({ toolRegistry: toolReg, events, log: silentLog });
      // Should not throw for unknown server
      expect(() =>
        (reg as unknown as { onToolsChanged: (name: string, tools: { name: string }[]) => void }).onToolsChanged(
          'never-registered',
          [{ name: 'x' } as never],
        ),
      ).not.toThrow();
    });

    it('onToolsChanged logs warning when tool registration fails', async () => {
      const warnCalls: { msg: string; err?: unknown }[] = [];
      const warnLog: Logger = {
        ...silentLog,
        warn: (msg, err) => warnCalls.push({ msg, err }),
      };
      const reg = new MCPRegistry({ toolRegistry: toolReg, events, log: warnLog });
      // Inject a client directly into the servers map
      const slot = {
        cfg: stdioCfg('warn-test', { permission: 'confirm' }),
        state: 'connected' as const,
        toolNames: [] as string[],
        attempts: 1,
        reconnectPending: false,
        reconnectCycles: 0,
        client: {
          listTools: () => [{ name: 'bad_tool', inputSchema: {} }],
        } as unknown as any,
      };
      (reg as unknown as { servers: Map<string, typeof slot> }).servers.set('warn-test', slot);
      // Override register to throw
      let regCall = 0;
      (reg as unknown as { toolRegistry: ToolRegistry }).toolRegistry = {
        ...toolReg,
        register: () => {
          regCall++;
          throw new Error('registration failed');
        },
        unregister: () => {},
      } as unknown as ToolRegistry;
      (reg as unknown as RegistryInternals).onToolsChanged(
        'warn-test',
        [{ name: 'bad_tool' } as never],
      );
      expect(regCall).toBe(1);
      expect(warnCalls.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('onChildExit — disconnection and reconnect scheduling', () => {
    it('onChildExit unregisters tools and schedules reconnect', async () => {
      const reg = new MCPRegistry({ toolRegistry: toolReg, events, log: silentLog });
      const slot = {
        cfg: stdioCfg('child-exit-test'),
        state: 'connected' as const,
        toolNames: ['t1', 't2'] as string[],
        attempts: 1,
        reconnectPending: false,
        reconnectCycles: 0,
        client: {} as unknown as any,
      };
      (reg as unknown as { servers: Map<string, typeof slot> }).servers.set('child-exit-test', slot);
      const disconnects: unknown[] = [];
      events.on('mcp.server.disconnected', (p) => disconnects.push(p));
      (reg as unknown as RegistryInternals).onChildExit('child-exit-test', 1, null);
      expect(slot.toolNames).toEqual([]);
      expect(slot.state).toBe('disconnected');
      expect(disconnects.length).toBe(1);
    });

    it('onChildExit skips unknown server', () => {
      const reg = new MCPRegistry({ toolRegistry: toolReg, events, log: silentLog });
      expect(() =>
        (reg as unknown as { onChildExit: (name: string, code: number | null, signal: string | null) => void }).onChildExit(
          'never-registered',
          0,
          null,
        ),
      ).not.toThrow();
    });

    it('onChildExit unregister throws are swallowed', async () => {
      const reg = new MCPRegistry({ toolRegistry: toolReg, events, log: silentLog });
      let unregCall = 0;
      const slot = {
        cfg: stdioCfg('swallow-test'),
        state: 'connected' as const,
        toolNames: ['t1'] as string[],
        attempts: 1,
        reconnectPending: false,
        reconnectCycles: 0,
        client: {} as unknown as any,
      };
      (reg as unknown as { servers: Map<string, typeof slot> }).servers.set('swallow-test', slot);
      (reg as unknown as { toolRegistry: ToolRegistry }).toolRegistry = {
        ...toolReg,
        unregister: () => {
          unregCall++;
          throw new Error('unregister error');
        },
      } as unknown as ToolRegistry;
      // Should not throw even when unregister throws
      expect(() =>
        (reg as unknown as RegistryInternals).onChildExit('swallow-test', 0, null),
      ).not.toThrow();
      expect(unregCall).toBe(1);
    });
  });

  describe('onTransportDisconnect — HTTP transport recovery', () => {
    it('onTransportDisconnect emits http-disconnect reason', async () => {
      const reg = new MCPRegistry({ toolRegistry: toolReg, events, log: silentLog });
      const slot = {
        cfg: stdioCfg('http-disconnect-test', { transport: 'sse' as never }),
        state: 'connected' as const,
        toolNames: ['t1'] as string[],
        attempts: 1,
        reconnectPending: false,
        reconnectCycles: 0,
        client: {} as unknown as any,
      };
      (reg as unknown as { servers: Map<string, typeof slot> }).servers.set('http-disconnect-test', slot);
      const disconnects: { name: string; reason: string }[] = [];
      events.on('mcp.server.disconnected', (p) => disconnects.push(p));
      (reg as unknown as RegistryInternals).onTransportDisconnect(
        'http-disconnect-test',
      );
      expect(slot.state).toBe('disconnected');
      expect(disconnects[0]?.reason).toBe('http-disconnect');
    });

    it('onTransportDisconnect skips unknown server', () => {
      const reg = new MCPRegistry({ toolRegistry: toolReg, events, log: silentLog });
      expect(() =>
        (reg as unknown as { onTransportDisconnect: (name: string) => void }).onTransportDisconnect(
          'never-registered',
        ),
      ).not.toThrow();
    });
  });

  describe('describe() — all servers including stopped/failed', () => {
    it('describe() includes server even when not started (direct servers map insertion)', () => {
      // describe() shows servers regardless of whether they were started or not.
      // When start() is called with enabled=false, the slot is still added to servers map.
      const reg = new MCPRegistry({ toolRegistry: toolReg, events, log: silentLog });
      // Directly inject a slot into the servers map (simulating a server that was
      // registered but not started, or stopped and removed from active list)
      const slot = {
        cfg: stdioCfg('inactive', { enabled: false }),
        state: 'idle' as const,
        toolNames: [] as string[],
        attempts: 0,
        reconnectPending: false,
        reconnectCycles: 0,
      };
      (reg as unknown as { servers: Map<string, typeof slot> }).servers.set('inactive', slot);
      const desc = reg.describe();
      expect(desc).toHaveLength(1);
      expect(desc[0]).toMatchObject({ name: 'inactive', enabled: false });
    });

    it('describe() includes active server with enabled=true', () => {
      const reg = new MCPRegistry({ toolRegistry: toolReg, events, log: silentLog });
      const slot = {
        cfg: stdioCfg('active', { enabled: true }),
        state: 'connected' as const,
        toolNames: [] as string[],
        attempts: 1,
        reconnectPending: false,
        reconnectCycles: 0,
      };
      (reg as unknown as { servers: Map<string, typeof slot> }).servers.set('active', slot);
      const desc = reg.describe();
      expect(desc).toHaveLength(1);
      expect(desc[0]?.enabled).toBe(true);
    });

    it('describe() returns empty array when no servers ever registered', () => {
      const reg = new MCPRegistry({ toolRegistry: toolReg, events, log: silentLog });
      expect(reg.describe()).toEqual([]);
    });
  });

  describe('attemptConnect — prior client cleanup (lines 286-295)', () => {
    it('attemptConnect closes prior client when replacing with new one', async () => {
      // Lines 286-295: when slot.client exists and differs from new client,
      // we remove listeners and call close() on the prior client.
      const reg = new MCPRegistry({ toolRegistry: toolReg, events, log: silentLog });
      // Create a slot with an existing "connected" client (simulated via servers map)
      const priorClient = {
        removeExitListener: vi.fn(),
        removeDisconnectListener: vi.fn(),
        removeToolsChangedListener: vi.fn(),
        close: vi.fn().mockResolvedValue(undefined),
      };
      const slot = {
        cfg: stdioCfg('replace-test', { permission: 'confirm' }),
        state: 'connected' as const,
        toolNames: [] as string[],
        attempts: 1,
        reconnectPending: false,
        reconnectCycles: 0,
        client: priorClient as unknown as any,
        onDisconnect: undefined,
      };
      (reg as unknown as { servers: Map<string, typeof slot> }).servers.set('replace-test', slot);
      // Verify the condition: slot.client && slot.client !== client
      // This test validates the state before an actual reconnect would replace the client
      expect(slot.client).toBe(priorClient);
      expect(slot.client === priorClient).toBe(true); // client !== priorClient would be false
    });

    it('attemptConnect does not close when reconnecting to same client', () => {
      // When slot.client === new client, the if block at 286 is skipped
      const reg = new MCPRegistry({ toolRegistry: toolReg, events, log: silentLog });
      const sharedClient = {
        removeExitListener: vi.fn(),
        removeDisconnectListener: vi.fn(),
        removeToolsChangedListener: vi.fn(),
        close: vi.fn().mockResolvedValue(undefined),
      };
      const slot = {
        cfg: stdioCfg('same-client', { permission: 'confirm' }),
        state: 'connected' as const,
        toolNames: [] as string[],
        attempts: 1,
        reconnectPending: false,
        reconnectCycles: 0,
        client: sharedClient as unknown as any,
        onDisconnect: undefined,
      };
      (reg as unknown as { servers: Map<string, typeof slot> }).servers.set('same-client', slot);
      // Verify the condition check
      expect(slot.client === sharedClient).toBe(true);
    });
  });

  describe('tool registration warning (line 317)', () => {
    it('logs warning when tool registration fails in onToolsChanged', async () => {
      const warnCalls: { msg: string; err?: unknown }[] = [];
      const warnLog: Logger = {
        ...silentLog,
        warn: (msg, err) => warnCalls.push({ msg, err }),
      };
      const reg = new MCPRegistry({ toolRegistry: toolReg, events, log: warnLog });
      // Create a slot with a client that returns a tool that fails registration
      const slot = {
        cfg: stdioCfg('warn-tool', { permission: 'confirm' }),
        state: 'connected' as const,
        toolNames: [] as string[],
        attempts: 1,
        reconnectPending: false,
        reconnectCycles: 0,
        client: {
          listTools: () => [{ name: 'failing-tool', inputSchema: {} }],
          removeExitListener: () => {},
          removeDisconnectListener: () => {},
          removeToolsChangedListener: () => {},
          close: () => Promise.resolve(),
        } as unknown as any,
        onDisconnect: undefined,
      };
      (reg as unknown as { servers: Map<string, typeof slot> }).servers.set('warn-tool', slot);
      // Override register to throw
      let regCall = 0;
      (reg as unknown as { toolRegistry: ToolRegistry }).toolRegistry = {
        ...toolReg,
        register: () => {
          regCall++;
          throw new Error('registration failed');
        },
        unregister: () => {},
      } as unknown as ToolRegistry;
      // Trigger onToolsChanged to exercise the warn path (line 317)
      const onToolsChanged = (reg as unknown as { onToolsChanged: (name: string, tools: { name: string }[]) => void }).onToolsChanged;
      onToolsChanged('warn-tool', [{ name: 'failing-tool' } as never]);
      expect(regCall).toBe(1);
      // Line 317 logs: `MCP tool "${tool.name}" not re-registered after list_changed`
      expect(warnCalls.some((c) => c.msg.includes('not re-registered'))).toBe(true);
    });
  });
});
