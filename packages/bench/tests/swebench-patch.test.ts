import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execCommand } from '../src/exec-command.js';
import {
  extractModelPatch,
  extractPatchPaths,
  filterPatchExcludingPaths,
} from '../src/suites/swebench-patch.js';

const git = (cwd: string, ...args: string[]) =>
  execCommand({ command: 'git', args, cwd, timeoutMs: 30_000, shell: false });

let repo: string;

beforeAll(async () => {
  repo = await fs.mkdtemp(path.join(os.tmpdir(), 'bench-swe-patch-'));
  await git(repo, 'init', '-q');
  await git(repo, 'config', 'user.email', 'bench@example.com');
  await git(repo, 'config', 'user.name', 'bench');
  await git(repo, 'config', 'commit.gpgsign', 'false');
  await fs.writeFile(path.join(repo, 'src.py'), 'def f():\n    return 1\n', 'utf8');
  await fs.writeFile(
    path.join(repo, 'test_src.py'),
    'def test_f():\n    assert f() == 2\n',
    'utf8',
  );
  await git(repo, 'add', '-A');
  await git(repo, 'commit', '-q', '-m', 'base');
  // The "agent" edits the source AND (wrongly) a test file, and adds a file.
  await fs.writeFile(path.join(repo, 'src.py'), 'def f():\n    return 2\n', 'utf8');
  await fs.writeFile(
    path.join(repo, 'test_src.py'),
    'def test_f():\n    assert f() == 999\n',
    'utf8',
  );
  await fs.writeFile(path.join(repo, 'newmod.py'), 'X = 1\n', 'utf8');
});

afterAll(async () => {
  await fs.rm(repo, { recursive: true, force: true });
});

describe('extractModelPatch', () => {
  it('captures modified and newly-added files as a unified diff', async () => {
    const patch = await extractModelPatch({ workdir: repo, timeoutMs: 30_000 });
    expect(patch).toContain('diff --git a/src.py b/src.py');
    expect(patch).toContain('+    return 2');
    expect(patch).toContain('newmod.py'); // new file included
  });

  it('excludes files touched by the held-out test patch', async () => {
    const testPatch =
      'diff --git a/test_src.py b/test_src.py\n--- a/test_src.py\n+++ b/test_src.py\n';
    const patch = await extractModelPatch({ workdir: repo, testPatch, timeoutMs: 30_000 });
    expect(patch).toContain('src.py');
    // The agent's edit to test_src.py must be stripped.
    expect(patch).not.toContain('test_src.py');
  });

  it('strips harness artifacts (.gitignore / .wrongstack) the subprocess writes', async () => {
    // Simulate what wstack boot does: add a .gitignore line and a .wrongstack dir.
    await fs.writeFile(path.join(repo, '.gitignore'), '.wrongstack/\n', 'utf8');
    await fs.mkdir(path.join(repo, '.wrongstack'), { recursive: true });
    await fs.writeFile(path.join(repo, '.wrongstack', 'state.json'), '{}', 'utf8');
    const patch = await extractModelPatch({ workdir: repo, timeoutMs: 30_000 });
    expect(patch).toContain('src.py'); // real edit survives
    expect(patch).not.toContain('.gitignore');
    expect(patch).not.toContain('.wrongstack');
  });
});

describe('extractPatchPaths', () => {
  it('reads paths from git and unified-diff headers', () => {
    const paths = extractPatchPaths('diff --git a/foo.py b/foo.py\n--- a/bar.py\n+++ b/baz.py\n');
    expect(paths.has('foo.py')).toBe(true);
    expect(paths.has('bar.py')).toBe(true);
    expect(paths.has('baz.py')).toBe(true);
  });
});

describe('filterPatchExcludingPaths', () => {
  it('drops only the excluded file sections', () => {
    const patch = [
      'diff --git a/keep.py b/keep.py',
      '@@ -1 +1 @@',
      '-a',
      '+b',
      'diff --git a/drop.py b/drop.py',
      '@@ -1 +1 @@',
      '-c',
      '+d',
    ].join('\n');
    const out = filterPatchExcludingPaths(patch, new Set(['drop.py']));
    expect(out).toContain('keep.py');
    expect(out).not.toContain('drop.py');
    expect(out).toContain('+b');
    expect(out).not.toContain('+d');
  });

  it('returns the patch unchanged when nothing is excluded', () => {
    const patch = 'diff --git a/x b/x\n';
    expect(filterPatchExcludingPaths(patch, new Set())).toBe(patch);
  });
});
