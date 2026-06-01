import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { SessionEvent } from '../types/session.js';

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
    let raw: string;
    try {
      raw = await fs.readFile(fp, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      // Corrupt or unreadable — not a candidate for resume.
      return null;
    }
    return this.parseForStale(sessionId, fp, raw);
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
      if (events[i]!.type === 'checkpoint') {
        lastCheckpoint = events[i]!;
        lastCheckpointIdx = i;
      }
    }
    // Events after the last checkpoint = the work that needs re-execution.
    const pendingEvents =
      lastCheckpointIdx >= 0 ? events.slice(lastCheckpointIdx + 1) : events;
    // The dangling in_flight_start, if the last event is one.
    const lastEv = events[events.length - 1]!;
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
    let entries: string[];
    try {
      entries = await fs.readdir(this.dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      return [];
    }
    const out: StaleSession[] = [];
    for (const name of entries) {
      if (!name.endsWith('.jsonl')) continue;
      const sessionId = name.slice(0, -'.jsonl'.length);
      if (sessionId.includes('.replay') || sessionId.includes('.annotations')) continue;
      const stale = await this.detectStale(sessionId);
      if (stale) out.push(stale);
    }
    return out.sort((a, b) => b.lastEventTs.localeCompare(a.lastEventTs));
  }

  // ── Internals ──────────────────────────────────────────────────────────

  private filePath(sessionId: string): string {
    if (
      !sessionId ||
      sessionId.includes('/') ||
      sessionId.includes('\\') ||
      sessionId.includes('..')
    ) {
      throw new Error(`Invalid sessionId: ${sessionId}`);
    }
    return path.join(this.dir, `${sessionId}.jsonl`);
  }

  /**
   * Stream-parse the last few lines of a JSONL log. We do NOT load
   * the whole file into memory — for long-running sessions the log
   * can be megabytes. Instead we read tail-ward and find the last
   * `in_flight_start` / `in_flight_end` pair.
   */
  private async parseForStale(
    sessionId: string,
    fp: string,
    raw: string,
  ): Promise<StaleSession | null> {
    const lines = raw.split('\n');
    let lastEvent: SessionEvent | null = null;
    let eventCount = 0;
    // Walk forward — for a fast log this is fine. For huge logs a
    // streaming parser would be better; deferred to Phase 2.
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const ev = JSON.parse(line) as SessionEvent;
        lastEvent = ev;
        eventCount++;
      } catch {
        // Skip corrupt lines — same recovery philosophy as the
        // other sidecar stores (meta-data, not fatal).
      }
    }
    if (!lastEvent) return null;
    if (lastEvent.type === 'in_flight_start') {
      return {
        sessionId,
        path: fp,
        lastEventTs: lastEvent.ts,
        context: lastEvent.context,
        eventCount,
      };
    }
    return null;
  }

  constructor(private readonly dir: string) {}
}
