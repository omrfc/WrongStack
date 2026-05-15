import { describe, expect, it, vi } from 'vitest';
import { DefaultMultiAgentCoordinator } from '../../src/coordination/multi-agent-coordinator.js';
import { BudgetExceededError } from '../../src/coordination/subagent-budget.js';
import type { SubagentRunner, TaskResult } from '../../src/types/multi-agent.js';

const makeConfig = (overrides: Record<string, unknown> = {}) => ({
  coordinatorId: 'coord1',
  doneCondition: { type: 'all_tasks_done' as const },
  maxConcurrent: 4,
  ...overrides,
});

function waitForDone(coord: DefaultMultiAgentCoordinator, timeoutMs = 2000): Promise<TaskResult[]> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(
      () => reject(new Error(`done not fired within ${timeoutMs}ms`)),
      timeoutMs,
    );
    coord.on('done', (e: { results: TaskResult[] }) => {
      clearTimeout(t);
      resolve(e.results);
    });
  });
}

function waitForCompletions(
  coord: DefaultMultiAgentCoordinator,
  count: number,
  timeoutMs = 2000,
): Promise<TaskResult[]> {
  return new Promise((resolve, reject) => {
    const results: TaskResult[] = [];
    const t = setTimeout(
      () => reject(new Error(`only ${results.length}/${count} completed`)),
      timeoutMs,
    );
    coord.on('task.completed', (e: { result: TaskResult }) => {
      results.push(e.result);
      if (results.length >= count) {
        clearTimeout(t);
        resolve(results);
      }
    });
  });
}

describe('DefaultMultiAgentCoordinator with runner', () => {
  it('runner executes a task and reports success', async () => {
    const runner: SubagentRunner = vi.fn(async () => ({
      result: 'ok',
      iterations: 3,
      toolCalls: 5,
    }));
    const coord = new DefaultMultiAgentCoordinator(makeConfig(), { runner });

    await coord.spawn({ id: 'a1', name: 'A1' });
    const donePromise = waitForDone(coord);
    await coord.assign({ id: 'task1', description: 'do work' });
    const [result] = await donePromise;

    expect(runner).toHaveBeenCalledOnce();
    expect(result.status).toBe('success');
    expect(result.result).toBe('ok');
    expect(result.iterations).toBe(3);
    expect(result.toolCalls).toBe(5);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('budget overflow surfaces as failed status', async () => {
    const runner: SubagentRunner = async (_task, ctx) => {
      ctx.budget.recordToolCall();
      ctx.budget.recordToolCall(); // 2nd call exceeds maxToolCalls=1
      return { result: undefined, iterations: 1, toolCalls: 2 };
    };
    const coord = new DefaultMultiAgentCoordinator(makeConfig(), { runner });

    await coord.spawn({ id: 'a1', name: 'A1', maxToolCalls: 1 });
    const donePromise = waitForDone(coord);
    await coord.assign({ id: 't1', description: 'overrun' });
    const [result] = await donePromise;

    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/tool_calls/);
    expect(result.toolCalls).toBe(2);
  });

  it('per-task budget overrides per-subagent budget', async () => {
    const runner: SubagentRunner = async (_task, ctx) => {
      expect(ctx.budget.limits.maxToolCalls).toBe(2);
      return { result: undefined, iterations: 1, toolCalls: 0 };
    };
    const coord = new DefaultMultiAgentCoordinator(makeConfig(), { runner });
    await coord.spawn({ id: 'a1', name: 'A1', maxToolCalls: 10 });
    const donePromise = waitForDone(coord);
    await coord.assign({ id: 't1', description: 'tight task', maxToolCalls: 2 });
    await donePromise;
  });

  it('timeout aborts the runner and reports status=timeout', async () => {
    const runner: SubagentRunner = async (_task, ctx) => {
      // Cooperative runner that respects the signal
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(() => resolve(), 500);
        ctx.signal.addEventListener('abort', () => {
          clearTimeout(t);
          reject(new Error('aborted'));
        });
      });
      return { result: 'too late', iterations: 1, toolCalls: 0 };
    };
    const coord = new DefaultMultiAgentCoordinator(makeConfig(), { runner });

    await coord.spawn({ id: 'a1', name: 'A1', timeoutMs: 30 });
    const donePromise = waitForDone(coord);
    await coord.assign({ id: 't1', description: 'slow' });
    const [result] = await donePromise;

    expect(result.status).toBe('timeout');
  });

  it('respects maxConcurrent — extra tasks queue until a slot frees', async () => {
    let active = 0;
    let maxActive = 0;
    const runner: SubagentRunner = async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 30));
      active--;
      return { result: undefined, iterations: 1, toolCalls: 0 };
    };
    const coord = new DefaultMultiAgentCoordinator(makeConfig({ maxConcurrent: 2 }), { runner });

    for (let i = 0; i < 4; i++) await coord.spawn({ id: `a${i}`, name: `A${i}` });
    const completions = waitForCompletions(coord, 5);
    for (let i = 0; i < 5; i++) await coord.assign({ id: `t${i}`, description: `task ${i}` });

    const results = await completions;
    expect(results).toHaveLength(5);
    expect(maxActive).toBeLessThanOrEqual(2);
    expect(results.every((r) => r.status === 'success')).toBe(true);
  });

  it('context isolation — each subagent gets its own AbortSignal', async () => {
    // Run both tasks concurrently so they land on different subagents.
    // With maxConcurrent=2 both slots are claimed before either completes,
    // forcing the coordinator to pick distinct subagents.
    const signals: AbortSignal[] = [];
    let resolveAll!: () => void;
    const allStarted = new Promise<void>((r) => {
      resolveAll = r;
    });
    let started = 0;
    const runner: SubagentRunner = async (_task, ctx) => {
      signals.push(ctx.signal);
      if (++started === 2) resolveAll();
      await allStarted;
      return { result: undefined, iterations: 1, toolCalls: 0 };
    };
    const coord = new DefaultMultiAgentCoordinator(makeConfig({ maxConcurrent: 2 }), { runner });

    await coord.spawn({ id: 'a1', name: 'A1' });
    await coord.spawn({ id: 'a2', name: 'A2' });
    const completions = waitForCompletions(coord, 2);
    await coord.assign({ id: 't1', description: 'one' });
    await coord.assign({ id: 't2', description: 'two' });
    await completions;

    expect(signals.length).toBe(2);
    expect(signals[0]).not.toBe(signals[1]);
  });

  it('stop() aborts an in-flight task', async () => {
    let aborted = false;
    const runner: SubagentRunner = async (_task, ctx) => {
      await new Promise<void>((resolve, reject) => {
        ctx.signal.addEventListener('abort', () => {
          aborted = true;
          reject(new Error('aborted'));
        });
        setTimeout(resolve, 1000);
      });
      return { result: undefined, iterations: 1, toolCalls: 0 };
    };
    const coord = new DefaultMultiAgentCoordinator(makeConfig(), { runner });

    await coord.spawn({ id: 'a1', name: 'A1' });
    const donePromise = waitForDone(coord);
    await coord.assign({ id: 't1', description: 'long' });

    // Yield once so the runner is dispatched before we stop.
    await new Promise((r) => setTimeout(r, 10));
    await coord.stop('a1');

    const [result] = await donePromise;
    expect(aborted).toBe(true);
    expect(result.status).toBe('stopped');
  });

  it('runner exception surfaces as failed status', async () => {
    const runner: SubagentRunner = async () => {
      throw new Error('runner kaboom');
    };
    const coord = new DefaultMultiAgentCoordinator(makeConfig(), { runner });

    await coord.spawn({ id: 'a1', name: 'A1' });
    const donePromise = waitForDone(coord);
    await coord.assign({ id: 't1', description: 'fail' });
    const [result] = await donePromise;

    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/kaboom/);
  });

  it('coordinator defaultBudget applies when subagent omits limits', async () => {
    let observed: { maxIterations?: number } = {};
    const runner: SubagentRunner = async (_task, ctx) => {
      observed = { maxIterations: ctx.budget.limits.maxIterations };
      return { result: undefined, iterations: 1, toolCalls: 0 };
    };
    const coord = new DefaultMultiAgentCoordinator(
      makeConfig({ defaultBudget: { maxIterations: 7 } }),
      { runner },
    );

    await coord.spawn({ id: 'a1', name: 'A1' });
    const donePromise = waitForDone(coord);
    await coord.assign({ id: 't1', description: 'x' });
    await donePromise;

    expect(observed.maxIterations).toBe(7);
  });

  it('subagent budget falls back to default if subagent error sidelines it briefly', async () => {
    // After a failed task the subagent should self-recover to 'idle' and accept new work
    const calls: number[] = [];
    let n = 0;
    const runner: SubagentRunner = async () => {
      n++;
      calls.push(n);
      if (n === 1) throw new Error('first crash');
      return { result: 'second-ok', iterations: 1, toolCalls: 0 };
    };
    const coord = new DefaultMultiAgentCoordinator(makeConfig({ maxConcurrent: 1 }), { runner });

    await coord.spawn({ id: 'a1', name: 'A1' });
    const completions = waitForCompletions(coord, 2);
    await coord.assign({ id: 't1', description: 'first' });
    await coord.assign({ id: 't2', description: 'second' });
    const results = await completions;

    expect(results[0].status).toBe('failed');
    expect(results[1].status).toBe('success');
    expect(results[1].result).toBe('second-ok');
  });

  it('BudgetExceededError is exported and constructible', () => {
    const err = new BudgetExceededError('tokens', 100, 150);
    expect(err.name).toBe('BudgetExceededError');
    expect(err.kind).toBe('tokens');
    expect(err.limit).toBe(100);
    expect(err.observed).toBe(150);
    expect(err.message).toMatch(/Budget exceeded/);
  });
});
