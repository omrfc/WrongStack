/**
 * Tests for the rewritten ACPSubagentRunner.
 *
 * Strategy: vi.mock the ACPSession class so the runner's behavior
 * (input shape → ACPSession.start / prompt call → output) is the
 * unit under test, with no child processes involved.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { SubagentError, SubagentRunContext, TaskSpec } from '@wrongstack/core';

interface MockSession {
  prompt: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
}

const hoisted = vi.hoisted(() => ({
  startCalls: [] as Array<{ command: string; args?: readonly string[]; env?: Record<string, string>; cwd?: string; projectRoot: string; timeoutMs: number }>,
  session: undefined as MockSession | undefined,
  errorKind: undefined as undefined | string,
  errorMessage: undefined as undefined | string,
  promptResult: undefined as { text: string; stopReason: string; hasText: boolean; toolCalls: unknown[]; diffs: unknown[]; thoughts: string; plan?: unknown[]; usage?: { used: number; size: number } } | undefined,
  promptError: undefined as unknown,
}));

vi.mock('../src/client/acp-session.js', () => {
  class ACPSessionError extends Error {
    readonly kind: string;
    constructor(kind: string, message: string) {
      super(message);
      this.name = 'ACPSessionError';
      this.kind = kind;
    }
  }
  class ACPSession {
    prompt = vi.fn(async () => {
      if (hoisted.promptError) throw hoisted.promptError;
      return hoisted.promptResult;
    });
    close = vi.fn(async () => {});
    static start = vi.fn(async (opts: {
      command: string;
      args?: readonly string[];
      env?: Record<string, string>;
      cwd?: string;
      projectRoot: string;
      timeoutMs: number;
    }) => {
      hoisted.startCalls.push({
        command: opts.command,
        ...(opts.args !== undefined ? { args: opts.args } : {}),
        ...(opts.env !== undefined ? { env: opts.env } : {}),
        ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
        projectRoot: opts.projectRoot,
        timeoutMs: opts.timeoutMs,
      });
      if (hoisted.errorKind) {
        throw new ACPSessionError(hoisted.errorKind, hoisted.errorMessage ?? 'mock error');
      }
      const session = new ACPSession();
      hoisted.session = session;
      return session;
    });
  }
  return { ACPSession, ACPSessionError, textContent: (t: string) => ({ type: 'text', text: t }) };
});

import {
  ACP_AGENT_COMMANDS,
  makeACPSubagentRunner,
  makeACPSubagentRunnerWithStop,
} from '../src/integration/acp-subagent-runner.js';
import { ACPSessionError } from '../src/client/acp-session.js';

const TASK: TaskSpec = { id: 't1', description: 'do the thing' };

function makeCtx(timeoutMs?: number): { ctx: SubagentRunContext; controller: AbortController } {
  const controller = new AbortController();
  const ctx = {
    subagentId: 'sub-1',
    config: {
      id: 'sub-1',
      name: 'sub-1',
      role: 'sub-1',
      provider: 'acp',
      prompt: '',
    },
    signal: controller.signal,
    budget: {
      limits: { timeoutMs },
      markActivity: () => {},
    },
    bridge: null,
  } as never as SubagentRunContext;
  return { ctx, controller };
}

beforeEach(() => {
  hoisted.startCalls.length = 0;
  hoisted.session = undefined;
  hoisted.errorKind = undefined;
  hoisted.errorMessage = undefined;
  hoisted.promptError = undefined;
  hoisted.promptResult = { text: 'ok', stopReason: 'end_turn', hasText: true, toolCalls: [], diffs: [], thoughts: '' };
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
  it('forwards only the defined options to ACPSession.start', async () => {
    const runner = await makeACPSubagentRunner({ command: 'gemini' });
    await runner(TASK, makeCtx(5000).ctx);
    expect(hoisted.startCalls).toHaveLength(1);
    expect(hoisted.startCalls[0]).toMatchObject({
      command: 'gemini',
      projectRoot: process.cwd(),
      timeoutMs: 5 * 60_000,
    });
    expect(hoisted.startCalls[0]?.args).toBeUndefined();

    hoisted.startCalls.length = 0;
    const runner2 = await makeACPSubagentRunner({
      command: 'npx',
      args: ['-y', 'x'],
      env: { FOO: 'bar' },
      cwd: '/tmp/proj',
      projectRoot: '/tmp/proj',
    });
    await runner2(TASK, makeCtx(5000).ctx);
    expect(hoisted.startCalls[0]).toMatchObject({
      command: 'npx',
      args: ['-y', 'x'],
      env: { FOO: 'bar' },
      cwd: '/tmp/proj',
      projectRoot: '/tmp/proj',
    });
  });

  it('runs a task and returns the prompt result text', async () => {
    hoisted.promptResult = {
      text: 'hello world',
      stopReason: 'end_turn',
      hasText: true,
      toolCalls: [],
      diffs: [],
      thoughts: '',
    };
    const runner = await makeACPSubagentRunner({ command: 'gemini' });
    const result = await runner(TASK, makeCtx(5000).ctx);
    expect(result.result).toBe('hello world');
    expect(result.iterations).toBe(1);
    expect(result.toolCalls).toBe(0);
    // session was closed in the finally block
    expect(hoisted.session?.close).toHaveBeenCalled();
  });

  it('reports the real tool-call count captured from the stream', async () => {
    hoisted.promptResult = {
      text: 'done',
      stopReason: 'end_turn',
      hasText: true,
      toolCalls: [
        { toolCallId: 'a', title: 'read x', status: 'completed' },
        { toolCallId: 'b', title: 'edit y', status: 'completed' },
      ],
      diffs: [],
      thoughts: '',
    };
    const runner = await makeACPSubagentRunner({ command: 'gemini' });
    const result = await runner(TASK, makeCtx(5000).ctx);
    expect(result.toolCalls).toBe(2);
  });

  it('throws SubagentError when ACPSession.start fails with spawn_failed', async () => {
    hoisted.errorKind = 'spawn_failed';
    hoisted.errorMessage = 'spawn failed';
    const runner = await makeACPSubagentRunner({ command: 'gemini' });
    let caught: unknown;
    try {
      await runner(TASK, makeCtx(5000).ctx);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    const subagentError = caught as SubagentError;
    expect(subagentError.kind).toBe('bridge_failed');
    expect(subagentError.message).toContain('spawn failed');
    expect(subagentError.retryable).toBe(false);
  });

  it('throws SubagentError when the prompt is aborted (kind=aborted → aborted_by_parent)', async () => {
    // Make the session's prompt throw a real ACPSessionError(aborted).
    hoisted.promptError = new ACPSessionError('aborted', 'aborted by parent');
    hoisted.errorKind = undefined;
    const runner = await makeACPSubagentRunner({ command: 'gemini' });
    let caught: unknown;
    try {
      await runner(TASK, makeCtx(5000).ctx);
    } catch (err) {
      caught = err;
    }
    const subagentError = caught as SubagentError;
    expect(subagentError.kind).toBe('aborted_by_parent');
  });

  it('maps prompt_failed to tool_failed', async () => {
    hoisted.promptError = new ACPSessionError('prompt_failed', 'oops');
    hoisted.errorKind = undefined;
    const runner = await makeACPSubagentRunner({ command: 'gemini' });
    let caught: unknown;
    try {
      await runner(TASK, makeCtx(5000).ctx);
    } catch (err) {
      caught = err;
    }
    const subagentError = caught as SubagentError;
    expect(subagentError.kind).toBe('tool_failed');
  });
});

describe('makeACPSubagentRunnerWithStop', () => {
  it('returns a stop() that is a no-op (sessions are per-call)', async () => {
    const { runner, stop } = await makeACPSubagentRunnerWithStop({ command: 'gemini' });
    expect(typeof stop).toBe('function');
    // Running the task completes normally
    const result = await runner(TASK, makeCtx(5000).ctx);
    expect(result.result).toBe('ok');
    // stop() doesn't throw
    expect(() => stop()).not.toThrow();
  });

  it('respects the explicit timeoutMs option', async () => {
    const { runner } = await makeACPSubagentRunnerWithStop({ command: 'gemini', timeoutMs: 12_345 });
    await runner(TASK, makeCtx(5000).ctx);
    expect(hoisted.startCalls[0]?.timeoutMs).toBe(12_345);
  });
});
