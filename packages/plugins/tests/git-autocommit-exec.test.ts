import { beforeEach, describe, expect, it, vi } from 'vitest';

const cp = vi.hoisted(() => ({ execFileSync: vi.fn() }));
vi.mock('node:child_process', async (o) => ({ ...(await o()), execFileSync: cp.execFileSync }));
const fsm = vi.hoisted(() => ({ existsSync: vi.fn() }));
vi.mock('node:fs', async (o) => ({ ...(await o()), existsSync: fsm.existsSync }));

import gitAutocommitPlugin from '../src/git-autocommit';

interface Tool {
  name: string;
  execute: (input: Record<string, unknown>, ctx?: unknown) => Promise<Record<string, unknown>>;
}

let gitHandler: (args: string[]) => string;
let sessionAppend: ReturnType<typeof vi.fn>;

function setup(extensions: Record<string, unknown> = {}): Record<string, Tool> {
  const tools: Record<string, Tool> = {};
  sessionAppend = vi.fn(async () => {});
  const api = {
    tools: { register: (t: Tool) => { tools[t.name] = t; } },
    config: { extensions },
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    session: { append: sessionAppend },
  };
  gitAutocommitPlugin.setup(api as never);
  return tools;
}

beforeEach(() => {
  cp.execFileSync.mockReset();
  fsm.existsSync.mockReset();
  fsm.existsSync.mockReturnValue(true);
  gitHandler = () => '';
  cp.execFileSync.mockImplementation((_bin: string, args: string[]) => gitHandler(args));
});

const key = (args: string[]) => args.join(' ');

describe('git_autocommit', () => {
  it('dry-runs with an invalid type using a fallback message', async () => {
    const tools = setup();
    const res = await tools.git_autocommit!.execute({ type: 'bogus', dryRun: true });
    expect(res).toMatchObject({ ok: true, dryRun: true });
    expect(res.message).toMatch(/Would create/);
  });

  it('rejects an invalid type on a real (non-dry) run', async () => {
    const tools = setup();
    const res = await tools.git_autocommit!.execute({ type: 'bogus' });
    expect(res).toMatchObject({ ok: false });
    expect(res.error).toMatch(/valid conventional commit type/);
  });

  it('rejects non-array files', async () => {
    const tools = setup();
    const res = await tools.git_autocommit!.execute({ type: 'feat', files: 'a.ts' });
    expect(res.error).toMatch(/files must be an array/);
  });

  it('stages provided files, commits, and appends to the session', async () => {
    gitHandler = (args) => {
      const k = key(args);
      if (k === 'diff --cached --name-only') return 'a.ts';
      if (k.startsWith('commit -m')) return 'deadbeef committed';
      if (k === 'diff --cached --stat') return ' a.ts | 1 +';
      if (k === 'diff --cached') return '+added line';
      return '';
    };
    const tools = setup();
    const res = await tools.git_autocommit!.execute({ type: 'feat', scope: 'core', message: 'add thing', body: 'details', files: ['a.ts'] });
    expect(res.ok).toBe(true);
    expect(res.hash).toBe('deadbeef committed');
    expect(res.message).toBe('feat(core): add thing\n\ndetails');
    expect(res.stagedFiles).toEqual(['a.ts']);
    expect(sessionAppend).toHaveBeenCalledOnce();
  });

  it('reports a staging failure when no provided file exists', async () => {
    fsm.existsSync.mockReturnValue(false);
    const tools = setup();
    const res = await tools.git_autocommit!.execute({ type: 'fix', message: 'x', files: ['ghost.ts'] });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/Failed to stage files/);
  });

  it('auto-detects and stages changed files when nothing is staged', async () => {
    let stagedCalls = 0;
    gitHandler = (args) => {
      const k = key(args);
      if (k === 'diff --cached --name-only') {
        stagedCalls++;
        return stagedCalls === 1 ? '' : 'auto.ts'; // empty first, staged after add
      }
      if (k === 'status --porcelain') return ' M auto.ts';
      if (k.startsWith('commit -m')) return 'cafe01 done';
      if (k === 'diff --cached --stat') return 'stat';
      if (k === 'diff --cached') return 'diff';
      return '';
    };
    const tools = setup();
    const res = await tools.git_autocommit!.execute({ type: 'chore', message: 'auto' });
    expect(res.ok).toBe(true);
    expect(res.stagedFiles).toEqual(['auto.ts']);
  });

  it('returns "Nothing staged" when there is nothing to commit', async () => {
    gitHandler = () => ''; // no staged, no changed
    const tools = setup();
    const res = await tools.git_autocommit!.execute({ type: 'feat', message: 'x' });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/Nothing staged/);
  });

  it('falls back to the default commit type when none is given', async () => {
    gitHandler = (args) => {
      const k = key(args);
      if (k === 'diff --cached --name-only') return 'a.ts';
      if (k.startsWith('commit -m')) return 'h ok';
      return '';
    };
    const tools = setup();
    const res = await tools.git_autocommit!.execute({ message: 'no type given' });
    expect(res.ok).toBe(true);
    expect(res.type).toBe('feat'); // defaultConfig.defaultType
  });

  it('handles staged-file lookups throwing both before and after auto-detect', async () => {
    gitHandler = (args) => {
      const k = key(args);
      if (k === 'diff --cached --name-only') throw new Error('cannot read index');
      if (k === 'status --porcelain') return '?? changed.ts';
      return '';
    };
    const tools = setup();
    const res = await tools.git_autocommit!.execute({ type: 'feat', message: 'x' });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/Nothing staged/);
  });

  it('surfaces worktree and external-change warnings', async () => {
    gitHandler = (args) => {
      const k = key(args);
      if (k === 'diff --cached --name-only') return 'a.ts';
      if (k === 'worktree list --porcelain') {
        return 'worktree /repo\nHEAD abc\nbranch refs/heads/main\n\nworktree /repo/wt\nHEAD def\nbranch refs/heads/feature\n';
      }
      if (k === 'status --porcelain') return '?? new.ts\n M other.ts';
      if (k.startsWith('commit -m')) return 'h1 ok';
      if (k === 'diff --cached --stat') return 'stat';
      if (k === 'diff --cached') return 'diff';
      return '';
    };
    const tools = setup();
    const res = await tools.git_autocommit!.execute({ type: 'feat', message: 'w' });
    expect(res.ok).toBe(true);
    expect(res.warning).toMatch(/Simultaneous edits/);
    expect(res.warning).toMatch(/External changes/);
  });

  it('truncates a very large staged diff in dry run', async () => {
    const big = 'x'.repeat(25_000);
    gitHandler = (args) => {
      const k = key(args);
      if (k === 'diff --cached --name-only') return 'a.ts';
      if (k === 'diff --cached --stat') return 'stat';
      if (k === 'diff --cached') return big;
      return '';
    };
    const tools = setup();
    const res = await tools.git_autocommit!.execute({ type: 'feat', message: 'big', dryRun: true });
    expect(res.dryRun).toBe(true);
    expect(res.stagedDiff).toMatch(/diff truncated/);
  });

  it('reports a commit failure', async () => {
    gitHandler = (args) => {
      const k = key(args);
      if (k === 'diff --cached --name-only') return 'a.ts';
      if (k.startsWith('commit -m')) throw new Error('nothing to commit');
      return '';
    };
    const tools = setup();
    const res = await tools.git_autocommit!.execute({ type: 'feat', message: 'x' });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/Failed to commit/);
  });

  it('tolerates a throwing existsSync during staging', async () => {
    fsm.existsSync.mockImplementation(() => { throw new Error('stat failed'); });
    const tools = setup();
    // No files exist (existsSync throws → treated as absent) → staging fails.
    const res = await tools.git_autocommit!.execute({ type: 'fix', message: 'x', files: ['a.ts'] });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/Failed to stage/);
  });

  it('falls back gracefully when diff/status commands throw', async () => {
    gitHandler = (args) => {
      const k = key(args);
      if (k === 'diff --cached --name-only') return 'a.ts';
      if (k.startsWith('commit -m')) return 'h ok';
      // getStagedDiff and externalChangesSinceStage commands throw → internal catches.
      if (k.startsWith('diff --cached')) throw new Error('diff blew up');
      if (k === 'status --porcelain') throw new Error('status blew up');
      return '';
    };
    const tools = setup();
    const res = await tools.git_autocommit!.execute({ type: 'feat', message: 'x' });
    expect(res.ok).toBe(true);
    expect(res.diff).toMatch(/unavailable/);
  });

  it('summarises more than ten external changes with a +N suffix', async () => {
    const many = Array.from({ length: 12 }, (_, i) => `?? f${i}.ts`).join('\n');
    gitHandler = (args) => {
      const k = key(args);
      if (k === 'diff --cached --name-only') return 'a.ts';
      if (k === 'status --porcelain') return many;
      if (k.startsWith('commit -m')) return 'h ok';
      if (k === 'diff --cached --stat') return 'stat';
      if (k === 'diff --cached') return 'diff';
      return '';
    };
    const tools = setup();
    const res = await tools.git_autocommit!.execute({ type: 'feat', message: 'x' });
    expect(res.warning).toMatch(/and 2 more/);
  });

  it('still succeeds when session.append throws', async () => {
    gitHandler = (args) => {
      const k = key(args);
      if (k === 'diff --cached --name-only') return 'a.ts';
      if (k.startsWith('commit -m')) return 'h ok';
      return '';
    };
    const tools = setup();
    sessionAppend.mockRejectedValue(new Error('disk full'));
    const res = await tools.git_autocommit!.execute({ type: 'feat', message: 'x' });
    expect(res.ok).toBe(true);
  });
});

describe('git_stage', () => {
  it('rejects an empty file list', async () => {
    const tools = setup();
    expect((await tools.git_stage!.execute({ files: [] })).ok).toBe(false);
  });

  it('rejects when files is omitted entirely', async () => {
    const tools = setup();
    const res = await tools.git_stage!.execute({});
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/non-empty array/);
  });

  it('dry-runs without staging', async () => {
    const tools = setup();
    const res = await tools.git_stage!.execute({ files: ['a.ts', 'b.ts'], dryRun: true });
    expect(res).toMatchObject({ ok: true, dryRun: true });
    expect(res.message).toMatch(/Would stage: a.ts, b.ts/);
  });

  it('stages files and reports remaining changes', async () => {
    gitHandler = (args) => (key(args) === 'status --porcelain' ? '?? c.ts' : '');
    const tools = setup();
    const res = await tools.git_stage!.execute({ files: ['a.ts'] });
    expect(res.ok).toBe(true);
    expect(res.staged).toEqual(['a.ts']);
    expect(res.stillChanged).toEqual(['c.ts']);
  });

  it('reports a staging failure', async () => {
    fsm.existsSync.mockReturnValue(false);
    const tools = setup();
    const res = await tools.git_stage!.execute({ files: ['ghost.ts'] });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/Failed to stage/);
  });

  it('tolerates getChangedFiles throwing after staging', async () => {
    gitHandler = (args) => {
      if (key(args) === 'status --porcelain') throw new Error('status failed');
      return '';
    };
    const tools = setup();
    const res = await tools.git_stage!.execute({ files: ['a.ts'] });
    expect(res.ok).toBe(true);
    expect(res.stillChanged).toEqual([]);
  });
});

describe('git_status_summary', () => {
  it('summarises branch, files, commits and worktrees', async () => {
    gitHandler = (args) => {
      const k = key(args);
      if (k === 'branch --show-current') return 'main';
      if (k === 'status --porcelain') return '?? b.ts\n M a.ts';
      if (k === 'diff --cached --name-only') return 'staged.ts';
      if (k === 'status -sb') return '## main...origin/main [ahead 1]';
      if (k.startsWith('log')) return 'h1hash feat: a thing\nh2hash random message';
      if (k === 'worktree list --porcelain') {
        return 'worktree /repo\nHEAD abc\nbranch refs/heads/main\n\nworktree /repo/wt\nHEAD def\nbranch refs/heads/feature\n';
      }
      return '';
    };
    const tools = setup();
    const res = await tools.git_status_summary!.execute({});
    expect(res.ok).toBe(true);
    expect(res.branch).toBe('main');
    expect(res.changedFiles).toEqual(['b.ts', 'a.ts']);
    expect(res.stagedFiles).toEqual(['staged.ts']);
    expect(res.aheadBehind).toMatch(/ahead 1/);
    expect((res.recentCommits as unknown[]).length).toBe(2);
    expect((res.worktrees as unknown[]).length).toBe(2);
    expect(res.worktreeWarning).toMatch(/Simultaneous/);
    expect(res.externalChanges).toEqual(['b.ts', 'a.ts']);
  });

  it('tolerates git failures across the board', async () => {
    gitHandler = () => { throw new Error('not a git repo'); };
    const tools = setup();
    const res = await tools.git_status_summary!.execute({});
    expect(res.ok).toBe(true);
    expect(res.branch).toBe('');
    expect(res.recentCommits).toEqual([]);
    expect(res.worktrees).toEqual([]);
  });

  it('handles an empty git log (no recent commits)', async () => {
    gitHandler = (args) => {
      const k = key(args);
      if (k === 'branch --show-current') return 'main';
      if (k.startsWith('log')) return ''; // empty history → getCommitHistory returns []
      return '';
    };
    const tools = setup();
    const res = await tools.git_status_summary!.execute({});
    expect(res.recentCommits).toEqual([]);
  });
});
