import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { EventBus } from '../../src/kernel/events.js';
import { DefaultTaskStore } from '../../src/sdd/task-generator.js';
import { SddBoardProjector } from '../../src/sdd/sdd-board-projector.js';
import { SddBoardStore } from '../../src/sdd/sdd-board-store.js';
import { TaskTracker, type TaskTrackerChange } from '../../src/sdd/task-tracker.js';
import type { TaskGraph, TaskNode } from '../../src/types/task-graph.js';

function node(id: string, over: Partial<TaskNode> = {}): TaskNode {
  return {
    id,
    title: id,
    description: '',
    type: 'feature',
    priority: 'medium',
    status: 'pending',
    createdAt: 0,
    updatedAt: 0,
    ...over,
  };
}

function graph(): TaskGraph {
  return {
    id: 'g1',
    specId: 's1',
    title: 'G',
    nodes: new Map([
      ['a', node('a', { createdAt: 1 })],
      ['b', node('b', { createdAt: 2 })],
    ]),
    edges: [{ id: 'e1', from: 'a', to: 'b', type: 'depends_on' }],
    rootNodes: ['a'],
    createdAt: 0,
    updatedAt: 0,
  };
}

function makeTracker(g: TaskGraph): TaskTracker {
  const t = new TaskTracker({ store: new DefaultTaskStore() });
  t.setGraph(g);
  return t;
}

describe('TaskTracker.subscribe', () => {
  it('fires status_changed with a transition', () => {
    const t = makeTracker(graph());
    const changes: TaskTrackerChange[] = [];
    t.subscribe((c) => changes.push(c));
    t.updateNodeStatus('a', 'in_progress');
    expect(changes).toHaveLength(1);
    expect(changes[0]!.type).toBe('status_changed');
    expect(changes[0]!.transition).toMatchObject({ from: 'pending', to: 'in_progress' });
  });

  it('fires node_updated on assignee change and unsubscribes cleanly', () => {
    const t = makeTracker(graph());
    const changes: TaskTrackerChange[] = [];
    const off = t.subscribe((c) => changes.push(c));
    t.updateNode('a', { assignee: 'Tesla' });
    expect(changes.at(-1)?.type).toBe('node_updated');
    off();
    t.updateNodeStatus('a', 'completed');
    expect(changes).toHaveLength(1); // no more after unsubscribe
  });

  it('a throwing listener never breaks the mutation', () => {
    const t = makeTracker(graph());
    t.subscribe(() => {
      throw new Error('boom');
    });
    expect(() => t.updateNodeStatus('a', 'completed')).not.toThrow();
    expect(t.getNode('a')?.status).toBe('completed');
  });
});

describe('SddBoardProjector', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sdd-proj-'));
  const store = new SddBoardStore({ baseDir: dir });

  afterAll(async () => {
    const { rm } = await import('node:fs/promises');
    await rm(dir, { recursive: true, force: true });
  });

  it('builds a live snapshot from tracker state + run events', () => {
    const g = graph();
    const tracker = makeTracker(g);
    const events = new EventBus();
    const snapshots: Array<{ runId: string; snapshot: { status: string } }> = [];
    (events.on as (e: string, h: (p: unknown) => void) => void)('sdd.board.snapshot', (p) =>
      snapshots.push(p as { runId: string; snapshot: { status: string } }),
    );

    const proj = new SddBoardProjector({ runId: 'r1', graph: g, tracker, events, store });

    events.emit('sdd.run.started', { runId: 'r1', graphId: 'g1', specId: 's1', total: 2 });
    tracker.updateNodeStatus('a', 'completed');

    // On-demand snapshot reflects live tracker state.
    const live = proj.snapshot();
    expect(live.status).toBe('running');
    expect(live.progress.completed).toBe(1);
    expect(live.tasks.find((t) => t.id === 'b')?.displayStatus).toBe('queued');

    proj.dispose();
  });

  it('accumulates a live activity feed from task lifecycle events (most recent first)', () => {
    const g = graph();
    const tracker = makeTracker(g);
    const events = new EventBus();
    const proj = new SddBoardProjector({ runId: 'rf', graph: g, tracker, events, store });

    events.emit('sdd.run.started', { runId: 'rf', graphId: 'g1', specId: 's1', total: 2 });
    events.emit('sdd.wave', { runId: 'rf', wave: 0, batchSize: 2 });
    events.emit('sdd.task.started', { runId: 'rf', taskId: 'a', subagentId: 's', agentName: 'Newton' });
    tracker.updateNodeStatus('a', 'completed');
    events.emit('sdd.task.completed', { runId: 'rf', taskId: 'a', subagentId: 's', durationMs: 2500 });

    const feed = proj.snapshot().feed ?? [];
    expect(feed.length).toBeGreaterThanOrEqual(3);
    expect(feed[0]?.kind).toBe('completed'); // newest first
    expect(feed.some((f) => f.kind === 'started' && f.agentName === 'Newton')).toBe(true);
    expect(feed.some((f) => f.kind === 'wave')).toBe(true);
    // Scoped by runId — a different run's event is ignored.
    events.emit('sdd.task.failed', { runId: 'OTHER', taskId: 'a', subagentId: 's', error: 'x' });
    expect(proj.snapshot().feed?.some((f) => f.kind === 'failed')).toBe(false);

    proj.dispose();
  });

  it('narrates the robustness events (verification / conflict / split / supervisor)', () => {
    const g = graph();
    const tracker = makeTracker(g);
    const events = new EventBus();
    const proj = new SddBoardProjector({ runId: 'rr', graph: g, tracker, events, store });

    events.emit('sdd.run.started', { runId: 'rr', graphId: 'g1', specId: 's1', total: 2 });
    events.emit('sdd.task.verification_failed', { runId: 'rr', taskId: 'a', reason: 'tests failed' });
    events.emit('sdd.task.conflict', { runId: 'rr', taskId: 'a', conflictFiles: ['src/x.ts', 'src/y.ts'] });
    events.emit('sdd.task.split', { runId: 'rr', taskId: 'a', subtaskIds: ['a1', 'a2', 'a3'] });
    events.emit('sdd.supervisor.decision', {
      runId: 'rr',
      taskId: 'a',
      action: 'reassign',
      rationale: 'try a stronger model',
    });

    const feed = proj.snapshot().feed ?? [];
    const verify = feed.find((f) => f.kind === 'verification_failed');
    expect(verify?.text).toContain('tests failed');
    const conflict = feed.find((f) => f.kind === 'conflict');
    expect(conflict?.text).toContain('2 file(s)');
    expect(conflict?.text).toContain('src/x.ts');
    expect(feed.find((f) => f.kind === 'split')?.text).toContain('3 sub-task(s)');
    const sup = feed.find((f) => f.kind === 'supervisor');
    expect(sup?.text).toContain('reassign');
    expect(sup?.text).toContain('try a stronger model');

    // Scoped by runId — another run's robustness event is ignored.
    events.emit('sdd.task.split', { runId: 'OTHER', taskId: 'a', subtaskIds: ['z'] });
    expect(proj.snapshot().feed?.filter((f) => f.kind === 'split').length).toBe(1);

    proj.dispose();
  });

  it('finalizes + persists on run.finished', async () => {
    const g = graph();
    const tracker = makeTracker(g);
    const events = new EventBus();
    const proj = new SddBoardProjector({ runId: 'r2', graph: g, tracker, events, store });

    events.emit('sdd.run.started', { runId: 'r2', graphId: 'g1', specId: 's1', total: 2 });
    tracker.updateNodeStatus('a', 'completed');
    tracker.updateNodeStatus('b', 'completed');
    events.emit('sdd.run.finished', { runId: 'r2', deadlocked: false, completed: 2, failed: 0, stopped: false });

    await proj.drain();
    const saved = await store.load('r2');
    expect(saved?.status).toBe('completed');
    expect(saved?.progress.completed).toBe(2);
    proj.dispose();
  });

  it('marks deadlocked + records blocking chains (as short ids)', async () => {
    const g = graph();
    const tracker = makeTracker(g);
    const events = new EventBus();
    const proj = new SddBoardProjector({ runId: 'r3', graph: g, tracker, events, store });

    events.emit('sdd.run.started', { runId: 'r3', graphId: 'g1', specId: 's1', total: 2 });
    tracker.updateNodeStatus('a', 'failed');
    // b is blocked by failed a → deadlock chain
    events.emit('sdd.deadlock', { runId: 'r3', chains: [{ blocked: 'b', blockedBy: ['a'] }] });
    events.emit('sdd.run.finished', { runId: 'r3', deadlocked: true, completed: 0, failed: 1, stopped: false });

    await proj.drain();
    const saved = await store.load('r3');
    expect(saved?.status).toBe('deadlocked');
    expect(saved?.diagnostics?.deadlockChains).toEqual([{ blocked: 't02', blockedBy: ['t01'] }]);
    proj.dispose();
  });

  it('ignores events for a different run id', () => {
    const g = graph();
    const tracker = makeTracker(g);
    const events = new EventBus();
    const proj = new SddBoardProjector({ runId: 'r4', graph: g, tracker, events, store });
    events.emit('sdd.wave', { runId: 'OTHER', wave: 9, batchSize: 1 });
    expect(proj.snapshot().wave).toBe(0);
    proj.dispose();
  });
});
