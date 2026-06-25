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
  return { events: new EventBus(), run: vi.fn() } as never as Agent;
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
    expect((big.run as never as { slots: number }).slots).toBe(16);
    expect((big.run as never as { maxRetries: number }).maxRetries).toBe(0);
    const small = await makeHarness({ parallelSlots: 0 });
    expect((small.run as never as { slots: number }).slots).toBe(1);
  });

  it('defaults to low parallelism (2) and 3 retries so worktrees stay manageable', async () => {
    const { run } = await makeHarness();
    expect((run as never as { slots: number }).slots).toBe(2);
    expect((run as never as { maxRetries: number }).maxRetries).toBe(3);
    expect((run as never as { maxFailedSweeps: number }).maxFailedSweeps).toBe(2);
  });
});

describe('SddParallelRun.executeWave', () => {
  it('spawns, assigns, awaits and marks every task completed on success', async () => {
    const { run, tracker, t1, t2 } = await makeHarness();
    const coord = fakeCoordinator();
    (run as never as { coordinator: unknown }).coordinator = coord;
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
    (run as never as { coordinator: unknown }).coordinator = coord;
    await run.executeWave({ wave: 0, tasks: [t1], deadlocked: false, allDone: false } as never);
    // retry path → t1 re-marked pending (not failed), and the retry counter advances
    const t1After = tracker.getAllNodes().find((n) => n.id === t1.id);
    expect(t1After?.status).toBe('pending');
    expect(tracker.getAllNodes({ status: ['failed'] })).toHaveLength(0);
    expect((run as never as { retryMap: Map<string, number> }).retryMap.get(t1.id)).toBe(1);
  });

  it('re-verifies a conflict-resolved merge and reverts the base when it regresses', async () => {
    // A fake worktree manager whose merge always lands as `resolved` (i.e. the
    // conflictResolver rewrote files). verifyTask passes in the worktree (pre-
    // merge) but FAILS against the integrated base (cwd === projectRoot), so the
    // engine must revert the squash commit and fail the task — not complete it.
    const revertCalls: string[] = [];
    const fakeWorktrees = {
      allocate: vi.fn(async (ownerId: string) => ({
        id: ownerId,
        ownerId,
        status: 'active',
        dir: `/wt/${ownerId}`,
        branch: `b-${ownerId}`,
        baseBranch: 'main',
      })),
      commitAll: vi.fn(async () => {}),
      baseHead: vi.fn(async () => 'SHA0'),
      merge: vi.fn(async () => ({ ok: true, resolved: true })),
      revertBaseTo: vi.fn(async (_h: unknown, sha: string) => {
        revertCalls.push(sha);
        return true;
      }),
      release: vi.fn(async () => {}),
    };
    const verifyTask = vi.fn(async ({ cwd }: { cwd: string }) =>
      cwd === '/proj' ? { ok: false, reason: 'integration regressed' } : { ok: true },
    );

    const { run, tracker, t1 } = await makeHarness({
      maxRetries: 0,
      worktrees: fakeWorktrees,
      conflictResolver: async () => true,
      verifyTask,
    });
    (run as never as { coordinator: unknown }).coordinator = fakeCoordinator();

    const events: string[] = [];
    (run as never as { emit: (e: string, p: unknown) => void }).emit = ((e: string) => {
      events.push(e);
    }) as never;

    await run.executeWave({ wave: 0, tasks: [t1], deadlocked: false, allDone: false } as never);

    // Reverted to the captured pre-merge tip, surfaced as a verification failure,
    // and the task is NOT completed.
    expect(revertCalls).toEqual(['SHA0']);
    expect(events).toContain('sdd.task.verification_failed');
    expect(tracker.getAllNodes({ status: ['completed'] })).toHaveLength(0);
    expect(tracker.getAllNodes({ status: ['failed'] })).toHaveLength(1);
  });

  it('marks a task failed once retries are exhausted, formatting the error', async () => {
    const { run, tracker, t1 } = await makeHarness({ maxRetries: 0 });
    const coord = fakeCoordinator({
      awaitTasks: vi.fn(async (ids: string[]) => ids.map((id) => failResult(id, { kind: 'timeout', message: 'too slow', retryable: false }))),
    });
    (run as never as { coordinator: unknown }).coordinator = coord;
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
    (run as never as { coordinator: unknown }).coordinator = coord;
    const wave = await run.executeWave({ wave: 0, tasks: nodes, deadlocked: false, allDone: false } as never);
    expect(wave.failCount).toBe(2);
  });

  it('throws when a subagent spawn returns no id', async () => {
    const { run, t1 } = await makeHarness();
    (run as never as { coordinator: unknown }).coordinator = fakeCoordinator({
      spawn: vi.fn(async () => ({ subagentId: '' })),
    });
    await expect(run.executeWave({ wave: 0, tasks: [t1], deadlocked: false, allDone: false } as never)).rejects.toThrow(/spawns failed/);
  });

  it('synthesizes failed results when awaitTasks throws', async () => {
    const { run, tracker, t1 } = await makeHarness({ maxRetries: 0 });
    (run as never as { coordinator: unknown }).coordinator = fakeCoordinator({
      awaitTasks: vi.fn(async () => { throw new Error('await exploded'); }),
    });
    const wave = await run.executeWave({ wave: 0, tasks: [t1], deadlocked: false, allDone: false } as never);
    expect(wave.failCount).toBe(1);
    expect(tracker.getAllNodes({ status: ['failed'] })).toHaveLength(1);
  });

  it('throws when no coordinator has been built', async () => {
    const { run, t1 } = await makeHarness();
    (run as never as { coordinator: unknown }).coordinator = null;
    await expect(run.executeWave({ wave: 0, tasks: [t1], deadlocked: false, allDone: false } as never)).rejects.toThrow(/requires a coordinator/);
  });
});

describe('SddParallelRun — task budget guard', () => {
  it('spawns with an idle reaper and NO hard wall-clock cap by default', async () => {
    const { run, t1 } = await makeHarness();
    const configs: Array<Record<string, unknown>> = [];
    const coord = fakeCoordinator({
      spawn: vi.fn(async (c: Record<string, unknown>) => {
        configs.push(c);
        return { subagentId: c.id as string };
      }),
    });
    (run as never as { coordinator: unknown }).coordinator = coord;
    await run.executeWave({ wave: 0, tasks: [t1], deadlocked: false, allDone: false } as never);
    // Default guard is the idle reaper (resets on activity), not a 5-min wall cap
    // that hard-kills a productive task with budget_timeout.
    expect(configs[0]?.idleTimeoutMs).toBe(600_000);
    expect(configs[0]?.timeoutMs).toBeUndefined();
  });

  it('passes a hard wall-clock cap through only when taskTimeoutMs is opted in', async () => {
    const { run, t1 } = await makeHarness({ taskTimeoutMs: 120_000, taskIdleTimeoutMs: 90_000 });
    const configs: Array<Record<string, unknown>> = [];
    const coord = fakeCoordinator({
      spawn: vi.fn(async (c: Record<string, unknown>) => {
        configs.push(c);
        return { subagentId: c.id as string };
      }),
    });
    (run as never as { coordinator: unknown }).coordinator = coord;
    await run.executeWave({ wave: 0, tasks: [t1], deadlocked: false, allDone: false } as never);
    expect(configs[0]?.timeoutMs).toBe(120_000);
    expect(configs[0]?.idleTimeoutMs).toBe(90_000);
  });
});

/** Spy executeOne so the real continuous scheduler drives a real tracker/graph. */
function stubExecuteOne(
  run: SddParallelRun,
  tracker: TaskTracker,
  fn?: (task: TaskNode) => void | Promise<void>,
) {
  vi.spyOn(run as never as { buildCoordinator: () => void }, 'buildCoordinator').mockImplementation(() => {});
  return vi.spyOn(run, 'executeOne').mockImplementation(async (task: TaskNode) => {
    await fn?.(task);
    tracker.updateNodeStatus(task.id, 'completed');
    return { taskId: task.id, success: true };
  });
}

describe('SddParallelRun.run (continuous scheduler)', () => {
  it('runs every ready task until the graph settles', async () => {
    const { run, tracker } = await makeHarness();
    const exec = stubExecuteOne(run, tracker);
    const result = await run.run();
    expect(exec).toHaveBeenCalledTimes(2);
    expect(result.totalCompleted).toBe(2);
    expect(result.deadlocked).toBe(false);
    expect(result.totalWaves).toBeGreaterThanOrEqual(1);
  });

  it('respects dependencies — a dependent only starts after its blocker completes', async () => {
    const { run, tracker, t1, t2 } = await makeHarness();
    tracker.addDependency(t1.id, t2.id); // t2 depends on t1
    const order: string[] = [];
    stubExecuteOne(run, tracker, (task) => {
      order.push(task.id);
    });
    await run.run();
    expect(order).toEqual([t1.id, t2.id]);
  });

  it('runs independent tasks in parallel (both in flight at once)', async () => {
    const { run, tracker } = await makeHarness(); // t1, t2 — no edge
    let inFlight = 0;
    let maxInFlight = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    stubExecuteOne(run, tracker, async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      if (inFlight >= 2) release();
      await gate;
      inFlight--;
    });
    await run.run();
    expect(maxInFlight).toBe(2);
  });

  it('reports deadlock when an incomplete task is blocked and nothing is runnable', async () => {
    const { run, tracker, t1, t2 } = await makeHarness();
    tracker.addDependency(t1.id, t2.id); // t2 depends on t1
    tracker.updateNodeStatus(t1.id, 'blocked'); // t1 not runnable, not terminal
    const exec = stubExecuteOne(run, tracker);
    const result = await run.run();
    expect(exec).not.toHaveBeenCalled();
    expect(result.deadlocked).toBe(true);
  });

  it('stops promptly when stop() is called from onProgress', async () => {
    let stopRef!: SddParallelRun;
    const onProgress = vi.fn(() => stopRef.stop());
    const { run, tracker } = await makeHarness({ onProgress });
    stopRef = run;
    stubExecuteOne(run, tracker);
    const result = await run.run();
    expect(result.stopRequested).toBe(true);
    expect(onProgress).toHaveBeenCalled();
  });

  it('emits progress via onProgress with the expected shape', async () => {
    const onProgress = vi.fn();
    const { run, tracker } = await makeHarness({ onProgress });
    stubExecuteOne(run, tracker);
    await run.run();
    expect(onProgress).toHaveBeenCalledWith(
      expect.objectContaining({ total: expect.any(Number), percent: expect.any(Number) }),
    );
  });
});

describe('SddParallelRun — coordinator + helpers', () => {
  it('buildCoordinator wires a real coordinator and the default factory returns the main agent', async () => {
    const { run } = await makeHarness();
    (run as never as { buildCoordinator: () => void }).buildCoordinator();
    expect((run as never as { coordinator: unknown }).coordinator).not.toBeNull();
    const factory = (run as never as { defaultFactory: () => (c: unknown) => Promise<unknown> }).defaultFactory();
    const made = await factory({ id: 'x', name: 'x', role: 'executor' });
    expect(made).toHaveProperty('agent');
    expect(made).toHaveProperty('events');
  });

  it('uses an injected subagentFactory when provided', async () => {
    const subagentFactory = vi.fn(async () => ({ agent: fakeAgent(), events: new EventBus() }));
    const { run } = await makeHarness({ subagentFactory });
    (run as never as { buildCoordinator: () => void }).buildCoordinator();
    expect((run as never as { coordinator: unknown }).coordinator).not.toBeNull();
  });

  it('stop() flags the run and stops the coordinator', async () => {
    const { run } = await makeHarness();
    const stopAll = vi.fn();
    (run as never as { coordinator: unknown }).coordinator = { stopAll };
    run.stop();
    expect((run as never as { stopRequested: boolean }).stopRequested).toBe(true);
    expect(stopAll).toHaveBeenCalled();
  });
});

function fakeWorktrees(opts: { merge?: () => { ok: boolean; conflict?: boolean; conflictFiles?: string[] } } = {}) {
  const calls: string[] = [];
  const wm = {
    async allocate(ownerId: string, o: { slugHint?: string; ownerLabel?: string } = {}) {
      calls.push(`allocate:${ownerId}`);
      return {
        id: ownerId,
        ownerId,
        ownerLabel: o.ownerLabel ?? ownerId,
        slug: o.slugHint ?? ownerId,
        dir: `/wt/${ownerId}`,
        branch: `wstack/sdd/${ownerId}`,
        baseBranch: 'main',
        status: 'active',
        createdAt: 0,
        updatedAt: 0,
        insertions: 0,
        deletions: 0,
        files: 0,
      };
    },
    async commitAll(h: { ownerId: string }) {
      calls.push(`commit:${h.ownerId}`);
      return { committed: true };
    },
    async merge(h: { ownerId: string }) {
      calls.push(`merge:${h.ownerId}`);
      return opts.merge ? opts.merge() : { ok: true, conflictFiles: [] };
    },
    async release(h: { ownerId: string }, o: { keep?: boolean } = {}) {
      calls.push(`release:${h.ownerId}:${o.keep ? 'keep' : 'remove'}`);
    },
    list: () => [],
  };
  return { wm: wm as never, calls };
}

describe('SddParallelRun — Layer 2: worktree isolation', () => {
  it('allocates a worktree per task, spawns into it, and squash-merges on success', async () => {
    const wt = fakeWorktrees();
    const { run, tracker, t1, t2 } = await makeHarness({ worktrees: wt.wm });
    const spawnConfigs: Array<{ id: string; cwd?: string }> = [];
    const coord = fakeCoordinator({
      spawn: vi.fn(async (c: { id: string; cwd?: string }) => {
        spawnConfigs.push(c);
        return { subagentId: c.id };
      }),
    });
    (run as never as { coordinator: unknown }).coordinator = coord;

    await run.executeWave({ wave: 0, tasks: [t1, t2], deadlocked: false, allDone: false } as never);

    // One worktree allocated per task, each spawn pointed at its worktree dir.
    expect(wt.calls).toContain(`allocate:sdd-${t1.id}`);
    expect(wt.calls).toContain(`allocate:sdd-${t2.id}`);
    expect(spawnConfigs.every((c) => c.cwd?.startsWith('/wt/sdd-'))).toBe(true);
    // Success → commit + merge + remove.
    expect(wt.calls).toContain(`merge:sdd-${t1.id}`);
    expect(wt.calls).toContain(`release:sdd-${t1.id}:remove`);
    // Branch surfaced on the node metadata for the board.
    expect((tracker.getNode(t1.id)?.metadata as { worktreeBranch?: string })?.worktreeBranch).toBe(
      `wstack/sdd/sdd-${t1.id}`,
    );
  });

  it('a merge conflict does not complete the task — terminal-fails + emits sdd.task.conflict', async () => {
    const events = new EventBus();
    const seen: string[] = [];
    events.on('sdd.task.conflict', () => seen.push('conflict'));
    events.on('sdd.task.completed', () => seen.push('completed'));
    const wt = fakeWorktrees({ merge: () => ({ ok: false, conflict: true, conflictFiles: ['src/x.ts'] }) });
    const { run, tracker, t1 } = await makeHarness({ worktrees: wt.wm, maxRetries: 0, events });
    (run as never as { coordinator: unknown }).coordinator = fakeCoordinator();
    await run.executeWave({ wave: 0, tasks: [t1], deadlocked: false, allDone: false } as never);
    expect(tracker.getNode(t1.id)?.status).toBe('failed'); // never 'completed'
    expect(seen).toContain('conflict');
    expect(seen).not.toContain('completed');
  });

  it('a merge conflict with retries left requeues to pending (fresh-base retry)', async () => {
    const wt = fakeWorktrees({ merge: () => ({ ok: false, conflict: true, conflictFiles: ['x'] }) });
    const { run, tracker, t1 } = await makeHarness({ worktrees: wt.wm, maxRetries: 2 });
    (run as never as { coordinator: unknown }).coordinator = fakeCoordinator();
    await run.executeWave({ wave: 0, tasks: [t1], deadlocked: false, allDone: false } as never);
    expect(tracker.getNode(t1.id)?.status).toBe('pending');
  });

  it('discards a failed task worktree (no merge, no pile-up)', async () => {
    const wt = fakeWorktrees();
    const { run, t1 } = await makeHarness({ worktrees: wt.wm, maxRetries: 0 });
    const coord = fakeCoordinator({ awaitTasks: vi.fn(async (ids: string[]) => ids.map((id) => failResult(id))) });
    (run as never as { coordinator: unknown }).coordinator = coord;
    await run.executeWave({ wave: 0, tasks: [t1], deadlocked: false, allDone: false } as never);
    // Failed checkout is discarded (keep:false) so worktrees don't accumulate;
    // a genuine merge-conflict handle would be force-kept by the manager itself.
    expect(wt.calls).toContain(`release:sdd-${t1.id}:remove`);
    expect(wt.calls.some((c) => c.startsWith(`merge:sdd-${t1.id}`))).toBe(false);
  });
});

describe('SddParallelRun — Layer 2: robustness', () => {
  it('resetOrphans returns interrupted in_progress tasks to pending', async () => {
    const { tracker, t1 } = await makeHarness();
    tracker.updateNodeStatus(t1.id, 'in_progress');
    const n = SddParallelRun.resetOrphans(tracker);
    expect(n).toBe(1);
    expect(tracker.getNode(t1.id)?.status).toBe('pending');
  });

  it('recoverFailedBlockers requeues a failed task that blocks a dependent', async () => {
    const { run, tracker, t1, t2 } = await makeHarness();
    tracker.addEdge(t1.id, t2.id, 'depends_on'); // t1 blocks t2
    tracker.updateNodeStatus(t1.id, 'failed');
    tracker.updateNodeStatus(t2.id, 'blocked');
    const recovered = (run as never as { recoverFailedBlockers: () => boolean }).recoverFailedBlockers();
    expect(recovered).toBe(true);
    expect(tracker.getNode(t1.id)?.status).toBe('pending');
  });

  it('restoreRetryMap rehydrates retry counts from node metadata (resume)', async () => {
    const { run, tracker, t1 } = await makeHarness();
    const node = tracker.getNode(t1.id)!;
    node.metadata = { retries: 2 };
    (run as never as { restoreRetryMap: () => void }).restoreRetryMap();
    expect((run as never as { retryMap: Map<string, number> }).retryMap.get(t1.id)).toBe(2);
  });

  it('the dispatch backstop guarantees termination when a task never settles', async () => {
    const { run, tracker } = await makeHarness({ maxTotalWaves: 3, maxRetries: 100 });
    vi.spyOn(run as never as { buildCoordinator: () => void }, 'buildCoordinator').mockImplementation(() => {});
    // Re-queues itself forever — only the dispatch backstop can end the run.
    vi.spyOn(run, 'executeOne').mockImplementation(async (task: TaskNode) => {
      tracker.updateNodeStatus(task.id, 'pending');
      return { taskId: task.id, success: false };
    });
    const result = await run.run();
    expect(result.totalCompleted).toBe(0);
    expect(result.totalWaves).toBeLessThanOrEqual(3); // bounded, not infinite
  });
});

describe('SddParallelRun — task controls (model / cancel / delete)', () => {
  it('setTaskModel + setTaskFallbacks patch node metadata for the next dispatch', async () => {
    const { run, tracker, t1 } = await makeHarness();
    expect(run.setTaskModel(t1.id, 'claude-opus-4-8', 'anthropic')).toBe(true);
    expect(run.setTaskFallbacks(t1.id, ['anthropic/claude-haiku-4-5'])).toBe(true);
    const m = tracker.getNode(t1.id)!.metadata!;
    expect(m.model).toBe('claude-opus-4-8');
    expect(m.provider).toBe('anthropic');
    expect(m.fallbackModels).toEqual(['anthropic/claude-haiku-4-5']);
  });

  it('setTaskModel returns false for an unknown task', async () => {
    const { run } = await makeHarness();
    expect(run.setTaskModel('nope', 'x')).toBe(false);
  });

  it('setTaskVerification sets/clears the completion-gate command (trimmed)', async () => {
    const { run, tracker, t1 } = await makeHarness();
    expect(run.setTaskVerification(t1.id, '  pnpm vitest run x  ')).toBe(true);
    expect(tracker.getNode(t1.id)!.metadata!.verificationCommand).toBe('pnpm vitest run x');
    // Empty / whitespace clears it.
    expect(run.setTaskVerification(t1.id, '   ')).toBe(true);
    expect(tracker.getNode(t1.id)!.metadata!.verificationCommand).toBeUndefined();
    expect(run.setTaskVerification('nope', 'x')).toBe(false);
  });

  it('cancelTask marks a not-running task terminal-cancelled', async () => {
    const { run, tracker, t1 } = await makeHarness();
    expect(await run.cancelTask(t1.id)).toBe(true);
    const n = tracker.getNode(t1.id)!;
    expect(n.status).toBe('failed');
    expect(n.metadata?.cancelled).toBe(true);
  });

  it('cancelTask aborts the live subagent of a running task', async () => {
    const { run, tracker, t1 } = await makeHarness();
    const stop = vi.fn(async () => {});
    (run as never as { coordinator: unknown }).coordinator = { stop };
    (run as never as { taskSubagents: Map<string, string> }).taskSubagents.set(t1.id, 'sub-1');
    expect(await run.cancelTask(t1.id)).toBe(true);
    expect(stop).toHaveBeenCalledWith('sub-1');
    expect(tracker.getNode(t1.id)?.metadata?.cancelled).toBe(true);
  });

  it('cancelTask returns false for an unknown task', async () => {
    const { run } = await makeHarness();
    expect(await run.cancelTask('nope')).toBe(false);
  });

  it('retryTask clears the cancel marker and re-queues to pending', async () => {
    const { run, tracker, t1 } = await makeHarness();
    await run.cancelTask(t1.id);
    expect(run.retryTask(t1.id)).toBe(true);
    const n = tracker.getNode(t1.id)!;
    expect(n.status).toBe('pending');
    expect(n.metadata?.cancelled).toBeFalsy();
  });

  it('deleteTask removes a pending task and unblocks its dependents', async () => {
    const { run, tracker, t1, t2 } = await makeHarness();
    tracker.addDependency(t1.id, t2.id); // t2 depends on t1
    expect(tracker.canStart(t2.id)).toBe(false);
    expect(run.deleteTask(t1.id)).toBe(true);
    expect(tracker.getNode(t1.id)).toBeUndefined();
    expect(tracker.getBlockers(t2.id)).toEqual([]);
    expect(tracker.canStart(t2.id)).toBe(true); // blocker gone → runnable
  });

  it('deleteTask refuses a running task', async () => {
    const { run, tracker, t1 } = await makeHarness();
    tracker.updateNodeStatus(t1.id, 'in_progress');
    expect(run.deleteTask(t1.id)).toBe(false);
    expect(tracker.getNode(t1.id)).toBeTruthy();
  });
});

describe('SddParallelRun — failed-task retry', () => {
  /** Drive the real scheduler with a stubbed executeOne whose verdict we control. */
  function stubExecuteOneWith(
    run: SddParallelRun,
    tracker: TaskTracker,
    verdict: (task: TaskNode, attempt: number) => 'pass' | 'fail',
  ) {
    const attempts = new Map<string, number>();
    vi.spyOn(run as never as { buildCoordinator: () => void }, 'buildCoordinator').mockImplementation(() => {});
    return vi.spyOn(run, 'executeOne').mockImplementation(async (task: TaskNode) => {
      const n = (attempts.get(task.id) ?? 0) + 1;
      attempts.set(task.id, n);
      if (verdict(task, n) === 'fail') {
        tracker.updateNodeStatus(task.id, 'failed', 'boom');
        return { taskId: task.id, success: false };
      }
      tracker.updateNodeStatus(task.id, 'completed');
      return { taskId: task.id, success: true };
    });
  }

  it('auto-retries a failed task in the end-of-run sweep until it completes', async () => {
    const { run, tracker, t1 } = await makeHarness();
    // t1 fails its first dispatch, then succeeds; t2 always passes.
    stubExecuteOneWith(run, tracker, (task, attempt) =>
      task.id === t1.id && attempt === 1 ? 'fail' : 'pass',
    );
    const result = await run.run();
    expect(result.totalCompleted).toBe(2);
    expect(result.totalFailed).toBe(0);
    expect(tracker.getNode(t1.id)?.status).toBe('completed');
  });

  it('bounds the sweep — a hopeless task ends failed and is dispatched a finite number of times', async () => {
    const { run, tracker, t1 } = await makeHarness({ maxFailedRetrySweeps: 2 });
    let t1Dispatches = 0;
    stubExecuteOneWith(run, tracker, (task) => {
      if (task.id === t1.id) {
        t1Dispatches++;
        return 'fail';
      }
      return 'pass';
    });
    const result = await run.run();
    expect(tracker.getNode(t1.id)?.status).toBe('failed');
    expect(result.totalFailed).toBe(1);
    // Initial dispatch + exactly one fruitless sweep: the no-progress guard stops
    // re-sweeping once a sweep yields no new completions (even though 2 are allowed).
    expect(t1Dispatches).toBe(2);
  });

  it('retryAllFailed requeues failed tasks (incl. cancelled) to pending and returns the count', async () => {
    const { run, tracker, t1, t2 } = await makeHarness();
    tracker.updateNodeStatus(t1.id, 'failed', 'boom');
    // t2: terminally failed + cancelled marker (user cancelled it).
    tracker.updateNodeStatus(t2.id, 'failed', 'cancelled');
    tracker.patchMetadata(t2.id, { cancelled: true });
    (run as never as { cancelledTasks: Set<string> }).cancelledTasks.add(t2.id);

    const n = run.retryAllFailed();
    expect(n).toBe(2);
    expect(tracker.getNode(t1.id)?.status).toBe('pending');
    expect(tracker.getNode(t2.id)?.status).toBe('pending');
    expect(tracker.getNode(t2.id)?.metadata?.cancelled).toBeFalsy();
  });

  it('the automatic sweep skips cancelled tasks (only the manual button resurrects them)', async () => {
    const { run, tracker, t1 } = await makeHarness();
    tracker.updateNodeStatus(t1.id, 'failed', 'cancelled');
    tracker.patchMetadata(t1.id, { cancelled: true });
    const n = (run as never as { requeueFailedTasks: (reason?: string) => number }).requeueFailedTasks();
    expect(n).toBe(0);
    expect(tracker.getNode(t1.id)?.status).toBe('failed');
  });
});

describe('SddParallelRun — completion gate (verification)', () => {
  it('does NOT complete a task whose verification gate fails — routes to failure path', async () => {
    const events = new EventBus();
    const seen: string[] = [];
    events.on('sdd.task.verification_failed', () => seen.push('verif_failed'));
    events.on('sdd.task.completed', () => seen.push('completed'));
    const verifyTask = vi.fn(async () => ({ ok: false, reason: 'tests failed' }));
    const { run, tracker, t1 } = await makeHarness({ maxRetries: 0, events, verifyTask });
    (run as never as { coordinator: unknown }).coordinator = fakeCoordinator(); // worker reports success
    await run.executeWave({ wave: 0, tasks: [t1], deadlocked: false, allDone: false } as never);
    expect(verifyTask).toHaveBeenCalledTimes(1);
    expect(tracker.getNode(t1.id)?.status).toBe('failed'); // gate rejected the false success
    expect(seen).toContain('verif_failed');
    expect(seen).not.toContain('completed');
  });

  it('completes when the verification gate passes', async () => {
    const verifyTask = vi.fn(async () => ({ ok: true }));
    const { run, tracker, t1 } = await makeHarness({ verifyTask });
    (run as never as { coordinator: unknown }).coordinator = fakeCoordinator();
    await run.executeWave({ wave: 0, tasks: [t1], deadlocked: false, allDone: false } as never);
    expect(verifyTask).toHaveBeenCalledTimes(1);
    expect(tracker.getNode(t1.id)?.status).toBe('completed');
  });

  it('a failing verifier with retries left requeues to pending', async () => {
    const verifyTask = vi.fn(async () => ({ ok: false, reason: 'nope' }));
    const { run, tracker, t1 } = await makeHarness({ maxRetries: 2, verifyTask });
    (run as never as { coordinator: unknown }).coordinator = fakeCoordinator();
    await run.executeWave({ wave: 0, tasks: [t1], deadlocked: false, allDone: false } as never);
    expect(tracker.getNode(t1.id)?.status).toBe('pending');
  });

  it('no verifier configured → success completes as before (no-op gate)', async () => {
    const { run, tracker, t1 } = await makeHarness();
    (run as never as { coordinator: unknown }).coordinator = fakeCoordinator();
    await run.executeWave({ wave: 0, tasks: [t1], deadlocked: false, allDone: false } as never);
    expect(tracker.getNode(t1.id)?.status).toBe('completed');
  });
});

describe('SddParallelRun — splitTask', () => {
  it('splits a task into leaves, rewires deps, and completes the parent container', async () => {
    const { run, tracker, t1, t2 } = await makeHarness();
    tracker.addDependency(t1.id, t2.id); // t2 depends on t1
    const leaves = run.splitTask(t1.id, [
      { title: 'L1', description: 'part 1' },
      { title: 'L2', description: 'part 2' },
    ]);
    expect(leaves).toHaveLength(2);
    // Parent becomes a completed container.
    expect(tracker.getNode(t1.id)?.status).toBe('completed');
    // The former dependent (t2) now waits on every leaf.
    const t2Blockers = tracker.getBlockers(t2.id);
    for (const leaf of leaves) expect(t2Blockers).toContain(leaf);
    // Leaves carry the parent id and start pending.
    for (const leaf of leaves) {
      expect(tracker.getNode(leaf)?.parentId).toBe(t1.id);
      expect(tracker.getNode(leaf)?.status).toBe('pending');
    }
  });

  it('leaves inherit the parent\'s blockers', async () => {
    const { run, tracker, t1, t2 } = await makeHarness();
    tracker.addDependency(t1.id, t2.id); // t2 depends on t1
    const leaves = run.splitTask(t2.id, [{ title: 'L', description: 'd' }]);
    expect(tracker.getBlockers(leaves[0]!)).toContain(t1.id); // leaf inherits t2's blocker
  });

  it('refuses to split a running task and an empty subtask list', async () => {
    const { run, tracker, t1 } = await makeHarness();
    expect(run.splitTask(t1.id, [])).toEqual([]);
    tracker.updateNodeStatus(t1.id, 'in_progress');
    expect(run.splitTask(t1.id, [{ title: 'X', description: 'y' }])).toEqual([]);
  });
});

describe('SddParallelRun — failure supervisor', () => {
  // Drive applyTaskFailure directly (private) with retries already exhausted.
  function makeFailing(overrides: Record<string, unknown> = {}) {
    return makeHarness({ maxRetries: 0, ...overrides });
  }
  const callFailure = (run: SddParallelRun, taskId: string) =>
    (run as never as { applyTaskFailure: (id: string, sid: string, msg: string) => Promise<void> }).applyTaskFailure(
      taskId,
      'sub',
      'boom',
    );

  it('a retry verdict requeues the task instead of failing it', async () => {
    const superviseFailure = vi.fn(async () => ({ action: 'retry' as const }));
    const { run, tracker, t1 } = await makeFailing({ superviseFailure });
    await callFailure(run, t1.id);
    expect(superviseFailure).toHaveBeenCalledTimes(1);
    expect(tracker.getNode(t1.id)?.status).toBe('pending');
  });

  it('a reassign verdict swaps the model and requeues', async () => {
    const superviseFailure = vi.fn(async () => ({ action: 'reassign' as const, model: 'claude-haiku-4-5' }));
    const { run, tracker, t1 } = await makeFailing({ superviseFailure });
    await callFailure(run, t1.id);
    expect(tracker.getNode(t1.id)?.status).toBe('pending');
    expect(tracker.getNode(t1.id)?.metadata?.model).toBe('claude-haiku-4-5');
  });

  it('a split verdict splits the task (parent completed)', async () => {
    const superviseFailure = vi.fn(async () => ({
      action: 'split' as const,
      subtasks: [{ title: 'A', description: 'a' }, { title: 'B', description: 'b' }],
    }));
    const { run, tracker, t1 } = await makeFailing({ superviseFailure });
    await callFailure(run, t1.id);
    expect(tracker.getNode(t1.id)?.status).toBe('completed'); // container
    expect(tracker.getAllNodes().filter((n) => n.parentId === t1.id)).toHaveLength(2);
  });

  it('a fail verdict (or none) lets the task terminal-fail', async () => {
    const superviseFailure = vi.fn(async () => ({ action: 'fail' as const }));
    const { run, tracker, t1 } = await makeFailing({ superviseFailure });
    await callFailure(run, t1.id);
    expect(tracker.getNode(t1.id)?.status).toBe('failed');
  });

  it('bounds supervisor rescues per task (maxSupervisorEscalations) so it cannot loop forever', async () => {
    const superviseFailure = vi.fn(async () => ({ action: 'retry' as const }));
    const { run, tracker, t1 } = await makeFailing({ superviseFailure, maxSupervisorEscalations: 1 });
    await callFailure(run, t1.id); // rescue #1 → pending
    expect(tracker.getNode(t1.id)?.status).toBe('pending');
    await callFailure(run, t1.id); // cap reached → terminal fail
    expect(tracker.getNode(t1.id)?.status).toBe('failed');
    expect(superviseFailure).toHaveBeenCalledTimes(1); // not consulted again past the cap
  });

  it('no supervisor configured → terminal-fails exactly as before', async () => {
    const { run, tracker, t1 } = await makeFailing();
    await callFailure(run, t1.id);
    expect(tracker.getNode(t1.id)?.status).toBe('failed');
  });
});
