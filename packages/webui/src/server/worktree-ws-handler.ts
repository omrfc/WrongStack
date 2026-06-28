import type { WebSocket } from 'ws';
import type { EventBus, Logger } from '@wrongstack/core';
import { cleanupStaleSddWorktrees, WorktreeManager } from '@wrongstack/core';
import type { WorktreeHandleView, WorktreeOrphanView, WSServerMessage } from '../types.js';
import { toErrorMessage } from '@wrongstack/core/utils';

const MAX_ACTIVITY = 6;

/** Statuses that mean a worktree is actively owned by a live in-session run. */
const ACTIVE_STATUSES = new Set(['allocating', 'active', 'committing', 'merging']);

export interface WorktreeManagementDeps {
  projectRoot: string;
  /** Board snapshot dir — powers the cross-process liveness guard on cleanup. */
  boardsDir: string;
}

/**
 * WorktreeWebSocketHandler — mirrors AutoPhaseWebSocketHandler. Subscribes to
 * the shared EventBus `worktree.*` lifecycle events, keeps a live snapshot of
 * every worktree, and broadcasts:
 *   - `worktree.event` incrementally (drives the flowing activity strip)
 *   - `worktree.state`  on connect + on a 2s timer (drives swim-lanes/DAG)
 */
export class WorktreeWebSocketHandler {
  private readonly clients = new Set<WebSocket>();
  private readonly handles = new Map<string, WorktreeHandleView>();
  private baseBranch = '';
  private broadcastInterval: ReturnType<typeof setInterval> | null = null;
  private readonly offs: Array<() => void> = [];

  constructor(
    private readonly events: EventBus,
    private readonly logger: Logger,
    private readonly management?: WorktreeManagementDeps | undefined,
  ) {
    this.subscribe();
  }

  addClient(ws: WebSocket): void {
    this.clients.add(ws);
    ws.on('close', () => this.clients.delete(ws));
    ws.on('error', () => this.clients.delete(ws));
    this.send(ws, this.stateMessage());
    // Push the current orphan inventory to the freshly-connected client.
    void this.scanAndBroadcast();
  }

  /** Handle worktree-panel control messages (scan / clean orphans). */
  async handleMessage(msg: { type: string }): Promise<boolean> {
    if (msg.type === 'worktree.scan') {
      await this.scanAndBroadcast();
      return true;
    }
    if (msg.type === 'worktree.cleanup') {
      await this.cleanupOrphans();
      return true;
    }
    return false;
  }

  dispose(): void {
    for (const off of this.offs) off();
    this.offs.length = 0;
    this.stopBroadcast();
  }

  // ── orphan management ─────────────────────────────────────────────────────

  /** Branches of worktrees a live in-session run currently owns. */
  private liveActiveBranches(): Set<string> {
    const live = new Set<string>();
    for (const h of this.handles.values()) {
      if (ACTIVE_STATUSES.has(h.status) && h.branch) live.add(h.branch);
    }
    return live;
  }

  /**
   * Scan the disk for managed worktrees/branches NOT owned by a live in-session
   * run and broadcast them as orphans, with whether it is safe to clean now.
   * No-op (empty inventory) when management deps were not wired.
   */
  private async scanAndBroadcast(): Promise<void> {
    if (!this.management) {
      this.broadcast({ type: 'worktree.orphans', payload: { orphans: [], canClean: false } });
      return;
    }
    try {
      const wt = new WorktreeManager({ projectRoot: this.management.projectRoot });
      const { worktrees, branches } = await wt.listManaged();
      const live = this.liveActiveBranches();
      const orphans: WorktreeOrphanView[] = [];
      const seenBranches = new Set<string>();
      for (const w of worktrees) {
        if (w.branch && live.has(w.branch)) continue; // owned by a live run
        if (w.branch) seenBranches.add(w.branch);
        orphans.push({ kind: 'worktree', dir: w.dir, branch: w.branch });
      }
      // Branch-only orphans (no checkout) — skip those a live run owns or that a
      // listed worktree already covers.
      for (const b of branches) {
        if (live.has(b) || seenBranches.has(b)) continue;
        orphans.push({ kind: 'branch', branch: b });
      }
      // Safe to clean when no live in-session worktree exists. (The cross-process
      // board guard is additionally enforced at cleanup time.)
      const canClean = this.liveActiveBranches().size === 0;
      this.broadcast({
        type: 'worktree.orphans',
        payload: {
          orphans,
          canClean,
          reason: canClean ? undefined : 'a run is live in this session',
        },
      });
    } catch (err) {
      this.logger.debug?.(`worktree orphan scan failed: ${toErrorMessage(err)}`);
      this.broadcast({ type: 'worktree.orphans', payload: { orphans: [], canClean: false } });
    }
  }

  /**
   * Force-remove every orphaned worktree + branch. Refused while a run is live —
   * in this session (active handles) OR another process (the SDD board liveness
   * guard inside cleanupStaleSddWorktrees). Best-effort; reports the outcome.
   */
  private async cleanupOrphans(): Promise<void> {
    if (!this.management) {
      this.broadcast({
        type: 'worktree.cleanup_result',
        payload: { ok: false, removed: 0, reason: 'cleanup is not available in this session' },
      });
      return;
    }
    if (this.liveActiveBranches().size > 0) {
      this.broadcast({
        type: 'worktree.cleanup_result',
        payload: { ok: false, removed: 0, reason: 'a run is live in this session — stop it first' },
      });
      return;
    }
    const res = await cleanupStaleSddWorktrees({
      projectRoot: this.management.projectRoot,
      boardsDir: this.management.boardsDir,
    });
    if (res.skippedReason) {
      this.broadcast({
        type: 'worktree.cleanup_result',
        payload: { ok: false, removed: 0, reason: res.skippedReason },
      });
      await this.scanAndBroadcast();
      return;
    }
    // Drop any kept-for-review handles we held — their checkouts are gone now.
    for (const [id, h] of [...this.handles]) {
      if (!ACTIVE_STATUSES.has(h.status)) this.handles.delete(id);
    }
    this.broadcast({ type: 'worktree.cleanup_result', payload: { ok: true, removed: res.removed } });
    this.broadcastState();
    await this.scanAndBroadcast();
  }

  // ── internals ───────────────────────────────────────────────────────────

  private subscribe(): void {
    const on = this.events.on.bind(this.events) as never as (
      ev: string,
      fn: (p: unknown) => void,
    ) => () => void;

    this.offs.push(
      on('worktree.allocated', (p) => {
        const e = p as { handleId: string; ownerId: string; ownerLabel: string; branch: string; baseBranch: string };
        this.baseBranch = e.baseBranch || this.baseBranch;
        this.upsert(e.handleId, {
          handleId: e.handleId,
          ownerId: e.ownerId,
          ownerLabel: e.ownerLabel,
          branch: e.branch,
          baseBranch: e.baseBranch,
          status: 'active',
          insertions: 0,
          deletions: 0,
          files: 0,
          allocatedAt: Date.now(),
          lastEventAt: Date.now(),
          recentActivity: [],
        });
        this.activity(e.handleId, 'allocated', `branch ${e.branch}`);
        this.ensureBroadcast();
      }),
      on('worktree.committed', (p) => {
        const e = p as { handleId: string; insertions: number; deletions: number; files: number; committed: boolean };
        this.patch(e.handleId, { status: 'committing', insertions: e.insertions, deletions: e.deletions, files: e.files });
        if (e.committed) this.activity(e.handleId, 'committed', `+${e.insertions}/-${e.deletions} (${e.files}f)`);
        this.broadcastState();
      }),
      on('worktree.merged', (p) => {
        const e = p as { handleId: string; baseBranch: string };
        this.patch(e.handleId, { status: 'merged' });
        this.activity(e.handleId, 'merged', `→ ${e.baseBranch}`);
        this.broadcastState();
      }),
      on('worktree.conflict', (p) => {
        const e = p as { handleId: string; conflictFiles: string[] };
        this.patch(e.handleId, { status: 'needs-review', conflictFiles: e.conflictFiles });
        this.activity(e.handleId, 'conflict', e.conflictFiles.join(', '));
        this.broadcastState();
      }),
      on('worktree.failed', (p) => {
        const e = p as { handleId: string; error: string };
        this.patch(e.handleId, { status: 'failed' });
        this.activity(e.handleId, 'failed', e.error);
        this.broadcastState();
      }),
      on('worktree.released', (p) => {
        const e = p as { handleId: string; kept: boolean };
        if (!e.kept) this.handles.delete(e.handleId);
        this.activity(e.handleId, 'released', e.kept ? 'kept for review' : 'removed');
        if (this.handles.size === 0) this.stopBroadcast();
        else this.broadcastState();
      }),
    );
  }

  private upsert(id: string, view: WorktreeHandleView): void {
    this.handles.set(id, view);
  }

  private patch(id: string, patch: Partial<WorktreeHandleView>): void {
    const cur = this.handles.get(id);
    if (!cur) return;
    this.handles.set(id, { ...cur, ...patch, lastEventAt: Date.now() });
  }

  private activity(id: string, kind: string, text: string): void {
    const cur = this.handles.get(id);
    if (cur) {
      const recentActivity = [...cur.recentActivity, { kind, text, at: Date.now() }].slice(-MAX_ACTIVITY);
      this.handles.set(id, { ...cur, recentActivity });
    }
    this.broadcast({ type: 'worktree.event', payload: { kind, handleId: id, text, at: Date.now() } });
  }

  private stateMessage(): WSServerMessage {
    return {
      type: 'worktree.state',
      payload: { worktrees: [...this.handles.values()], baseBranch: this.baseBranch },
    };
  }

  private broadcastState(): void {
    this.broadcast(this.stateMessage());
  }

  private ensureBroadcast(): void {
    this.broadcast(this.stateMessage());
    if (this.broadcastInterval) return;
    this.broadcastInterval = setInterval(() => this.broadcast(this.stateMessage()), 2000);
  }

  private stopBroadcast(): void {
    this.broadcast(this.stateMessage());
    if (this.broadcastInterval) {
      clearInterval(this.broadcastInterval);
      this.broadcastInterval = null;
    }
  }

  private broadcast(msg: WSServerMessage): void {
    const data = JSON.stringify(msg);
    for (const ws of this.clients) {
      try {
        if (ws.readyState === 1) ws.send(data);
      } catch (err) {
        this.logger.debug?.(`worktree broadcast failed: ${toErrorMessage(err)}`);
      }
    }
  }

  private send(ws: WebSocket, msg: WSServerMessage): void {
    try {
      if (ws.readyState === 1) ws.send(JSON.stringify(msg));
    } catch {
      /* client gone */
    }
  }
}
