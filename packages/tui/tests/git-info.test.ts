import { spawnSync } from 'node:child_process';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readGitInfo } from '../src/git-info.js';

const hasGit = (() => {
  try {
    const r = spawnSync('git', ['--version'], { stdio: 'ignore' });
    return r.status === 0;
  } catch {
    return false;
  }
})();

const describeIfGit = hasGit ? describe : describe.skip;

describeIfGit('readGitInfo', () => {
  let repoDir: string;

  beforeAll(async () => {
    repoDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'wstack-git-'));
    // Initialise repo with a stable default branch and a noisy-quiet
    // git config so signed-commit or hook plugins don't trip the test.
    run(repoDir, ['init', '--initial-branch=main', '--quiet']);
    run(repoDir, ['config', 'user.email', 'test@example.com']);
    run(repoDir, ['config', 'user.name', 'test']);
    run(repoDir, ['config', 'commit.gpgsign', 'false']);
    await fsp.writeFile(path.join(repoDir, 'a.txt'), 'one\ntwo\nthree\n');
    run(repoDir, ['add', 'a.txt']);
    run(repoDir, ['commit', '-m', 'init', '--quiet']);
  });

  afterAll(async () => {
    await fsp.rm(repoDir, { recursive: true, force: true });
  });

  it('returns null for a non-git directory', async () => {
    const plain = await fsp.mkdtemp(path.join(os.tmpdir(), 'wstack-plain-'));
    try {
      expect(await readGitInfo(plain)).toBeNull();
    } finally {
      await fsp.rm(plain, { recursive: true, force: true });
    }
  });

  it('reports branch and zero changes on a clean tree', async () => {
    const info = await readGitInfo(repoDir);
    expect(info).not.toBeNull();
    expect(info?.branch).toBe('main');
    expect(info?.added).toBe(0);
    expect(info?.deleted).toBe(0);
    expect(info?.untracked).toBe(0);
  });

  it('counts added and deleted lines from working-tree diff', async () => {
    // Rewrite a.txt: 1 line deleted (three), 2 lines added (four/five).
    await fsp.writeFile(path.join(repoDir, 'a.txt'), 'one\ntwo\nfour\nfive\n');
    const info = await readGitInfo(repoDir);
    expect(info?.added).toBe(2);
    expect(info?.deleted).toBe(1);
  });

  it('counts untracked files separately', async () => {
    await fsp.writeFile(path.join(repoDir, 'newfile.txt'), 'hello');
    const info = await readGitInfo(repoDir);
    expect(info?.untracked).toBeGreaterThanOrEqual(1);
  });
});

function run(cwd: string, args: string[]): void {
  const r = spawnSync('git', args, { cwd, stdio: 'ignore' });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed (${r.status})`);
  }
}
