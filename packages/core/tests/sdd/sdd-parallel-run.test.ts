import { describe, expect, it, vi } from 'vitest';
import { SddParallelRun } from '../../src/sdd/sdd-parallel-run.js';
import { TaskTracker } from '../../src/sdd/task-tracker.js';
import { EventBus } from '../../src/kernel/events.js';
import type { Agent } from '../../src/core/agent.js';
import type { TaskGraph, TaskNode, TaskStore } from '../../src/types/task-graph.js';
import type { TaskResult } from '../../src/types/multi-agent.js';

function makeFakeStore(): TaskStore {
  const graphs = new Map<string, TaskGraph>();
  return {
    async saveGraph(graph: TaskGraph) {
      graphs.set(graph.id, { ...graph, nodes: new Map(graph.nodes), edges: [...graph.edges], rootNodes: [...graph.rootNodes] });
    },
    async loadGraph(id: string) {
      const g = graphs.get(id);
      return g ? { ...g, nodes: new Map(g.nodes), edges: [...g.edges], rootNodes: [...g.rootNodes] } : null;
    },
    async listGraphs() {
      return Array.from(graphs.values()).map((g) => ({ id: g.id, title: g.title, updatedAt: g.updatedAt }));
    },
    async deleteGraph(id: string) {
      graphs.delete(id);
    },
  };
}

function fakeAgent(): Agent {
  return { events: new EventBus(), run: vi.fn() } as unknown as Agent;
}

async function makeHarness(overrides: Record<string, unknown> = {}) {
  const tracker = new TaskTracker({ store: makeFakeStore() });
  const graph = await tracker.createGraph('spec-1', 'Parallel Graph');
  const t1 = tracker.addNode({ title: 'T1', description: 'do one', type: 'feature', priority: 'high', status: 'pending' } as never);
  const t2 = tracker.addNode({ title: 'T2', description: 'do two', type: 'chore', priority: 'medium', status: 'pending' } as never);
  const run = new SddParallelRun({ tracker, graph, agent: fakeAgent(), projectRoot: '/proj', ...overrides });
  return { run, tracker, graph, t1, t2 };
}

const okResult = (taskId: string): TaskResult => ({ subagentId: 's', taskId, status: 'success', iterations: 1, toolCalls: 1, durationMs: 1 });
const failResult = (taskId: string, error?: TaskResult['error']): TaskResult => ({
  subagentId: 's', taskId, status: 'failed', error, iterations: 1, toolCalls: 0, durationMs: 1,
});

function fakeCoordinator(over: Partial<Record<string, unknown>> = {}) {
  return {
    spawn: vi.fn(async (c: { id: string }) => ({ subagentId: c.id })),
    assign: vi.fn(async () => {}),
    awaitTasks: vi.fn(async (ids: string[]) => ids.map(okResult)),
    stopAll: vi.fn(),
    ...over,
  };
}

describe('SddParallelRun — constructor clamps', () => {
  it('clamps parallel slots and retries into range', async () => {
    const big = await makeHarness({ parallelSlots: 100, maxRetries: -5 });
    expect((big.run as unknown as { slots: number }).slots).toBe(16);
    expect((big.run as unknown as { maxRetries: number }).maxRetries).toBe(0);
    const small = await makeHarness({ parallelSlots: 0 });
    expect((small.run as unknown as { slots: number }).slots).toBe(1);
  });
});

describe('SddParallelRun.executeWave', () => {
  it('spawns, assigns, awaits and marks every task completed on success', async () => {
    const { run, tracker, t1, t2 } = await makeHarness();
    const coord = fakeCoordinator();
    (run as unknown as { coordinator: unknown }).coordinator = coord;
    const wave = await run.executeWave({ wave: 0, tasks: [t1, t2], deadlocked: false, allDone: false } as never);
    expect(wave.successCount).toBe(2);
    expect(wave.failCount).toBe(0);
    expect(coord.spawn).toHaveBeenCalledTimes(2);
    expect(coord.assign).toHaveBeenCalledTimes(2);
    expect(tracker.getAllNodes({ status: ['completed'] })).toHaveLength(2);
  });

  it('re-queues a failed task for retry while retries remain', async () => {
    const { run, tracker, t1 } = await makeHarness({ maxRetries: 2 });
    const coord = fakeCoordinator({
      awaitTasks: vi.fn(async (ids: string[]) => ids.map((id) => failResult(id, { kind: 'unknown', message: 'boom', retryable: true }))),
    });
    (run as unknown as { coordinator: unknown }).coordinator = coord;
    await run.executeWave({ wave: 0, tasks: [t1], deadlocked: false, allDone: false } as never);
    // retry path → t1 re-marked pending (not failed), and the retry counter advances
    const t1After = tracker.getAllNodes().find((n) => n.id === t1.id);
    expect(t1After?.status).toBe('pending');
    expect(tracker.getAllNodes({ status: ['failed'] })).toHaveLength(0);
    expect((run as unknown as { retryMap: Map<string, number> }).retryMap.get(t1.id)).toBe(1);
  });

  it('marks a task failed once retries are exhausted, formatting the error', async () => {
    const { run, tracker, t1 } = await makeHarness({ maxRetries: 0 });
    const coord = fakeCoordinator({
      awaitTasks: vi.fn(async (ids: string[]) => ids.map((id) => failResult(id, { kind: 'timeout', message: 'too slow', retryable: false }))),
    });
    (run as unknown as { coordinator: unknown }).coordinator = coord;
    await run.executeWave({ wave: 0, tasks: [t1], deadlocked: false, allDone: false } as never);
    expect(tracker.getAllNodes({ status: ['failed'] })).toHaveLength(1);
  });

  it('handles a failure result with only a message and one with no error object', async () => {
    const { run, tracker } = await makeHarness({ maxRetries: 0 });
    const nodes = tracker.getAllNodes();
    const coord = fakeCoordinator({
      awaitTasks: vi.fn(async (ids: string[]) => [
        failResult(ids[0]!, { kind: undefined as never, message: 'just a message', retryable: false }),
        failResult(ids[1]!, undefined),
      ]),
    });
    (run as unknown as { coordinator: unknown }).coordinator = coord;
    const wave = await run.executeWave({ wave: 0, tasks: nodes, deadlocked: false, allDone: false } as never);
    expect(wave.failCount).toBe(2);
  });

  it('throws when a subagent spawn returns no id', async () => {
    const { run, t1 } = await makeHarness();
    (run as unknown as { coordinator: unknown }).coordinator = fakeCoordinator({
      spawn: vi.fn(async () => ({ subagentId: '' })),
    });
    await expect(run.executeWave({ wave: 0, tasks: [t1], deadlocked: false, allDone: false } as never)).rejects.toThrow(/spawns failed/);
  });

  it('synthesizes failed results when awaitTasks throws', async () => {
    const { run, tracker, t1 } = await makeHarness({ maxRetries: 0 });
    (run as unknown as { coordinator: unknown }).coordinator = fakeCoordinator({
      awaitTasks: vi.fn(async () => { throw new Error('await exploded'); }),
    });
    const wave = await run.executeWave({ wave: 0, tasks: [t1], deadlocked: false, allDone: false } as never);
    expect(wave.failCount).toBe(1);
    expect(tracker.getAllNodes({ status: ['failed'] })).toHaveLength(1);
  });

  it('throws when no coordinator has been built', async () => {
    const { run, t1 } = await makeHarness();
    (run as unknown as { coordinator: unknown }).coordinator = null;
    await expect(run.executeWave({ wave: 0, tasks: [t1], deadlocked: false, allDone: false } as never)).rejects.toThrow(/requires a coordinator/);
  });
});

/** Drives run()'s loop with a scripted decomposer + a stubbed executeWave. */
function scriptDecomposer(run: SddParallelRun, batches: Array<{ tasks: TaskNode[]; deadlocked?: boolean; allDone?: boolean }>) {
  let i = 0;
  let done = false;
  (run as unknown as { decomposer: unknown }).decomposer = {
    isDone: () => done,
    nextBatch: () => ({ wave: i, tasks: [], deadlocked: false, allDone: false, ...batches[Math.min(i, batches.length - 1)] }),
    acknowledgeBatch: () => { i++; if (i >= batches.length - 1) done = true; },
    getWaveCount: () => i,
  };
}

describe('SddParallelRun.run', () => {
  it('runs waves until the decomposer reports done', async () => {
    const { run } = await makeHarness();
    vi.spyOn(run as unknown as { buildCoordinator: () => void }, 'buildCoordinator').mockImplementation(() => {});
    const exec = vi.spyOn(run, 'executeWave').mockResolvedValue({ wave: 0, batch: {} as never, results: [], successCount: 1, failCount: 0, durationMs: 1, stopRequested: false });
    scriptDecomposer(run, [{ tasks: [{ id: 'x' } as TaskNode] }, { tasks: [], allDone: true }]);
    const result = await run.run();
    expect(exec).toHaveBeenCalled();
    expect(result.totalWaves).toBe(1);
    expect(result.totalCompleted).toBe(1);
    expect(result.deadlocked).toBe(false);
  });

  it('breaks and reports deadlock when no task is runnable', async () => {
    const { run } = await makeHarness();
    vi.spyOn(run as unknown as { buildCoordinator: () => void }, 'buildCoordinator').mockImplementation(() => {});
    (run as unknown as { decomposer: unknown }).decomposer = {
      isDone: () => false,
      nextBatch: () => ({ wave: 0, tasks: [], deadlocked: true, allDone: false }),
      acknowledgeBatch: () => {},
      getWaveCount: () => 0,
    };
    const result = await run.run();
    expect(result.totalWaves).toBe(0);
    expect(result.deadlocked).toBe(true);
  });

  it('breaks cleanly when the graph is already complete', async () => {
    const { run } = await makeHarness();
    vi.spyOn(run as unknown as { buildCoordinator: () => void }, 'buildCoordinator').mockImplementation(() => {});
    (run as unknown as { decomposer: unknown }).decomposer = {
      isDone: () => false,
      nextBatch: () => ({ wave: 0, tasks: [], deadlocked: false, allDone: true }),
      acknowledgeBatch: () => {},
      getWaveCount: () => 0,
    };
    const result = await run.run();
    expect(result.totalWaves).toBe(0);
  });

  it('stops after the current wave when stop() is called from onWave', async () => {
    const { run } = await makeHarness();
    let stopRun!: SddParallelRun;
    const onWave = vi.fn(() => stopRun.stop());
    const { run: r2 } = await makeHarness({ onWave });
    stopRun = r2;
    vi.spyOn(r2 as unknown as { buildCoordinator: () => void }, 'buildCoordinator').mockImplementation(() => {});
    vi.spyOn(r2, 'executeWave').mockResolvedValue({ wave: 0, batch: {} as never, results: [], successCount: 0, failCount: 0, durationMs: 1, stopRequested: false });
    scriptDecomposer(r2, [{ tasks: [{ id: 'x' } as TaskNode] }, { tasks: [{ id: 'y' } as TaskNode] }, { tasks: [], allDone: true }]);
    const result = await r2.run();
    expect(result.stopRequested).toBe(true);
    expect(onWave).toHaveBeenCalled();
    void run;
  });

  it('emits progress via onProgress', async () => {
    const onProgress = vi.fn();
    const { run } = await makeHarness({ onProgress });
    vi.spyOn(run as unknown as { buildCoordinator: () => void }, 'buildCoordinator').mockImplementation(() => {});
    vi.spyOn(run, 'executeWave').mockResolvedValue({ wave: 0, batch: {} as never, results: [], successCount: 1, failCount: 0, durationMs: 1, stopRequested: false });
    scriptDecomposer(run, [{ tasks: [{ id: 'x' } as TaskNode] }, { tasks: [], allDone: true }]);
    await run.run();
    expect(onProgress).toHaveBeenCalledWith(expect.objectContaining({ total: expect.any(Number), percent: expect.any(Number) }));
  });
});

describe('SddParallelRun — coordinator + helpers', () => {
  it('buildCoordinator wires a real coordinator and the default factory returns the main agent', async () => {
    const { run } = await makeHarness();
    (run as unknown as { buildCoordinator: () => void }).buildCoordinator();
    expect((run as unknown as { coordinator: unknown }).coordinator).not.toBeNull();
    const factory = (run as unknown as { defaultFactory: () => (c: unknown) => Promise<unknown> }).defaultFactory();
    const made = await factory({ id: 'x', name: 'x', role: 'executor' });
    expect(made).toHaveProperty('agent');
    expect(made).toHaveProperty('events');
  });

  it('uses an injected subagentFactory when provided', async () => {
    const subagentFactory = vi.fn(async () => ({ agent: fakeAgent(), events: new EventBus() }));
    const { run } = await makeHarness({ subagentFactory });
    (run as unknown as { buildCoordinator: () => void }).buildCoordinator();
    expect((run as unknown as { coordinator: unknown }).coordinator).not.toBeNull();
  });

  it('stop() flags the run and stops the coordinator', async () => {
    const { run } = await makeHarness();
    const stopAll = vi.fn();
    (run as unknown as { coordinator: unknown }).coordinator = { stopAll };
    run.stop();
    expect((run as unknown as { stopRequested: boolean }).stopRequested).toBe(true);
    expect(stopAll).toHaveBeenCalled();
  });
});
