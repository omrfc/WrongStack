import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { WorktreeManager, assertSafePath, type RunResult } from '../../src/worktree/worktree-manager.js';

/** Records every git invocation and returns scripted results. */
function stubRunner(script: (args: string[]) => RunResult = () => ({ code: 0, stdout: '', stderr: '' })) {
  const calls: Array<{ args: string[]; cwd: string }> = [];
  const run = async (args: string[], cwd: string): Promise<RunResult> => {
    calls.push({ args, cwd });
    return script(args);
  };
  return { calls, run };
}

const gitAvailable = spawnSync('git', ['--version'], { stdio: 'ignore' }).status === 0;
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'T',
  GIT_AUTHOR_EMAIL: 't@t',
  GIT_COMMITTER_NAME: 'T',
  GIT_COMMITTER_EMAIL: 't@t',
};

describe('WorktreeManager (stubbed git)', () => {
  it('allocates with `worktree add -b <branch> <dir> <base>` (path before commit-ish)', async () => {
    const { calls, run } = stubRunner((args) =>
      args[0] === 'rev-parse' ? { code: 0, stdout: 'main\n', stderr: '' } : { code: 0, stdout: '', stderr: '' },
    );
    const wm = new WorktreeManager({ projectRoot: '/proj', run });
    const h = await wm.allocate('phase-1', { slugHint: 'Build API' });

    const add = calls.find((c) => c.args[0] === 'worktree' && c.args[1] === 'add');
    expect(add).toBeTruthy();
    expect(add!.args).toEqual(['worktree', 'add', '-b', h.branch, h.dir, 'main']);
    // path comes before the base ref
    expect(add!.args.indexOf(h.dir)).toBeLessThan(add!.args.indexOf('main'));
  });

  it('namespaces the branch and sanitizes the slug', async () => {
    const { run } = stubRunner((args) =>
      args[0] === 'rev-parse' ? { code: 0, stdout: 'main\n', stderr: '' } : { code: 0, stdout: '', stderr: '' },
    );
    const wm = new WorktreeManager({ projectRoot: '/proj', run });
    const h = await wm.allocate('p', { slugHint: 'Feature: Auth/API!!' });
    expect(h.branch.startsWith('wstack/ap/')).toBe(true);
    expect(h.slug).toMatch(/^feature-auth-api-[0-9a-f]{6}$/);
    expect(h.dir).toContain(path.join('.wrongstack', 'worktrees'));
  });

  it('emits worktree.allocated on success and marks active', async () => {
    const events: Array<{ name: string; payload: any }> = [];
    const fakeBus = { emit: (name: string, payload: any) => events.push({ name, payload }) } as any;
    const { run } = stubRunner((args) =>
      args[0] === 'rev-parse' ? { code: 0, stdout: 'main\n', stderr: '' } : { code: 0, stdout: '', stderr: '' },
    );
    const wm = new WorktreeManager({ projectRoot: '/proj', events: fakeBus, run });
    const h = await wm.allocate('p1', { slugHint: 'x' });
    expect(h.status).toBe('active');
    expect(events.map((e) => e.name)).toContain('worktree.allocated');
  });

  it('marks failed (and emits) when `worktree add` fails', async () => {
    const events: string[] = [];
    const fakeBus = { emit: (name: string) => events.push(name) } as any;
    const { run } = stubRunner((args) => {
      if (args[0] === 'rev-parse') return { code: 0, stdout: 'main\n', stderr: '' };
      if (args[1] === 'add') return { code: 1, stdout: '', stderr: 'fatal: branch exists' };
      return { code: 0, stdout: '', stderr: '' };
    });
    const wm = new WorktreeManager({ projectRoot: '/proj', events: fakeBus, run });
    const h = await wm.allocate('p1');
    expect(h.status).toBe('failed');
    expect(h.lastError).toMatch(/branch exists/);
    expect(events).toContain('worktree.failed');
  });

  it('list()/get() reflect the registry', async () => {
    const { run } = stubRunner((args) =>
      args[0] === 'rev-parse' ? { code: 0, stdout: 'main\n', stderr: '' } : { code: 0, stdout: '', stderr: '' },
    );
    const wm = new WorktreeManager({ projectRoot: '/proj', run });
    await wm.allocate('a', { slugHint: 'a' });
    await wm.allocate('b', { slugHint: 'b' });
    expect(wm.list()).toHaveLength(2);
    expect(wm.get('a')?.ownerId).toBe('a');
  });
});

describe.skipIf(!gitAvailable)('WorktreeManager (real repo)', () => {
  async function makeRepo(): Promise<string> {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), 'wm-real-'));
    spawnSync('git', ['init', '-q', base], { stdio: 'ignore' });
    await fs.writeFile(path.join(base, 'seed.txt'), 'line1\nline2\nline3\n');
    spawnSync('git', ['-C', base, 'add', '-A'], { stdio: 'ignore', env: GIT_ENV });
    spawnSync('git', ['-C', base, 'commit', '-q', '-m', 'init'], { stdio: 'ignore', env: GIT_ENV });
    spawnSync('git', ['-C', base, 'branch', '-M', 'main'], { stdio: 'ignore', env: GIT_ENV });
    return base;
  }

  it('allocate → commitAll → squash-merge lands the change on base', async () => {
    const base = await makeRepo();
    try {
      const wm = new WorktreeManager({ projectRoot: base });
      const h = await wm.allocate('phase-1', { slugHint: 'feature' });
      expect(h.status).toBe('active');
      const dotGit = await fs.stat(path.join(h.dir, '.git'));
      expect(dotGit.isFile()).toBe(true);

      await fs.writeFile(path.join(h.dir, 'new.txt'), 'hello\n');
      const c = await wm.commitAll(h, 'feat: add new.txt');
      expect(c.committed).toBe(true);
      expect(h.files).toBeGreaterThanOrEqual(1);
      expect(h.insertions).toBeGreaterThanOrEqual(1);

      const m = await wm.merge(h, { squash: true });
      expect(m.ok).toBe(true);
      expect(h.status).toBe('merged');

      // file is present on the base branch working tree
      const onBase = await fs.readFile(path.join(base, 'new.txt'), 'utf8');
      expect(onBase.replace(/\r/g, '')).toBe('hello\n');

      await wm.release(h, { keep: false });
      // Removed from the registry (deterministic). The on-disk removal is
      // `git worktree remove --force`, whose timing is OS-dependent on Windows,
      // so we don't assert the directory is gone here.
      expect(wm.get('phase-1')).toBeUndefined();
    } finally {
      await fs.rm(base, { recursive: true, force: true });
    }
  });

  it('commitAll on a clean tree returns committed:false', async () => {
    const base = await makeRepo();
    try {
      const wm = new WorktreeManager({ projectRoot: base });
      const h = await wm.allocate('p', { slugHint: 'noop' });
      const c = await wm.commitAll(h, 'nothing');
      expect(c.committed).toBe(false);
    } finally {
      await fs.rm(base, { recursive: true, force: true });
    }
  });

  it('conflicting merge → needs-review, run not aborted, worktree kept', async () => {
    const base = await makeRepo();
    try {
      const wm = new WorktreeManager({ projectRoot: base });
      const h = await wm.allocate('p', { slugHint: 'conflict' });

      // Worktree edits line2.
      await fs.writeFile(path.join(h.dir, 'seed.txt'), 'line1\nWORKTREE\nline3\n');
      await wm.commitAll(h, 'edit on branch');

      // Base also edits line2 → conflict on squash-merge.
      await fs.writeFile(path.join(base, 'seed.txt'), 'line1\nBASE\nline3\n');
      spawnSync('git', ['-C', base, 'commit', '-aqm', 'edit on base'], { stdio: 'ignore', env: GIT_ENV });

      const m = await wm.merge(h, { squash: true });
      expect(m.ok).toBe(false);
      expect(m.conflict).toBe(true);
      expect(m.conflictFiles).toContain('seed.txt');
      expect(h.status).toBe('needs-review');

      // release keeps a needs-review worktree on disk regardless of keep flag
      await wm.release(h, { keep: false });
      const stat = await fs.stat(h.dir);
      expect(stat.isDirectory()).toBe(true);
    } finally {
      await fs.rm(base, { recursive: true, force: true });
    }
  });
});

describe('assertSafePath', () => {
  it('allows paths inside the root', () => {
    expect(() => assertSafePath('/proj/.wrongstack/worktrees/x', '/proj')).not.toThrow();
  });
  it('rejects escapes', () => {
    expect(() => assertSafePath('/etc/evil', '/proj')).toThrow(/escapes project root/);
  });
});
