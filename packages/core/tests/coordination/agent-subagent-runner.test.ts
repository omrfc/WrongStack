import { describe, expect, it, vi } from 'vitest';
import { makeAgentSubagentRunner } from '../../src/coordination/agent-subagent-runner.js';
import { DefaultMultiAgentCoordinator } from '../../src/coordination/multi-agent-coordinator.js';
import type { Agent, RunResult } from '../../src/core/agent.js';
import { EventBus } from '../../src/kernel/events.js';
import type { TaskResult } from '../../src/types/multi-agent.js';

/**
 * Stub agent that emits the events a real Agent would emit during one run.
 * Lets us exercise the adapter's budget bookkeeping without dragging in the
 * full Agent dependency graph (Container, registries, provider, etc.).
 */
function makeStubAgent(opts: {
  iterations: number;
  toolCallsPerIteration?: number;
  finalText?: string;
  durationMs?: number;
  fail?: boolean;
}): { agent: Agent; events: EventBus } {
  const events = new EventBus();
  const ctx = {} as any;
  const usage = { input: 100, output: 50 };
  const toolCallsPerIter = opts.toolCallsPerIteration ?? 1;

  const agent = {
    async run(_input: unknown, runOpts: { signal: AbortSignal }): Promise<RunResult> {
      for (let i = 0; i < opts.iterations; i++) {
        if (runOpts.signal.aborted) {
          return { status: 'aborted', iterations: i };
        }
        events.emit('iteration.started', { ctx, index: i });
        for (let t = 0; t < toolCallsPerIter; t++) {
          events.emit('tool.started', { name: 'stub', id: `t${i}-${t}` });
        }
        events.emit('provider.response', { ctx, usage, stopReason: 'end_turn' });
        events.emit('iteration.completed', { ctx, index: i });
        if (opts.durationMs) {
          await new Promise<void>((r) => setTimeout(r, opts.durationMs));
        }
      }
      if (opts.fail) {
        return { status: 'failed', error: new Error('stub failure'), iterations: opts.iterations };
      }
      return { status: 'done', iterations: opts.iterations, finalText: opts.finalText };
    },
  } as unknown as Agent;

  return { agent, events };
}

const makeConfig = (overrides: Record<string, unknown> = {}) => ({
  coordinatorId: 'coord1',
  doneCondition: { type: 'all_tasks_done' as const },
  maxConcurrent: 4,
  ...overrides,
});

function waitForCompletion(
  coord: DefaultMultiAgentCoordinator,
  timeoutMs = 2000,
): Promise<TaskResult> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(
      () => reject(new Error(`task did not complete within ${timeoutMs}ms`)),
      timeoutMs,
    );
    coord.once('task.completed', (e: { result: TaskResult }) => {
      clearTimeout(t);
      resolve(e.result);
    });
  });
}

describe('makeAgentSubagentRunner', () => {
  it('drives a real agent and reports success', async () => {
    const factory = vi.fn(async () => makeStubAgent({ iterations: 2, finalText: 'all done' }));
    const runner = makeAgentSubagentRunner({ factory });
    const coord = new DefaultMultiAgentCoordinator(makeConfig(), { runner });

    await coord.spawn({ id: 'a1', name: 'A1' });
    const completion = waitForCompletion(coord);
    await coord.assign({ id: 't1', description: 'task body' });
    const result = await completion;

    expect(result.status).toBe('success');
    expect(result.result).toBe('all done');
    expect(result.iterations).toBe(2);
    expect(result.toolCalls).toBe(2); // 1 per iteration
    expect(factory).toHaveBeenCalledOnce();
  });

  it('enforces tool-call budget via event hook', async () => {
    // Agent would run 5 iterations × 2 tool calls = 10 tool calls, but
    // budget allows only 3. The adapter must abort the agent and surface
    // failure.
    const factory = async () => makeStubAgent({ iterations: 5, toolCallsPerIteration: 2 });
    const runner = makeAgentSubagentRunner({ factory });
    const coord = new DefaultMultiAgentCoordinator(makeConfig(), { runner });

    await coord.spawn({ id: 'a1', name: 'A1', maxToolCalls: 3 });
    const completion = waitForCompletion(coord);
    await coord.assign({ id: 't1', description: 'over-budget' });
    const result = await completion;

    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/tool_calls/);
    // Tool calls observed at least breached the limit
    expect(result.toolCalls).toBeGreaterThanOrEqual(3);
  });

  it('records iterations and respects iteration budget', async () => {
    const factory = async () => makeStubAgent({ iterations: 10 });
    const runner = makeAgentSubagentRunner({ factory });
    const coord = new DefaultMultiAgentCoordinator(makeConfig(), { runner });

    await coord.spawn({ id: 'a1', name: 'A1', maxIterations: 2 });
    const completion = waitForCompletion(coord);
    await coord.assign({ id: 't1', description: 'iter-budget' });
    const result = await completion;

    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/iterations/);
  });

  it('agent failure surfaces as failed task', async () => {
    const factory = async () => makeStubAgent({ iterations: 1, fail: true });
    const runner = makeAgentSubagentRunner({ factory });
    const coord = new DefaultMultiAgentCoordinator(makeConfig(), { runner });

    await coord.spawn({ id: 'a1', name: 'A1' });
    const completion = waitForCompletion(coord);
    await coord.assign({ id: 't1', description: 'will fail' });
    const result = await completion;

    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/stub failure/);
  });

  it('coordinator stop() propagates as abort signal to the agent', async () => {
    let observedAbort = false;
    const factory = async () => {
      const stub = makeStubAgent({ iterations: 100, durationMs: 30 });
      // Wrap run() to capture abort observation
      const inner = stub.agent.run.bind(stub.agent);
      stub.agent.run = async (input, opts) => {
        const res = await inner(input, opts);
        if (opts.signal.aborted) observedAbort = true;
        return res;
      };
      return stub;
    };
    const runner = makeAgentSubagentRunner({ factory });
    const coord = new DefaultMultiAgentCoordinator(makeConfig(), { runner });

    await coord.spawn({ id: 'a1', name: 'A1' });
    const completion = waitForCompletion(coord);
    await coord.assign({ id: 't1', description: 'long' });
    await new Promise((r) => setTimeout(r, 50));
    await coord.stop('a1');
    const result = await completion;

    expect(observedAbort).toBe(true);
    expect(result.status).toBe('stopped');
  });

  it('custom formatTaskInput is used to build the agent input', async () => {
    const inputs: unknown[] = [];
    const factory = async () => {
      const stub = makeStubAgent({ iterations: 1 });
      const inner = stub.agent.run.bind(stub.agent);
      stub.agent.run = async (input, opts) => {
        inputs.push(input);
        return inner(input, opts);
      };
      return stub;
    };
    const runner = makeAgentSubagentRunner({
      factory,
      formatTaskInput: (task, config) => `[${config.name}] ${task.description}`,
    });
    const coord = new DefaultMultiAgentCoordinator(makeConfig(), { runner });

    await coord.spawn({ id: 'a1', name: 'Researcher' });
    const completion = waitForCompletion(coord);
    await coord.assign({ id: 't1', description: 'investigate X' });
    await completion;

    expect(inputs).toEqual(['[Researcher] investigate X']);
  });
});
