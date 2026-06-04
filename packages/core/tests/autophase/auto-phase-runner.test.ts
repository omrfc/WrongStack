import { describe, expect, it } from 'vitest';
import { AutoPhaseRunner } from '../../src/autophase/auto-phase-runner.js';
import type { PhaseTemplate } from '../../src/autophase/types.js';
import type { WorktreeHandle, WorktreeManager } from '../../src/worktree/worktree-manager.js';

function fakeWorktrees() {
  const calls: string[] = [];
  const handles = new Map<string, WorktreeHandle>();
  const wm = {
    async allocate(ownerId: string, opts: { slugHint?: string; ownerLabel?: string } = {}) {
      calls.push(`allocate:${ownerId}`);
      const handle: WorktreeHandle = {
        id: ownerId,
        ownerId,
        ownerLabel: opts.ownerLabel ?? ownerId,
        slug: opts.slugHint ?? ownerId,
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
      handles.set(ownerId, handle);
      return handle;
    },
    async commitAll(handle: WorktreeHandle) {
      calls.push(`commit:${handle.ownerId}`);
      return { committed: true };
    },
    async merge(handle: WorktreeHandle) {
      calls.push(`merge:${handle.ownerId}`);
      handle.status = 'merged';
      return { ok: true };
    },
    async release(handle: WorktreeHandle, opts: { keep?: boolean } = {}) {
      calls.push(`release:${handle.ownerId}:${opts.keep ? 'keep' : 'remove'}`);
      if (!opts.keep) handles.delete(handle.ownerId);
    },
    get: (id: string) => handles.get(id),
    list: () => [...handles.values()],
  };
  return { wm: wm as unknown as WorktreeManager, calls };
}

function phases(): PhaseTemplate[] {
  return [
    {
      name: 'Build',
      description: 'Build the feature',
      priority: 'high',
      estimateHours: 1,
      parallelizable: false,
      taskTemplates: [
        {
          title: 'Implement feature',
          description: 'Make the change',
          type: 'feature',
          priority: 'high',
          estimateHours: 1,
        },
      ],
    },
  ];
}

describe('AutoPhaseRunner', () => {
  it('forwards worktree env and verification hooks to the orchestrator', async () => {
    const wt = fakeWorktrees();
    const taskCwds: Array<string | undefined> = [];
    const verifyCwds: Array<string | undefined> = [];

    const runner = new AutoPhaseRunner({
      title: 'Runner propagation',
      phases: phases(),
      worktrees: wt.wm,
      executeTask: async (_task, _phaseId, env) => {
        taskCwds.push(env?.cwd);
      },
      verifyPhase: async (_phase, env) => {
        verifyCwds.push(env?.cwd);
        return { ok: true };
      },
    });

    const graph = await runner.start();
    const phaseId = Array.from(graph.phases.keys())[0]!;

    expect(taskCwds).toEqual([`/wt/${phaseId}`]);
    expect(verifyCwds).toEqual([`/wt/${phaseId}`]);
    expect(wt.calls).toContain(`allocate:${phaseId}`);
    expect(wt.calls).toContain(`commit:${phaseId}`);
    expect(wt.calls).toContain(`merge:${phaseId}`);
    expect(wt.calls).toContain(`release:${phaseId}:remove`);
  });

  it('forwards maxVerifyAttempts and repairPhase', async () => {
    let verifies = 0;
    let repairs = 0;

    const runner = new AutoPhaseRunner({
      title: 'Runner repair',
      phases: phases(),
      maxVerifyAttempts: 1,
      executeTask: async () => {},
      verifyPhase: async () => {
        verifies++;
        return verifies === 1 ? { ok: false, output: 'broken' } : { ok: true };
      },
      repairPhase: async () => {
        repairs++;
      },
    });

    const graph = await runner.start();
    const phase = Array.from(graph.phases.values())[0]!;

    expect(phase.status).toBe('completed');
    expect(verifies).toBe(2);
    expect(repairs).toBe(1);
  });
});
