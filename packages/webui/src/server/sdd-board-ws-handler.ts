import type { WebSocket } from 'ws';
import type { EventBus, SddBoardSnapshot } from '@wrongstack/core';
import { SddBoardStore } from '@wrongstack/core';

interface WSClient {
  ws: WebSocket;
  id: string;
}

interface SddBoardWSMessage {
  type: string;
  payload?: Record<string, unknown>;
}

const CONTROL_TYPES = new Set([
  'pause',
  'resume',
  'stop',
  'retry',
  'retry_all_failed',
  'reassign',
  // Per-task model / fallback / verification assignment + stop/delete (drained by start-sdd-run).
  'set_task_model',
  'set_task_fallbacks',
  'set_task_verification',
  'cancel_task',
  'delete_task',
  'split_task',
]);

/**
 * SddBoardWebSocketHandler — streams the live SDD multi-agent board to clients
 * and relays control commands back to the CLI-owned run.
 *
 * Two observe modes (one class, shared by both webui servers):
 *  • in-process (CLI-hosted): subscribe the shared EventBus `sdd.board.snapshot`
 *    for instant updates;
 *  • standalone (separate process): poll the on-disk snapshot store (the CLI
 *    run persists JSON every change).
 *
 * Control is uniform + cross-process: every command is appended to the run's
 * `<runId>.control.jsonl`, which the CLI run drains and applies — so the run
 * stays the single driver and nothing races on shared state.
 */
export class SddBoardWebSocketHandler {
  private readonly store: SddBoardStore;
  private readonly clients = new Set<WSClient>();
  private latest: SddBoardSnapshot | null = null;
  private poll: ReturnType<typeof setInterval> | null = null;
  private unsub: (() => void) | null = null;

  constructor(boardsDir: string, events?: EventBus) {
    this.store = new SddBoardStore({ baseDir: boardsDir });

    if (events) {
      // Instant updates in the CLI-hosted server (shared bus).
      const handler = (e: { runId: string; snapshot: SddBoardSnapshot }) => {
        this.latest = e.snapshot;
        this.broadcast({ type: 'sdd.board.snapshot', payload: e.snapshot });
      };
      this.unsub = events.on('sdd.board.snapshot', handler as (p: unknown) => void);
    } else {
      // Standalone server (other process): poll the persisted snapshot.
      this.poll = setInterval(() => void this.pollLatest(), 1000);
    }
  }

  addClient(ws: WebSocket): void {
    const client: WSClient = { ws, id: crypto.randomUUID() };
    this.clients.add(client);
    ws.on('close', () => this.clients.delete(client));
    ws.on('error', () => this.clients.delete(client));
    // Send the current board immediately (from memory or disk).
    void this.sendCurrent(client);
  }

  async handleMessage(msg: SddBoardWSMessage): Promise<void> {
    if (msg.type === 'sdd.board.get') {
      await this.broadcastCurrent();
      return;
    }
    if (msg.type === 'sdd.board.list') {
      const boards = await this.store.list();
      this.broadcast({ type: 'sdd.board.list', payload: { boards } });
      return;
    }
    const action = msg.type.replace(/^sdd\.board\./, '');
    if (CONTROL_TYPES.has(action)) {
      const runId =
        (msg.payload?.runId as string | undefined) ??
        this.latest?.runId ??
        (await this.store.list())[0]?.runId;
      if (runId) {
        await this.store.appendControl(runId, {
          ts: Date.now(),
          type: action,
          payload: msg.payload,
        });
      }
    }
  }

  dispose(): void {
    if (this.poll) clearInterval(this.poll);
    this.unsub?.();
    this.poll = null;
    this.unsub = null;
  }

  // ── internal ────────────────────────────────────────────────────────────

  private async pollLatest(): Promise<void> {
    const entry = (await this.store.list())[0];
    if (!entry) return;
    if (this.latest && this.latest.updatedAt >= entry.updatedAt && this.latest.runId === entry.runId) {
      return; // nothing newer
    }
    const snap = await this.store.load(entry.runId);
    if (snap) {
      this.latest = snap;
      this.broadcast({ type: 'sdd.board.snapshot', payload: snap });
    }
  }

  private async sendCurrent(client: WSClient): Promise<void> {
    const snap = this.latest ?? (await this.loadLatestFromDisk());
    if (snap) this.send(client, { type: 'sdd.board.snapshot', payload: snap });
  }

  private async broadcastCurrent(): Promise<void> {
    const snap = this.latest ?? (await this.loadLatestFromDisk());
    if (snap) this.broadcast({ type: 'sdd.board.snapshot', payload: snap });
  }

  private async loadLatestFromDisk(): Promise<SddBoardSnapshot | null> {
    const entry = (await this.store.list())[0];
    return entry ? this.store.load(entry.runId) : null;
  }

  private broadcast(msg: { type: string; payload: unknown }): void {
    const data = JSON.stringify(msg);
    for (const client of this.clients) {
      if (client.ws.readyState === 1) client.ws.send(data);
    }
  }

  private send(client: WSClient, msg: { type: string; payload: unknown }): void {
    if (client.ws.readyState === 1) client.ws.send(JSON.stringify(msg));
  }
}
