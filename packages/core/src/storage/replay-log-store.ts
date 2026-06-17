import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { atomicWrite, withFileLock } from '../utils/atomic-write.js';
import { toErrorMessage } from '../utils/error.js';
import { sessionScopedPath } from '../utils/session-scoped-path.js';
import { hashRequest } from '../replay/hash.js';
import type { Request, Response } from '../types/provider.js';
import { safeParse } from '../utils/safe-json.js';
import type { EventBus } from '../kernel/events.js';

/**
 * Surface the OS error code (EACCES, ENOSPC, …) alongside the message in
 * storage.* event payloads. Codes are stable and locale-independent, so
 * they are what dashboards and alerts key on; the message is supplementary.
 */
function storageErrorString(err: unknown): string {
  if (err instanceof Error) {
    const code = (err as NodeJS.ErrnoException).code;
    return code ? `${code}: ${err.message}` : err.message;
  }
  /* v8 ignore next -- defensive: fs/lock failures are always Error instances */
  return String(err);
}

/**
 * ReplayLogStore — sidecar store for deterministic-replay support
 * (idea #2 from IDEAS.md). One JSONL file per session, recording
 * every provider request/response pair so the same agent loop can
 * be re-run later with frozen API responses.
 *
 * Why a sidecar (not the session JSONL)?
 *
 *   Same reason as `AnnotationsStore` — the session log is
 *   event-sourced and append-only; a provider request payload can be
 *   tens of kilobytes (especially with long conversation history),
 *   and we want replay to be opt-in (recorded only when the user
 *   runs with `--replay` or a future equivalent). Mixing it into
 *   the event log would inflate every read for replay-irrelevant
 *   paths.
 *
 * File layout: `<dir>/<sessionId>.replay.jsonl`, one entry per line.
 * Each entry: `{ hash, ts, request, response }`. The `hash` is
 * computed via `hashRequest` so lookups are O(1) by hash.
 *
 * Concurrency: per-session write queue (same pattern as
 * `AnnotationsStore`). Reads are lock-free; the write chain makes
 * the append + rehash sequence atomic.
 */
export interface ReplayEntry {
  hash: string;
  ts: string;
  request: Request;
  response: Response;
}

const FILE_VERSION = 1;

/** Default cap on the number of entries per session. */
const DEFAULT_MAX_ENTRIES = 1000;

export interface ReplayLogStoreOptions {
  /** Directory where `<sessionId>.replay.jsonl` files live. */
  dir: string;
  /**
   * Cap on the number of entries per session. When a `record` would
   * push the file beyond this, the oldest entries are evicted (LRU
   * by insertion order). Set to `Infinity` to disable rotation.
   * Defaults to 1000 — a single LLM call averages ~5KB serialized
   * (messages + tools + response), so 1000 entries is ~5MB per
   * session which is a reasonable upper bound.
   */
  maxEntries?: number | undefined;
  events?: EventBus;
  traceId?: string;
}

export class ReplayLogStore {
  private readonly dir: string;
  private readonly events: EventBus | undefined;
  private readonly traceId: string | undefined;
  private readonly writeChains = new Map<string, Promise<void>>();
  /** Per-session hash → entry index, kept in memory after the first load. */
  private readonly cache = new Map<string, Map<string, ReplayEntry>>();
  /** Per-session entry count on disk, to detect when compaction is needed. */
  private readonly diskCount = new Map<string, number>();
  private readonly maxEntries: number;

  constructor(opts: ReplayLogStoreOptions) {
    this.dir = opts.dir;
    this.events = opts.events;
    this.traceId = opts.traceId;
    this.maxEntries = opts.maxEntries ?? DEFAULT_MAX_ENTRIES;
  }

  // ── Writes ──────────────────────────────────────────────────────────────

  /**
   * Record a request/response pair. Idempotent on hash: a second
   * `record` for the same hash is a no-op (the existing entry wins).
   * Returns the hash.
   */
  async record(input: {
    sessionId: string;
    request: Request;
    response: Response;
  }): Promise<string> {
    const hash = hashRequest(input.request);
    const fp = this.filePath(input.sessionId);
    const t0 = Date.now();
    try {
      await this.enqueue(input.sessionId, async () => {
        await withFileLock(fp, async () => {
          // Dedup via the in-memory hash map — O(1) instead of re-reading
          // and re-parsing the whole JSONL just to run `entries.some(...)`.
          // `ensureCache` populates both the cache and `diskCount` from a
          // single read on first contact; subsequent records reuse it.
          const cache = await this.ensureCache(input.sessionId);
          if (cache.has(hash)) return; // already recorded

          const entry: ReplayEntry = {
            hash,
            ts: new Date().toISOString(),
            request: input.request,
            response: input.response,
          };

          const currentCount = this.diskCount.get(input.sessionId) ?? 0;
          const willEvict = currentCount + 1 > this.maxEntries;

          if (!willEvict) {
            // Common path (the first `maxEntries` writes per session, plus
            // any session that never hits the cap): a single O(1) append.
            // The previous implementation did a full readAll + full rewrite
            // (atomicWrite of the entire file) on every single record, which
            // was quadratic in session length — a 1000-call session rewrote
            // a multi-MB file 1000 times.
            await fs.appendFile(fp, JSON.stringify(entry) + '\n', 'utf8');
            cache.set(hash, entry);
            this.diskCount.set(input.sessionId, currentCount + 1);
            this.events?.emit('storage.write', {
              sessionId: input.sessionId,
              store: 'replay',
              filePath: fp,
              operation: 'record',
              outcome: 'success',
              durationMs: Date.now() - t0,
              ...(this.traceId !== undefined ? { traceId: this.traceId } : {}),
            });
            return;
          }

          // Eviction path: we're at capacity, drop the oldest entry to make
          // room. This does require a full read + rewrite, but it fires at
          // most once per `maxEntries` writes (default 1000), not per write.
          const all = await this.readAll(input.sessionId);
          all.push(entry);
          const keep = all.slice(-this.maxEntries);
          const refreshed = new Map<string, ReplayEntry>();
          for (const e of keep) refreshed.set(e.hash, e);
          this.cache.set(input.sessionId, refreshed);
          this.diskCount.set(input.sessionId, keep.length);
          await this.writeAll(input.sessionId, keep, 'compact');
        });
      });
      return hash;
    } catch (err) {
      this.events?.emit('storage.error', {
        sessionId: input.sessionId,
        store: 'replay',
        filePath: fp,
        operation: 'record',
        outcome: 'failure',
        error: storageErrorString(err),
        recoverable: false,
        durationMs: Date.now() - t0,
        ...(this.traceId !== undefined ? { traceId: this.traceId } : {}),
      });
      throw err;
    }
  }

  // ── Reads ───────────────────────────────────────────────────────────────

  /**
   * Look up an entry by hash. Returns `null` when the request has
   * not been recorded for this session. O(1) after the first call
   * per session (in-memory cache).
   */
  async lookup(sessionId: string, hash: string): Promise<ReplayEntry | null> {
    const fp = this.filePath(sessionId);
    const t0 = Date.now();
    try {
      const cache = await this.ensureCache(sessionId);
      this.events?.emit('storage.read', {
        sessionId,
        store: 'replay',
        filePath: fp,
        operation: 'lookup',
        outcome: 'success',
        durationMs: Date.now() - t0,
        ...(this.traceId !== undefined ? { traceId: this.traceId } : {}),
      });
      return cache.get(hash) ?? null;
    } catch (err) {
      this.events?.emit('storage.read', {
        sessionId,
        store: 'replay',
        filePath: fp,
        operation: 'lookup',
        outcome: 'failure',
        durationMs: Date.now() - t0,
        error: storageErrorString(err),
        ...(this.traceId !== undefined ? { traceId: this.traceId } : {}),
      });
      throw err;
    }
  }

  /** All recorded entries for a session, in insertion order. */
  async load(sessionId: string): Promise<ReplayEntry[]> {
    const fp = this.filePath(sessionId);
    const t0 = Date.now();
    try {
      const cache = await this.ensureCache(sessionId);
      const durationMs = Date.now() - t0;
      this.events?.emit('storage.read', {
        sessionId,
        store: 'replay',
        filePath: fp,
        operation: 'load',
        outcome: 'success',
        durationMs,
        ...(this.traceId !== undefined ? { traceId: this.traceId } : {}),
      });
      return [...cache.values()];
    } catch (err) {
      const durationMs = Date.now() - t0;
      this.events?.emit('storage.read', {
        sessionId,
        store: 'replay',
        filePath: fp,
        operation: 'load',
        outcome: 'failure',
        durationMs,
        error: storageErrorString(err),
        ...(this.traceId !== undefined ? { traceId: this.traceId } : {}),
      });
      throw err;
    }
  }

  /**
   * List every session id that has a replay log in the store dir.
   * Returns an array of `{ sessionId, entryCount, path }` sorted
   * by sessionId for stable output. Used by `wstack replay --list`.
   */
  async list(): Promise<Array<{ sessionId: string; entryCount: number; path: string }>> {
    const out: Array<{ sessionId: string; entryCount: number; path: string }> = [];
    // Replay logs sit next to their session JSONL — flat at the root for
    // legacy/`record-<ts>` ids, inside a date-shard dir for modern ids.
    // Scan both levels; a root-only scan misses every sharded session.
    const scan = async (dir: string, prefix: string, depth: number): Promise<void> => {
      let entries: import('node:fs').Dirent[];
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch (err) {
        if (depth === 0 && (err as NodeJS.ErrnoException).code !== 'ENOENT') {
          // EACCES, ENOTDIR, etc. — log the real error so the operator can
          // diagnose a misconfiguration, but still return empty list so the
          // caller (slash command display) doesn't crash.
          console.warn(JSON.stringify({
            level: 'warn',
            event: 'replay_log_store.list_readdir_failed',
            dir,
            message: toErrorMessage(err),
            timestamp: new Date().toISOString(),
          }));
        }
        return;
      }
      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue;
        if (entry.isDirectory()) {
          if (depth === 0) await scan(path.join(dir, entry.name), entry.name, depth + 1);
          continue;
        }
        if (!entry.isFile() || !entry.name.endsWith('.replay.jsonl')) continue;
        const base = entry.name.slice(0, -'.replay.jsonl'.length);
        const sessionId = prefix ? `${prefix}/${base}` : base;
        const all = await this.load(sessionId);
        out.push({
          sessionId,
          entryCount: all.length,
          path: path.join(dir, entry.name),
        });
      }
    };
    await scan(this.dir, '', 0);
    return out.sort((a, b) => a.sessionId.localeCompare(b.sessionId));
  }

  // ── Internals ───────────────────────────────────────────────────────────

  private filePath(sessionId: string): string {
    // Containment-checked: date-sharded ids ("2026-06-11/<base>") are
    // legitimate; traversal is rejected. A plain slash ban would throw
    // the moment a real (sharded) session id is used for --replay.
    return sessionScopedPath(this.dir, sessionId, '.replay.jsonl');
  }

  private async readAll(sessionId: string): Promise<ReplayEntry[]> {
    const fp = this.filePath(sessionId);
    try {
      const raw = await fs.readFile(fp, 'utf8');
      const out: ReplayEntry[] = [];
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        try {
          const parsed = safeParse<
            { version?: number | undefined; entry?: ReplayEntry | undefined } & ReplayEntry
          >(line);
          if (!parsed.ok || !parsed.value) continue;
          // Forward-compat: v1 stores entries one per line, no envelope.
          // A future "v2" could wrap with `{version, entries:[...]}`;
          // the loader would then branch on `parsed.version`.
          if ('entry' in parsed.value && parsed.value.entry) {
            out.push(parsed.value.entry);
          } else {
            out.push(parsed.value);
          }
        } catch {
          // Skip a corrupt line — annotations-store and other sidecar
          // stores take the same approach (meta-data, not fatal).
        }
      }
      return out;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      // Non-ENOENT errors (EACCES, ENOSPC, etc.) are real I/O failures —
      // re-throw so callers can emit storage.error.
      throw err;
    }
  }

  private async writeAll(
    sessionId: string,
    entries: ReplayEntry[],
    operation: 'record' | 'compact' = 'record',
  ): Promise<void> {
    const fp = this.filePath(sessionId);
    const t0 = Date.now();
    const body = entries.map((e) => JSON.stringify(e)).join('\n') + (entries.length ? '\n' : '');
    await atomicWrite(fp, body);
    const durationMs = Date.now() - t0;
    this.events?.emit('storage.write', {
      sessionId,
      store: 'replay',
      filePath: fp,
      operation,
      outcome: 'success',
      durationMs,
      ...(this.traceId !== undefined ? { traceId: this.traceId } : {}),
    });
    // Drop the version-stamp comment at the top — v1 has no envelope,
    // but we keep a one-line marker for human readers / future tooling.
    // (The atomicWrite just wrote pure JSONL; that's correct for v1.)
    void FILE_VERSION;
  }

  private async ensureCache(sessionId: string): Promise<Map<string, ReplayEntry>> {
    let cache = this.cache.get(sessionId);
    if (cache) return cache;
    const all = await this.readAll(sessionId);
    cache = new Map();
    for (const e of all) cache.set(e.hash, e);
    this.cache.set(sessionId, cache);
    this.diskCount.set(sessionId, all.length);
    return cache;
  }

  private enqueue(sessionId: string, fn: () => Promise<void>): Promise<void> {
    const prev = this.writeChains.get(sessionId) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.writeChains.set(
      sessionId,
      next.catch(() => undefined),
    );
    return next;
  }
}
