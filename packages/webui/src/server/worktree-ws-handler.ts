import type { WebSocket } from 'ws';
import type { EventBus, Logger } from '@wrongstack/core';
import type { WorktreeHandleView, WSServerMessage } from '../types.js';

const MAX_ACTIVITY = 6;

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
  ) {
    this.subscribe();
  }

  addClient(ws: WebSocket): void {
    this.clients.add(ws);
    ws.on('close', () => this.clients.delete(ws));
    ws.on('error', () => this.clients.delete(ws));
    this.send(ws, this.stateMessage());
  }

  dispose(): void {
    for (const off of this.offs) off();
    this.offs.length = 0;
    this.stopBroadcast();
  }

  // ── internals ───────────────────────────────────────────────────────────

  private subscribe(): void {
    const on = this.events.on.bind(this.events) as unknown as (
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
        this.logger.debug?.(`worktree broadcast failed: ${err instanceof Error ? err.message : String(err)}`);
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
