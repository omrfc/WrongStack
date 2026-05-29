import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { buildChildEnv } from '../utils/child-env.js';
import type { EventBus } from '../kernel/events.js';

/**
 * Lifecycle of a single worktree handle.
 *
 *   allocating → active → committing → merging → merged
 *                                            └─→ needs-review (conflict, kept)
 *   (any)      → failed
 */
export type WorktreeStatus =
  | 'allocating'
  | 'active'
  | 'committing'
  | 'merging'
  | 'merged'
  | 'needs-review'
  | 'failed';

export interface WorktreeHandle {
  /** Stable id (== slug). Used as the event `handleId`. */
  id: string;
  /** Caller-supplied owner (a phase id in AutoPhase). */
  ownerId: string;
  /** Human label for the owner (phase name). */
  ownerLabel: string;
  slug: string;
  /** Absolute path to the worktree checkout. */
  dir: string;
  /** Branch checked out in the worktree (`wstack/ap/<slug>`). */
  branch: string;
  /** Branch the worktree was forked from and merges back into. */
  baseBranch: string;
  status: WorktreeStatus;
  createdAt: number;
  updatedAt: number;
  /** Diff stats from the last commit. */
  insertions: number;
  deletions: number;
  files: number;
  sha?: string;
  lastError?: string;
  conflictFiles?: string[];
}

export interface AllocateOpts {
  /** Friendly basis for the slug/branch (e.g. the phase name). */
  slugHint?: string;
  ownerLabel?: string;
  /** Override the detected base branch. */
  baseBranch?: string;
}

export interface MergeOpts {
  squash?: boolean;
  message?: string;
}

export interface MergeResult {
  ok: boolean;
  conflict?: boolean;
  conflictFiles?: string[];
  stderr?: string;
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface WorktreeManagerOptions {
  projectRoot: string;
  events?: EventBus;
  gitBin?: string;
  /**
   * Test seam. When provided, replaces the real `git` spawn so the manager's
   * sequencing/arg vectors can be asserted without touching a repo.
   */
  run?: (args: string[], cwd: string) => Promise<RunResult>;
}

const MAX_SLUG = 40;

/**
 * Owns the git-worktree lifecycle for isolated, parallel work units. Shells out
 * to `git` directly (never via the `git` *tool*) so it can target arbitrary
 * worktree directories without the tool's permission gate or `findGitDir`
 * resolution, and so `@wrongstack/core` keeps no dependency on `@wrongstack/tools`.
 */
export class WorktreeManager {
  private readonly projectRoot: string;
  private readonly events?: EventBus;
  private readonly gitBin: string;
  private readonly runGit: (args: string[], cwd: string) => Promise<RunResult>;
  /** Keyed by ownerId. */
  private readonly handles = new Map<string, WorktreeHandle>();
  private readonly usedSlugs = new Set<string>();

  constructor(opts: WorktreeManagerOptions) {
    this.projectRoot = resolve(opts.projectRoot);
    this.events = opts.events;
    this.gitBin = opts.gitBin ?? 'git';
    this.runGit = opts.run ?? ((args, cwd) => this.defaultRun(args, cwd));
  }

  /** Create a fresh worktree + branch forked from the current base branch. */
  async allocate(ownerId: string, opts: AllocateOpts = {}): Promise<WorktreeHandle> {
    const existing = this.handles.get(ownerId);
    if (existing && (existing.status === 'allocating' || existing.status === 'active')) {
      return existing;
    }

    const slug = this.makeSlug(opts.slugHint ?? ownerId);
    const branch = `wstack/ap/${slug}`;
    const dir = join(this.worktreesRoot(), slug);
    assertSafePath(dir, this.projectRoot);

    const baseBranch = opts.baseBranch ?? (await this.detectBaseBranch());

    const handle: WorktreeHandle = {
      id: slug,
      ownerId,
      ownerLabel: opts.ownerLabel ?? opts.slugHint ?? ownerId,
      slug,
      dir,
      branch,
      baseBranch,
      status: 'allocating',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      insertions: 0,
      deletions: 0,
      files: 0,
    };
    this.handles.set(ownerId, handle);

    try {
      await mkdir(this.worktreesRoot(), { recursive: true });
      // git worktree add -b <branch> <path> <base> — path before commit-ish.
      const res = await this.runGit(
        ['worktree', 'add', '-b', branch, dir, baseBranch],
        this.projectRoot,
      );
      if (res.code !== 0) {
        return this.fail(handle, res.stderr || 'git worktree add failed');
      }
    } catch (err) {
      return this.fail(handle, err instanceof Error ? err.message : String(err));
    }

    this.setStatus(handle, 'active');
    this.emit('worktree.allocated', {
      handleId: handle.id,
      ownerId: handle.ownerId,
      ownerLabel: handle.ownerLabel,
      slug: handle.slug,
      dir: handle.dir,
      branch: handle.branch,
      baseBranch: handle.baseBranch,
    });
    return handle;
  }

  /** Stage everything and commit inside the worktree. */
  async commitAll(handle: WorktreeHandle, message: string): Promise<{ committed: boolean }> {
    this.setStatus(handle, 'committing');
    await this.runGit(['add', '-A'], handle.dir);

    // `diff --cached --quiet` exits 1 when there are staged changes, 0 when none.
    const staged = await this.runGit(['diff', '--cached', '--quiet'], handle.dir);
    if (staged.code === 0) {
      this.emitCommitted(handle, false);
      return { committed: false };
    }

    const committed = await this.runGit(['commit', '-m', message], handle.dir);
    if (committed.code !== 0) {
      this.fail(handle, committed.stderr || 'git commit failed');
      return { committed: false };
    }

    const stats = await this.collectStats(handle.dir);
    handle.insertions = stats.insertions;
    handle.deletions = stats.deletions;
    handle.files = stats.files;
    handle.sha = stats.sha;
    handle.updatedAt = Date.now();
    this.emitCommitted(handle, true);
    return { committed: true };
  }

  /** Merge the worktree branch back into the base branch (squash by default). */
  async merge(handle: WorktreeHandle, opts: MergeOpts = {}): Promise<MergeResult> {
    const squash = opts.squash ?? true;
    this.setStatus(handle, 'merging');

    const checkout = await this.runGit(['checkout', handle.baseBranch], this.projectRoot);
    if (checkout.code !== 0) {
      this.fail(handle, checkout.stderr || `checkout ${handle.baseBranch} failed`);
      return { ok: false, stderr: checkout.stderr };
    }

    const mergeArgs = squash
      ? ['merge', '--squash', handle.branch]
      : ['merge', '--no-ff', handle.branch];
    const merged = await this.runGit(mergeArgs, this.projectRoot);

    if (merged.code !== 0) {
      const conflictFiles = await this.unmergedFiles();
      // `merge --squash` leaves no MERGE_HEAD, so `merge --abort` won't work;
      // hard-reset the base tree — the work is safe on the branch.
      await this.runGit(['reset', '--hard', 'HEAD'], this.projectRoot);
      handle.conflictFiles = conflictFiles;
      this.setStatus(handle, 'needs-review', { lastError: merged.stderr });
      this.emit('worktree.conflict', {
        handleId: handle.id,
        ownerId: handle.ownerId,
        branch: handle.branch,
        conflictFiles,
      });
      return { ok: false, conflict: true, conflictFiles, stderr: merged.stderr };
    }

    if (squash) {
      // --squash stages the changes but does not commit; finish the commit.
      const msg = opts.message ?? `merge ${handle.branch} (squash)`;
      const commit = await this.runGit(['commit', '-m', msg], this.projectRoot);
      // A no-op squash (empty diff) returns nonzero "nothing to commit" — fine.
      if (commit.code !== 0 && !/nothing to commit/i.test(commit.stdout + commit.stderr)) {
        this.fail(handle, commit.stderr || 'squash commit failed');
        return { ok: false, stderr: commit.stderr };
      }
    }

    this.setStatus(handle, 'merged');
    this.emit('worktree.merged', {
      handleId: handle.id,
      ownerId: handle.ownerId,
      branch: handle.branch,
      baseBranch: handle.baseBranch,
      squash,
    });
    return { ok: true };
  }

  /**
   * Remove the worktree + branch. Conflicted/failed handles (or `keep:true`)
   * are left on disk for inspection.
   */
  async release(handle: WorktreeHandle, opts: { keep?: boolean } = {}): Promise<void> {
    const keep =
      opts.keep || handle.status === 'needs-review' || handle.status === 'failed';
    if (!keep) {
      await this.runGit(['worktree', 'remove', '--force', handle.dir], this.projectRoot);
      await this.runGit(['branch', '-D', handle.branch], this.projectRoot);
      await this.runGit(['worktree', 'prune'], this.projectRoot);
      this.handles.delete(handle.ownerId);
    }
    this.emit('worktree.released', {
      handleId: handle.id,
      ownerId: handle.ownerId,
      branch: handle.branch,
      kept: keep,
    });
  }

  get(ownerId: string): WorktreeHandle | undefined {
    return this.handles.get(ownerId);
  }

  list(): WorktreeHandle[] {
    return [...this.handles.values()];
  }

  // ── internals ────────────────────────────────────────────────────────────

  private worktreesRoot(): string {
    return join(this.projectRoot, '.wrongstack', 'worktrees');
  }

  private async detectBaseBranch(): Promise<string> {
    const head = await this.runGit(['rev-parse', '--abbrev-ref', 'HEAD'], this.projectRoot);
    const name = head.stdout.trim();
    if (name && name !== 'HEAD') return name;
    // Detached HEAD — fall back to the commit SHA.
    const sha = await this.runGit(['rev-parse', 'HEAD'], this.projectRoot);
    return sha.stdout.trim() || 'HEAD';
  }

  private makeSlug(hint: string): string {
    let base = hint
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^[-.]+/, '')
      .replace(/[-.]+$/, '')
      .slice(0, MAX_SLUG)
      .replace(/[-.]+$/, '');
    if (!base) base = 'wt';
    let slug = `${base}-${crypto.randomUUID().slice(0, 6)}`;
    while (this.usedSlugs.has(slug)) slug = `${base}-${crypto.randomUUID().slice(0, 6)}`;
    this.usedSlugs.add(slug);
    return slug;
  }

  private async collectStats(
    dir: string,
  ): Promise<{ insertions: number; deletions: number; files: number; sha: string }> {
    const sha = (await this.runGit(['rev-parse', 'HEAD'], dir)).stdout.trim();
    const numstat = await this.runGit(['show', '--numstat', '--format=', 'HEAD'], dir);
    let insertions = 0;
    let deletions = 0;
    let files = 0;
    for (const line of numstat.stdout.split('\n')) {
      const m = line.trim().match(/^(\d+|-)\t(\d+|-)\t(.+)$/);
      if (!m) continue;
      files++;
      if (m[1] !== '-') insertions += Number(m[1]);
      if (m[2] !== '-') deletions += Number(m[2]);
    }
    return { insertions, deletions, files, sha };
  }

  private async unmergedFiles(): Promise<string[]> {
    const res = await this.runGit(
      ['diff', '--name-only', '--diff-filter=U'],
      this.projectRoot,
    );
    return res.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
  }

  private emitCommitted(handle: WorktreeHandle, committed: boolean): void {
    this.emit('worktree.committed', {
      handleId: handle.id,
      ownerId: handle.ownerId,
      branch: handle.branch,
      committed,
      insertions: handle.insertions,
      deletions: handle.deletions,
      files: handle.files,
      sha: handle.sha,
    });
  }

  private fail(handle: WorktreeHandle, error: string): WorktreeHandle {
    this.setStatus(handle, 'failed', { lastError: error });
    this.emit('worktree.failed', {
      handleId: handle.id,
      ownerId: handle.ownerId,
      branch: handle.branch,
      error,
    });
    return handle;
  }

  private setStatus(
    handle: WorktreeHandle,
    status: WorktreeStatus,
    patch?: Partial<WorktreeHandle>,
  ): void {
    handle.status = status;
    handle.updatedAt = Date.now();
    if (patch) Object.assign(handle, patch);
  }

  private emit<E extends Parameters<EventBus['emit']>[0]>(
    event: E,
    payload: Parameters<EventBus['emit']>[1],
  ): void {
    this.events?.emit(event, payload as never);
  }

  private defaultRun(args: string[], cwd: string): Promise<RunResult> {
    return new Promise((res) => {
      let stdout = '';
      let stderr = '';
      const child = spawn(this.gitBin, args, {
        cwd,
        env: buildChildEnv(),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      child.stdout?.on('data', (c: Buffer) => {
        stdout += c.toString();
      });
      child.stderr?.on('data', (c: Buffer) => {
        stderr += c.toString();
      });
      child.on('error', (err) => res({ code: 1, stdout, stderr: err.message }));
      child.on('close', (code) => res({ code: code ?? 1, stdout, stderr }));
    });
  }
}

/** Throw if `dir` resolves outside `projectRoot`. */
export function assertSafePath(dir: string, projectRoot: string): void {
  const root = resolve(projectRoot);
  const abs = resolve(dir);
  if (abs !== root && !abs.startsWith(root + sep)) {
    throw new Error(`worktree path escapes project root: ${dir}`);
  }
}
