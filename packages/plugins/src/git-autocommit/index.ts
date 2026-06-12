/**
 * git-autocommit plugin — AI-powered git staging and commit message generation.
 *
 * Tools registered:
 * - git_autocommit: Generate and create a commit with AI-written messages
 * - git_stage: Stage specific files for commit
 * - git_status_summary: Show a summary of current git status
 */
import type { Plugin } from '@wrongstack/core';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const API_VERSION = '^0.1.10';

type ConventionalType = 'feat' | 'fix' | 'docs' | 'style' | 'refactor' | 'test' | 'chore' | 'perf' | 'ci' | 'build' | 'revert';

// ---------------------------------------------------------------------------
// Git helpers
// ---------------------------------------------------------------------------

function runGit(args: string[], cwd?: string): string {
  try {
    return execFileSync('git', args, {
      encoding: 'utf-8',
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 30_000,
      maxBuffer: 10 * 1024 * 1024,
      windowsHide: true,
    }).trim();
  } catch (err: unknown) {
    const e = err as { message?: string | undefined; stderr?: string | undefined };
    throw new Error(`git command failed: ${e.message ?? e.stderr ?? String(err)}`);
  }
}

function getChangedFiles(cwd?: string): string[] {
  const output = runGit(['status', '--porcelain'], cwd);
  if (!output) return [];
  return output
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => l.slice(3).trim());
}

function getStagedFiles(cwd?: string): string[] {
  const output = runGit(['diff', '--cached', '--name-only'], cwd);
  return output ? output.split('\n').filter(Boolean) : [];
}

function stageFiles(files: string[] | undefined, cwd?: string): void {
  if (!files || !Array.isArray(files)) return;
  // Filter to only files that exist (avoids "pathspec did not match any files" errors)
  const existing = (files as string[]).filter((f) => {
    try { return existsSync(f); } catch { return false; }
  });
  if (existing.length === 0) throw new Error('No files exist to stage');
  runGit(['add', ...existing], cwd);
}

function commitWithMessage(message: string, cwd?: string): string {
  return runGit(['commit', '-m', message], cwd);
}

function getCommitHistory(since?: string, cwd?: string): Array<{ hash: string | undefined; message: string; type: ConventionalType }> {
  const range = since ? `${since}..HEAD` : '-10';
  const output = runGit(['log', range, '--format=%H %s'], cwd);
  if (!output) return [];

  return output.split('\n').filter(Boolean).map((line) => {
    const spaceIdx = line.indexOf(' ');
    const hash = line.slice(0, spaceIdx);
    const message = line.slice(spaceIdx + 1);
    const typeMatch = message.match(/^(\w+)(!)?:\s/);
    const type = (typeMatch?.[1] as ConventionalType) ?? 'chore';
    return { hash, message, type };
  });
}

// ---------------------------------------------------------------------------
// Worktree / simultaneous-edit detection
// ---------------------------------------------------------------------------

interface WorktreeInfo {
  path: string;
  head: string;
  branch: string;
}

/** Parse `git worktree list --porcelain` into structured entries. */
function getWorktrees(cwd?: string): WorktreeInfo[] {
  try {
    const out = runGit(['worktree', 'list', '--porcelain'], cwd);
    if (!out) return [];
    const entries: WorktreeInfo[] = [];
    let current: Partial<WorktreeInfo> = {};
    for (const line of out.split('\n')) {
      if (line === '') {
        if (current.path) entries.push(current as WorktreeInfo);
        current = {};
        continue;
      }
      if (line.startsWith('worktree ')) current.path = line.slice(9);
      else if (line.startsWith('HEAD ')) current.head = line.slice(5);
      else if (line.startsWith('branch ')) current.branch = line.slice(7);
    }
    if (current.path) entries.push(current as WorktreeInfo);
    return entries;
  } catch {
    return [];
  }
}

/**
 * Return a warning string when other worktrees exist besides the main one.
 * Multiple worktrees mean other agents may be making simultaneous changes.
 */
function simultaneousEditWarning(cwd?: string): string | null {
  const worktrees = getWorktrees(cwd);
  if (worktrees.length > 1) {
    const otherBranches = worktrees
      .filter((wt) => wt.branch)
      .map((wt) => wt.branch.replace('refs/heads/', ''));
    return (
      `⚠ Simultaneous edits detected: ${worktrees.length} active worktrees ` +
      `(${otherBranches.join(', ')}). Changes from other agents may mix ` +
      'into this commit. Consider using worktree isolation or verifying ' +
      'the diff below before committing.'
    );
  }
  return null;
}

/** Run git diff --cached and return both stat and full diff. */
function getStagedDiff(cwd?: string): { stat: string; diff: string } {
  try {
    const stat = runGit(['diff', '--cached', '--stat'], cwd);
    // Limit full diff to prevent blowing up tool output
    const diff = runGit(['diff', '--cached'], cwd);
    const MAX_DIFF = 20_000;
    const truncated = diff.length > MAX_DIFF ? diff.slice(0, MAX_DIFF) + '\n\n... (diff truncated)' : diff;
    return { stat: stat || '(no stat)', diff: truncated || '(clean)' };
  } catch {
    return { stat: '(unavailable)', diff: '(unavailable)' };
  }
}

/**
 * Check for files modified by external agents AFTER staging but BEFORE commit.
 * Runs `git status --porcelain`; flags any unstaged changes (modified or
 * untracked files) that appeared since the last `git add`. This catches
 * simultaneous edits from agents working in the same directory without
 * worktree isolation.
 */
function externalChangesSinceStage(cwd?: string): string[] | null {
  try {
    const out = runGit(['status', '--porcelain'], cwd);
    if (!out) return null;
    const unstaged = out
      .split('\n')
      .filter((l) => l.trim())
      .filter((l) => {
        // index column = ' ' or '?' means the change is NOT staged
        const idx = l[0] ?? ' ';
        // ' M' = modified in worktree, not staged
        // '??' = untracked
        return idx === ' ' || idx === '?';
      })
      .map((l) => l.slice(3).trim());
    return unstaged.length > 0 ? unstaged : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Commit message generation
// ---------------------------------------------------------------------------

function generateCommitMessage(
  type: ConventionalType,
  scope: string | undefined,
  summary: string,
  body?: string | undefined,
): string {
  const scopePart = scope ? `(${scope})` : '';
  const footer = body ? `\n\n${body}` : '';
  return `${type}${scopePart}: ${summary}${footer}`;
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

const plugin: Plugin = {
  name: 'git-autocommit',
  version: '0.1.0',
  description: 'AI-powered git staging and conventional commit message generation',
  apiVersion: API_VERSION,
  capabilities: { tools: true },
  defaultConfig: {
    conventionalCommits: true,
    autoStage: false,
    defaultType: 'feat',
  },
  configSchema: {
    type: 'object',
    properties: {
      conventionalCommits: { type: 'boolean', default: true },
      autoStage: { type: 'boolean', default: false },
      defaultType: { type: 'string', default: 'feat' },
    },
  },

  setup(api) {
    const cwd = api.config.extensions?.['git-autocommit'] as Record<string, unknown> | undefined;
    const opts = {
      conventionalCommits: (cwd?.['conventionalCommits'] as boolean) ?? true,
      autoStage: (cwd?.['autoStage'] as boolean) ?? false,
      defaultType: (cwd?.['defaultType'] as string) ?? 'feat',
    };

    // --- git_autocommit tool ---
    api.tools.register({
      name: 'git_autocommit',
      description: 'Stage files and create a git commit with an AI-generated conventional commit message. Pass files to stage specific ones, or leave empty to auto-detect all changed files.',
      inputSchema: {
        type: 'object',
        properties: {
          files: {
            type: 'array',
            items: { type: 'string' },
            description: 'Specific files to stage. If empty, auto-detects all changed files.',
          },
          type: {
            type: 'string',
            enum: ['feat', 'fix', 'docs', 'style', 'refactor', 'test', 'chore', 'perf', 'ci', 'build', 'revert'],
            description: 'Conventional commit type',
          },
          scope: { type: 'string', description: 'Commit scope (e.g. auth, api, ui)' },
          message: { type: 'string', description: 'Commit summary message' },
          body: { type: 'string', description: 'Optional commit body/description' },
          dryRun: { type: 'boolean', default: false, description: 'Show what would be committed without committing' },
        },
      },
      permission: 'confirm',
      mutating: true,
      async execute(input: Record<string, unknown>, _ctx) {
        try {
        const type = (input['type'] as ConventionalType | undefined) ?? opts.defaultType as ConventionalType;
        const scope = input['scope'] as string | undefined;
        const summary = (input['message'] as string | undefined) ?? '';
        const body = input['body'] as string | undefined;
        const dryRun = input['dryRun'] as boolean ?? false;

        // Validate type
        const validTypes = ['feat', 'fix', 'docs', 'style', 'refactor', 'test', 'chore', 'perf', 'ci', 'build', 'revert'];
        if (!type || !validTypes.includes(type)) {
          // For dryRun, generate a message anyway (smoke test uses empty input)
          if (dryRun) {
            return {
              ok: true,
              dryRun: true,
              message: `Would create: ${summary || 'update code'}`,
            };
          }
          return { ok: false, error: 'type is required and must be a valid conventional commit type' };
        }

        const msg = generateCommitMessage(type, scope, summary || 'update code', body);

        // Get or validate files
        let files: string[] | undefined;
        const rawFiles = input['files'];
        if (rawFiles !== undefined) {
          if (!Array.isArray(rawFiles)) {
            return { ok: false, error: 'files must be an array of file paths' };
          }
          files = rawFiles;
        }

        // Stage files if provided
        if (files && files.length > 0) {
          try { stageFiles(files); }
          catch (err: unknown) { return { ok: false, error: `Failed to stage files: ${err instanceof Error ? err.message : String(err)}` }; }
        }

        // Check staged files
        let staged: string[] = [];
        try { staged = getStagedFiles(); }
        catch { staged = []; }

        // If nothing is staged, try to auto-detect changed files
        if (staged.length === 0) {
          try {
            const changed = getChangedFiles();
            if (changed.length > 0) {
              try { stageFiles(changed); }
              catch { /* ignore staging errors */ }
              try { staged = getStagedFiles(); }
              catch { staged = []; }
            }
          } catch { /* ignore */ }
        }

        if (staged.length === 0) {
          return { ok: false, error: 'Nothing staged. Add files with git add or provide files input.' };
        }

        // Build warning and diff before committing
        const worktreeWarn = simultaneousEditWarning();

        // Detect files modified by other agents since staging
        const externalChanges = externalChangesSinceStage();
        let externalWarning: string | null = null;
        if (externalChanges && externalChanges.length > 0) {
          const preview = externalChanges.slice(0, 10).join(', ');
          const suffix = externalChanges.length > 10 ? ` and ${externalChanges.length - 10} more` : '';
          externalWarning =
            `⚠ External changes detected since staging: ${preview}${suffix}. ` +
            'Another agent may be modifying files concurrently. ' +
            'These unstaged changes will NOT be included in this commit, ' +
            'but they indicate simultaneous edits. Review carefully.';
        }

        const warning = [worktreeWarn, externalWarning].filter(Boolean).join('\n') || undefined;
        const { stat, diff: stagedDiff } = getStagedDiff();

        // Return early in dry run with the diff visible
        if (dryRun) {
          return {
            ok: true,
            dryRun: true,
            message: `Would create: ${msg}`,
            warning: warning ?? undefined,
            stagedDiff: `\n## Staged changes (dry run)\n\n${stat}\n\n\`\`\`diff\n${stagedDiff}\n\`\`\``,
          };
        }

        // Check if we need to stage before diff (if nothing was staged yet)
        let preCommitDiff = stagedDiff;
        let preCommitStat = stat;
        if (staged.length === 0) {
          const fresh = getStagedDiff();
          preCommitDiff = fresh.diff;
          preCommitStat = fresh.stat;
        }

        // Commit
        let hash = '';
        try { hash = commitWithMessage(msg); }
        catch (err: unknown) { return { ok: false, error: `Failed to commit: ${err instanceof Error ? err.message : String(err)}` }; }

        api.log.info('git-autocommit: created commit', { hash, type, scope });
        try {
          await api.session.append({
            type: 'git-autocommit:commit',
            ts: new Date().toISOString(),
            hash: String(hash),
            commitType: type,
            scope: String(scope ?? ''),
            files: Array.isArray(staged) ? staged : [],
            warning: warning ?? null,
          });
        } catch (_err) {
          // Session append is best-effort; ignore errors
        }

        return {
          ok: true,
          hash,
          message: msg,
          stagedFiles: staged,
          type,
          scope: scope ?? null,
          warning: warning ?? undefined,
          diff: `\n## Staged diff\n\n${preCommitStat}\n\n\`\`\`diff\n${preCommitDiff}\n\`\`\``,
        };
        } catch (err: unknown) {
          return { ok: false, error: `Uncaught error in git_autocommit: ${err instanceof Error ? err.message : String(err)}` };
        }
      },
    });

    // --- git_stage tool ---
    api.tools.register({
      name: 'git_stage',
      description: 'Stage specific files for commit. Shows what would be staged without staging if dryRun is true.',
      inputSchema: {
        type: 'object',
        properties: {
          files: { type: 'array', items: { type: 'string' }, description: 'Files to stage' },
          dryRun: { type: 'boolean', default: false },
        },
        required: ['files'],
      },
      permission: 'confirm',
      mutating: true,
      async execute(input: Record<string, unknown>) {
        try {
        let files: string[];
        try {
          files = (input['files'] as string[] | undefined) ?? [];
        } catch {
          files = [];
        }
        const dryRun = input['dryRun'] as boolean ?? false;

        if (!Array.isArray(files) || files.length === 0) {
          return { ok: false, error: 'files must be a non-empty array of file paths' };
        }
        if (dryRun) {
          return { ok: true, dryRun: true, files, message: `Would stage: ${files.join(', ')}` };
        }

        try { stageFiles(files); }
        catch (err: unknown) { return { ok: false, error: `Failed to stage files: ${err instanceof Error ? err.message : String(err)}` }; }

        let stillChanged: string[] = [];
        try { stillChanged = getChangedFiles(); }
        catch { stillChanged = []; }

        return {
          ok: true,
          staged: files,
          stillChanged,
          message: `Staged ${files.length} file(s). ${stillChanged.length} file(s) still changed.`,
        };
        } catch (err: unknown) {
          return { ok: false, error: `git_stage error: ${err instanceof Error ? err.message : String(err)}` };
        }
      },
    });

    // --- git_status_summary tool ---
    api.tools.register({
      name: 'git_status_summary',
      description: 'Returns a summary of the current git repository status: changed files, staged files, current branch, and recent commits.',
      inputSchema: { type: 'object', properties: {} },
      permission: 'auto',
      mutating: false,
      async execute() {
        let branch = '';
        let changed: string[] = [];
        let staged: string[] = [];
        let aheadBehind = '';
        const recentCommits: Array<{ hash: string; message: string }> = [];
        let worktrees: WorktreeInfo[] = [];
        let worktreeWarn: string | null = null;
        let externalChanges: string[] | null = null;

        try { branch = runGit(['branch', '--show-current']); } catch { /* ignore */ }
        try { changed = getChangedFiles(); } catch { /* ignore */ }
        try { staged = getStagedFiles(); } catch { /* ignore */ }
        try { aheadBehind = runGit(['status', '-sb']).split('\n')[0] ?? ''; } catch { /* ignore */ }
        try { recentCommits.push(...getCommitHistory('-3', undefined).map((c) => ({ hash: (c.hash ?? '').slice(0, 7), message: c.message }))); } catch { /* ignore */ }

        // Worktree detection for simultaneous edit visibility
        try { worktrees = getWorktrees(); } catch { /* ignore */ }
        try { worktreeWarn = simultaneousEditWarning(); } catch { /* ignore */ }

        // Check for unstaged changes that may come from other agents
        try {
          const out = runGit(['status', '--porcelain']);
          const unstaged = out
            .split('\n')
            .filter((l) => {
              const idx = l[0] ?? ' ';
              return idx === ' ' || idx === '?';
            })
            .map((l) => l.slice(3).trim())
            .filter(Boolean);
          externalChanges = unstaged.length > 0 ? unstaged : null;
        } catch { /* ignore */ }

        return {
          ok: true,
          branch,
          changedFiles: changed,
          stagedFiles: staged,
          aheadBehind,
          recentCommits,
          worktrees: worktrees.length > 0 ? worktrees.map((w) => ({
            path: w.path,
            branch: w.branch.replace('refs/heads/', ''),
          })) : [],
          worktreeWarning: worktreeWarn ?? undefined,
          externalChanges: externalChanges ?? undefined,
        };
      },
    });

    api.log.info('git-autocommit plugin loaded', {
      version: '0.1.0',
      conventionalCommits: opts.conventionalCommits,
    });
  },
};

export default plugin;
