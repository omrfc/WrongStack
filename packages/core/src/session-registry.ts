/**
 * SessionRegistry — cross-process session and agent tracker.
 *
 * Each WrongStack process registers its session on start and updates its
 * status periodically. The registry is a single JSON file at
 * `~/.wrongstack/session-registry.json`. Entries are keyed by session ID.
 *
 * Because multiple processes may write concurrently, every write is an
 * atomic read-modify-write protected by a per-file advisory lock (flock on
 * Unix, exclusive open on Windows). Stale entries (process no longer alive)
 * are pruned on every read.
 *
 * @module session-registry
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

// ── Types ─────────────────────────────────────────────────────────────────

/** Live status of a single agent within a session. */
export type AgentLiveStatus =
  | 'idle'
  | 'running'
  | 'streaming'
  | 'waiting_user' // brain.ask_human, confirm prompt
  | 'error';

export interface AgentEntry {
  /** Unique agent id (ULID or UUID). */
  id: string;
  /** Human-readable label (e.g. "leader", "bug-hunter #1"). */
  name: string;
  status: AgentLiveStatus;
  /** Current tool name if running, undefined otherwise. */
  currentTool?: string | undefined;
  /** Iteration count so far. */
  iterations: number;
  /** Tool calls so far. */
  toolCalls: number;
  /** Cumulative cost in USD for this agent, when known. */
  costUsd?: number | undefined;
  /** Cumulative input tokens, when known. */
  tokensIn?: number | undefined;
  /** Cumulative output tokens, when known. */
  tokensOut?: number | undefined;
  /** Context window fill 0–100 (may exceed 100 when over limit), when known. */
  ctxPct?: number | undefined;
  /** Model id this agent is running on, when known. */
  model?: string | undefined;
  /**
   * Tail of the assistant text currently being streamed (capped, throttled).
   * Lets a cross-process watcher see the response form in near-real-time
   * instead of waiting for the completed turn to land in the session log.
   */
  partialText?: string | undefined;
  /** UTC ISO timestamp of last activity. */
  lastActivityAt: string;
}

export type SessionLiveStatus =
  | 'active'   // process running, agents may be idle or busy
  | 'idle'     // process running, no agent activity
  | 'closing'  // session_end written, process shutting down
  | 'stale';   // process no longer alive (pruned on next read)

export interface SessionRegistryEntry {
  sessionId: string;
  projectSlug: string;
  projectRoot: string;
  projectName: string;
  workingDir: string;
  /**
   * Which surface owns this session — `'tui'` / `'webui'` / `'cli'` (one-shot or
   * REPL). Lets cross-process consumers (e.g. the WebUI Fleet HQ office map) label
   * each live session by client kind. Optional for back-compat with older entries.
   */
  clientType?: 'tui' | 'webui' | 'cli' | 'repl' | string | undefined;
  /** Current git branch, if the project is a git repo. Detected at registration. */
  gitBranch?: string | undefined;
  status: SessionLiveStatus;
  pid: number;
  /** UTC ISO */
  startedAt: string;
  /** UTC ISO — updated on every heartbeat */
  lastHeartbeatAt: string;
  /** Count of tracked agents */
  agentCount: number;
  agents: AgentEntry[];
}

// ── Constants ─────────────────────────────────────────────────────────────

const REGISTRY_FILE = 'session-registry.json';
const HEARTBEAT_INTERVAL_MS = 5_000;
const STALE_TIMEOUT_MS = 30_000; // entry considered stale after 30s without heartbeat
// A session that announced `closing` (heartbeat stopped) is dropped this long
// after its last heartbeat, so the fleet view doesn't keep a dead client around.
const CLOSING_GRACE_MS = 15_000;
// A held lock is released within milliseconds; anything older is a crashed
// owner's leftover and is safe to break so writes never wedge permanently.
const STALE_LOCK_MS = 10_000;
const STALE_TMP_MS = 60_000;
const MAX_STALE_TMP_FILES = 20;

// ── Helpers ───────────────────────────────────────────────────────────────

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// ── Registry class ────────────────────────────────────────────────────────

export class SessionRegistry {
  private readonly filePath: string;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private currentSessionId: string | null = null;
  /**
   * Last full entry this process registered. Kept so the heartbeat can
   * re-create our entry if it ever goes missing — e.g. our initial register()
   * write was dropped (a wedged lock), the file was reset, or we were pruned.
   */
  private lastEntry: SessionRegistryEntry | null = null;

  constructor(globalRoot: string) {
    this.filePath = path.join(globalRoot, REGISTRY_FILE);
  }

  // ── Public API ──────────────────────────────────────────────────────────

  /**
   * Register the current session. Call once on session start.
   * Starts the heartbeat timer.
   */
  async register(
    entry: Omit<SessionRegistryEntry, 'status' | 'lastHeartbeatAt' | 'agentCount' | 'agents'> & {
      agents?: AgentEntry[] | undefined;
    },
  ): Promise<void> {
    // Safe to call again on a project switch: the WebUI re-roots in place and
    // creates a fresh session id pointing at the new project. Clear the prior
    // heartbeat timer (otherwise each switch leaks a timer that keeps writing).
    // A process owns exactly one entry, so the same-pid dedup below drops our
    // own previous entry — the registry never carries a phantom session still
    // pointing at the old project's root/workingDir.
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    this.currentSessionId = entry.sessionId;
    const full: SessionRegistryEntry = {
      ...entry,
      status: 'active',
      lastHeartbeatAt: new Date().toISOString(),
      agentCount: entry.agents?.length ?? 0,
      agents: entry.agents ?? [],
    };
    this.lastEntry = full;
    await this.atomicUpdate((registry) => {
      // Prune dead entries that haven't heartbeated recently.
      // A just-created entry has no heartbeat yet — don't prune it.
      const now = Date.now();
      for (const [id, existing] of Object.entries(registry)) {
        if (existing.pid === entry.pid) {
          // Our own process owns exactly one entry. When re-registering under
          // a new session id (project switch re-roots in place), drop the
          // stale same-pid entry so it doesn't linger pointing at the old
          // project's root/workingDir.
          if (id !== entry.sessionId) delete registry[id];
          continue;
        }
        const heartbeatAge = now - new Date(existing.lastHeartbeatAt).getTime();
        if (heartbeatAge > STALE_TIMEOUT_MS && !pidAlive(existing.pid)) {
          delete registry[id];
        }
      }
      registry[entry.sessionId] = full;
    });

    // Start heartbeat
    this.heartbeatTimer = setInterval(() => {
      void this.heartbeat();
    }, HEARTBEAT_INTERVAL_MS);
    if (this.heartbeatTimer.unref) this.heartbeatTimer.unref();
  }

  /**
   * Update agent status for the current session. Call on every
   * significant status change (agent start, tool start, user wait, error).
   */
  async updateAgents(agents: AgentEntry[]): Promise<void> {
    if (!this.currentSessionId) return;
    // Derive session status from the agent collective.
    const hasRunning = agents.some((a) => a.status === 'running' || a.status === 'streaming');
    const hasWaiting = agents.some((a) => a.status === 'waiting_user');
    const hasError = agents.some((a) => a.status === 'error');
    const status: SessionLiveStatus = hasRunning || hasWaiting || hasError ? 'active' : 'idle';
    const nowIso = new Date().toISOString();

    // Keep the cached entry current so a heartbeat re-insert carries live agents.
    if (this.lastEntry) {
      this.lastEntry.agents = agents;
      this.lastEntry.agentCount = agents.length;
      this.lastEntry.status = status;
      this.lastEntry.lastHeartbeatAt = nowIso;
    }

    await this.atomicUpdate((registry) => {
      let entry = registry[this.currentSessionId!];
      if (!entry) {
        // Our entry vanished (dropped write / reset / pruned) — re-create it.
        if (!this.lastEntry) return;
        entry = { ...this.lastEntry };
        registry[this.currentSessionId!] = entry;
      }
      entry.agents = agents;
      entry.agentCount = agents.length;
      entry.status = status;
      entry.lastHeartbeatAt = nowIso;
    });
  }

  /**
   * Mark the session as closing. Called during shutdown.
   * Stops the heartbeat timer.
   */
  async markClosing(): Promise<void> {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (!this.currentSessionId) return;
    await this.atomicUpdate((registry) => {
      const entry = registry[this.currentSessionId!];
      if (!entry) return;
      entry.status = 'closing';
      entry.lastHeartbeatAt = new Date().toISOString();
    });
  }

  /**
   * Remove the current session from the registry. Call on clean exit.
   */
  async unregister(): Promise<void> {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (!this.currentSessionId) return;
    const sid = this.currentSessionId;
    this.currentSessionId = null;
    await this.atomicUpdate((registry) => {
      delete registry[sid];
    });
  }

  /**
   * List all non-stale sessions. Prunes stale entries automatically.
   */
  async list(): Promise<SessionRegistryEntry[]> {
    const registry = await this.readAndPrune();
    return Object.values(registry);
  }

  /**
   * Get a single session entry by ID. Returns undefined if not found or stale.
   */
  async get(sessionId: string): Promise<SessionRegistryEntry | undefined> {
    const registry = await this.readAndPrune();
    return registry[sessionId];
  }

  /**
   * List all sessions for a specific project (by slug).
   */
  async listByProject(projectSlug: string): Promise<SessionRegistryEntry[]> {
    const all = await this.list();
    return all.filter((e) => e.projectSlug === projectSlug);
  }

  /**
   * Return the registry file path. Useful for WebUI to watch/read.
   */
  get registryPath(): string {
    return this.filePath;
  }

  // ── Internal ────────────────────────────────────────────────────────────

  private async heartbeat(): Promise<void> {
    if (!this.currentSessionId) return;
    try {
      const sessionId = this.currentSessionId;
      const nowIso = new Date().toISOString();
      await this.atomicUpdate((registry) => {
        const entry = registry[sessionId];
        if (entry) {
          entry.lastHeartbeatAt = nowIso;
          // Status bound: if closing, don't revert
          if (entry.status !== 'closing') {
            const hasRunning = (entry.agents ?? []).some(
              (a) => a.status === 'running' || a.status === 'streaming',
            );
            entry.status = hasRunning ? 'active' : 'idle';
          }
          return;
        }
        if (this.lastEntry) {
          // Our entry is gone (initial register() dropped on a wedged lock, file
          // reset, or pruned). Re-create it through the locked path so a process
          // that booted into a broken registry still shows up once it heals.
          registry[sessionId] = { ...this.lastEntry, lastHeartbeatAt: nowIso };
        }
      });
    } catch {
      // Best-effort heartbeat — never throw
    }
  }

  private async readAndPrune(): Promise<Record<string, SessionRegistryEntry>> {
    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      const registry = JSON.parse(raw) as Record<string, SessionRegistryEntry>;
      const now = Date.now();
      let pruned = false;

      for (const [id, entry] of Object.entries(registry)) {
        const heartbeatAge = now - new Date(entry.lastHeartbeatAt).getTime();
        // Cleanly-closed session: drop after a short grace (handles both a fully
        // exited process and one still alive but done) so no dead client lingers.
        if (entry.status === 'closing' && heartbeatAge > CLOSING_GRACE_MS) {
          delete registry[id];
          pruned = true;
          continue;
        }
        if (heartbeatAge > STALE_TIMEOUT_MS && !pidAlive(entry.pid)) {
          entry.status = 'stale';
          // Keep stale entries for 5 minutes so UIs can show "recently closed"
          const startedAge = now - new Date(entry.startedAt).getTime();
          if (startedAge > 5 * 60_000) {
            delete registry[id];
            pruned = true;
          }
        }
      }

      if (pruned) {
        await this.writeAtomic(registry).catch(() => undefined);
      }

      return registry;
    } catch {
      return {};
    }
  }

  private async atomicUpdate(
    fn: (registry: Record<string, SessionRegistryEntry>) => void,
  ): Promise<void> {
    const lockPath = `${this.filePath}.lock`;
    const maxRetries = 8;
    const retryDelayMs = 20;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        // Ensure directory exists
        await fs.mkdir(path.dirname(this.filePath), { recursive: true });

        // Acquire exclusive lock via O_CREAT | O_EXCL
        let lockHandle = await fs.open(lockPath, 'wx').catch(() => null);
        if (!lockHandle) {
          // Lock contended. A crashed process can leave its lock file behind
          // forever (the `finally` unlink never ran), which would wedge EVERY
          // future write — the registry silently stops updating. Break the lock
          // when its owner pid is dead or it has been held implausibly long
          // (legit holds are sub-millisecond), then retry the open once.
          if (await this.breakStaleLock(lockPath)) {
            lockHandle = await fs.open(lockPath, 'wx').catch(() => null);
          }
          if (!lockHandle) {
            await new Promise((r) => setTimeout(r, retryDelayMs * (attempt + 1)));
            continue;
          }
        }

        try {
          // Stamp the owner pid so other processes can detect a stale lock.
          await lockHandle.writeFile(String(process.pid)).catch(() => undefined);
          const raw = await fs.readFile(this.filePath, 'utf8').catch(() => '{}');
          const registry = JSON.parse(raw) as Record<string, SessionRegistryEntry>;
          fn(registry);
          await this.writeAtomicLocked(registry);
          return; // success
        } finally {
          await lockHandle.close();
          await fs.unlink(lockPath).catch(() => undefined);
        }
      } catch {
        // Best-effort — never throw from registry writes
        return;
      }
    }
    // All retries exhausted — registry update dropped (non-critical)
  }

  /**
   * Break a contended lock if it is stale: the recorded owner pid is no longer
   * alive, or the lock is older than {@link STALE_LOCK_MS}. Returns true when the
   * lock was removed (caller should retry acquisition). Best-effort and
   * race-tolerant — a fresh lock (age ~0, live owner) is never broken, so the
   * common concurrent case self-heals on the next heartbeat.
   */
  private async breakStaleLock(lockPath: string): Promise<boolean> {
    try {
      const [stat, content] = await Promise.all([
        fs.stat(lockPath),
        fs.readFile(lockPath, 'utf8').catch(() => ''),
      ]);
      const ageMs = Date.now() - stat.mtimeMs;
      const ownerPid = Number.parseInt(content.trim(), 10);
      const ownerDead =
        Number.isInteger(ownerPid) && ownerPid > 0 && ownerPid !== process.pid && !pidAlive(ownerPid);
      if (ownerDead || ageMs > STALE_LOCK_MS) {
        await fs.unlink(lockPath).catch(() => undefined);
        return true;
      }
      return false;
    } catch {
      // stat failed → the lock vanished underneath us; let the caller retry.
      return true;
    }
  }

  private async writeAtomicLocked(registry: Record<string, SessionRegistryEntry>): Promise<void> {
    await this.pruneStaleTempFiles();
    await this.writeAtomicFile(registry);
  }

  /** Legacy write without lock — used by heartbeat for performance. */
  private async writeAtomic(registry: Record<string, SessionRegistryEntry>): Promise<void> {
    await this.pruneStaleTempFiles();
    await this.writeAtomicFile(registry);
  }

  private async writeAtomicFile(registry: Record<string, SessionRegistryEntry>): Promise<void> {
    const tmp = path.join(
      path.dirname(this.filePath),
      `.${path.basename(this.filePath)}.${randomUUID().slice(0, 8)}.tmp`,
    );
    try {
      await fs.writeFile(tmp, JSON.stringify(registry, null, 2), 'utf8');
      await fs.rename(tmp, this.filePath);
    } catch (err) {
      await fs.unlink(tmp).catch(() => undefined);
      throw err;
    }
  }

  private async pruneStaleTempFiles(): Promise<void> {
    try {
      const dir = path.dirname(this.filePath);
      const base = path.basename(this.filePath);
      const now = Date.now();
      const stale: Array<{ name: string; mtimeMs: number }> = [];

      for (const name of await fs.readdir(dir)) {
        const isTemp =
          (name.startsWith(`${base}.`) || name.startsWith(`.${base}.`)) && name.endsWith('.tmp');
        if (!isTemp) continue;
        const stat = await fs.stat(path.join(dir, name)).catch(() => null);
        if (!stat) continue;
        if (now - stat.mtimeMs > STALE_TMP_MS) stale.push({ name, mtimeMs: stat.mtimeMs });
      }

      stale.sort((a, b) => b.mtimeMs - a.mtimeMs);
      await Promise.all(
        stale.slice(MAX_STALE_TMP_FILES).map(async ({ name }) => {
          await fs.unlink(path.join(dir, name)).catch(() => undefined);
        }),
      );
    } catch {
      // best-effort cleanup must not block registry heartbeats
    }
  }
}

/** Singleton — created once per process. */
let _instance: SessionRegistry | null = null;

export function getSessionRegistry(globalRoot?: string): SessionRegistry {
  if (!_instance && globalRoot) {
    _instance = new SessionRegistry(globalRoot);
  }
  if (!_instance) {
    throw new Error('SessionRegistry not initialized. Call getSessionRegistry(globalRoot) first.');
  }
  return _instance;
}

export function hasSessionRegistry(): boolean {
  return _instance !== null;
}
