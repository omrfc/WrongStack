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
  Mailbox,
  MailboxAckInput,
  MailboxAgentStatus,
  MailboxMessage,
  MailboxQuery,
  MailboxSendInput,
} from './mailbox-types.js';

const MAILBOX_FILE = '_mailbox.jsonl';
const LINE_SEPARATOR = '\n';

export class DefaultMailbox implements Mailbox {
  private readonly filePath: string;

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
    });
    return msg;
  }

  // ── Query ─────────────────────────────────────────────────────────────

  async query(q: MailboxQuery): Promise<MailboxMessage[]> {
    const all = await this._readAll();
    const limit = q.limit ?? 50;
    let filtered = all;
    if (q.to !== undefined) {
      filtered = filtered.filter((m) => m.to === q.to || m.to === '*');
    }
    if (q.from !== undefined) {
      filtered = filtered.filter((m) => m.from === q.from);
    }
    if (q.unreadBy !== undefined) {
      filtered = filtered.filter((m) => !(q.unreadBy! in m.readBy));
    }
    if (q.incompleteOnly) {
      filtered = filtered.filter((m) => !m.completed);
    }
    if (q.type !== undefined) {
      filtered = filtered.filter((m) => m.type === q.type);
    }
    if (q.minPriority !== undefined) {
      const order = { low: 0, normal: 1, high: 2 } as const;
      const min = order[q.minPriority];
      filtered = filtered.filter((m) => (order[m.priority as keyof typeof order] ?? 1) >= min);
    }
    if (q.since !== undefined) {
      const since = q.since;
      filtered = filtered.filter((m) => m.timestamp > since);
    }
    filtered.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
    return filtered.slice(0, limit);
  }

  // ── Ack ───────────────────────────────────────────────────────────────

  async ack(input: MailboxAckInput): Promise<MailboxMessage | null> {
    // Read-modify-write must happen entirely under the lock: reading the
    // file before acquiring it lets two concurrent acks each start from a
    // snapshot missing the other's receipt — last writer wins and a read
    // receipt is silently lost.
    let result: MailboxMessage | null = null;
    await withFileLock(this.filePath, async () => {
      const all = await this._readAll();
      const idx = all.findIndex((m) => m.id === input.messageId);
      if (idx === -1) return;
      const msg = all[idx]!;
      const now = new Date().toISOString();
      if (input.read !== false) {
        msg.readBy[input.readerId] = now;
      }
      if (input.completed) {
        msg.completed = true;
        msg.completedBy = input.readerId;
        msg.completedAt = now;
      }
      if (input.outcome !== undefined) {
        msg.outcome = input.outcome;
      }
      const serialized = all.map((m) => JSON.stringify(m)).join(LINE_SEPARATOR) + LINE_SEPARATOR;
      await fsp.writeFile(this.filePath, serialized, 'utf8');
      result = msg;
    });
    return result;
  }

  // ── Agent statuses ────────────────────────────────────────────────────

  async getAgentStatuses(): Promise<MailboxAgentStatus[]> {
    const all = await this._readAll();
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
    const all = await this._readAll();
    return all.filter(
      (m) =>
        (m.to === forAgentId || m.to === '*') &&
        !(forAgentId in m.readBy) &&
        !m.completed,
    ).length;
  }

  async close(): Promise<void> {
    // JSONL append-only — no flush needed
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
          messages.push(parsed as unknown as MailboxMessage);
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
}
