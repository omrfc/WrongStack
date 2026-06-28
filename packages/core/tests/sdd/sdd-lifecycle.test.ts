import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SddBoardSnapshot } from '../../src/sdd/board-types.js';
import { SddBoardStore } from '../../src/sdd/sdd-board-store.js';
import {
  applySddLifecycle,
  cleanupStaleSddWorktrees,
  destroySddProject,
  rollbackSddRunFromDisk,
} from '../../src/sdd/sdd-lifecycle.js';

let tmp: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'sdd-lifecycle-'));
});
afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true }).catch(() => undefined);
});

function snapshot(over: Partial<SddBoardSnapshot> = {}): SddBoardSnapshot {
  return {
    runId: 'run-1',
    graphId: 'g1',
    title: 'T',
    status: 'idle',
    startedAt: 0,
    updatedAt: 0,
    progress: {
      total: 1,
      completed: 1,
      failed: 0,
      inProgress: 0,
      pending: 0,
      blocked: 0,
      review: 0,
      percentComplete: 100,
    },
    wave: 0,
    tasks: [],
    columns: [],
    ...over,
  };
}

describe('destroySddProject', () => {
  it('deletes specs / task-graphs / boards dirs + the session file', async () => {
    const paths = {
      projectSpecs: path.join(tmp, 'specs'),
      projectTaskGraphs: path.join(tmp, 'task-graphs'),
      projectSddSession: path.join(tmp, 'sdd-session.json'),
      projectSddBoards: path.join(tmp, 'sdd-boards'),
    };
    await fs.mkdir(paths.projectSpecs, { recursive: true });
    await fs.writeFile(path.join(paths.projectSpecs, 's.json'), '{}');
    await fs.mkdir(paths.projectTaskGraphs, { recursive: true });
    await fs.mkdir(paths.projectSddBoards, { recursive: true });
    await fs.writeFile(paths.projectSddSession, '{}');

    const res = await destroySddProject({ projectRoot: tmp, paths });

    expect(res.deleted.sort()).toEqual(['boards', 'session', 'specs', 'task-graphs']);
    await expect(fs.access(paths.projectSpecs)).rejects.toBeDefined();
    await expect(fs.access(paths.projectSddSession)).rejects.toBeDefined();
    await expect(fs.access(paths.projectSddBoards)).rejects.toBeDefined();
    // Not a git repo → cleanup removes nothing but never throws.
    expect(res.worktreesRemoved).toBe(0);
  });

  it('skips missing artifacts without throwing', async () => {
    const paths = {
      projectSpecs: path.join(tmp, 'nope-specs'),
      projectTaskGraphs: path.join(tmp, 'nope-graphs'),
      projectSddSession: path.join(tmp, 'nope-session.json'),
      projectSddBoards: path.join(tmp, 'nope-boards'),
    };
    const res = await destroySddProject({ projectRoot: tmp, paths });
    // Missing dirs are removed idempotently (rm force) but the file unlink fails.
    expect(res.deleted).not.toContain('session');
  });
});

describe('rollbackSddRunFromDisk', () => {
  const boardsDir = () => path.join(tmp, 'sdd-boards');

  it('reports when there is no board to roll back', async () => {
    const res = await rollbackSddRunFromDisk({ projectRoot: tmp, boardsDir: boardsDir() });
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/no SDD board/i);
  });

  it('reports when the run recorded no merged commits', async () => {
    const store = new SddBoardStore({ baseDir: boardsDir() });
    await store.saveSnapshot(snapshot({ baseBranch: 'main', mergedCommits: [] }));
    const res = await rollbackSddRunFromDisk({ projectRoot: tmp, boardsDir: boardsDir() });
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/no merged commits/i);
  });

  it('reports when the run recorded no base branch', async () => {
    const store = new SddBoardStore({ baseDir: boardsDir() });
    await store.saveSnapshot(snapshot({ mergedCommits: [{ taskId: 't', sha: 'abc', title: 'x' }] }));
    const res = await rollbackSddRunFromDisk({ projectRoot: tmp, boardsDir: boardsDir() });
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/base branch/i);
  });
});

describe('destroySddProject with revertMerged', () => {
  function destroyPaths() {
    return {
      projectSpecs: path.join(tmp, 'specs'),
      projectTaskGraphs: path.join(tmp, 'task-graphs'),
      projectSddSession: path.join(tmp, 'sdd-session.json'),
      projectSddBoards: path.join(tmp, 'sdd-boards'),
    };
  }

  it('surfaces a refused revert but still wipes the artifacts', async () => {
    const paths = destroyPaths();
    await fs.mkdir(paths.projectSpecs, { recursive: true });
    await fs.writeFile(paths.projectSddSession, '{}');
    // No board recorded → the revert can find nothing, but destroy proceeds.
    const res = await destroySddProject({ projectRoot: tmp, paths, revertMerged: true });

    expect(res.revertOk).toBe(false);
    expect(res.revertReason).toMatch(/no SDD board/i);
    expect(res.reverted).toBe(0);
    expect(res.deleted).toContain('specs');
    expect(res.deleted).toContain('session');
  });

  it('leaves revert fields untouched when not requested', async () => {
    const res = await destroySddProject({ projectRoot: tmp, paths: destroyPaths() });
    expect(res.reverted).toBe(0);
    expect(res.revertOk).toBeUndefined();
  });
});

describe('applySddLifecycle', () => {
  function lcPaths() {
    return {
      projectSpecs: path.join(tmp, 'specs'),
      projectTaskGraphs: path.join(tmp, 'task-graphs'),
      projectSddSession: path.join(tmp, 'sdd-session.json'),
      projectSddBoards: path.join(tmp, 'sdd-boards'),
    };
  }

  it('cleanup_worktrees → ok with a removed count (0 outside a repo)', async () => {
    const res = await applySddLifecycle('cleanup_worktrees', { projectRoot: tmp, paths: lcPaths() });
    expect(res).toMatchObject({ op: 'cleanup_worktrees', ok: true, removed: 0 });
  });

  it('rollback → ok:false with a reason when there is no board', async () => {
    const res = await applySddLifecycle('rollback', { projectRoot: tmp, paths: lcPaths() });
    expect(res.op).toBe('rollback');
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/no SDD board/i);
  });

  it('destroy → ok:true and reports deleted artifacts', async () => {
    const paths = lcPaths();
    await fs.mkdir(paths.projectSpecs, { recursive: true });
    await fs.writeFile(paths.projectSddSession, '{}');
    const res = await applySddLifecycle('destroy', { projectRoot: tmp, paths });
    expect(res.op).toBe('destroy');
    expect(res.ok).toBe(true);
    expect(res.deleted).toContain('specs');
  });
});

describe('cleanupStaleSddWorktrees — liveness guard', () => {
  const boardsDir = () => path.join(tmp, 'sdd-boards');
  const NOW = 10_000_000;

  async function saveBoard(status: SddBoardSnapshot['status'], updatedAt: number) {
    const store = new SddBoardStore({ baseDir: boardsDir() });
    await store.saveSnapshot(snapshot({ status, updatedAt }));
  }

  it('skips while a running board is fresh (run appears live)', async () => {
    await saveBoard('running', NOW - 5_000); // 5s old
    const res = await cleanupStaleSddWorktrees({ projectRoot: tmp, boardsDir: boardsDir(), now: () => NOW });
    expect(res.swept).toBe(false);
    expect(res.skippedReason).toMatch(/live/i);
  });

  it('skips while a paused board is within the paused window', async () => {
    await saveBoard('paused', NOW - 60_000); // 1min old, < 30min default
    const res = await cleanupStaleSddWorktrees({ projectRoot: tmp, boardsDir: boardsDir(), now: () => NOW });
    expect(res.swept).toBe(false);
    expect(res.skippedReason).toMatch(/paused/i);
  });

  it('proceeds when a running board is stale (crash → no recent update)', async () => {
    await saveBoard('running', NOW - 5 * 60_000); // 5min old, > 2min default
    const res = await cleanupStaleSddWorktrees({ projectRoot: tmp, boardsDir: boardsDir(), now: () => NOW });
    // tmp is not a git repo → nothing to sweep, but the guard did NOT skip.
    expect(res.skippedReason).toBeUndefined();
  });

  it('proceeds for a finished board and when no board exists', async () => {
    const none = await cleanupStaleSddWorktrees({ projectRoot: tmp, boardsDir: boardsDir(), now: () => NOW });
    expect(none.skippedReason).toBeUndefined();

    await saveBoard('completed', NOW - 1_000);
    const done = await cleanupStaleSddWorktrees({ projectRoot: tmp, boardsDir: boardsDir(), now: () => NOW });
    expect(done.skippedReason).toBeUndefined();
  });
});
