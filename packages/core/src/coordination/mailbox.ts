/**
 * DefaultMailbox — append-only JSONL inter-agent mailbox (per-session).
 *
 * Stores messages under `<sessionDir>/_mailbox.jsonl`. Every send appends
 * one line. Query reads and filters all lines. Ack rewrites changed
 * messages in-place via atomic write.
 *
 * For cross-session communication, use GlobalMailbox instead.
 *
 * @module DefaultMailbox
 */

import { randomUUID } from 'node:crypto';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { withFileLock } from '../utils/atomic-write.js';
import { normalizeRecipient } from './mailbox-types.js';
import type {
  AgentHeartbeatInput,
  AgentRegistrationInput,
  ClientHeartbeatInput,
  ClientRegistrationInput,
  ClientStatus,
  Mailbox,
  MailboxAckBatchInput,
  MailboxAckInput,
  MailboxAgentStatus,
  MailboxMessage,
  MailboxQuery,
  MailboxSendInput,
  PurgeOptions,
  PurgeResult,
} from './mailbox-types.js';

const MAILBOX_FILE = '_mailbox.jsonl';
const LINE_SEPARATOR = '\n';
const MESSAGE_CACHE_MAX_ENTRIES = 10_000;

export class DefaultMailbox implements Mailbox {
  private readonly filePath: string;
  private _messageCache: MailboxMessage[] | null = null;
  private _messageCacheMtime = -1;
  private _messageCacheSize = -1;

  constructor(sessionDir: string) {
    this.filePath = path.join(sessionDir, MAILBOX_FILE);
  }

  get mailboxPath(): string {
    return this.filePath;
  }

  // ── Send ──────────────────────────────────────────────────────────────

  async send(input: MailboxSendInput): Promise<MailboxMessage> {
    const now = new Date().toISOString();
    const msg: MailboxMessage = {
      id: randomUUID(),
      from: input.from,
      // "all" is an accepted spelling of the broadcast address — canonical
      // form on disk is '*' so every query/checker matches it.
      to: normalizeRecipient(input.to),
      type: input.type,
      subject: input.subject,
      body: input.body,
      priority: input.priority ?? 'normal',
      readBy: {},
      completed: false,
      timestamp: now,
      replyTo: input.replyTo,
      taskContext: input.taskContext,
    };
    const line = JSON.stringify(msg) + LINE_SEPARATOR;
    await fsp.mkdir(path.dirname(this.filePath), { recursive: true });
    // The append must hold the same lock ack() rewrites under: an unlocked
    // append racing ack's read→rewrite gets silently erased when the rewrite
    // lands (it was serialized from a snapshot taken before the append).
    await withFileLock(this.filePath, async () => {
      await fsp.appendFile(this.filePath, line, 'utf8');
      this._pushToCache(msg);
    });
    return msg;
  }

  // ── Query ─────────────────────────────────────────────────────────────

  async query(q: MailboxQuery): Promise<MailboxMessage[]> {
    const all = await this._readAllCached();
    const limit = q.limit ?? 50;
    const order = q.minPriority !== undefined ? { low: 0, normal: 1, high: 2 } as const : null;
    const minPriorityRank = order && q.minPriority !== undefined ? order[q.minPriority] : 0;
    const filtered: MailboxMessage[] = [];

    for (const msg of all) {
      if (q.to !== undefined && msg.to !== q.to && msg.to !== '*') continue;
      if (q.from !== undefined && msg.from !== q.from) continue;
      if (q.unreadBy !== undefined && q.unreadBy in msg.readBy) continue;
      if (q.incompleteOnly && msg.completed) continue;
      if (q.type !== undefined && msg.type !== q.type) continue;
      if (order !== null && (order[msg.priority as keyof typeof order] ?? 1) < minPriorityRank) continue;
      if (q.since !== undefined && msg.timestamp <= q.since) continue;
      filtered.push(msg);
    }

    filtered.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
    return filtered.slice(0, limit);
  }

  // ── Ack ───────────────────────────────────────────────────────────────

  async ack(input: MailboxAckInput): Promise<MailboxMessage | null> {
    const updated = await this.ackMany({ acks: [input] });
    return updated.length > 0 ? updated[0]! : null;
  }

  async ackMany(input: MailboxAckBatchInput): Promise<MailboxMessage[]> {
    // Batched: one lock acquisition + one file rewrite for N acks. The
    // per-message ack() did a full read-modify-rewrite for every single
    // ack — N acks meant N full-file rewrites in a row.
    if (input.acks.length === 0) return [];
    const updated: MailboxMessage[] = [];
    const byId = new Map<string, MailboxAckInput>();
    for (const a of input.acks) byId.set(a.messageId, a);

    await withFileLock(this.filePath, async () => {
      const all = await this._readAll();
      const now = new Date().toISOString();
      let changed = false;
      for (const msg of all) {
        const a = byId.get(msg.id);
        if (!a) continue;
        updated.push(msg);
        if (a.read !== false && !(a.readerId in msg.readBy)) {
          msg.readBy[a.readerId] = now;
          changed = true;
        }
        if (a.completed && !msg.completed) {
          msg.completed = true;
          msg.completedBy = a.readerId;
          msg.completedAt = now;
          changed = true;
        }
        if (a.outcome !== undefined && msg.outcome !== a.outcome) {
          msg.outcome = a.outcome;
          changed = true;
        }
      }
      if (changed) {
        const serialized =
          all.map((m) => JSON.stringify(m)).join(LINE_SEPARATOR) + LINE_SEPARATOR;
        await fsp.writeFile(this.filePath, serialized, 'utf8');
      }
      this._setMessageCache(all);
    });
    return updated;
  }

  // ── Agent statuses ────────────────────────────────────────────────────

  async getAgentStatuses(): Promise<MailboxAgentStatus[]> {
    const all = await this._readAllCached();
    const latest = new Map<string, MailboxAgentStatus>();
    for (const m of all) {
      if (m.type !== 'status') continue;
      // taskContext is optional — status messages posted through the mailbox
      // tool carry only from/subject. Synthesize a minimal entry from those
      // so fleet discovery still sees the agent.
      const existing = latest.get(m.from);
      if (existing && m.timestamp <= existing.lastActivityAt) continue;
      latest.set(m.from, {
        agentId: m.from,
        name: m.taskContext?.agentName ?? m.from,
        role: m.taskContext?.agentRole,
        sessionId: m.senderSessionId ?? '?',
        status: (m.taskContext?.status as MailboxAgentStatus['status']) ?? 'idle',
        currentTool: undefined,
        currentTask: m.subject,
        iterations: 0,
        toolCalls: 0,
        lastActivityAt: m.timestamp,
        lastSeenAt: m.timestamp,
        online: true,
        pid: 0,
        source: undefined,
      });
    }
    return Array.from(latest.values()).sort((a, b) =>
      b.lastActivityAt.localeCompare(a.lastActivityAt),
    );
  }

  // ── Stubs for cross-session features (not applicable per-session) ─────

  async getOnlineAgents(): Promise<MailboxAgentStatus[]> {
    return this.getAgentStatuses();
  }

  async registerAgent(_input: AgentRegistrationInput): Promise<void> {
    // no-op: per-session mailbox doesn't track agents globally
  }

  async heartbeat(_input: AgentHeartbeatInput): Promise<void> {
    // no-op: per-session mailbox doesn't track heartbeats
  }

  async unreadCount(forAgentId: string): Promise<number> {
    const all = await this._readAllCached();
    return all.filter(
      (m) =>
        (m.to === forAgentId || m.to === '*') &&
        !(forAgentId in m.readBy) &&
        !m.completed,
    ).length;
  }

  async close(): Promise<void> {
    this._messageCache = null;
    this._messageCacheMtime = -1;
    this._messageCacheSize = -1;
  }

  async clearAll(): Promise<void> {
    // Truncate the mailbox file under the same lock that protects
    // append/ack so a concurrent send can't be half-erased.
    await withFileLock(this.filePath, async () => {
      await fsp.writeFile(this.filePath, '', 'utf8');
      this._setMessageCache([]);
    });
  }

  async purgeStale(opts?: PurgeOptions): Promise<PurgeResult> {
    const COMPLETED_MAX_AGE_MS = opts?.completedMaxAgeMs ?? 86_400_000; // 1 day
    const INCOMPLETE_MAX_AGE_MS = opts?.incompleteMaxAgeMs ?? 604_800_000; // 7 days

    let completedPurged = 0;
    let incompletePurged = 0;
    let remaining = 0;

    await withFileLock(this.filePath, async () => {
      const all = await this._readAll();
      const now = Date.now();
      const cutoffCompleted = now - COMPLETED_MAX_AGE_MS;
      const cutoffIncomplete = now - INCOMPLETE_MAX_AGE_MS;

      const kept: MailboxMessage[] = [];

      for (const msg of all) {
        const msgTime = new Date(msg.timestamp).getTime();
        const completedTime = msg.completedAt ? new Date(msg.completedAt).getTime() : 0;

        if (msg.completed && completedTime < cutoffCompleted) {
          completedPurged++;
          continue;
        }
        if (!msg.completed && msgTime < cutoffIncomplete) {
          incompletePurged++;
          continue;
        }

        kept.push(msg);
      }

      remaining = kept.length;
      if (kept.length < all.length) {
        const content = kept.map((m) => JSON.stringify(m)).join(LINE_SEPARATOR) + LINE_SEPARATOR;
        await fsp.writeFile(this.filePath, content, 'utf8');
      }
      this._setMessageCache(kept);
    });

    return {
      completedPurged,
      incompletePurged,
      totalPurged: completedPurged + incompletePurged,
      remaining,
    };
  }

  // ── Client registry stubs (not applicable per-session) ─────────────────

  async registerClient(_input: ClientRegistrationInput): Promise<void> {
    // no-op: per-session mailbox doesn't track clients globally
  }

  async clientHeartbeat(_input: ClientHeartbeatInput): Promise<void> {
    // no-op: per-session mailbox doesn't track client heartbeats
  }

  async getClientStatuses(): Promise<ClientStatus[]> {
    // no-op: per-session mailbox doesn't track clients globally
    return [];
  }

  // ── Internal ──────────────────────────────────────────────────────────

  private async _readAll(): Promise<MailboxMessage[]> {
    try {
      const raw = await fsp.readFile(this.filePath, 'utf8');
      const lines = raw.split(LINE_SEPARATOR).filter((l) => l.trim().length > 0);
      const messages: MailboxMessage[] = [];
      for (const line of lines) {
        try {
          const parsed = JSON.parse(line) as Record<string, unknown>;
          // Migrate old `read: boolean` + `readAt` to new `readBy`
          if (!parsed['readBy']) {
            const readBy: Record<string, unknown> = {};
            if (parsed['read'] && parsed['readAt']) {
              readBy[(parsed['to'] as string) ?? 'unknown'] = parsed['readAt'];
            }
            parsed['readBy'] = readBy;
            delete parsed['read'];
            delete parsed['readAt'];
          }
          messages.push(parsed as never as MailboxMessage);
        } catch {
          // Skip malformed lines
        }
      }
      return messages;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
  }

  private async _readAllCached(): Promise<MailboxMessage[]> {
    try {
      const st = await fsp.stat(this.filePath);
      if (
        this._messageCache !== null &&
        this._messageCacheMtime === st.mtimeMs &&
        this._messageCacheSize === st.size
      ) {
        return this._messageCache;
      }
      const all = await this._readAll();
      this._setMessageCache(all, st.mtimeMs, st.size);
      return all;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        this._setMessageCache([], -1, -1);
        return [];
      }
      throw err;
    }
  }

  private _setMessageCache(messages: MailboxMessage[], mtime?: number, size?: number): void {
    if (messages.length > MESSAGE_CACHE_MAX_ENTRIES) {
      this._messageCache = null;
      this._messageCacheMtime = -1;
      this._messageCacheSize = -1;
      return;
    }
    this._messageCache = messages;
    if (mtime !== undefined && size !== undefined) {
      this._messageCacheMtime = mtime;
      this._messageCacheSize = size;
      return;
    }
    void fsp
      .stat(this.filePath)
      .then((st) => {
        this._messageCacheMtime = st.mtimeMs;
        this._messageCacheSize = st.size;
      })
      .catch(() => {
        /* best-effort cache metadata refresh */
      });
  }

  private _pushToCache(msg: MailboxMessage): void {
    if (this._messageCache === null) return;
    if (this._messageCache.length >= MESSAGE_CACHE_MAX_ENTRIES) {
      this._messageCache = null;
      this._messageCacheMtime = -1;
      this._messageCacheSize = -1;
      return;
    }
    this._messageCache.push(msg);
  }
}
