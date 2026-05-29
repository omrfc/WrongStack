import { describe, expect, it } from 'vitest';
import { EventBus } from '@wrongstack/core';
import { WorktreeWebSocketHandler } from '../../src/server/worktree-ws-handler.js';
import { deriveWorktreeGraph } from '../../src/components/WorktreeGraph.js';
import type { WorktreeHandleView } from '../../src/types.js';

/** Minimal ws stub capturing sent JSON messages. */
function fakeWs() {
  const sent: any[] = [];
  return {
    readyState: 1,
    send: (data: string) => sent.push(JSON.parse(data)),
    on: () => {},
    sent,
  } as any;
}

const noopLogger = { info() {}, warn() {}, error() {}, debug() {} } as any;

function lastState(ws: ReturnType<typeof fakeWs>) {
  const states = ws.sent.filter((m: any) => m.type === 'worktree.state');
  return states[states.length - 1]?.payload;
}

describe('WorktreeWebSocketHandler', () => {
  it('sends an immediate worktree.state snapshot on connect', () => {
    const events = new EventBus();
    const h = new WorktreeWebSocketHandler(events, noopLogger);
    const ws = fakeWs();
    h.addClient(ws);
    expect(ws.sent[0]?.type).toBe('worktree.state');
    h.dispose();
  });

  it('tracks the lifecycle: allocated → committed → merged → released', () => {
    const events = new EventBus();
    const h = new WorktreeWebSocketHandler(events, noopLogger);
    const ws = fakeWs();
    h.addClient(ws);

    events.emit('worktree.allocated', {
      handleId: 'p1', ownerId: 'p1', ownerLabel: 'Build', slug: 'build', dir: '/wt/p1',
      branch: 'wstack/ap/build', baseBranch: 'main',
    } as never);
    let s = lastState(ws);
    expect(s.worktrees).toHaveLength(1);
    expect(s.baseBranch).toBe('main');
    expect(s.worktrees[0].status).toBe('active');

    events.emit('worktree.committed', {
      handleId: 'p1', ownerId: 'p1', branch: 'wstack/ap/build', committed: true,
      insertions: 12, deletions: 3, files: 2,
    } as never);
    s = lastState(ws);
    expect(s.worktrees[0].insertions).toBe(12);
    expect(s.worktrees[0].status).toBe('committing');

    events.emit('worktree.merged', { handleId: 'p1', ownerId: 'p1', branch: 'wstack/ap/build', baseBranch: 'main', squash: true } as never);
    expect(lastState(ws).worktrees[0].status).toBe('merged');

    events.emit('worktree.released', { handleId: 'p1', ownerId: 'p1', branch: 'wstack/ap/build', kept: false } as never);
    expect(lastState(ws).worktrees).toHaveLength(0);
    h.dispose();
  });

  it('keeps conflicted worktrees and records conflict files', () => {
    const events = new EventBus();
    const h = new WorktreeWebSocketHandler(events, noopLogger);
    const ws = fakeWs();
    h.addClient(ws);
    events.emit('worktree.allocated', {
      handleId: 'p2', ownerId: 'p2', ownerLabel: 'Migrate', slug: 'mig', dir: '/wt/p2',
      branch: 'wstack/ap/mig', baseBranch: 'main',
    } as never);
    events.emit('worktree.conflict', { handleId: 'p2', ownerId: 'p2', branch: 'wstack/ap/mig', conflictFiles: ['db.sql'] } as never);
    events.emit('worktree.released', { handleId: 'p2', ownerId: 'p2', branch: 'wstack/ap/mig', kept: true } as never);
    const s = lastState(ws);
    expect(s.worktrees).toHaveLength(1);
    expect(s.worktrees[0].status).toBe('needs-review');
    expect(s.worktrees[0].conflictFiles).toEqual(['db.sql']);
    h.dispose();
  });
});

describe('deriveWorktreeGraph', () => {
  const mk = (id: string, at: number): WorktreeHandleView => ({
    handleId: id, ownerId: id, ownerLabel: id, branch: `wstack/ap/${id}`, baseBranch: 'main',
    status: 'active', insertions: 0, deletions: 0, files: 0, allocatedAt: at, lastEventAt: at, recentActivity: [],
  });

  it('orders by allocation time and assigns distinct lane positions', () => {
    const nodes = deriveWorktreeGraph([mk('b', 2), mk('a', 1)]);
    expect(nodes.map((n) => n.handle.handleId)).toEqual(['a', 'b']);
    expect(nodes[0]!.y).toBeLessThan(nodes[1]!.y);
    expect(nodes[0]!.color).not.toBe(nodes[1]!.color);
  });
});
