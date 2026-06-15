import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { SubagentRunContext, TaskSpec } from '@wrongstack/core';
import type { ACPMessage } from '../src/types/acp-messages.js';

// Replace the real ClientTransport (which spawns a child) with a controllable fake.
const hoisted = vi.hoisted(() => ({ instances: [] as FakeTransport[] }));

interface FakeTransport {
  opts: Record<string, unknown>;
  sent: ACPMessage[];
  handlers: Array<(m: ACPMessage) => void>;
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  read: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
  onMessage: (h: (m: ACPMessage) => void) => () => void;
  emit: (m: ACPMessage) => void;
}

vi.mock('../src/agent/stdio-transport.js', () => {
  class ClientTransport {
    opts: Record<string, unknown>;
    sent: ACPMessage[] = [];
    handlers: Array<(m: ACPMessage) => void> = [];
    start = vi.fn(async () => {});
    stop = vi.fn();
    read = vi.fn(async () => ({ id: '1', method: 'initialize', result: {} }));
    send = vi.fn(async (m: ACPMessage) => {
      this.sent.push(m);
    });
    constructor(opts: Record<string, unknown>) {
      this.opts = opts;
      hoisted.instances.push(this as unknown as FakeTransport);
    }
    onMessage(h: (m: ACPMessage) => void): () => void {
      this.handlers.push(h);
      return () => {};
    }
    emit(m: ACPMessage): void {
      for (const h of [...this.handlers]) h(m);
    }
  }
  return { ClientTransport, StdioTransport: class {} };
});

import {
  ACP_AGENT_COMMANDS,
  makeACPSubagentRunner,
  makeACPSubagentRunnerWithStop,
} from '../src/integration/acp-subagent-runner.js';

const TASK: TaskSpec = { id: 't1', description: 'do the thing' };

function makeCtx(timeoutMs?: number): { ctx: SubagentRunContext; controller: AbortController } {
  const controller = new AbortController();
  const ctx = {
    subagentId: 'sub-1',
    signal: controller.signal,
    budget: { limits: { timeoutMs }, markActivity: () => {} },
  } as unknown as SubagentRunContext;
  return { ctx, controller };
}

const lastInstance = (): FakeTransport => hoisted.instances[hoisted.instances.length - 1]!;

beforeEach(() => {
  hoisted.instances.length = 0;
});

describe('ACP_AGENT_COMMANDS', () => {
  it('maps known roles to spawn options', () => {
    expect(ACP_AGENT_COMMANDS.cline).toMatchObject({ command: 'npx', role: 'cline' });
    expect(ACP_AGENT_COMMANDS['gemini-cli']).toMatchObject({ command: 'gemini' });
    expect(ACP_AGENT_COMMANDS.copilot).toMatchObject({ command: 'gh', args: ['copilot', 'agent'] });
    expect(Object.keys(ACP_AGENT_COMMANDS)).toEqual(
      expect.arrayContaining(['cline', 'gemini-cli', 'copilot', 'openhands', 'goose']),
    );
  });
});

describe('makeACPSubagentRunner', () => {
  it('forwards only the defined client-transport options', async () => {
    await makeACPSubagentRunner({ command: 'gemini' });
    expect(lastInstance().opts).toEqual({ command: 'gemini', handshakeTimeoutMs: 30_000 });

    await makeACPSubagentRunner({ command: 'npx', args: ['-y', 'x'], env: { E: '1' }, cwd: '/c' });
    expect(lastInstance().opts).toEqual({
      command: 'npx',
      handshakeTimeoutMs: 30_000,
      args: ['-y', 'x'],
      env: { E: '1' },
      cwd: '/c',
    });
  });

  it('runs a task and returns the parsed tool result', async () => {
    const runner = await makeACPSubagentRunner({ command: 'gemini' });
    const inst = lastInstance();
    const { ctx } = makeCtx(5000);

    const promise = runner(TASK, ctx);
    await vi.waitFor(() => expect(inst.sent.some((m) => m.method === 'agent/run')).toBe(true));
    // A non-tools/call message must be ignored by the result listener.
    inst.emit({ method: 'progress', id: 'noise' } as ACPMessage);
    inst.emit({ method: 'tools/call', id: 'c1', result: { content: [{ type: 'text', text: 'done' }] } } as ACPMessage);

    const res = await promise;
    expect(res).toMatchObject({ result: 'done', iterations: 1, toolCalls: 1 });
    // initialize + agent/run were sent
    expect(inst.sent.map((m) => m.method)).toEqual(['initialize', 'agent/run']);
    expect(inst.start).toHaveBeenCalled();
  });

  it('defaults the budget timeout to 300s when none is given', async () => {
    const runner = await makeACPSubagentRunner({ command: 'gemini' });
    const inst = lastInstance();
    const { ctx } = makeCtx(undefined);
    const promise = runner(TASK, ctx);
    await vi.waitFor(() => expect(inst.sent.some((m) => m.method === 'agent/run')).toBe(true));
    inst.emit({ method: 'tools/call', id: 'c2', result: { content: [{ type: 'text', text: 'ok' }] } } as ACPMessage);
    const res = await promise;
    expect(res.result).toBe('ok');
  });

  it('throws when initialize returns an error', async () => {
    const runner = await makeACPSubagentRunner({ command: 'gemini' });
    lastInstance().read.mockResolvedValueOnce({ id: '1', method: 'initialize', error: { code: 1, message: 'bad init' } });
    await expect(runner(TASK, makeCtx(5000).ctx)).rejects.toThrow(/initialize failed: bad init/);
  });

  it('throws when initialize gets no response', async () => {
    const runner = await makeACPSubagentRunner({ command: 'gemini' });
    lastInstance().read.mockResolvedValueOnce(null);
    await expect(runner(TASK, makeCtx(5000).ctx)).rejects.toThrow(/initialize failed: no response/);
  });

  it('returns an error result when the task is aborted', async () => {
    const runner = await makeACPSubagentRunner({ command: 'gemini' });
    const inst = lastInstance();
    const { ctx, controller } = makeCtx(5000);
    const promise = runner(TASK, ctx);
    await vi.waitFor(() => expect(inst.sent.some((m) => m.method === 'agent/run')).toBe(true));
    controller.abort();
    const res = await promise;
    expect(res.result).toMatch(/aborted by parent/);
    expect(res.iterations).toBe(0);
    expect(res.toolCalls).toBe(0);
    expect(inst.stop).toHaveBeenCalled();
  });

  it('returns an error result when the task times out', async () => {
    const runner = await makeACPSubagentRunner({ command: 'gemini' });
    const { ctx } = makeCtx(40); // short budget; no response emitted
    const res = await runner(TASK, ctx);
    expect(res.result).toMatch(/timed out/);
    expect(res.iterations).toBe(0);
  });

  it('returns an error result (stringifying a non-Error) when sending the task fails', async () => {
    const runner = await makeACPSubagentRunner({ command: 'gemini' });
    const inst = lastInstance();
    inst.send.mockImplementation(async (m: ACPMessage) => {
      inst.sent.push(m);
      if (m.method === 'agent/run') throw 'raw string failure';
    });
    const res = await runner(TASK, makeCtx(5000).ctx);
    expect(res.result).toBe('ACP subagent error: raw string failure');
    expect(res.iterations).toBe(0);
  });

  it('only starts the session once across multiple runs', async () => {
    const runner = await makeACPSubagentRunner({ command: 'gemini' });
    const inst = lastInstance();

    const run = async () => {
      const { ctx } = makeCtx(5000);
      const p = runner(TASK, ctx);
      await vi.waitFor(() => expect(inst.sent.filter((m) => m.method === 'agent/run').length).toBeGreaterThan(0));
      inst.emit({ method: 'tools/call', id: 'x', result: { content: [{ type: 'text', text: 'r' }] } } as ACPMessage);
      return p;
    };
    await run();
    await run();
    expect(inst.start).toHaveBeenCalledTimes(1);
  });
});

describe('makeACPSubagentRunnerWithStop', () => {
  it('runs a task and exposes a stop() that tears down the transport', async () => {
    const { runner, stop } = await makeACPSubagentRunnerWithStop({ command: 'goose' });
    const inst = lastInstance();
    const { ctx } = makeCtx(5000);

    const promise = runner(TASK, ctx);
    await vi.waitFor(() => expect(inst.sent.some((m) => m.method === 'agent/run')).toBe(true));
    inst.emit({ method: 'progress', id: 'noise' } as ACPMessage);
    inst.emit({ method: 'tools/call' } as ACPMessage); // tools/call without an id is ignored
    inst.emit({ method: 'tools/call', id: 's1', result: { content: [{ type: 'text', text: 'finished' }] } } as ACPMessage);
    const res = await promise;
    expect(res.result).toBe('finished');

    stop();
    expect(inst.stop).toHaveBeenCalled();
  });

  it('returns an error result when the task is aborted', async () => {
    const { runner } = await makeACPSubagentRunnerWithStop({ command: 'goose' });
    const inst = lastInstance();
    const { ctx, controller } = makeCtx(5000);
    const promise = runner(TASK, ctx);
    await vi.waitFor(() => expect(inst.sent.some((m) => m.method === 'agent/run')).toBe(true));
    controller.abort();
    const res = await promise;
    expect(res.result).toMatch(/aborted by parent/);
  });

  it('throws when initialize fails', async () => {
    const { runner } = await makeACPSubagentRunnerWithStop({ command: 'goose' });
    lastInstance().read.mockResolvedValueOnce(null);
    await expect(runner(TASK, makeCtx(5000).ctx)).rejects.toThrow(/initialize failed/);
  });

  it('returns an error result when the task times out', async () => {
    const { runner } = await makeACPSubagentRunnerWithStop({ command: 'goose' });
    const res = await runner(TASK, makeCtx(40).ctx); // short budget, no response emitted
    expect(res.result).toMatch(/timed out/);
    expect(res.iterations).toBe(0);
  });

  it('defaults the budget timeout to 300s when none is given', async () => {
    const { runner } = await makeACPSubagentRunnerWithStop({ command: 'goose' });
    const inst = lastInstance();
    const promise = runner(TASK, makeCtx(undefined).ctx);
    await vi.waitFor(() => expect(inst.sent.some((m) => m.method === 'agent/run')).toBe(true));
    inst.emit({ method: 'tools/call', id: 'z', result: { content: [{ type: 'text', text: 'ok' }] } } as ACPMessage);
    expect((await promise).result).toBe('ok');
  });

  it('returns an error result (stringifying a non-Error) when sending the task fails', async () => {
    const { runner } = await makeACPSubagentRunnerWithStop({ command: 'goose' });
    const inst = lastInstance();
    inst.send.mockImplementation(async (m: ACPMessage) => {
      inst.sent.push(m);
      if (m.method === 'agent/run') throw 'raw string failure';
    });
    const res = await runner(TASK, makeCtx(5000).ctx);
    expect(res.result).toBe('ACP subagent error: raw string failure');
  });

  it('only starts the session once across multiple runs', async () => {
    const { runner } = await makeACPSubagentRunnerWithStop({ command: 'goose' });
    const inst = lastInstance();
    const run = async () => {
      const p = runner(TASK, makeCtx(5000).ctx);
      await vi.waitFor(() => expect(inst.sent.filter((m) => m.method === 'agent/run').length).toBeGreaterThan(0));
      inst.emit({ method: 'tools/call', id: 'x', result: { content: [{ type: 'text', text: 'r' }] } } as ACPMessage);
      return p;
    };
    await run();
    await run();
    expect(inst.start).toHaveBeenCalledTimes(1);
  });
});
