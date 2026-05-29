import { describe, it, expect } from 'vitest';
import { PhaseOrchestrator } from '../../src/autophase/phase-orchestrator.js';
import { PhaseGraphBuilder } from '../../src/autophase/phase-graph-builder.js';
import type { PhaseExecutionContext, PhaseGraph } from '../../src/autophase/types.js';
import type { TaskNode } from '../../src/types/task-graph.js';
import type { WorktreeHandle, WorktreeManager } from '../../src/worktree/worktree-manager.js';

/**
 * Records every call and hands out one active handle per owner. `conflictOn`
 * forces `merge()` to report a conflict for matching slug hints.
 */
function fakeWorktrees(opts: { conflictOn?: (label: string) => boolean } = {}) {
  const calls: string[] = [];
  const handles = new Map<string, WorktreeHandle>();
  let liveMerges = 0;
  let maxLiveMerges = 0;
  const wm = {
    async allocate(ownerId: string, o: { slugHint?: string; ownerLabel?: string } = {}) {
      calls.push(`allocate:${ownerId}`);
      const h: WorktreeHandle = {
        id: ownerId,
        ownerId,
        ownerLabel: o.ownerLabel ?? ownerId,
        slug: o.slugHint ?? ownerId,
        dir: `/wt/${ownerId}`,
        branch: `wstack/ap/${ownerId}`,
        baseBranch: 'main',
        status: 'active',
        createdAt: 0,
        updatedAt: 0,
        insertions: 0,
        deletions: 0,
        files: 0,
      };
      handles.set(ownerId, h);
      return h;
    },
    async commitAll(h: WorktreeHandle) {
      calls.push(`commit:${h.ownerId}`);
      return { committed: true };
    },
    async merge(h: WorktreeHandle) {
      liveMerges++;
      maxLiveMerges = Math.max(maxLiveMerges, liveMerges);
      await new Promise((r) => setTimeout(r, 5));
      liveMerges--;
      const conflict = opts.conflictOn?.(h.slug) ?? false;
      calls.push(`merge:${h.ownerId}:${conflict ? 'conflict' : 'ok'}`);
      if (conflict) h.status = 'needs-review';
      return { ok: !conflict, conflict, conflictFiles: conflict ? ['x.ts'] : [] };
    },
    async release(h: WorktreeHandle, o: { keep?: boolean } = {}) {
      calls.push(`release:${h.ownerId}:${o.keep ? 'keep' : 'remove'}`);
      if (!o.keep) handles.delete(h.ownerId);
    },
    get: (id: string) => handles.get(id),
    list: () => [...handles.values()],
  };
  return { wm: wm as unknown as WorktreeManager, calls, get maxLiveMerges() { return maxLiveMerges; } };
}

describe('PhaseOrchestrator', () => {
  async function buildGraph(): Promise<PhaseGraph> {
    const builder = new PhaseGraphBuilder({
      title: 'Test Orchestrator',
      phases: [
        {
          name: 'Setup',
          description: 'Setup phase',
          priority: 'high',
          estimateHours: 1,
          parallelizable: false,
          taskTemplates: [
            { title: 'Task 1', description: 'First task', type: 'chore', priority: 'high', estimateHours: 0.5 },
            { title: 'Task 2', description: 'Second task', type: 'chore', priority: 'medium', estimateHours: 0.5 },
          ],
        },
        {
          name: 'Build',
          description: 'Build phase',
          priority: 'critical',
          estimateHours: 2,
          parallelizable: false,
          taskTemplates: [
            { title: 'Task 3', description: 'Third task', type: 'feature', priority: 'critical', estimateHours: 1 },
          ],
        },
      ],
    });
    return builder.build();
  }

  it('should start root phase and mark it running', async () => {
    const graph = await buildGraph();
    const executedTasks: string[] = [];

    const ctx: PhaseExecutionContext = {
      executeTask: async (task: TaskNode) => {
        executedTasks.push(task.title);
        await new Promise((r) => setTimeout(r, 10));
      },
    };

    const orchestrator = new PhaseOrchestrator({
      graph,
      ctx,
      autonomous: false,
      maxConcurrentTasks: 2,
    });

    await orchestrator.start();

    const phases = Array.from(graph.phases.values());
    expect(phases[0]!.status).toBe('completed');
    expect(phases[1]!.status).toBe('completed');
    expect(executedTasks).toContain('Task 1');
    expect(executedTasks).toContain('Task 2');
    expect(executedTasks).toContain('Task 3');
  });

  it('should calculate progress correctly', async () => {
    const graph = await buildGraph();

    const ctx: PhaseExecutionContext = {
      executeTask: async () => {
        await new Promise((r) => setTimeout(r, 10));
      },
    };

    const orchestrator = new PhaseOrchestrator({
      graph,
      ctx,
      autonomous: false,
    });

    await orchestrator.start();

    const progress = orchestrator.getProgress();
    expect(progress.totalPhases).toBe(2);
    expect(progress.completed).toBe(2);
    expect(progress.percentComplete).toBe(100);
    expect(progress.totalTasks).toBe(3);
    expect(progress.completedTasks).toBe(3);
  });

  it('should support pause and resume', async () => {
    const graph = await buildGraph();

    const ctx: PhaseExecutionContext = {
      executeTask: async () => {
        await new Promise((r) => setTimeout(r, 10));
      },
    };

    const orchestrator = new PhaseOrchestrator({
      graph,
      ctx,
      autonomous: false,
    });

    orchestrator.pause();
    expect(orchestrator.isPaused()).toBe(true);

    orchestrator.resume();
    expect(orchestrator.isPaused()).toBe(false);
  });

  it('should assign and release agents', async () => {
    const graph = await buildGraph();
    const phase = Array.from(graph.phases.values())[0]!;

    const orchestrator = new PhaseOrchestrator({
      graph,
      ctx: { executeTask: async () => {} },
      autonomous: false,
    });

    orchestrator.assignAgent(phase.id, 'agent-1');
    expect(phase.assignedAgents).toContain('agent-1');

    orchestrator.releaseAgent(phase.id, 'agent-1');
    expect(phase.assignedAgents).not.toContain('agent-1');
  });
});

describe('PhaseOrchestrator + worktrees', () => {
  async function buildGraph(): Promise<PhaseGraph> {
    return new PhaseGraphBuilder({
      title: 'WT Test',
      phases: [
        {
          name: 'Setup', description: '', priority: 'high', estimateHours: 1, parallelizable: false,
          taskTemplates: [{ title: 'T1', description: '', type: 'chore', priority: 'high', estimateHours: 0.5 }],
        },
        {
          name: 'Build', description: '', priority: 'critical', estimateHours: 2, parallelizable: false,
          taskTemplates: [{ title: 'T2', description: '', type: 'feature', priority: 'critical', estimateHours: 1 }],
        },
      ],
    }).build();
  }

  it('allocates one worktree per phase and runs tasks in its dir', async () => {
    const graph = await buildGraph();
    const wt = fakeWorktrees();
    const seenCwds: Array<string | undefined> = [];

    const orchestrator = new PhaseOrchestrator({
      graph,
      ctx: { executeTask: async (_t, _p, env) => { seenCwds.push(env?.cwd); } },
      worktrees: wt.wm,
      autonomous: false,
    });
    await orchestrator.start();

    const phaseIds = Array.from(graph.phases.values()).map((p) => p.id);
    for (const id of phaseIds) expect(wt.calls).toContain(`allocate:${id}`);
    // each task ran with a worktree dir, never the shared (undefined) tree
    expect(seenCwds.every((c) => typeof c === 'string' && c.startsWith('/wt/'))).toBe(true);
  });

  it('commits then merges then removes the worktree on clean completion', async () => {
    const graph = await buildGraph();
    const wt = fakeWorktrees();
    const orchestrator = new PhaseOrchestrator({
      graph,
      ctx: { executeTask: async () => {} },
      worktrees: wt.wm,
      autonomous: false,
    });
    await orchestrator.start();

    const first = Array.from(graph.phases.values())[0]!.id;
    const order = wt.calls.filter((c) => c.includes(first));
    expect(order).toEqual([
      `allocate:${first}`,
      `commit:${first}`,
      `merge:${first}:ok`,
      `release:${first}:remove`,
    ]);
  });

  it('a merge conflict keeps the worktree and does NOT fail the run', async () => {
    const graph = await buildGraph();
    const firstName = Array.from(graph.phases.values())[0]!.name;
    const wt = fakeWorktrees({ conflictOn: (slug) => slug === firstName });
    const orchestrator = new PhaseOrchestrator({
      graph,
      ctx: { executeTask: async () => {} },
      worktrees: wt.wm,
      autonomous: false,
    });
    await orchestrator.start();

    const phases = Array.from(graph.phases.values());
    // run completes; phases are not marked failed by a worktree conflict
    expect(phases.every((p) => p.status === 'completed')).toBe(true);
    const first = phases[0]!.id;
    expect(wt.calls).toContain(`merge:${first}:conflict`);
    expect(wt.calls).toContain(`release:${first}:keep`);
  });

  it('serializes merges even when phases run in parallel', async () => {
    // two parallelizable phases, concurrency 2 → distinct worktrees, serial merge
    const graph = await new PhaseGraphBuilder({
      title: 'Parallel',
      phases: [
        { name: 'A', description: '', priority: 'high', estimateHours: 1, parallelizable: true,
          taskTemplates: [{ title: 'a', description: '', type: 'chore', priority: 'high', estimateHours: 0.5 }] },
        { name: 'B', description: '', priority: 'high', estimateHours: 1, parallelizable: true,
          taskTemplates: [{ title: 'b', description: '', type: 'chore', priority: 'high', estimateHours: 0.5 }] },
      ],
    }).build();
    const wt = fakeWorktrees();
    const orchestrator = new PhaseOrchestrator({
      graph,
      ctx: { executeTask: async () => { await new Promise((r) => setTimeout(r, 5)); } },
      worktrees: wt.wm,
      autonomous: false,
      maxConcurrentPhases: 2,
    });
    await orchestrator.start();

    expect(wt.maxLiveMerges).toBe(1); // never two merges touching base at once
  });

  it('is backward compatible with a 1-arg executeTask and no worktrees', async () => {
    const graph = await buildGraph();
    let count = 0;
    const ctx: PhaseExecutionContext = { executeTask: async () => { count++; } };
    const orchestrator = new PhaseOrchestrator({ graph, ctx, autonomous: false });
    await orchestrator.start();
    expect(count).toBe(2);
    expect(Array.from(graph.phases.values()).every((p) => p.status === 'completed')).toBe(true);
  });
});
