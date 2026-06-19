/**
 * commit-safety — detect when a commit would sweep up work that this session
 * did NOT author.
 *
 * When several coding agents (or a separate wrongstack process, or a human)
 * edit the same worktree at once, a blanket `git add .` / commit-all captures
 * everyone's uncommitted changes — including half-finished work from another
 * agent. There is no way to un-bake that once it lands in a shared commit.
 *
 * This module reads the working tree and cross-references it against the
 * per-project {@link file-author-tracker} log (which records the sessionId that
 * created/edited each file). Dirty files whose latest author is a DIFFERENT
 * session are flagged as "foreign"; dirty files with no recorded author are
 * "unverified" (a concurrent non-wrongstack agent, a build/format step, or a
 * human). The result is a plain-text warning callers render before committing.
 *
 * Warn-only by design: this never blocks or rewrites what gets committed — it
 * surfaces the risk so the agent (or user) can scope the commit to its own
 * files or coordinate first.
 *
 * @module commit-safety
 */

import { spawn } from 'node:child_process';
import * as path from 'node:path';
import { buildChildEnv } from '../utils/child-env.js';
import { resolveWstackPaths } from '../utils/wstack-paths.js';
import { type FileAuthorEntry, getFullLog } from './file-author-tracker.js';

export interface CommitSafetyOptions {
  /** Directory to run git in (the agent's cwd is fine). */
  cwd: string;
  /** Project root, used to locate the file-author log. */
  projectRoot: string;
  /**
   * The current session's id — the "self" key. Dirty files authored by a
   * different sessionId are flagged as foreign. When omitted, every authored
   * file counts as foreign (we cannot prove ownership).
   */
  sessionId?: string | undefined;
  /**
   * Directory holding the file-author log. Defaults to the resolved per-project
   * dir (`~/.wrongstack/projects/<slug>`). Mainly an injection seam for tests.
   */
  storageDir?: string | undefined;
  /** Abort signal for the git subprocesses. */
  signal?: AbortSignal | undefined;
}

export interface ForeignFile {
  /** Repo-relative path. */
  path: string;
  /** Human-readable name of the agent that last authored it, if known. */
  agentName?: string | undefined;
  /** Session that last authored it, if known. */
  sessionId?: string | undefined;
}

export interface CommitSafetyReport {
  /** Total uncommitted (staged + unstaged + untracked) paths. */
  dirtyCount: number;
  /** Dirty files whose latest recorded author is a DIFFERENT session. */
  foreignFiles: ForeignFile[];
  /** Dirty files with no recorded author for any session. */
  unverifiedFiles: string[];
  /** Branch names of OTHER active worktrees of this repo (excludes ours). */
  otherWorktrees: string[];
  /**
   * Pre-formatted, plain-text (no ANSI) multi-line warning, or '' when there
   * is nothing notable to surface. Callers may colorize/wrap as they see fit.
   */
  warning: string;
}

const GIT_TIMEOUT_MS = 10_000;
const MAX_LISTED = 12;

/**
 * Assess whether committing now risks capturing another agent's work.
 *
 * Best-effort: any git failure (not a repo, git missing, timeout) yields an
 * empty report rather than throwing — commit-safety must never break a commit.
 */
export async function assessCommitSafety(opts: CommitSafetyOptions): Promise<CommitSafetyReport> {
  const empty: CommitSafetyReport = {
    dirtyCount: 0,
    foreignFiles: [],
    unverifiedFiles: [],
    otherWorktrees: [],
    warning: '',
  };

  let dirty: string[];
  let topLevel: string;
  try {
    [dirty, topLevel] = await Promise.all([
      gitDirtyFiles(opts.cwd, opts.signal),
      gitTopLevel(opts.cwd, opts.signal),
    ]);
  } catch {
    return empty;
  }
  if (dirty.length === 0) return empty;

  const otherWorktrees = await gitOtherWorktrees(opts.cwd, opts.signal).catch(() => []);

  // Build a path → latest-author map from the per-project tracker log. Best
  // effort: if the log is missing/corrupt, every dirty file is "unverified".
  const authors = await loadAuthorMap(opts.projectRoot, opts.storageDir).catch(
    () => new Map<string, FileAuthorEntry>(),
  );

  const foreignFiles: ForeignFile[] = [];
  const unverifiedFiles: string[] = [];

  for (const rel of dirty) {
    const abs = path.resolve(topLevel, rel);
    const entry = authors.get(normPath(abs)) ?? authors.get(normPath(rel));
    if (!entry) {
      unverifiedFiles.push(rel);
      continue;
    }
    // A file last authored by THIS session is ours — never flag it.
    if (opts.sessionId && entry.sessionId === opts.sessionId) continue;
    foreignFiles.push({
      path: rel,
      agentName: entry.agentName ?? entry.agentId,
      sessionId: entry.sessionId,
    });
  }

  // "Unverified" files (no recorded author) are only a credible concurrency
  // signal when we can prove this session is actively tracked — i.e. at least
  // one dirty/known file was authored by us. Otherwise (fresh repo, solo run,
  // bash-driven edits, build artifacts) flagging every untracked file would
  // cry wolf on ordinary commits, so we keep them as data but don't warn.
  const sessionTracked =
    !!opts.sessionId && [...authors.values()].some((e) => e.sessionId === opts.sessionId);

  const warning = formatWarning(
    dirty.length,
    foreignFiles,
    sessionTracked ? unverifiedFiles : [],
    otherWorktrees,
  );

  return {
    dirtyCount: dirty.length,
    foreignFiles,
    unverifiedFiles,
    otherWorktrees,
    warning,
  };
}

// ── formatting ──────────────────────────────────────────────────────

function formatWarning(
  dirtyCount: number,
  foreign: ForeignFile[],
  unverified: string[],
  otherWorktrees: string[],
): string {
  // Nothing to say: every dirty file is provably ours and no sibling worktrees.
  if (foreign.length === 0 && unverified.length === 0 && otherWorktrees.length === 0) {
    return '';
  }

  const lines: string[] = [];
  const notOurs = foreign.length + unverified.length;
  if (notOurs > 0) {
    lines.push(
      `⚠ Shared-worktree warning: ${notOurs} of ${dirtyCount} uncommitted change(s) ` +
        `were NOT recorded as authored by this session.`,
    );
  } else {
    lines.push(`⚠ Shared-worktree warning: other active worktrees detected.`);
  }

  if (foreign.length > 0) {
    lines.push(`  Authored by another agent/session:`);
    for (const f of foreign.slice(0, MAX_LISTED)) {
      lines.push(`    - ${f.path}${f.agentName ? ` (by ${f.agentName})` : ''}`);
    }
    if (foreign.length > MAX_LISTED) {
      lines.push(`    … and ${foreign.length - MAX_LISTED} more`);
    }
  }

  if (unverified.length > 0) {
    lines.push(`  Unverified author (concurrent agent, build/format step, or human):`);
    for (const p of unverified.slice(0, MAX_LISTED)) {
      lines.push(`    - ${p}`);
    }
    if (unverified.length > MAX_LISTED) {
      lines.push(`    … and ${unverified.length - MAX_LISTED} more`);
    }
  }

  if (otherWorktrees.length > 0) {
    lines.push(`  Other active worktrees: ${otherWorktrees.join(', ')}`);
  }

  lines.push(`  Committing all of these may capture half-done work from another agent.`);
  lines.push(`  Prefer committing only the files you changed (pass an explicit file list),`);
  lines.push(`  or coordinate before sweeping the whole working tree.`);

  return lines.join('\n');
}

// ── author map ──────────────────────────────────────────────────────

async function loadAuthorMap(
  projectRoot: string,
  storageDirOverride?: string,
): Promise<Map<string, FileAuthorEntry>> {
  const storageDir = storageDirOverride ?? resolveWstackPaths({ projectRoot }).projectDir;
  const log = await getFullLog({ storageDir, projectRoot });
  const map = new Map<string, FileAuthorEntry>();
  // Newest last → later writes overwrite, leaving the latest author per path.
  for (const e of log.entries) {
    map.set(normPath(e.filePath), e);
    // Also key by the absolute form so a relative tracker path matches an
    // absolute lookup (and vice-versa) regardless of how the tool recorded it.
    if (!path.isAbsolute(e.filePath)) {
      map.set(normPath(path.resolve(projectRoot, e.filePath)), e);
    }
  }
  return map;
}

/** Normalize a path for cross-platform comparison (slashes + win32 casing). */
function normPath(p: string): string {
  const slashed = p.replace(/\\/g, '/');
  return process.platform === 'win32' ? slashed.toLowerCase() : slashed;
}

// ── git plumbing ────────────────────────────────────────────────────

async function gitDirtyFiles(cwd: string, signal?: AbortSignal): Promise<string[]> {
  const out = await runGit(['status', '--porcelain'], cwd, signal);
  const files: string[] = [];
  for (const line of out.split('\n')) {
    if (line.length < 4) continue;
    // Format: "XY <path>" or "XY <orig> -> <path>" for renames/copies.
    let p = line.slice(3);
    const arrow = p.indexOf(' -> ');
    if (arrow !== -1) p = p.slice(arrow + 4);
    p = unquoteGitPath(p.trim());
    if (p) files.push(p);
  }
  return files;
}

/** git quotes paths with special chars in double quotes — strip them. */
function unquoteGitPath(p: string): string {
  if (p.startsWith('"') && p.endsWith('"') && p.length >= 2) {
    return p.slice(1, -1);
  }
  return p;
}

async function gitTopLevel(cwd: string, signal?: AbortSignal): Promise<string> {
  const out = await runGit(['rev-parse', '--show-toplevel'], cwd, signal);
  return out.trim() || cwd;
}

async function gitOtherWorktrees(cwd: string, signal?: AbortSignal): Promise<string[]> {
  const out = await runGit(['worktree', 'list', '--porcelain'], cwd, signal);
  const blocks = out.split('\n\n').filter((b) => b.trim().startsWith('worktree '));
  if (blocks.length <= 1) return [];
  // The first block is the main worktree; the current cwd may be any of them.
  // We can't reliably tell which block is "ours" from list output alone, so
  // report every branch and let the count (>1) drive the warning.
  const branches: string[] = [];
  for (const b of blocks) {
    const branchLine = b.split('\n').find((l) => l.startsWith('branch '));
    if (branchLine) branches.push(branchLine.slice(7).replace('refs/heads/', ''));
  }
  // Drop one entry (assume one is ours) so the list reflects *other* worktrees.
  return branches.slice(1);
}

function runGit(args: string[], cwd: string, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    const child = spawn('git', args, {
      cwd,
      signal,
      env: buildChildEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      timeout: GIT_TIMEOUT_MS,
    });
    child.stdout?.on('data', (c: Buffer) => {
      stdout += c.toString();
    });
    child.stderr?.on('data', (c: Buffer) => {
      stderr += c.toString();
    });
    child.on('error', (err) => reject(err));
    child.on('close', (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(stderr || `git ${args[0]} exited ${code}`));
    });
  });
}
