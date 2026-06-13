import { describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import type { WsServerMessage } from '../../src/webui-server/ws-handlers/index.js';
import {
  handleProcessKill,
  handleProcessKillAll,
  handleProcessList,
} from '../../src/webui-server/ws-handlers/index.js';
import type { ProcessContext } from '../../src/webui-server/ws-handlers/process.js';

/**
 * PR 5g of Issue #30: process ws-handler unit tests.
 *
 * Mocks the @wrongstack/tools process registry to test list/kill/killAll
 * without spawning real processes.
 */

const FAKE_WS = {} as WebSocket;

function makeCtx(over: Partial<ProcessContext> = {}): {
  ctx: ProcessContext;
  sent: WsServerMessage[];
  bc: WsServerMessage[];
} {
  const sent: WsServerMessage[] = [];
  const bc: WsServerMessage[] = [];
  const ctx: ProcessContext = {
    send: (_ws, m) => sent.push(m),
    broadcast: (m) => bc.push(m),
    log: () => {},
    ...over,
  };
  return { ctx, sent, bc };
}

const lastOf = (msgs: WsServerMessage[], type: string) =>
  msgs.filter((m) => m.type === type).at(-1);

// Mock the process registry module
vi.mock('@wrongstack/tools', async () => {
  const actual = await vi.importActual<typeof import('@wrongstack/tools')>('@wrongstack/tools');
  return {
    ...actual,
    getProcessRegistry: () => mockRegistry,
  };
});

const mockRegistry = {
  list: vi.fn(),
  get: vi.fn(),
  kill: vi.fn(),
  killAll: vi.fn(),
};

describe('handleProcessList', () => {
  it('returns empty array when registry throws', async () => {
    const { ctx, sent } = makeCtx();
    mockRegistry.list.mockImplementation(() => {
      throw new Error('registry error');
    });
    await handleProcessList(ctx, FAKE_WS);
    const msg = lastOf(sent, 'process.list');
    expect(msg?.payload).toEqual({ processes: [] });
  });

  it('maps registry entries to process list payload', async () => {
    const { ctx, sent } = makeCtx();
    mockRegistry.list.mockReturnValue([
      { pid: 123, command: 'node test.js', name: 'test', startedAt: '2024-01-01', killed: false, protected: false },
      { pid: 456, command: 'sleep 999', name: 'bash', startedAt: '2024-01-02', killed: true, protected: true },
    ]);
    await handleProcessList(ctx, FAKE_WS);
    const msg = lastOf(sent, 'process.list');
    expect(msg?.payload).toEqual({
      processes: [
        { pid: 123, command: 'node test.js', tool: 'test', startedAt: '2024-01-01', status: 'running', protected: false },
        { pid: 456, command: 'sleep 999', tool: 'bash', startedAt: '2024-01-02', status: 'killed', protected: true },
      ],
    });
  });
});

describe('handleProcessKill', () => {
  it('refuses to kill a protected process', async () => {
    const { ctx, sent } = makeCtx();
    mockRegistry.get.mockReturnValue({ pid: 123, protected: true });
    await handleProcessKill(ctx, FAKE_WS, 123);
    const msg = lastOf(sent, 'key.operation_result');
    expect(msg?.payload).toEqual({ success: false, message: 'Cannot kill protected process (PID 123)' });
    expect(mockRegistry.kill).not.toHaveBeenCalled();
  });

  it('kills an unprotected process', async () => {
    const { ctx, sent } = makeCtx();
    mockRegistry.get.mockReturnValue({ pid: 123, protected: false });
    await handleProcessKill(ctx, FAKE_WS, 123);
    expect(mockRegistry.kill).toHaveBeenCalledWith(123);
    const msg = lastOf(sent, 'key.operation_result');
    expect(msg?.payload).toEqual({ success: true, message: 'Killed PID 123' });
  });

  it('handles registry errors', async () => {
    const { ctx, sent } = makeCtx();
    mockRegistry.get.mockImplementation(() => {
      throw new Error('get failed');
    });
    await handleProcessKill(ctx, FAKE_WS, 123);
    const msg = lastOf(sent, 'key.operation_result');
    expect(msg?.payload).toEqual({ success: false, message: 'get failed' });
  });
});

describe('handleProcessKillAll', () => {
  it('kills all processes and reports success', async () => {
    const { ctx, sent } = makeCtx();
    await handleProcessKillAll(ctx, FAKE_WS);
    expect(mockRegistry.killAll).toHaveBeenCalled();
    const msg = lastOf(sent, 'key.operation_result');
    expect(msg?.payload).toEqual({ success: true, message: 'All processes killed' });
  });

  it('handles registry errors', async () => {
    const { ctx, sent } = makeCtx();
    mockRegistry.killAll.mockImplementation(() => {
      throw new Error('killAll failed');
    });
    await handleProcessKillAll(ctx, FAKE_WS);
    const msg = lastOf(sent, 'key.operation_result');
    expect(msg?.payload).toEqual({ success: false, message: 'killAll failed' });
  });
});
