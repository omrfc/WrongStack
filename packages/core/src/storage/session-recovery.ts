import { expectDefined } from '../utils/expect-defined.js';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { SessionEvent } from '../types/session.js';
import { sessionScopedPath } from '../utils/session-scoped-path.js';
/**
 * Idea #1 from IDEAS.md — Stateful Session Recovery.
 *
 * `SessionRecovery` is the read-side companion to the in-flight
 * marker mechanism. When the agent loop is running, it writes an
 * `in_flight_start` event at the current point in the log. On
 * clean shutdown, a matching `in_flight_end` follows. If the
 * process dies (crash, OOM, machine sleep, SIGKILL) the marker
 * is the last event in the file — and `detectStale` flags the
 * session as "incomplete, can be resumed".
 *
 * Phase 1 of this feature is **detection only**. The actual
 * re-execution of incomplete work is a follow-up: it requires
 * tracking pending tool calls, mid-stream LLM responses, and
 * uncommitted file changes — and re-running the agent loop from
 * the last `checkpoint` event. The detection layer is independent
 * and ships first because (a) it gives the user immediate
 * visibility into what died, and (b) it's the foundation for the
 * resume command and the CLI's "Incomplete sessions" surface.
 *
 * Concurrency: pure read; no writes. Safe to call from multiple
 * processes simultaneously.
 */
export interface StaleSession {
  sessionId: string;
  /** Path to the JSONL log. */
  path: string;
  /** Last event ts (the in_flight_start timestamp). */
  lastEventTs: string;
  /** Context the agent was working on when it died. */
  context: string;
  /** Total events in the log. */
  eventCount: number;
}

export interface RecoveryPlan {
  sessionId: string;
  /** True if the session is stale (has a dangling in_flight_start). */
  stale: boolean;
  /** The last `checkpoint` event before the un-replayed work, or null. */
  lastCheckpoint: SessionEvent | null;
  /** All events after the last checkpoint (i.e. the work that needs re-execution). */
  pendingEvents: SessionEvent[];
  /** The dangling in_flight_start event, if any. */
  inFlightStart: SessionEvent | null;
  /** Free-form context the agent was working on, if any. */
  context: string | null;
}

/**
 * Result of `SessionRecovery.recover(sessionId)`. Distinct from
 * `StaleSession`: a session is "stale" if the last event is an
 * open marker, but a "recovery plan" can also be generated for
 * clean sessions whose last checkpoint is older than the
 * conversation history (e.g. a user-initiated "rewind to last
 * good state" flow). Phase 2 of idea #1: this returns the plan;
 * the actual kernel re-execution is a follow-up.
 */
export class SessionRecovery {
  /**
   * Scan a session log and return a `StaleSession` if and only
   * if the last event is an `in_flight_start` without a matching
   * `in_flight_end`. Returns `null` when:
   *   - the log does not exist;
   *   - the log is empty;
   *   - the last event is `in_flight_end` (clean shutdown);
   *   - the last event is something else (e.g. an unannotated
   *     legacy log without in-flight markers).
   */
  async detectStale(sessionId: string): Promise<StaleSession | null> {
    const fp = this.filePath(sessionId);
    // Only read the last ~8KB — enough for several large events.
    // This is O(1) I/O vs O(n) of reading the entire file.
    const TAIL_SIZE = 8192;
    let stat;
    try {
      stat = await fs.stat(fp);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      /* v8 ignore next -- defensive: any other stat failure is also non-recoverable */
      return null;
    }
    if (stat.size === 0) return null;
    const position = Math.max(0, stat.size - TAIL_SIZE);
    const buf = Buffer.alloc(TAIL_SIZE);
    let fh;
    try {
      fh = await fs.open(fp, 'r');
      const { bytesRead } = await fh.read(buf, 0, TAIL_SIZE, position);
      // Count total events for StaleSession.eventCount — requires full scan.
      // For very large files this is a trade-off; count is informational.
      let eventCount = 0;
      const raw = buf.subarray(0, bytesRead).toString('utf8');
      for (const line of raw.split('\n')) {
        if (line.trim()) eventCount++;
      }
      // Find the last complete JSON line in the tail.
      const lines = raw.split('\n').filter((l) => l.trim());
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const ev = JSON.parse(expectDefined(lines[i])) as SessionEvent;
          if (ev.type === 'in_flight_start') {
            return {
              sessionId,
              path: fp,
              lastEventTs: ev.ts,
              context: ev.context,
              eventCount,
            };
          }
          // Found a different last event — clean shutdown or legacy
          return null;
        } catch {
          // Incomplete line (spans the read boundary) — skip
        }
      }
      return null;
      /* v8 ignore start -- defensive: tail open/read failure after a successful stat is rare */
    } catch {
      return null;
    } finally {
      if (fh) await fh.close();
    }
    /* v8 ignore stop */
  }

  /**
   * Generate a recovery plan for a session. The plan describes
   * "what would be re-executed" if the user chose to resume —
   * everything after the last `checkpoint` event, plus the
   * dangling in-flight marker if present.
   *
   * Returns a non-null plan for ANY session that has at least
   * one event after a checkpoint (or, for legacy sessions, at
   * least one event). Pure read; no mutation.
   */
  async recover(sessionId: string): Promise<RecoveryPlan | null> {
    const fp = this.filePath(sessionId);
    let raw: string;
    try {
      raw = await fs.readFile(fp, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      /* v8 ignore next -- defensive: any other read failure is also non-recoverable */
      return null;
    }
    const events: SessionEvent[] = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        events.push(JSON.parse(line) as SessionEvent);
      } catch {
        // skip corrupt lines
      }
    }
    if (events.length === 0) return null;
    // Find the last checkpoint.
    let lastCheckpoint: SessionEvent | null = null;
    let lastCheckpointIdx = -1;
    for (let i = 0; i < events.length; i++) {
      if (events[i]?.type === 'checkpoint') {
        lastCheckpoint = expectDefined(events[i]);
        lastCheckpointIdx = i;
      }
    }
    // Events after the last checkpoint = the work that needs re-execution.
    const pendingEvents =
      lastCheckpointIdx >= 0 ? events.slice(lastCheckpointIdx + 1) : events;
    // The dangling in_flight_start, if the last event is one.
    const lastEv = expectDefined(events[events.length - 1]);
    const inFlightStart =
      lastEv.type === 'in_flight_start' ? lastEv : null;
    const context = inFlightStart && inFlightStart.type === 'in_flight_start'
      ? inFlightStart.context
      : null;
    return {
      sessionId,
      stale: inFlightStart !== null,
      lastCheckpoint,
      pendingEvents,
      inFlightStart,
      context,
    };
  }

  /**
   * List every stale session in a directory. Returns an array
   * (possibly empty) sorted by `lastEventTs` descending — most
   * recent crash first.
   */
  async listResumable(): Promise<StaleSession[]> {
    const out: StaleSession[] = [];
    // Modern sessions live inside date-shard subdirectories
    // ("2026-06-11/<base>.jsonl"); legacy/flat sessions sit at the root.
    // Scan both — a root-only scan silently misses every modern crash.
    const collect = async (dir: string, prefix: string, depth: number): Promise<void> => {
      let entries: import('node:fs').Dirent[];
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
        /* v8 ignore start -- defensive: the sessions dir (and its shards) are readable during a scan */
      } catch {
        return;
      }
      /* v8 ignore stop */
      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue;
        if (
          entry.name === 'shared' ||
          entry.name === 'subagents' ||
          entry.name === 'attachments'
        )
          continue;
        if (entry.isDirectory()) {
          if (depth === 0) {
            await collect(path.join(dir, entry.name), entry.name, depth + 1);
          }
          continue;
        }
        if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
        if (entry.name === '_index.jsonl' || entry.name === '_mailbox.jsonl') continue;
        const base = entry.name.slice(0, -'.jsonl'.length);
        if (base.includes('.replay') || base.includes('.annotations') || base.includes('.audit'))
          continue;
        const sessionId = prefix ? `${prefix}/${base}` : base;
        const stale = await this.detectStale(sessionId);
        if (stale) out.push(stale);
      }
    };
    await collect(this.dir, '', 0);
    return out.sort((a, b) => b.lastEventTs.localeCompare(a.lastEventTs));
  }

  // ── Internals ──────────────────────────────────────────────────────────

  private filePath(sessionId: string): string {
    // Containment-checked: date-sharded ids ("2026-06-11/<base>") are
    // legitimate; traversal is rejected. Shared with the other per-session
    // sidecar stores so the contract can't drift.
    return sessionScopedPath(this.dir, sessionId, '.jsonl');
  }

  constructor(private readonly dir: string) {}
}
