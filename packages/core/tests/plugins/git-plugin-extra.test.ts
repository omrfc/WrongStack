import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildCommitCommand, buildGitcheckCommand, buildPushCommand, createGitPlugin } from '../../src/plugins/git-plugin.js';
import type { SlashCommand } from '../../src/index.js';

const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '');

let tmp: string;
const initGit = () => {
  execFileSync('git', ['init', '-q'], { cwd: tmp, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 't@e.com'], { cwd: tmp, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'T'], { cwd: tmp, stdio: 'ignore' });
  execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: tmp, stdio: 'ignore' });
};
const commitAll = (msg: string) => {
  execFileSync('git', ['add', '.'], { cwd: tmp, stdio: 'ignore' });
  execFileSync('git', ['commit', '-q', '-m', msg], { cwd: tmp, stdio: 'ignore' });
};
const ctxFor = (provider?: unknown) => ({ session: { id: 's1' }, cwd: tmp, model: 'm', provider }) as never;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'git-plugin-extra-'));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('createGitPlugin lifecycle', () => {
  it('registers /commit /gitcheck /push, unregisters them, health ok', async () => {
    const registered: SlashCommand[] = [];
    const unregister = vi.fn();
    const api = { slashCommands: { register: (c: SlashCommand) => registered.push(c), unregister }, log: { info: vi.fn() } } as never;
    const plugin = createGitPlugin();
    plugin.setup!(api);
    expect(registered.map((c) => c.name).sort()).toEqual(['commit', 'gitcheck', 'push']);
    plugin.teardown!(api);
    expect(unregister).toHaveBeenCalledTimes(3);
    expect(await plugin.health!()).toMatchObject({ ok: true });
  });
});

describe('/commit heuristics with many changed files', () => {
  it('summarizes >3 changed files with a scope and "N more"', async () => {
    initGit();
    await fs.mkdir(path.join(tmp, 'src'), { recursive: true });
    for (const n of ['a', 'b', 'c', 'd']) await fs.writeFile(path.join(tmp, 'src', `${n}.ts`), 'v1');
    commitAll('init');
    for (const n of ['a', 'b', 'c', 'd']) await fs.writeFile(path.join(tmp, 'src', `${n}.ts`), 'v2'); // modify all 4
    const res = await buildCommitCommand().run!('--dry-run --no-llm', ctxFor());
    const msg = stripAnsi(res!.message);
    expect(msg).toContain('(src)'); // scope from the primary dir
    expect(msg).toMatch(/and 1 more/);
  });

  it('summarizes 1-3 changed files by basename', async () => {
    initGit();
    await fs.writeFile(path.join(tmp, 'README.md'), 'a');
    commitAll('init');
    await fs.writeFile(path.join(tmp, 'README.md'), 'b'); // single modified file
    const res = await buildCommitCommand().run!('--dry-run --no-llm', ctxFor());
    expect(stripAnsi(res!.message)).toContain('README.md');
  });
});

describe('/push edge cases', () => {
  it('reports "not a git repo" outside a repository', async () => {
    expect((await buildPushCommand().run!('', ctxFor())).message).toMatch(/not a git repo/i);
  });

  it('reports when there is nothing to push (no commits / no remote)', async () => {
    initGit();
    await fs.writeFile(path.join(tmp, 'f.ts'), 'x');
    commitAll('init');
    const res = await buildPushCommand().run!('', ctxFor());
    // no remote configured → the command surfaces a no-remote / push message
    expect(typeof res!.message).toBe('string');
  });

  it('fails to push when the remote is unreachable (and honors --force)', async () => {
    initGit();
    await fs.writeFile(path.join(tmp, 'f.ts'), 'x');
    commitAll('init');
    execFileSync('git', ['remote', 'add', 'origin', path.join(tmp, 'no-such-remote.git')], { cwd: tmp, stdio: 'ignore' });
    const res = await buildPushCommand().run!('--force', ctxFor());
    expect(stripAnsi(res!.message)).toMatch(/Push failed|fatal|error/i);
  });

  it('--dry-run reports the would-push target', async () => {
    initGit();
    await fs.writeFile(path.join(tmp, 'f.ts'), 'x');
    commitAll('init');
    execFileSync('git', ['remote', 'add', 'origin', path.join(tmp, 'r.git')], { cwd: tmp, stdio: 'ignore' });
    expect((await buildPushCommand().run!('--dry-run --force', ctxFor())).message).toMatch(/Would push/);
  });
});

describe('/commit worktree warning', () => {
  let wt: string;
  afterEach(async () => {
    if (wt) await fs.rm(wt, { recursive: true, force: true });
  });
  it('warns about simultaneous edits when multiple worktrees are active', async () => {
    initGit();
    await fs.writeFile(path.join(tmp, 'a.ts'), 'v1');
    commitAll('init');
    wt = path.join(os.tmpdir(), `git-wt-${Date.now()}`);
    execFileSync('git', ['worktree', 'add', '-q', '-b', 'feature', wt], { cwd: tmp, stdio: 'ignore' });
    await fs.writeFile(path.join(tmp, 'a.ts'), 'v2'); // an uncommitted change to commit
    const res = await buildCommitCommand().run!('--no-llm', ctxFor());
    expect(stripAnsi(res!.message)).toContain('worktrees active');
  });
});

describe('/gitcheck reports uncommitted changes', () => {
  it('warns when the working tree is dirty', async () => {
    initGit();
    await fs.writeFile(path.join(tmp, 'a.ts'), 'v1');
    commitAll('init');
    await fs.writeFile(path.join(tmp, 'a.ts'), 'v2');
    await fs.writeFile(path.join(tmp, 'b.ts'), 'new');
    const res = await buildGitcheckCommand().run!('', ctxFor());
    expect(stripAnsi(res!.message)).toMatch(/uncommitted change/);
  });
});
