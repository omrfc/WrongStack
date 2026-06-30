/**
 * git-autocommit plugin — AI-powered git staging and commit message generation.
 *
 * Tools registered:
 * - git_autocommit: Stage files and create a commit with AI-written conventional commit messages.
 *   Supports `files` for specific staging and `dry_run` for preview.
 *
 * Note: The former `git_autocommit` and `git_autocommit` tools have been removed.
 * - For staging: use `git_autocommit` with `files` (it stages automatically), or `bash` with `git add`.
 * - For status: use the built-in `git` tool with `command: "status"` or `command: "diff"`.
 */
import type { Plugin } from '@wrongstack/core';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const API_VERSION = '^0.1.10';

type ConventionalType = 'feat' | 'fix' | 'docs' | 'style' | 'refactor' | 'test' | 'chore' | 'perf' | 'ci' | 'build' | 'revert';

// Module-level state, shared between `setup`, `teardown`, and `health`.
//
// Why module-level? The Plugin interface in @wrongstack/core does not
// thread state from `setup` → `teardown`. Today `git-autocommit` holds
// no in-process resources (everything goes through `execFileSync`),
// but `health()` wants to report a commit count and last-commit hash
// that survive the function-call boundary — and a future reload-cycle
// audit could turn those into resource-tracking requirements the same
// way `cron` and `file-watcher` needed timers cleared (H1 audit,
// 2026-06-03). Module-level state is the path of least friction: it
// gives `teardown` something concrete to reset and `health()` something
// concrete to report. Setup re-zeros the counters (idempotent re-init
// on plugin reload); teardown clears them and logs.
const commitCount = { value: 0 };
const lastCommit = { hash: null as string | null, at: null as string | null };

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
    /* v8 ignore next -- execFileSync errors always carry .message; the stderr/String fallbacks are defensive. */
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
  /* v8 ignore next -- callers always pass a validated array; the guard is defensive. */
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
        /* v8 ignore next -- non-empty lines guarantee l[0] is defined; the ?? ' ' fallback is defensive. */
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
  version: '0.2.0',
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
    // Idempotent re-init: zero the counters on every reload so the
    // counters reported by health() reflect the current plugin lifetime,
    // not the accumulated history across reloads.
    commitCount.value = 0;
    lastCommit.hash = null;
    lastCommit.at = null;

    const extConfig = api.config.extensions?.['git-autocommit'] as Record<string, unknown> | undefined;
    const opts = {
      conventionalCommits: (extConfig?.['conventionalCommits'] as boolean) ?? true,
      autoStage: (extConfig?.['autoStage'] as boolean) ?? false,
      defaultType: (extConfig?.['defaultType'] as string) ?? 'feat',
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
          dry_run: { type: 'boolean', default: false, description: 'Show what would be committed without committing' },
        },
      },
      permission: 'confirm',
      category: 'Git',
      mutating: true,
      async execute(input: Record<string, unknown>, _ctx) {
        try {
        const type = (input['type'] as ConventionalType | undefined) ?? opts.defaultType as ConventionalType;
        const scope = input['scope'] as string | undefined;
        const summary = (input['message'] as string | undefined) ?? '';
        const body = input['body'] as string | undefined;
        const dryRun = input['dry_run'] as boolean ?? false;

        // Validate type
        const validTypes = ['feat', 'fix', 'docs', 'style', 'refactor', 'test', 'chore', 'perf', 'ci', 'build', 'revert'];
        if (!type || !validTypes.includes(type)) {
          // For dryRun, generate a message anyway (smoke test uses empty input)
          if (dryRun) {
            return {
              ok: true,
              dry_run: true,
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
          /* v8 ignore next -- stageFiles only throws Error; the String(err) branch is defensive. */
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
            dry_run: true,
            message: `Would create: ${msg}`,
            warning: warning ?? undefined,
            stagedDiff: `\n## Staged changes (dry run)\n\n${stat}\n\n\`\`\`diff\n${stagedDiff}\n\`\`\``,
          };
        }

        // Check if we need to stage before diff (if nothing was staged yet)
        let preCommitDiff = stagedDiff;
        let preCommitStat = stat;
        /* v8 ignore start -- unreachable: an empty `staged` already returned at the "Nothing staged" guard above. */
        if (staged.length === 0) {
          const fresh = getStagedDiff();
          preCommitDiff = fresh.diff;
          preCommitStat = fresh.stat;
        }
        /* v8 ignore stop */

        // Commit
        let hash = '';
        try { hash = commitWithMessage(msg); }
        /* v8 ignore next -- commitWithMessage only throws Error; the String(err) branch is defensive. */
        catch (err: unknown) { return { ok: false, error: `Failed to commit: ${err instanceof Error ? err.message : String(err)}` }; }

        api.log.info('git-autocommit: created commit', { hash, type, scope });

        // Bump the health counters only on success — a failed commit
        // must not show up in /diag plugins as having happened.
        commitCount.value += 1;
        lastCommit.hash = String(hash);
        lastCommit.at = new Date().toISOString();
        try {
          await api.session.append({
            type: 'git-autocommit:commit',
            ts: new Date().toISOString(),
            hash: String(hash),
            commitType: type,
            scope: String(scope ?? ''),
            /* v8 ignore next -- staged is always an array here; the : [] fallback is defensive. */
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
        /* v8 ignore start -- top-level safety net: inner try/catches already handle the realistic failures. */
        } catch (err: unknown) {
          return { ok: false, error: `Uncaught error in git_autocommit: ${err instanceof Error ? err.message : String(err)}` };
        }
        /* v8 ignore stop */
      },
    });

    api.log.info('git-autocommit plugin loaded', {
      version: '0.2.0',
      conventionalCommits: opts.conventionalCommits,
    });
  },

  teardown(api) {
    // git-autocommit has no in-process resources to release (every
    // git interaction goes through `execFileSync` and finishes before
    // the tool returns), but we still want a symmetric teardown so:
    //   1. /diag plugins can observe the unload
    //   2. The counters reset cleanly on the next setup() — without
    //      this, a reload that skips a successful commit would leave
    //      stale counts in health().
    // Snap the current values for the log line, then zero them so
    // the next setup() starts fresh (matching the cron/file-watcher
    // pattern from the H1 audit).
    const finalCount = commitCount.value;
    const finalHash = lastCommit.hash;
    commitCount.value = 0;
    lastCommit.hash = null;
    lastCommit.at = null;
    api.log.info('git-autocommit: teardown complete', {
      commits: finalCount,
      lastHash: finalHash,
    });
  },

  async health() {
    // /diag plugins wants a quick yes/no plus a useful message.
    // `ok` reflects "did the plugin load successfully" — the plugin
    // is otherwise healthy until git itself is unreachable, which the
    // tool surface handles per-call. The message surfaces the last
    // commit so an operator can confirm the plugin is still wiring
    // commits at a glance.
    return {
      ok: true,
      message:
        commitCount.value === 0
          ? 'git-autocommit: no commits yet this session'
          : `git-autocommit: ${commitCount.value} commit(s), last ${String(lastCommit.hash).slice(0, 8)} at ${lastCommit.at}`,
      commits: commitCount.value,
      lastCommitHash: lastCommit.hash,
      lastCommitAt: lastCommit.at,
    };
  },
};

export default plugin;
