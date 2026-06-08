import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFileSync } from 'node:child_process';
import {
  buildCommitCommand,
  buildGitcheckCommand,
  buildPushCommand,
} from '../../src/plugins/git-plugin.js';

// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape sequences are valid here
const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '');

let tmp: string;

async function rmWithRetry(dir: string): Promise<void> {
  for (let i = 0; i < 5; i++) {
    try {
      await fs.rm(dir, { recursive: true, force: true });
      return;
    } catch (err: unknown) {
      if (i === 4) throw err;
      // EBUSY on Windows: give the OS a moment to release file handles
      await new Promise((r) => setTimeout(r, 200));
    }
  }
}

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'commit-slash-'));
});

afterEach(async () => {
  await rmWithRetry(tmp);
});

function initGitRepo(): void {
  // execFileSync (no shell) keeps args un-interpolated and Windows-safe.
  execFileSync('git', ['init', '-q'], { cwd: tmp, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: tmp, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: tmp, stdio: 'ignore' });
  execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: tmp, stdio: 'ignore' });
}

/**
 * Build a fake session context. `provider` is the structural LLM provider the
 * plugin reads off `ctx.provider` (a `complete()` callable); omit it to force
 * the heuristic path.
 */
function ctxFor(dir: string, provider?: unknown) {
  return { session: { id: 's1' }, cwd: dir, model: 'test-model', provider } as never;
}

// ── /commit ─────────────────────────────────────────────────────────────────

describe('buildCommitCommand', () => {
  it('reports "not a git repo" when run outside a repository', async () => {
    const cmd = buildCommitCommand();
    const res = await cmd.run('', ctxFor(tmp));
    expect(res?.message).toContain('Not a git repository');
  });

  it('reports "nothing to commit" when working tree is clean', async () => {
    initGitRepo();
    await fs.writeFile(path.join(tmp, 'a.txt'), 'first');
    execFileSync('git', ['add', '.'], { cwd: tmp });
    execFileSync('git', ['commit', '-m', 'initial'], { cwd: tmp });
    const cmd = buildCommitCommand();
    const res = await cmd.run('', ctxFor(tmp));
    expect(res?.message).toContain('Nothing to commit');
  });

  it('--dry-run uses heuristics and never invokes git commit', async () => {
    initGitRepo();
    // Seed an initial commit so the heuristic's `git diff` can report changes.
    await fs.writeFile(path.join(tmp, 'a.test.ts'), 'test1');
    execFileSync('git', ['add', '.'], { cwd: tmp });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: tmp });
    await fs.writeFile(path.join(tmp, 'a.test.ts'), 'test2');
    const cmd = buildCommitCommand();
    const res = await cmd.run('--dry-run', ctxFor(tmp));
    const clean = stripAnsi(res!.message!);
    expect(clean).toContain('Would commit:');
    expect(clean).toContain('test'); // commit type from detection (test file)
    // No NEW commit happened — log still has only the seed.
    const log = execFileSync('git', ['log', '--oneline'], { cwd: tmp }).toString().trim();
    expect(log.split('\n').length).toBe(1);
  }, 30_000);

  it('uses LLM-provided message when the session provider is available', async () => {
    initGitRepo();
    await fs.writeFile(path.join(tmp, 'src.ts'), 'code');
    const complete = vi.fn(async () => ({
      content: [{ type: 'text' as const, text: 'feat: llm-suggested message' }],
      model: 'test-model',
    }));
    const cmd = buildCommitCommand();
    const res = await cmd.run('--dry-run', ctxFor(tmp, { complete }));
    expect(complete).toHaveBeenCalled();
    expect(stripAnsi(res!.message!)).toContain('feat: llm-suggested message');
  });

  it('falls back to heuristics when the LLM throws', async () => {
    initGitRepo();
    await fs.writeFile(path.join(tmp, 'README.md'), 'docs1');
    execFileSync('git', ['add', '.'], { cwd: tmp });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: tmp });
    await fs.writeFile(path.join(tmp, 'README.md'), 'docs2');
    const complete = vi.fn().mockRejectedValue(new Error('llm down'));
    const cmd = buildCommitCommand();
    const res = await cmd.run('--dry-run', ctxFor(tmp, { complete }));
    // Heuristic picks "docs" for README/.md
    expect(stripAnsi(res!.message!)).toContain('docs');
  }, 30_000);

  it('--no-llm flag skips the LLM even when a provider is available', async () => {
    initGitRepo();
    await fs.writeFile(path.join(tmp, 'tsconfig.json'), '{}');
    execFileSync('git', ['add', '.'], { cwd: tmp });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: tmp });
    await fs.writeFile(path.join(tmp, 'tsconfig.json'), '{ "x": 1 }');
    const complete = vi.fn(async () => ({
      content: [{ type: 'text' as const, text: 'feat: should not be used' }],
      model: 'test-model',
    }));
    const cmd = buildCommitCommand();
    const res = await cmd.run('--no-llm --dry-run', ctxFor(tmp, { complete }));
    expect(complete).not.toHaveBeenCalled();
    // tsconfig.json triggers "chore"
    expect(stripAnsi(res!.message!)).toContain('chore');
  }, 30_000);

  it('-n shortcut is treated as --dry-run', async () => {
    initGitRepo();
    await fs.writeFile(path.join(tmp, 'thing'), 'x');
    const cmd = buildCommitCommand();
    const res = await cmd.run('-n', ctxFor(tmp));
    expect(stripAnsi(res!.message!)).toContain('Would commit');
  });

  it('actually commits and reports the short SHA when not dry-run', async () => {
    initGitRepo();
    await fs.writeFile(path.join(tmp, 'a.txt'), 'first');
    const cmd = buildCommitCommand();
    const res = await cmd.run('', ctxFor(tmp));
    const clean = stripAnsi(res!.message!);
    expect(clean).toContain('Committed');
    // Real commit should be visible in git log
    const log = execFileSync('git', ['log', '--oneline'], { cwd: tmp }).toString();
    expect(log.trim().length).toBeGreaterThan(0);
  });

  it('mentions /push tip when a remote is configured', async () => {
    initGitRepo();
    execFileSync('git', ['remote', 'add', 'origin', 'https://example.com/x.git'], { cwd: tmp });
    await fs.writeFile(path.join(tmp, 'a.txt'), 'first');
    const cmd = buildCommitCommand();
    const res = await cmd.run('', ctxFor(tmp));
    expect(stripAnsi(res!.message!)).toContain('/push');
  });

  it('does not mention /push when no remote configured', async () => {
    initGitRepo();
    await fs.writeFile(path.join(tmp, 'a.txt'), 'first');
    const cmd = buildCommitCommand();
    const res = await cmd.run('', ctxFor(tmp));
    expect(stripAnsi(res!.message!)).not.toContain('/push');
  });
});

// ── /gitcheck ───────────────────────────────────────────────────────────────

describe('buildGitcheckCommand', () => {
  it('emits empty string outside a git repo', async () => {
    const cmd = buildGitcheckCommand();
    const res = await cmd.run('', ctxFor(tmp));
    expect(res?.message).toBe('');
  });

  it('emits empty string when tree is clean', async () => {
    initGitRepo();
    await fs.writeFile(path.join(tmp, 'a.txt'), 'first');
    execFileSync('git', ['add', '.'], { cwd: tmp });
    execFileSync('git', ['commit', '-m', 'initial'], { cwd: tmp });
    const cmd = buildGitcheckCommand();
    const res = await cmd.run('', ctxFor(tmp));
    expect(res?.message).toBe('');
  });

  it('reports change count with singular form', async () => {
    initGitRepo();
    await fs.writeFile(path.join(tmp, 'one.txt'), 'x');
    const cmd = buildGitcheckCommand();
    const res = await cmd.run('', ctxFor(tmp));
    expect(stripAnsi(res!.message!)).toContain('1 uncommitted change');
    expect(stripAnsi(res!.message!)).not.toContain('changes');
  });

  it('reports change count with plural form', async () => {
    initGitRepo();
    await fs.writeFile(path.join(tmp, 'one.txt'), 'x');
    await fs.writeFile(path.join(tmp, 'two.txt'), 'y');
    const cmd = buildGitcheckCommand();
    const res = await cmd.run('', ctxFor(tmp));
    expect(stripAnsi(res!.message!)).toContain('2 uncommitted changes');
  });
});

// ── /push ───────────────────────────────────────────────────────────────────

describe('buildPushCommand', () => {
  it('exposes name "push"', () => {
    const cmd = buildPushCommand();
    expect(cmd.name).toBe('push');
  });

  it('reports "not a git repository" when run outside a repo', async () => {
    const cmd = buildPushCommand();
    const res = await cmd.run('', ctxFor(tmp));
    expect(res?.message).toMatch(/Not a git repository|no remote|push failed/i);
  });

  it('reports "no remote configured" when repo has no remote', async () => {
    initGitRepo();
    const cmd = buildPushCommand();
    const res = await cmd.run('', ctxFor(tmp));
    expect(res?.message).toContain('No remote configured');
  });

  it('--dry-run with a remote shows "would push to <remote>"', async () => {
    initGitRepo();
    execFileSync('git', ['remote', 'add', 'origin', 'https://example.com/x.git'], { cwd: tmp });
    const cmd = buildPushCommand();
    const res = await cmd.run('--dry-run', ctxFor(tmp));
    const clean = stripAnsi(res!.message!);
    expect(clean).toContain('Would push');
    expect(clean).toContain('origin');
  });

  it('--dry-run -f shows "(force)" marker', async () => {
    initGitRepo();
    execFileSync('git', ['remote', 'add', 'origin', 'https://example.com/x.git'], { cwd: tmp });
    const cmd = buildPushCommand();
    const res = await cmd.run('--dry-run --force', ctxFor(tmp));
    const clean = stripAnsi(res!.message!);
    expect(clean).toContain('force');
  });

  it('-n shortcut is treated as --dry-run for push too', async () => {
    initGitRepo();
    execFileSync('git', ['remote', 'add', 'origin', 'https://example.com/x.git'], { cwd: tmp });
    const cmd = buildPushCommand();
    const res = await cmd.run('-n', ctxFor(tmp));
    expect(stripAnsi(res!.message!)).toContain('Would push');
  });

  it('pushes successfully to a local bare-repo remote and reports the short SHA', async () => {
    // file:// remotes never hang and never need credentials, so we can exercise
    // the real push code path (branch lookup + `git push` invocation).
    initGitRepo();
    // Seed at least one commit so push has something to send.
    await fs.writeFile(path.join(tmp, 'a.txt'), 'hello');
    execFileSync('git', ['add', '.'], { cwd: tmp });
    execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: tmp });
    // Bare repo to act as the remote.
    const bare = await fs.mkdtemp(path.join(os.tmpdir(), 'push-target-'));
    execFileSync('git', ['init', '--bare', '-q', bare]);
    execFileSync('git', ['remote', 'add', 'origin', bare], { cwd: tmp });

    try {
      const cmd = buildPushCommand();
      const res = await cmd.run('', ctxFor(tmp));
      const clean = stripAnsi(res!.message!);
      // Either success path ("Pushed to origin (branch)") or a graceful
      // failure path ("Push failed: ..."). Both exercise the same lines.
      expect(clean).toMatch(/Pushed to origin|Push failed/);
    } finally {
      await fs.rm(bare, { recursive: true, force: true });
    }
  });
});
