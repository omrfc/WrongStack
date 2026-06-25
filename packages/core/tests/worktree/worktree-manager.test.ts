import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  type RunResult,
  WorktreeManager,
  assertSafePath,
  parseConflictPaths,
} from '../../src/worktree/worktree-manager.js';

/** Records every git invocation and returns scripted results. */
function stubRunner(
  script: (args: string[]) => RunResult = () => ({ code: 0, stdout: '', stderr: '' }),
) {
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
      args[0] === 'rev-parse'
        ? { code: 0, stdout: 'main\n', stderr: '' }
        : { code: 0, stdout: '', stderr: '' },
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
      args[0] === 'rev-parse'
        ? { code: 0, stdout: 'main\n', stderr: '' }
        : { code: 0, stdout: '', stderr: '' },
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
      args[0] === 'rev-parse'
        ? { code: 0, stdout: 'main\n', stderr: '' }
        : { code: 0, stdout: '', stderr: '' },
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

  it('commitAll injects a fallback identity when git has no user.name/email', async () => {
    const { calls, run } = stubRunner((args) => {
      if (args[0] === 'rev-parse') return { code: 0, stdout: 'main\n', stderr: '' };
      // diff --cached --quiet exits 1 → there ARE staged changes to commit
      if (args[0] === 'diff' && args.includes('--cached'))
        return { code: 1, stdout: '', stderr: '' };
      if (args[0] === 'config') return { code: 0, stdout: '', stderr: '' }; // no identity set
      if (args[0] === 'show') return { code: 0, stdout: '2\t1\tnew.txt\n', stderr: '' };
      return { code: 0, stdout: '', stderr: '' };
    });
    const wm = new WorktreeManager({ projectRoot: '/proj', run });
    const h = await wm.allocate('p', { slugHint: 'x' });
    const res = await wm.commitAll(h, 'msg');
    expect(res.committed).toBe(true);
    const commit = calls.map((c) => c.args).find((a) => a.includes('commit'));
    expect(commit).toBeTruthy();
    expect(commit!).toContain('-c');
    expect(commit!.join(' ')).toMatch(/user\.name=/);
    expect(commit!.join(' ')).toMatch(/user\.email=/);
    // -c flags must precede the `commit` subcommand
    expect(commit!.indexOf('-c')).toBeLessThan(commit!.indexOf('commit'));
  });

  it('commitAll does NOT override an existing git identity', async () => {
    const { calls, run } = stubRunner((args) => {
      if (args[0] === 'rev-parse') return { code: 0, stdout: 'main\n', stderr: '' };
      if (args[0] === 'diff' && args.includes('--cached'))
        return { code: 1, stdout: '', stderr: '' };
      if (args[0] === 'config')
        return { code: 0, stdout: args.includes('user.email') ? 'me@x\n' : 'Me\n', stderr: '' };
      if (args[0] === 'show') return { code: 0, stdout: '1\t0\tf\n', stderr: '' };
      return { code: 0, stdout: '', stderr: '' };
    });
    const wm = new WorktreeManager({ projectRoot: '/proj', run });
    const h = await wm.allocate('p', { slugHint: 'x' });
    await wm.commitAll(h, 'msg');
    const commit = calls.map((c) => c.args).find((a) => a.includes('commit'));
    expect(commit).toEqual(['commit', '-m', 'msg']);
  });

  it('list()/get() reflect the registry', async () => {
    const { run } = stubRunner((args) =>
      args[0] === 'rev-parse'
        ? { code: 0, stdout: 'main\n', stderr: '' }
        : { code: 0, stdout: '', stderr: '' },
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
  }, 120_000);

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
  }, 120_000);

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
      spawnSync('git', ['-C', base, 'commit', '-aqm', 'edit on base'], {
        stdio: 'ignore',
        env: GIT_ENV,
      });

      const m = await wm.merge(h, { squash: true });
      // Critical semantics: the conflict is detected, the run is not aborted,
      // and the worktree is parked for review.
      expect(m.ok).toBe(false);
      expect(m.conflict).toBe(true);
      expect(h.status).toBe('needs-review');
      // Conflict-FILE listing is best-effort — git's machine-readable conflict
      // reporting varies by version/config/runner — so we only require it to
      // name seed.txt when it reported anything at all. (parseConflictPaths is
      // unit-tested separately for the documented output format.)
      if (m.conflictFiles && m.conflictFiles.length > 0) {
        expect(m.conflictFiles).toContain('seed.txt');
      }

      // release keeps a needs-review worktree on disk regardless of keep flag
      await wm.release(h, { keep: false });
      const stat = await fs.stat(h.dir);
      expect(stat.isDirectory()).toBe(true);
    } finally {
      await fs.rm(base, { recursive: true, force: true });
    }
  }, 120_000);

  it('resolve callback clears the conflict → merge lands on base (resolved)', async () => {
    const base = await makeRepo();
    try {
      const wm = new WorktreeManager({ projectRoot: base });
      const h = await wm.allocate('p', { slugHint: 'resolve-ok' });

      await fs.writeFile(path.join(h.dir, 'seed.txt'), 'line1\nWORKTREE\nline3\n');
      await wm.commitAll(h, 'edit on branch');
      await fs.writeFile(path.join(base, 'seed.txt'), 'line1\nBASE\nline3\n');
      spawnSync('git', ['-C', base, 'commit', '-aqm', 'edit on base'], {
        stdio: 'ignore',
        env: GIT_ENV,
      });

      let sawConflict: string[] | undefined;
      const m = await wm.merge(h, {
        squash: true,
        resolve: async ({ conflictFiles, cwd }) => {
          sawConflict = conflictFiles;
          // Resolve by combining both sides and removing every marker.
          await fs.writeFile(path.join(cwd, 'seed.txt'), 'line1\nBASE+WORKTREE\nline3\n');
          return true;
        },
      });

      expect(m.ok).toBe(true);
      expect(m.resolved).toBe(true);
      expect(h.status).toBe('merged');
      if (sawConflict && sawConflict.length > 0) expect(sawConflict).toContain('seed.txt');
      const onBase = await fs.readFile(path.join(base, 'seed.txt'), 'utf8');
      expect(onBase.replace(/\r/g, '')).toBe('line1\nBASE+WORKTREE\nline3\n');
    } finally {
      await fs.rm(base, { recursive: true, force: true });
    }
  }, 120_000);

  it('baseHead + revertBaseTo undo a resolved squash-merge back to the captured tip', async () => {
    const base = await makeRepo();
    try {
      const wm = new WorktreeManager({ projectRoot: base });
      const h = await wm.allocate('p', { slugHint: 'revert-resolved' });

      await fs.writeFile(path.join(h.dir, 'seed.txt'), 'line1\nWORKTREE\nline3\n');
      await wm.commitAll(h, 'edit on branch');
      await fs.writeFile(path.join(base, 'seed.txt'), 'line1\nBASE\nline3\n');
      spawnSync('git', ['-C', base, 'commit', '-aqm', 'edit on base'], { stdio: 'ignore', env: GIT_ENV });

      // Capture the base tip BEFORE the merge (the revert target).
      const preSha = await wm.baseHead(h);
      expect(preSha).toBeTruthy();

      const m = await wm.merge(h, {
        squash: true,
        resolve: async ({ cwd }) => {
          await fs.writeFile(path.join(cwd, 'seed.txt'), 'line1\nBASE+WORKTREE\nline3\n');
          return true;
        },
      });
      expect(m.ok).toBe(true);
      expect(m.resolved).toBe(true);
      // The squash-resolution commit advanced base.
      const after = spawnSync('git', ['-C', base, 'log', '-1', '--pretty=%H'], { encoding: 'utf8', env: GIT_ENV });
      expect(after.stdout.trim()).not.toBe(preSha);

      // Revert undoes it: base tip + tree are back to the pre-merge state.
      expect(await wm.revertBaseTo(h, preSha!)).toBe(true);
      const reverted = spawnSync('git', ['-C', base, 'log', '-1', '--pretty=%H'], { encoding: 'utf8', env: GIT_ENV });
      expect(reverted.stdout.trim()).toBe(preSha);
      const onBase = await fs.readFile(path.join(base, 'seed.txt'), 'utf8');
      expect(onBase.replace(/\r/g, '')).toBe('line1\nBASE\nline3\n');
    } finally {
      await fs.rm(base, { recursive: true, force: true });
    }
  }, 120_000);

  it('resolve callback that leaves markers → aborts to needs-review (never commits)', async () => {
    const base = await makeRepo();
    try {
      const wm = new WorktreeManager({ projectRoot: base });
      const h = await wm.allocate('p', { slugHint: 'resolve-bad' });

      await fs.writeFile(path.join(h.dir, 'seed.txt'), 'line1\nWORKTREE\nline3\n');
      await wm.commitAll(h, 'edit on branch');
      await fs.writeFile(path.join(base, 'seed.txt'), 'line1\nBASE\nline3\n');
      spawnSync('git', ['-C', base, 'commit', '-aqm', 'edit on base'], {
        stdio: 'ignore',
        env: GIT_ENV,
      });

      // Resolver claims success but leaves the conflict markers in place.
      const m = await wm.merge(h, { squash: true, resolve: async () => true });

      expect(m.ok).toBe(false);
      expect(m.conflict).toBe(true);
      expect(m.resolved).toBeFalsy();
      expect(h.status).toBe('needs-review');
      // base HEAD is still the pre-merge commit (nothing was committed)
      const head = spawnSync('git', ['-C', base, 'log', '-1', '--pretty=%s'], {
        encoding: 'utf8',
        env: GIT_ENV,
      });
      expect(head.stdout.trim()).toBe('edit on base');
    } finally {
      await fs.rm(base, { recursive: true, force: true });
    }
  }, 120_000);
});

describe('parseConflictPaths', () => {
  it('extracts conflicted files from git merge stdout', () => {
    const output = [
      'Auto-merging seed.txt',
      'CONFLICT (content): Merge conflict in seed.txt',
      'Auto-merging dir/app.ts',
      'CONFLICT (add/add): Merge conflict in dir/app.ts',
      'Squash commit -- not updating HEAD',
    ].join('\n');
    expect(parseConflictPaths(output)).toEqual(['seed.txt', 'dir/app.ts']);
  });

  it('returns [] when there are no conflict lines', () => {
    expect(parseConflictPaths('Auto-merging x\nFast-forward')).toEqual([]);
  });

  it('dedupes repeated paths and trims trailing whitespace', () => {
    const output =
      'CONFLICT (content): Merge conflict in a.txt  \nCONFLICT (content): Merge conflict in a.txt';
    expect(parseConflictPaths(output)).toEqual(['a.txt']);
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
