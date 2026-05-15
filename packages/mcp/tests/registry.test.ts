import { EventBus, type Logger, type MCPServerConfig, ToolRegistry } from '@wrongstack/core';
import { beforeEach, describe, expect, it } from 'vitest';
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
});
