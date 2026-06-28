import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
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

describe('WorktreeWebSocketHandler — orphan management', () => {
  const dirs: string[] = [];
  async function tmpDir(): Promise<string> {
    const d = await fs.mkdtemp(path.join(os.tmpdir(), 'wt-ws-'));
    dirs.push(d);
    return d;
  }
  afterEach(async () => {
    for (const d of dirs.splice(0)) await fs.rm(d, { recursive: true, force: true }).catch(() => undefined);
  });
  const lastOf = (ws: ReturnType<typeof fakeWs>, type: string) => {
    const m = ws.sent.filter((x: any) => x.type === type);
    return m[m.length - 1];
  };

  it('broadcasts a worktree.orphans inventory on a scan (empty outside a repo)', async () => {
    const root = await tmpDir();
    const h = new WorktreeWebSocketHandler(new EventBus(), noopLogger, {
      projectRoot: root,
      boardsDir: path.join(root, 'sdd-boards'),
    });
    const ws = fakeWs();
    h.addClient(ws);
    await h.handleMessage({ type: 'worktree.scan' });
    const msg = lastOf(ws, 'worktree.orphans');
    expect(msg?.payload).toMatchObject({ orphans: [], canClean: true });
    h.dispose();
  });

  it('refuses cleanup while a worktree is actively owned by a live run', async () => {
    const root = await tmpDir();
    const events = new EventBus();
    const h = new WorktreeWebSocketHandler(events, noopLogger, {
      projectRoot: root,
      boardsDir: path.join(root, 'sdd-boards'),
    });
    const ws = fakeWs();
    h.addClient(ws);
    events.emit('worktree.allocated', {
      handleId: 'h1', ownerId: 'o1', ownerLabel: 'task', slug: 's1',
      dir: path.join(root, '.wrongstack', 'worktrees', 's1'), branch: 'wstack/ap/s1', baseBranch: 'main',
    } as never);

    await h.handleMessage({ type: 'worktree.cleanup' });
    const res = lastOf(ws, 'worktree.cleanup_result');
    expect(res?.payload.ok).toBe(false);
    expect(String(res?.payload.reason)).toMatch(/live/i);
    h.dispose();
  });

  it('cleans when idle and reports the outcome (0 removed outside a repo)', async () => {
    const root = await tmpDir();
    const h = new WorktreeWebSocketHandler(new EventBus(), noopLogger, {
      projectRoot: root,
      boardsDir: path.join(root, 'sdd-boards'),
    });
    const ws = fakeWs();
    h.addClient(ws);
    await h.handleMessage({ type: 'worktree.cleanup' });
    const res = lastOf(ws, 'worktree.cleanup_result');
    expect(res?.payload).toMatchObject({ ok: true, removed: 0 });
    h.dispose();
  });

  it('handleMessage returns false for unrelated message types', async () => {
    const root = await tmpDir();
    const h = new WorktreeWebSocketHandler(new EventBus(), noopLogger, {
      projectRoot: root,
      boardsDir: path.join(root, 'sdd-boards'),
    });
    expect(await h.handleMessage({ type: 'something.else' })).toBe(false);
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
