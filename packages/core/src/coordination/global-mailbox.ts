/**
 * GlobalMailbox — project-level inter-agent mailbox with cross-session support.
 *
 * Stores messages at `~/.wrongstack/projects/<slug>/_mailbox.jsonl` so all
 * sessions (terminals, WebUIs) working on the same project share one inbox.
 *
 * Features:
 * - Agent registration + heartbeat (agents go stale after 60s without heartbeat)
 * - Per-recipient read receipts (readBy[agentId] = ISO8601)
 * - Atomic file-locking for concurrent multi-process writes
 * - Unread count for new-mail notifications
 * - Online agent list
 *
 * @module GlobalMailbox
 */

import { createHash, randomUUID } from 'node:crypto';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { withFileLock } from '../utils/atomic-write.js';
import type { EventBus } from '../kernel/events.js';
import type {
  AgentHeartbeatInput,
  AgentRegistrationInput,
  Mailbox,
  MailboxAckInput,
  MailboxAgentStatus,
  MailboxMessage,
  MailboxQuery,
  MailboxSendInput,
  RegisteredAgent,
} from './mailbox-types.js';

// ── Constants ────────────────────────────────────────────────────────────

const MAILBOX_FILE = '_mailbox.jsonl';
/** Agents without a heartbeat for this long are considered offline. */
const AGENT_STALE_MS = 60_000;
/** Heartbeat updates are throttled to at most this interval. */
const HEARTBEAT_THROTTLE_MS = 5_000;
/**
 * How long a read may be served from the in-process registry cache before
 * re-reading the shared file. Kept well below HEARTBEAT_THROTTLE_MS so
 * cross-process registrations become visible promptly.
 */
const REGISTRY_CACHE_TTL_MS = 2_000;
const LINE_SEPARATOR = '\n';

/**
 * Derive the project-level mailbox directory path.
 *
 * Matches the slug format used by `wstack-paths`: `<slug>-<6-char-sha256-hash>`.
 * Both CLI and WebUI must use the same derivation so agents register in the
 * same registry regardless of which interface created them.
 *
 * @param projectRoot  — absolute path to the project root
 * @param globalRoot   — `~/.wrongstack` (or custom global root)
 */
export function resolveProjectDir(projectRoot: string, globalRoot: string): string {
  const hash = createHash('sha256')
    .update(path.resolve(projectRoot))
    .digest('hex')
    .slice(0, 6);
  const slug = path
    .basename(projectRoot)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, 40) || 'project';
  return path.join(globalRoot, 'projects', `${slug}-${hash}`);
}

// ── GlobalMailbox ────────────────────────────────────────────────────────

export class GlobalMailbox implements Mailbox {
  /** Path to the JSONL message file. */
  readonly messagePath: string;
  /** Path to the JSON agent registry file. */
  readonly registryPath: string;
  /** Optional event bus for emitting agent registration/heartbeat events. */
  private readonly _events?: EventBus | undefined;
  /**
   * Local cache of the agent registry to avoid re-reading on every call.
   * Time-bounded: the registry file is shared ACROSS PROCESSES (that's the
   * whole point of GlobalMailbox), so a cache served forever would never see
   * agents registered by other sessions. Writers always bypass it.
   */
  private _registryCache: Map<string, RegisteredAgent> | null = null;
  /** When the registry cache was last refreshed from disk (epoch ms). */
  private _registryCacheAt = 0;
  /** Last time each local agent sent a heartbeat (throttle). */
  private _lastHeartbeat = new Map<string, number>();

  /**
   * @param projectDir — `~/.wrongstack/projects/<slug>/`
   * @param events — optional EventBus for real-time TUI/WebUI notifications
   */
  constructor(projectDir: string, events?: EventBus) {
    this.messagePath = path.join(projectDir, MAILBOX_FILE);
    this.registryPath = path.join(projectDir, '_mailbox.registry.json');
    this._events = events;
  }

  // ── Messages ────────────────────────────────────────────────────────────

  async send(input: MailboxSendInput): Promise<MailboxMessage> {
    const now = new Date().toISOString();
    const msg: MailboxMessage = {
      id: randomUUID(),
      from: input.from,
      to: input.to,
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
    await fsp.mkdir(path.dirname(this.messagePath), { recursive: true });
    await fsp.appendFile(this.messagePath, line, 'utf8');

    return msg;
  }

  async query(q: MailboxQuery): Promise<MailboxMessage[]> {
    const all = await this._readMessages();
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

  async ack(input: MailboxAckInput): Promise<MailboxMessage | null> {
    // Read-modify-write entirely under the lock. The file is shared across
    // processes — reading before acquiring the lock lets two concurrent acks
    // each start from a snapshot missing the other's receipt, so the last
    // writer silently erases the first one's read/completed state.
    let result: MailboxMessage | null = null;
    await withFileLock(this.messagePath, async () => {
      const all = await this._readMessages();
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
      await fsp.writeFile(this.messagePath, serialized, 'utf8');
      result = msg;
    });

    return result;
  }

  async unreadCount(forAgentId: string): Promise<number> {
    const all = await this._readMessages();
    return all.filter(
      (m) =>
        (m.to === forAgentId || m.to === '*') &&
        !(forAgentId in m.readBy) &&
        !m.completed,
    ).length;
  }

  // ── Agent registry ──────────────────────────────────────────────────────

  async registerAgent(input: AgentRegistrationInput): Promise<void> {
    await this._ensureRegistry();
    const now = new Date().toISOString();
    const agent: RegisteredAgent = {
      agentId: input.agentId,
      sessionId: input.sessionId,
      name: input.name,
      role: input.role,
      status: 'idle',
      currentTool: undefined,
      currentTask: undefined,
      iterations: 0,
      toolCalls: 0,
      registeredAt: now,
      lastSeenAt: now,
      pid: input.pid,
      source: input.source,
    };

    await withFileLock(this.registryPath, async () => {
      // fresh: read-modify-write must start from the on-disk state, not the
      // cache — other processes may have registered agents since.
      const registry = await this._readRegistry({ fresh: true });
      // Prune stale agents
      this._pruneStaleInPlace(registry);
      // Upsert
      registry.set(input.agentId, agent);
      // Update cache
      this._registryCache = registry;
      this._registryCacheAt = Date.now();
      await this._writeRegistry(registry);
    });

    // Emit event for TUI/WebUI to update online agent count
    this._events?.emitCustom('mailbox.agent_registered', {
      agentId: input.agentId, sessionId: input.sessionId,
      name: input.name, role: input.role, source: input.source,
    });
  }

  async heartbeat(input: AgentHeartbeatInput): Promise<void> {
    // Throttle: at most one heartbeat per agent per HEARTBEAT_THROTTLE_MS
    const last = this._lastHeartbeat.get(input.agentId) ?? 0;
    const now = Date.now();
    if (now - last < HEARTBEAT_THROTTLE_MS) return;

    this._lastHeartbeat.set(input.agentId, now);

    await this._ensureRegistry();

    await withFileLock(this.registryPath, async () => {
      // fresh: see registerAgent — never read-modify-write from the cache.
      const registry = await this._readRegistry({ fresh: true });
      this._pruneStaleInPlace(registry);

      const agent = registry.get(input.agentId);
      if (agent) {
        const iso = new Date().toISOString();
        agent.lastSeenAt = iso;
        if (input.status !== undefined) agent.status = input.status;
        if (input.currentTool !== undefined) agent.currentTool = input.currentTool;
        if (input.currentTask !== undefined) agent.currentTask = input.currentTask;
        if (input.iterations !== undefined) agent.iterations = input.iterations;
        if (input.toolCalls !== undefined) agent.toolCalls = input.toolCalls;
      }
      // If agent not registered yet, silently skip — registerAgent first

      this._registryCache = registry;
      this._registryCacheAt = Date.now();
      await this._writeRegistry(registry);
    });

    // Emit event so TUI/WebUI can track online agents in real time
    this._events?.emitCustom('mailbox.agent_heartbeat', {
      agentId: input.agentId,
      status: input.status,
      currentTool: input.currentTool,
      currentTask: input.currentTask,
    });
  }

  async getAgentStatuses(): Promise<MailboxAgentStatus[]> {
    await this._ensureRegistry();
    const registry = await this._readRegistry();
    this._pruneStaleInPlace(registry);

    const now = Date.now();
    return Array.from(registry.values())
      .map((a) => ({
        agentId: a.agentId,
        name: a.name,
        role: a.role,
        sessionId: a.sessionId,
        status: a.status,
        currentTool: a.currentTool,
        currentTask: a.currentTask,
        iterations: a.iterations,
        toolCalls: a.toolCalls,
        lastActivityAt: a.lastSeenAt,
        lastSeenAt: a.lastSeenAt,
        online: now - new Date(a.lastSeenAt).getTime() < AGENT_STALE_MS,
        pid: a.pid,
        source: a.source,
      }))
      .sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt));
  }

  async getOnlineAgents(): Promise<MailboxAgentStatus[]> {
    const all = await this.getAgentStatuses();
    return all.filter((a) => a.online);
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────

  async close(): Promise<void> {
    // JSONL append-only — no flush needed
    // Cache is cleared on next read
    this._registryCache = null;
  }

  // ── Internal ────────────────────────────────────────────────────────────

  private async _readMessages(): Promise<MailboxMessage[]> {
    try {
      const raw = await fsp.readFile(this.messagePath, 'utf8');
      const lines = raw.split(LINE_SEPARATOR).filter((l) => l.trim().length > 0);
      const messages: MailboxMessage[] = [];
      for (const line of lines) {
        try {
          const parsed = JSON.parse(line) as Record<string, unknown>;
          // Migrate old `read: boolean` + `readAt` to new `readBy`
          if (!parsed['readBy']) {
            const readBy: Record<string, unknown> = {};
            if (parsed['read'] && parsed['readAt']) {
              readBy[parsed['to'] as string] = parsed['readAt'];
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

  private async _ensureRegistry(): Promise<void> {
    await fsp.mkdir(path.dirname(this.registryPath), { recursive: true });
  }

  private async _readRegistry(opts?: { fresh?: boolean }): Promise<Map<string, RegisteredAgent>> {
    // The registry file is shared across processes. Reads may use a short
    // TTL cache; writers (under the file lock) MUST pass { fresh: true } —
    // a read-modify-write from a stale cache would silently erase agents
    // registered by other sessions.
    if (
      !opts?.fresh &&
      this._registryCache &&
      Date.now() - this._registryCacheAt < REGISTRY_CACHE_TTL_MS
    ) {
      return new Map(this._registryCache);
    }

    try {
      const raw = await fsp.readFile(this.registryPath, 'utf8');
      const data = JSON.parse(raw) as Record<string, RegisteredAgent>;
      // Parse lastSeenAt strings back into objects
      const map = new Map<string, RegisteredAgent>();
      for (const [id, agent] of Object.entries(data)) {
        map.set(id, agent as RegisteredAgent);
      }
      this._registryCache = map;
      this._registryCacheAt = Date.now();
      return new Map(map);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        const empty = new Map<string, RegisteredAgent>();
        this._registryCache = empty;
        this._registryCacheAt = Date.now();
        return empty;
      }
      throw err;
    }
  }

  private _pruneStaleInPlace(registry: Map<string, RegisteredAgent>): void {
    const cutoff = Date.now() - AGENT_STALE_MS;
    for (const agent of registry.values()) {
      if (new Date(agent.lastSeenAt).getTime() < cutoff) {
        agent.status = 'idle'; // preserve entry but mark as offline
        // Note: we don't delete — the WebUI wants to show recently-offline agents
      }
    }
  }

  private async _writeRegistry(registry: Map<string, RegisteredAgent>): Promise<void> {
    const obj: Record<string, RegisteredAgent> = {};
    for (const [id, agent] of registry) {
      obj[id] = agent;
    }
    const tmp = `${this.registryPath}.${randomUUID().slice(0, 8)}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(obj, null, 2), 'utf8');
    await fsp.rename(tmp, this.registryPath);
  }
}
