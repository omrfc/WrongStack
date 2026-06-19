import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { EventBus, type Logger, type MCPServerConfig, ToolRegistry } from '@wrongstack/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Shared, hoisted state so the mocked MCPClient can be inspected from tests.
const h = vi.hoisted(() => ({
  connectCalls: 0,
  callToolCalls: 0,
  closes: 0,
  tools: [
    { name: 'echo', description: 'echo', inputSchema: { type: 'object', properties: {} } },
  ] as { name: string; description?: string; inputSchema: Record<string, unknown> }[],
}));

vi.mock('../src/client.js', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  class FakeClient {
    opts: { name: string };
    constructor(opts: { name: string }) {
      this.opts = opts;
    }
    async connect() {
      h.connectCalls++;
    }
    listTools() {
      return h.tools;
    }
    async callTool() {
      h.callToolCalls++;
      return { content: 'ok', isError: false };
    }
    async close() {
      h.closes++;
    }
    addExitListener() {}
    removeExitListener() {}
    addDisconnectListener() {}
    removeDisconnectListener() {}
    addToolsChangedListener() {}
    removeToolsChangedListener() {}
  }
  return { ...actual, MCPClient: FakeClient };
});

// Import AFTER the mock so the registry binds to FakeClient.
const { MCPRegistry } = await import('../src/registry.js');

const silentLog: Logger = {
  error: () => {},
  warn: () => {},
  info: () => {},
  debug: () => {},
  trace: () => {},
  child: () => silentLog,
} as unknown as Logger;

const lazyCfg = (name: string, extra: Partial<MCPServerConfig> = {}): MCPServerConfig => ({
  name,
  transport: 'stdio',
  command: 'never-actually-run',
  args: [],
  lazy: true,
  ...extra,
});

let tmp: string;
let toolReg: ToolRegistry;
let events: EventBus;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-lazy-'));
  toolReg = new ToolRegistry();
  events = new EventBus();
  h.connectCalls = 0;
  h.callToolCalls = 0;
  h.closes = 0;
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

function toolNames(reg: InstanceType<typeof MCPRegistry>, name: string): string[] {
  return reg.list().find((s) => s.name === name)?.tools ?? [];
}

describe('MCPRegistry lazy-connect', () => {
  it('cold-discovers once and writes a manifest when no cache exists', async () => {
    const reg = new MCPRegistry({ toolRegistry: toolReg, events, log: silentLog, cacheDir: tmp });
    await reg.start(lazyCfg('svc'));
    // No cache → one discovery connect.
    expect(h.connectCalls).toBe(1);
    expect(toolNames(reg, 'svc')).toContain('mcp__svc__echo');
    // Manifest persisted for next boot.
    const manifest = await fs.readFile(path.join(tmp, 'mcp-tools', 'svc.json'), 'utf8');
    expect(manifest).toContain('echo');
    await reg.stopAll();
  });

  it('registers from cache as dormant WITHOUT spawning on the next boot', async () => {
    // First boot: cold discovery writes the manifest.
    const reg1 = new MCPRegistry({ toolRegistry: toolReg, events, log: silentLog, cacheDir: tmp });
    await reg1.start(lazyCfg('svc'));
    await reg1.stopAll();

    // Second boot with a fresh registry + tool registry: should NOT connect.
    h.connectCalls = 0;
    const toolReg2 = new ToolRegistry();
    const reg2 = new MCPRegistry({
      toolRegistry: toolReg2,
      events,
      log: silentLog,
      cacheDir: tmp,
    });
    await reg2.start(lazyCfg('svc'));
    expect(h.connectCalls).toBe(0); // dormant — process not spawned
    expect(reg2.list().find((s) => s.name === 'svc')?.state).toBe('dormant');
    // Tools are still visible to the model.
    expect(toolReg2.list().some((t) => t.name === 'mcp__svc__echo')).toBe(true);
    await reg2.stopAll();
  });

  it('spawns on first tool call (single-flight under concurrency)', async () => {
    // Seed the cache so start() is dormant.
    const seed = new MCPRegistry({
      toolRegistry: new ToolRegistry(),
      events,
      log: silentLog,
      cacheDir: tmp,
    });
    await seed.start(lazyCfg('svc'));
    await seed.stopAll();

    h.connectCalls = 0;
    const reg = new MCPRegistry({ toolRegistry: toolReg, events, log: silentLog, cacheDir: tmp });
    await reg.start(lazyCfg('svc'));
    expect(reg.list().find((s) => s.name === 'svc')?.state).toBe('dormant');

    // Two concurrent ensureConnected calls → exactly one connect.
    const [c1, c2] = await Promise.all([reg.ensureConnected('svc'), reg.ensureConnected('svc')]);
    expect(c1).toBe(c2);
    expect(h.connectCalls).toBe(1);
    expect(reg.list().find((s) => s.name === 'svc')?.state).toBe('connected');
    await reg.stopAll();
  });

  it('a registered lazy tool wakes the server when executed', async () => {
    const seed = new MCPRegistry({
      toolRegistry: new ToolRegistry(),
      events,
      log: silentLog,
      cacheDir: tmp,
    });
    await seed.start(lazyCfg('svc'));
    await seed.stopAll();

    h.connectCalls = 0;
    const reg = new MCPRegistry({ toolRegistry: toolReg, events, log: silentLog, cacheDir: tmp });
    await reg.start(lazyCfg('svc'));
    const tool = toolReg.list().find((t) => t.name === 'mcp__svc__echo');
    expect(tool).toBeDefined();
    const out = await tool?.execute?.({}, {} as never, {} as never);
    expect(out).toBe('ok');
    expect(h.connectCalls).toBe(1); // execute spawned the dormant server
    expect(h.callToolCalls).toBe(1);
    await reg.stopAll();
  });

  it('auto-sleeps a connected lazy server after the idle timeout', async () => {
    const reg = new MCPRegistry({
      toolRegistry: toolReg,
      events,
      log: silentLog,
      cacheDir: tmp,
      idleTimeoutMs: 5,
    });
    await reg.start(lazyCfg('svc')); // cold discovery → connected
    expect(reg.list().find((s) => s.name === 'svc')?.state).toBe('connected');

    await new Promise((r) => setTimeout(r, 20)); // exceed the 5ms idle window
    // Invoke the private sweep directly (the interval would also fire it).
    await (reg as unknown as { sweepIdle(): Promise<void> }).sweepIdle();

    expect(reg.list().find((s) => s.name === 'svc')?.state).toBe('dormant');
    expect(h.closes).toBeGreaterThanOrEqual(1);
    // Tools stay registered so the next call can re-wake.
    expect(toolReg.list().some((t) => t.name === 'mcp__svc__echo')).toBe(true);
    await reg.stopAll();
  });

  it('falls back to eager connect when no cacheDir is configured', async () => {
    const reg = new MCPRegistry({ toolRegistry: toolReg, events, log: silentLog });
    await reg.start(lazyCfg('svc')); // lazy requested but no cacheDir → eager
    expect(h.connectCalls).toBe(1);
    expect(reg.list().find((s) => s.name === 'svc')?.state).toBe('connected');
    await reg.stopAll();
  });
});
