import { expectDefined } from '../utils/expect-defined.js';
import { randomBytes } from 'node:crypto';
import type { Dirent } from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import type { EventBus } from '../kernel/events.js';
import type { ContentBlock } from '../types/blocks.js';
import type { Message } from '../types/messages.js';
import type { SecretScrubber } from '../types/secret-scrubber.js';
import type {
  ResumedSession,
  SessionData,
  SessionEvent,
  SessionMetadata,
  SessionStore,
  SessionSummary,
  SessionWriter,
} from '../types/session.js';
import { atomicWrite, ensureDir } from '../utils/atomic-write.js';
import { repairToolUseAdjacency } from '../utils/message-invariants.js';
import { toErrorMessage } from '../utils/index.js';
// ─── Session ID naming ───────────────────────────────────────────────────────

/** Sanitize a model name for use in filenames: alphanumeric + dash + underscore. */
function sanitizeModel(model: string): string {
  return model
    .replace(/[^a-zA-Z0-9_-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
}

/**
 * Generate a session ID in the format:
 *   `YYYY-MM-DD/HH-MM-SSZ[_model]_xxxx.jsonl`
 *
 * Examples:
 *   `2026-06-06/12-30-45Z_claude-sonnet_a1b2.jsonl`
 *   `2026-06-06/14-22-10Z_a1b2.jsonl`          (no model)
 *
 * The date prefix becomes a subdirectory so sessions group naturally by day.
 * The model name (when available) lets you see at a glance which provider was
 * used, without opening the file. The 4-byte random suffix prevents collisions
 * within the same second.
 */
function generateSessionId(startedAt: string, model?: string): string {
  const date = startedAt.slice(0, 10);                       // "2026-06-06"
  const time = startedAt.slice(11, 19).replace(/:/g, '-');   // "12-30-45"
  const suffix = randomBytes(2).toString('hex');              // "a1b2"
  const modelPart = model ? `_${sanitizeModel(model)}` : '';
  return `${date}/${time}Z${modelPart}_${suffix}`;
}

export interface SessionStoreOptions {
  dir: string;
  /** Optional EventBus for emitting session diagnostics. */
  events?: EventBus | undefined;
  /**
   * Optional secret scrubber. When set, `user_input` and `llm_response` event
   * content is scrubbed before being persisted to the JSONL log and the
   * summary sidecar — so a secret a user pastes or the model echoes does not
   * sit in cleartext on disk (and does not ride along in history cloud-sync).
   * Tool output is already scrubbed upstream by the executor; this closes the
   * conversation-turn gap (finding F-06).
   */
  secretScrubber?: SecretScrubber | undefined;
}

/**
 * Cache entry for load() — stores the parsed SessionData along with the
 * file's mtimeMs and size at the time of loading. On subsequent calls,
 * if the file's mtimeMs+size match, we return the cached data without
 * re-reading or re-parsing the JSONL.
 */
interface LoadCacheEntry {
  mtimeMs: number;
  size: number;
  data: SessionData;
}

export class DefaultSessionStore implements SessionStore {
  private readonly dir: string;
  private readonly events?: EventBus | undefined;
  private readonly secretScrubber?: SecretScrubber | undefined;

  /**
   * In-memory cache for load() results, keyed by session ID. The cache is
   * invalidated when the file's mtimeMs or size changes (indicating the
   * file was written to). This eliminates redundant full-file reads and
   * JSON parses when the same session is loaded multiple times within the
   * store's lifetime (e.g., webui session detail views, list() fallbacks).
   *
   * Max size is capped to prevent unbounded memory growth in long-running
   * processes. When the limit is reached, the oldest entry is evicted.
   */
  private readonly _loadCache = new Map<string, LoadCacheEntry>();
  private static readonly LOAD_CACHE_MAX_ENTRIES = 50;

  constructor(opts: SessionStoreOptions) {
    this.dir = opts.dir;
    this.events = opts.events;
    this.secretScrubber = opts.secretScrubber;
  }

  /**
   * Clear the load() cache. Useful for testing or when the caller knows
   * the file has changed externally (e.g., another process wrote to it).
   */
  clearLoadCache(sessionId?: string): void {
    if (sessionId !== undefined) {
      this._loadCache.delete(sessionId);
    } else {
      this._loadCache.clear();
    }
  }

  // ── Storage event helpers ───────────────────────────────────────────────────

  private emitRead(
    sessionId: string,
    filePath: string,
    operation: 'load' | 'list' | 'summary' | 'index_read',
    outcome: 'success' | 'failure',
    durationMs: number,
    error?: string,
  ): void {
    this.events?.emit('storage.read', {
      sessionId,
      store: 'session',
      filePath,
      operation,
      outcome,
      durationMs,
      ...(error !== undefined ? { error } : {}),
    });
  }

  private emitWrite(
    sessionId: string,
    filePath: string,
    operation: 'create' | 'resume' | 'append' | 'flush' | 'close' | 'index_append' | 'compact' | 'checkpoint',
    outcome: 'success' | 'failure',
    durationMs: number,
    eventCount?: number,
    error?: string,
  ): void {
    this.events?.emit('storage.write', {
      sessionId,
      store: 'session',
      filePath,
      operation,
      outcome,
      durationMs,
      ...(eventCount !== undefined ? { eventCount } : {}),
      ...(error !== undefined ? { error } : {}),
    });
  }

  private emitError(
    sessionId: string,
    filePath: string,
    operation: string,
    error: string,
    recoverable: boolean,
  ): void {
    this.events?.emit('storage.error', {
      sessionId,
      store: 'session',
      filePath,
      operation,
      error,
      recoverable,
    });
  }

  /** Absolute path to the session index file. */
  private get indexFile(): string {
    return path.join(this.dir, '_index.jsonl');
  }

  /** Join session ID to its absolute path within the store directory. */
  private sessionPath(id: string, ext: '.jsonl' | '.summary.json'): string {
    return path.join(this.dir, `${id}${ext}`);
  }

  /**
   * Ensure the directory implied by the session ID exists. When the ID
   * contains a date prefix like `2026-06-06/...`, this creates the date
   * subdirectory so sessions group naturally by day.
   */
  private async ensureShardDir(id: string): Promise<string> {
    const dirPath = path.dirname(path.join(this.dir, id));
    await ensureDir(dirPath);
    return dirPath;
  }

  async create(meta: Omit<SessionMetadata, 'startedAt'>): Promise<SessionWriter> {
    const startedAt = new Date().toISOString();
    const id =
      meta.id && meta.id.length > 0
        ? meta.id
        : generateSessionId(startedAt, meta.model ?? meta.provider);
    const shardDir = await this.ensureShardDir(id);
    const file = path.join(shardDir, `${path.basename(id)}.jsonl`);
    const t0 = Date.now();
    let handle: fsp.FileHandle;
    try {
      handle = await fsp.open(file, 'a', 0o600);
    } catch (err) {
      this.emitError(id, file, 'create', toErrorMessage(err), false);
      throw new Error(
        `Failed to open session file: ${toErrorMessage(err)}`,
        { cause: err },
      );
    }
    try {
      const writer = new FileSessionWriter(id, handle, startedAt, meta, this.events, {
        dir: shardDir,
        filePath: file,
        secretScrubber: this.secretScrubber,
        onClose: (s) => this.appendToIndex(s),
      });
      this.emitWrite(id, file, 'create', 'success', Date.now() - t0);
      return writer;
      /* v8 ignore start -- defensive: FileSessionWriter ctor does not throw in practice */
    } catch (err) {
      await handle.close().catch((e) => console.warn(JSON.stringify({
        level: 'warn',
        event: 'session_store.handle_close_failed',
        message: e instanceof Error ? e.message : String(e),
        timestamp: new Date().toISOString(),
      })));
      this.emitError(id, file, 'create', toErrorMessage(err), true);
      throw err;
    }
    /* v8 ignore stop */
  }

  async resume(id: string): Promise<ResumedSession> {
    const file = this.sessionPath(id, '.jsonl');
    const t0 = Date.now();
    const data = await this.load(id);
    let handle: fsp.FileHandle;
    try {
      handle = await fsp.open(file, 'a', 0o600);
      /* v8 ignore start -- defensive: load() above already validated the file is readable */
    } catch (err) {
      this.emitError(id, file, 'resume', toErrorMessage(err), false);
      throw new Error(
        `Failed to open session "${id}" for append: ${toErrorMessage(err)}`,
        { cause: err },
      );
    }
    /* v8 ignore stop */
    try {
      const writer = new FileSessionWriter(
        id,
        handle,
        new Date().toISOString(),
        {
          id,
          model: data.metadata.model,
          provider: data.metadata.provider,
        },
        this.events,
        {
          resumed: true,
          // Shard directory (sessions/<date>/) — must match create() so the
          // .summary.json sidecar lands next to the JSONL instead of the
          // sessions root (where summaryFor() would never find it).
          dir: path.dirname(file),
          filePath: file,
          secretScrubber: this.secretScrubber,
          onClose: (s) => this.appendToIndex(s),
        },
      );
      this.emitWrite(id, file, 'resume', 'success', Date.now() - t0);
      return { writer, data };
      /* v8 ignore start -- defensive: FileSessionWriter ctor does not throw in practice */
    } catch (err) {
      await handle.close().catch((e) => console.warn(JSON.stringify({
        level: 'warn',
        event: 'session_store.handle_close_failed',
        message: e instanceof Error ? e.message : String(e),
        timestamp: new Date().toISOString(),
      })));
      this.emitError(id, file, 'resume', toErrorMessage(err), true);
      throw err;
    }
    /* v8 ignore stop */
  }

  async load(id: string): Promise<SessionData> {
    const file = this.sessionPath(id, '.jsonl');
    const t0 = Date.now();
    let outcome: 'success' | 'failure' = 'success';
    let errorMsg: string | undefined;
    let cacheHit = false;
    try {
      // Stat the file first to check the cache. The stat is cheap (no content
      // read) and lets us skip the full readFile + JSON parse when the file
      // hasn't changed since the last load.
      let stat: { mtimeMs: number; size: number };
      try {
        const s = await fsp.stat(file);
        stat = { mtimeMs: s.mtimeMs, size: s.size };
      } catch (err) {
        // File doesn't exist or can't be stat'd — fall through to the
        // readFile path which will throw the original ENOENT.
        throw err;
      }

      // Check cache: if mtimeMs AND size match, the file hasn't changed.
      const cached = this._loadCache.get(id);
      if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
        cacheHit = true;
        return cached.data;
      }

      // Cache miss — do the full read + parse.
      const raw = await fsp.readFile(file, 'utf8');
      const lines = raw.split('\n').filter((l) => l.trim());
      const events: SessionEvent[] = [];
      for (const line of lines) {
        try {
          const parsed: unknown = JSON.parse(line);
          if (
            parsed !== null &&
            typeof parsed === 'object' &&
            typeof (parsed as { type?: unknown | undefined }).type === 'string' &&
            typeof (parsed as { ts?: unknown | undefined }).ts === 'string'
          ) {
            events.push(parsed as SessionEvent);
          }
        } catch {
          // skip malformed JSON
        }
      }
      const meta = this.metaFromEvents(id, events);
      const { messages, usage } = this.replay(events, id);
      // Extract tool_call_end events for TUI tool entry rendering on resume.
      const toolCallEnds = extractToolCallEnds(events);
      const data: SessionData = { metadata: meta, events, messages, usage, toolCallEnds };

      // Update the cache. Evict oldest entry if at capacity.
      if (this._loadCache.size >= DefaultSessionStore.LOAD_CACHE_MAX_ENTRIES) {
        // Map iteration order is insertion order — delete the first key.
        const oldest = this._loadCache.keys().next().value;
        if (oldest !== undefined) {
          this._loadCache.delete(oldest);
        }
      }
      this._loadCache.set(id, { mtimeMs: stat.mtimeMs, size: stat.size, data });

      return data;
    } catch (err) {
      outcome = 'failure';
      errorMsg = toErrorMessage(err);
      throw err;
    } finally {
      this.emitRead(id, file, 'load', outcome, Date.now() - t0, errorMsg);
      if (cacheHit) {
        this.events?.emit('storage.cache_hit', {
          sessionId: id,
          store: 'session',
          filePath: file,
          operation: 'load',
          durationMs: Date.now() - t0,
        });
      }
    }
  }

  async list(limit = 20): Promise<SessionSummary[]> {
    try {
      await ensureDir(this.dir);
      // Try the index first; fall back to directory scan if the index is
      // missing, empty, or unreadable.
      const indexed = await this.readIndex();
      if (indexed.length > 0) {
        indexed.sort((a, b) => {
          if (a.startedAt < b.startedAt) return 1;
          if (a.startedAt > b.startedAt) return -1;
          return a.id.localeCompare(b.id);
        });
        return indexed.slice(0, limit);
      }
      // Index unavailable — fall back to full directory scan + summary parse.
      const ids = await this.collectSessionIds(this.dir);
      /* v8 ignore next -- summaryFor() never rejects for a collected id (its .jsonl exists) */
      const sessions = await Promise.all(ids.map((id) => this.summaryFor(id).catch(() => null))); /* best-effort */
      const out = sessions.filter((s): s is SessionSummary => s !== null);
      out.sort((a, b) => {
        if (a.startedAt < b.startedAt) return 1;
        if (a.startedAt > b.startedAt) return -1;
        return a.id.localeCompare(b.id);
      });
      return out.slice(0, limit);
    } catch {
      return [];
    }
  }

  // ── Session index (_index.jsonl) ─────────────────────────────────────────
  //
  // One JSON line per closed session, appended atomically on close().
  // When a session is deleted, a tombstone {action:"delete",id:"..."} is
  // appended. On read, tombstones filter out matching session entries.
  // This keeps listing O(lines-in-index) instead of O(files-on-disk).
  //
  // The index auto-compacts every N appends to prevent unbounded growth
  // from tombstones and duplicate entries (resume cycles).

  private indexAppendCount = 0;
  private static readonly COMPACT_EVERY = 30;

  /** Append a session summary to the index. */
  private async appendToIndex(summary: SessionSummary): Promise<void> {
    // Note: storage.write for this operation is emitted by FileSessionWriter.doClose()
    // so it can include the traceId. Do NOT emit here to avoid duplicates.
    try {
      await ensureDir(this.dir);
      const line = JSON.stringify(summary) + '\n';
      await fsp.appendFile(this.indexFile, line, 'utf8');
      this.indexAppendCount++;
      // Auto-compact the index periodically to remove tombstones and duplicates.
      if (this.indexAppendCount >= DefaultSessionStore.COMPACT_EVERY) {
        await this.compactIndex();
        this.indexAppendCount = 0;
      }
    } catch {
      // best-effort — error surfaced via the storage.write event in doClose()
    }
  }

  /** Append a tombstone entry for a deleted session. */
  private async writeTombstone(id: string): Promise<void> {
    try {
      await ensureDir(this.dir);
      const line = JSON.stringify({ action: 'delete', id }) + '\n';
      await fsp.appendFile(this.indexFile, line, 'utf8');
      this.indexAppendCount++;
    } catch {
      // best-effort
    }
  }

  /**
   * Compact the index: read all entries, drop tombstones, deduplicate
   * (keep latest per session), and rewrite. Atomic via temp+rename.
   */
  private async compactIndex(): Promise<void> {
    const t0 = Date.now();
    let outcome: 'success' | 'failure' = 'success';
    let errorMsg: string | undefined;
    try {
      const entries = await this.readIndex();
      if (entries.length === 0) return;
      const tmp = `${this.indexFile}.compact.tmp`;
      const lines = entries.map((s) => JSON.stringify(s)).join('\n') + '\n';
      await fsp.writeFile(tmp, lines, 'utf8');
      await fsp.rename(tmp, this.indexFile);
    } catch (err) {
      outcome = 'failure';
      errorMsg = toErrorMessage(err);
    } finally {
      // Compact is internal — use 'session' as the session ID placeholder.
      this.emitWrite('~compact~', this.indexFile, 'compact', outcome, Date.now() - t0, undefined, errorMsg);
    }
  }

  /**
   * Read the index file and return deduplicated session summaries.
   * Entries with a matching tombstone are filtered out.
   * Returns empty array when the index doesn't exist or is corrupt.
   */
  private async readIndex(): Promise<SessionSummary[]> {
    let raw: string;
    try {
      raw = await fsp.readFile(this.indexFile, 'utf8');
    } catch {
      return [];
    }
    const deleted = new Set<string>();
    const seen = new Map<string, SessionSummary>();
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as { action?: string | undefined; id?: string | undefined } & SessionSummary;
        if (entry.action === 'delete' && entry.id) {
          deleted.add(entry.id);
          seen.delete(entry.id);
          continue;
        }
        if (entry.id && !deleted.has(entry.id)) {
          // Keep the latest entry for each session (multiple appends on resume).
          seen.set(entry.id, entry as SessionSummary);
        }
      } catch {
        // skip corrupt lines
      }
    }
    return Array.from(seen.values());
  }

  /**
   * Rebuild the index from disk by scanning all sessions and writing a
   * fresh _index.jsonl. Useful after manual cleanup or index corruption.
   */
  async rebuildIndex(): Promise<number> {
    const ids = await this.collectSessionIds(this.dir);
    /* v8 ignore next -- summaryFor() never rejects for a collected id (its .jsonl exists) */
    const summaries = await Promise.all(ids.map((id) => this.summaryFor(id).catch(() => null))); /* best-effort */
    const valid = summaries.filter((s): s is SessionSummary => s !== null);
    // Atomic rewrite: write to temp, then rename.
    const tmp = `${this.indexFile}.tmp`;
    const lines = valid.map((s) => JSON.stringify(s)).join('\n') + '\n';
    await fsp.writeFile(tmp, lines, 'utf8');
    await fsp.rename(tmp, this.indexFile);
    return valid.length;
  }

  /** Recursively collect session IDs from date-shard subdirectories.
   *  IDs include the date-prefix path (e.g. "2026-06-06/17-46-57Z_…").
   *  Skips `.jsonl`/`.summary.json` root files, dot-files, and
   *  sub-directories that belong to fleet/subagent sessions. */
  private async collectSessionIds(
    dir: string,
    prefix = '',
    depth = 0,
  ): Promise<string[]> {
    const ids: string[] = [];
    let entries: Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return ids;
    }
    for (const entry of entries) {
      // Skip dot-files and known non-session directories
      if (entry.name.startsWith('.') && entry.name !== '.wrongstack') continue;
      if (entry.name === 'shared' || entry.name === 'subagents' || entry.name === 'attachments')
        continue;
      if (entry.isDirectory()) {
        // Date-shard directories become the prefix for their contents
        const childPrefix = depth === 0 ? entry.name : `${prefix}/${entry.name}`;
        ids.push(...(await this.collectSessionIds(path.join(dir, entry.name), childPrefix, depth + 1)));
      } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        // Skip the session index itself — it's bookkeeping, not a session log.
        // (Only skip THIS file at root, not every root-level jsonl: flat/legacy
        // sessions and the test fixtures live directly under the sessions dir.)
        if (entry.name === '_index.jsonl') continue;
        const base = entry.name.replace(/\.jsonl$/, '');
        // Subagent session logs live under subagents/ which we skip above.
        ids.push(prefix ? `${prefix}/${base}` : base);
      }
    }
    return ids;
  }

  private async summaryFor(id: string): Promise<SessionSummary> {
    const manifest = this.sessionPath(id, '.summary.json');
    const t0 = Date.now();
    let outcome: 'success' | 'failure' = 'success';
    let errorMsg: string | undefined;
    try {
      const raw = await fsp.readFile(manifest, 'utf8');
      this.emitRead(id, manifest, 'summary', 'success', Date.now() - t0);
      return JSON.parse(raw) as SessionSummary;
    } catch {
      const full = this.sessionPath(id, '.jsonl');
      const stat = await fsp.stat(full);
      const summary = await this.summarize(id, stat.mtime.toISOString());
      await atomicWrite(manifest, JSON.stringify(summary), { mode: 0o600 }).catch((err) => {
        const msg = toErrorMessage(err);
        this.emitError(id, manifest, 'summary_fallback', msg, true);
        console.warn(JSON.stringify({
          level: 'warn',
          event: 'session_store.manifest_write_failed',
          sessionId: id,
          message: msg,
          timestamp: new Date().toISOString(),
        }));
      });
      outcome = 'failure';
      errorMsg = 'summary fallback — manifest rebuilt';
      this.emitRead(id, manifest, 'summary', outcome, Date.now() - t0, errorMsg);
      return summary;
    }
  }

  /**
   * Delete a session and all associated files: JSONL, summary, plan/todos
   * sidecars, and the session directory (fleet.json, shared/, subagents/).
   *
   * Individual file deletions are best-effort (logged as structured warnings),
   * but a tombstone is always written so readIndex() filters this session out.
   * If the session directory itself can't be removed, the error is surfaced
   * to the caller so prune() can report it.
   */
  private async deleteSession(id: string): Promise<void> {
    const jsonlPath = this.sessionPath(id, '.jsonl');
    const summaryPath = this.sessionPath(id, '.summary.json');
    const shardDir = path.dirname(path.join(this.dir, id));
    const base = path.basename(id);
    const sessDir = path.join(shardDir, base);

    const deletions: Array<Promise<void>> = [
      fsp.unlink(jsonlPath),
      fsp.unlink(summaryPath),
      fsp.unlink(path.join(shardDir, `${base}.plan.json`)),
      fsp.unlink(path.join(shardDir, `${base}.todos.json`)),
    ];

    const results = await Promise.allSettled(deletions);
    for (const r of results) {
      if (r.status === 'rejected') {
        const msg = r.reason instanceof Error ? r.reason.message : String(r.reason);
        // ENOENT is expected (file may not exist — sidecars are optional).
        if ((r.reason as NodeJS.ErrnoException)?.code !== 'ENOENT') {
          console.warn(JSON.stringify({
            level: 'warn',
            event: 'session_store.delete_failed',
            sessionId: id,
            message: msg,
            timestamp: new Date().toISOString(),
          }));
        }
      }
    }

    // Remove the session directory (may contain fleet.json, shared/, subagents/).
    /* v8 ignore start -- defensive: rm with force:true rarely rejects */
    await fsp.rm(sessDir, { recursive: true, force: true }).catch((err) => {
      console.warn(JSON.stringify({
        level: 'warn',
        event: 'session_store.rmdir_failed',
        sessionId: id,
        message: toErrorMessage(err),
        timestamp: new Date().toISOString(),
      }));
    });
    /* v8 ignore stop */

    // Write an index tombstone so readIndex() filters this session out.
    await this.writeTombstone(id);
  }

  async delete(id: string): Promise<void> {
    await this.deleteSession(id);
  }

  async prune(maxAgeDays = 30): Promise<number> {
    const cutoff = Date.now() - maxAgeDays * 86_400_000;
    let deleted = 0;

    // Read the active session lock to avoid pruning the current session.
    let activeSessionId: string | null = null;
    try {
      const raw = await fsp.readFile(path.join(this.dir, 'active.json'), 'utf8');
      const active = JSON.parse(raw) as { sessionId?: string | undefined };
      activeSessionId = active.sessionId ?? null;
    } catch {
      // no active.json — nothing to protect
    }

    const isPrunableJsonl = (name: string): boolean =>
      name.endsWith('.jsonl') &&
      name !== '_index.jsonl' &&
      name !== '_mailbox.jsonl' &&
      !name.endsWith('.replay.jsonl') &&
      !name.endsWith('.audit.jsonl');

    const pruneFile = async (dir: string, name: string, prefix: string): Promise<void> => {
      const jsonlPath = path.join(dir, name);
      try {
        const stat = await fsp.stat(jsonlPath);
        if (stat.mtimeMs >= cutoff) return;
        /* v8 ignore start -- defensive: file vanished between readdir and stat */
      } catch {
        return;
      }
      /* v8 ignore stop */
      const base = name.replace(/\.jsonl$/, '');
      const id = prefix ? `${prefix}/${base}` : base;
      // Never prune the currently active session.
      if (activeSessionId && id === activeSessionId) return;
      await this.deleteSession(id);
      deleted++;
    };

    /* v8 ignore next -- defensive: store dir is ensured before prune runs */
    const entries = await fsp.readdir(this.dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.isFile()) {
        // Flat legacy sessions at the sessions root — pre-shard layout.
        // A shard-only scan left these accumulating forever.
        if (isPrunableJsonl(entry.name)) await pruneFile(this.dir, entry.name, '');
        continue;
      }
      /* v8 ignore next -- defensive: root entries are only files or directories */
      if (!entry.isDirectory()) continue;
      // entry.name is a date-shard like "2026-06-06"
      const dateDir = path.join(this.dir, entry.name);
      /* v8 ignore next -- defensive: dateDir came from readdir and is readable */
      const files = await fsp.readdir(dateDir, { withFileTypes: true }).catch(() => []);
      for (const file of files) {
        if (!file.isFile() || !isPrunableJsonl(file.name)) continue;
        await pruneFile(dateDir, file.name, entry.name);
      }
    }
    if (deleted > 0) {
      // Compact the index to remove tombstones for deleted sessions.
      /* v8 ignore next -- best-effort: compactIndex swallows its own errors */
      await this.compactIndex().catch(() => undefined); /* best-effort */
    }
    // Clean up empty date-shard directories left behind after pruning.
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dateDir = path.join(this.dir, entry.name);
      try {
        const remaining = await fsp.readdir(dateDir);
        if (remaining.length === 0) {
          /* v8 ignore next -- best-effort: rmdir of a confirmed-empty dir does not reject */
          await fsp.rmdir(dateDir).catch(() => undefined);
        }
      } catch {
        // best-effort
      }
    }
    return deleted;
  }

  async clearHistory(id: string): Promise<void> {
    await this.ensureShardDir(id);
    const file = this.sessionPath(id, '.jsonl');
    const meta = this.sessionPath(id, '.summary.json');
    const record = `${JSON.stringify({
      type: 'session_start',
      ts: new Date().toISOString(),
      id,
      model: 'unknown',
      provider: 'unknown',
    })}\n`;
    await fsp.writeFile(file, record, 'utf8');
    await fsp.unlink(meta).catch(() => undefined);
  }

  private async summarize(id: string, mtime: string): Promise<SessionSummary> {
    try {
      const data = await this.load(id);
      const firstUser = data.events.find((e) => e.type === 'user_input');
      const title =
        firstUser && firstUser.type === 'user_input'
          ? userInputTitle(firstUser.content)
          : '(empty session)';

      // Compute enriched stats from events.
      let iterationCount = 0;
      let toolCallCount = 0;
      let toolErrorCount = 0;
      let fileChangeCount = 0;
      const toolBreakdown: Record<string, number> = {};
      let outcome: SessionSummary['outcome'] ;
      const lastEvent = data.events[data.events.length - 1];

      for (const e of data.events) {
        if (e.type === 'in_flight_start') iterationCount++;
        else if (e.type === 'tool_call_start') {
          toolCallCount++;
          toolBreakdown[e.name] = (toolBreakdown[e.name] ?? 0) + 1;
        } else if (e.type === 'tool_result' && e.isError) toolErrorCount++;
        else if (e.type === 'file_snapshot') fileChangeCount += e.files.length;
      }

      // Determine outcome from the last event.
      if (lastEvent?.type === 'session_end') {
        outcome = 'completed';
      } else if (lastEvent?.type === 'in_flight_start') {
        outcome = 'aborted';
      } else if (data.events.some((e) => e.type === 'error')) {
        outcome = 'error';
      }

      return {
        id,
        title,
        startedAt: data.metadata.startedAt,
        endedAt: data.metadata.endedAt,
        model: data.metadata.model ?? 'unknown',
        provider: data.metadata.provider ?? 'unknown',
        tokenTotal: data.usage.input + data.usage.output,
        iterationCount: iterationCount > 0 ? iterationCount : undefined,
        toolCallCount: toolCallCount > 0 ? toolCallCount : undefined,
        toolErrorCount: toolErrorCount > 0 ? toolErrorCount : undefined,
        fileChangeCount: fileChangeCount > 0 ? fileChangeCount : undefined,
        toolBreakdown: Object.keys(toolBreakdown).length > 0 ? toolBreakdown : {},
        outcome,
      };
    } catch {
      return {
        id,
        title: '(damaged)',
        startedAt: mtime,
        model: 'unknown',
        provider: 'unknown',
        tokenTotal: 0,
      };
    }
  }

  private metaFromEvents(id: string, events: SessionEvent[]): SessionMetadata {
    const start = events.find((e) => e.type === 'session_start');
    // Use the LAST session_end: resume cycles append a new session_end on
    // every clean exit, and legacy /save commands wrote mid-stream markers.
    const end = events.findLast((e) => e.type === 'session_end');
    return {
      id,
      startedAt: start?.ts ?? new Date(0).toISOString(),
      endedAt: end?.ts,
      model: start?.model,
      provider: start?.provider,
      pendingToolUses: end?.pendingToolUses,
    };
  }

  private replay(
    events: SessionEvent[],
    sessionId = 'unknown',
  ): { messages: Message[]; usage: SessionData['usage'] } {
    const messages: Message[] = [];
    let usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    const openToolUses = new Set<string>();
    for (const e of events) {
      if (e.type === 'user_input') {
        openToolUses.clear();
        messages.push({ role: 'user', content: e.content, ts: e.ts });
      } else if (e.type === 'llm_response') {
        messages.push({ role: 'assistant', content: e.content, ts: e.ts });
        for (const b of e.content) {
          if (b.type === 'tool_use') openToolUses.add(b.id);
        }
        usage = {
          input: usage.input + (e.usage.input ?? 0),
          output: usage.output + (e.usage.output ?? 0),
          cacheRead: (usage.cacheRead ?? 0) + (e.usage.cacheRead ?? 0),
          cacheWrite: (usage.cacheWrite ?? 0) + (e.usage.cacheWrite ?? 0),
        };
      } else if (e.type === 'tool_result') {
        if (!openToolUses.has(e.id)) {
          this.events?.emit('session.damaged', {
            sessionId,
            detail: `Orphan tool_result "${e.id}" has no matching tool_use`,
          });
          continue;
        }
        openToolUses.delete(e.id);
        // Provider protocol: tool_result blocks live in a USER message that
        // follows the assistant's tool_use turn — never inside the assistant
        // message itself (repairToolUseAdjacency would treat that as broken
        // adjacency and strip the tool_use blocks, silently dropping the
        // assistant turn on resume). Consecutive results from one turn are
        // grouped into a single user message.
        const resultBlock: ContentBlock = {
          type: 'tool_result',
          tool_use_id: e.id,
          content: typeof e.content === 'string' ? e.content : JSON.stringify(e.content),
          is_error: e.isError,
        };
        const last = messages[messages.length - 1];
        const lastIsToolResultUser =
          last?.role === 'user' &&
          Array.isArray(last.content) &&
          last.content.every((b) => (b as ContentBlock).type === 'tool_result');
        if (lastIsToolResultUser && Array.isArray(last.content)) {
          last.content.push(resultBlock);
        } else {
          messages.push({ role: 'user', content: [resultBlock], ts: e.ts });
        }
      }
    }
    if (openToolUses.size > 0) {
      this.events?.emit('session.damaged', {
        sessionId,
        detail: `${openToolUses.size} tool_use blocks without matching results - replay repaired`,
      });
    }
    const repaired = repairToolUseAdjacency(messages);
    if (repaired.report.changed) {
      this.events?.emit('session.damaged', {
        sessionId,
        detail:
          `Repaired replay adjacency: removed ${repaired.report.removedToolUses.length} tool_use, ` +
          `${repaired.report.removedToolResults.length} tool_result, ` +
          `${repaired.report.removedMessages} empty messages`,
      });
    }
    return { messages: repaired.messages, usage };
  }
}

/**
 * Extract tool execution records from `tool_call_end` events in the JSONL.
 * These are used by the TUI to render tool entries (name, duration, ok/error)
 * when a session is resumed. Events are returned in JSONL order (the order
 * they appear in the file, which is chronological insertion order).
 */
function extractToolCallEnds(events: SessionEvent[]): SessionData['toolCallEnds'] {
  const result: SessionData['toolCallEnds'] = [];
  for (const e of events) {
    if (e.type === 'tool_call_end') {
      result.push({
        name: e.name,
        id: e.id,
        durationMs: e.durationMs,
        ok: e.ok ?? false,
        outputBytes: e.outputBytes,
        outputTokens: e.outputTokens,
        outputLines: e.outputLines,
      });
    }
  }
  return result;
}

class FileSessionWriter implements SessionWriter {
  private closed = false;
  private closePromise: Promise<void> | null = null;
  private manifestFile: string;
  private summary: SessionSummary;
  private tokenIn = 0;
  private tokenOut = 0;
  private readonly filePath: string;
  get transcriptPath(): string | undefined {
    return this.filePath || undefined;
  }
  /**
   * Lazy session_start/session_resumed init, shared by all appenders.
   * A single promise (not a boolean) so a second append racing the first
   * can't push its event into the buffer BEFORE the first append's event —
   * every appender awaits the same init and resumes in FIFO call order.
   */
  private initPromise: Promise<void> | null = null;
  private ensureInit(): Promise<void> {
    if (!this.initPromise) this.initPromise = this.writeSessionStartLazy();
    return this.initPromise;
  }
  private readonly resumed: boolean;
  private appendFailCount = 0;
  private lastAppendWarnAt = 0;
  private readonly secretScrubber?: SecretScrubber | undefined;
  private readonly onCloseCb?: (((summary: SessionSummary) => void | Promise<void>)) | undefined;
  /** Implements SessionWriter.traceId — propagated from ContextInit.traceId. */
  traceId: string | undefined;

  // ── Write buffer — batches events to reduce per-event disk I/O ─────────
  //
  // Every append() pushes the scrubbed event into an in-memory buffer instead
  // of calling handle.appendFile() synchronously. The buffer flushes to disk
  // when it reaches FLUSH_SIZE events OR after FLUSH_INTERVAL_MS of inactivity.
  // This cuts the number of disk writes by ~95% without changing the on-disk
  // format — the JSONL is still one JSON object per line.
  private writeBuffer: SessionEvent[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private static readonly FLUSH_INTERVAL_MS = 500;
  private static readonly FLUSH_SIZE = 50;

  // ── Write serialization ─────────────────────────────────────────────────
  //
  // All disk writes are funneled through a FIFO promise chain. Without it,
  // a timer-driven flush racing an explicit flush()/close() issues two
  // concurrent appendFile() calls on the shared O_APPEND handle — the kernel
  // may complete them out of order (chronology breaks) or, for large
  // batches, interleave partial writes (torn JSONL lines). The chain keeps
  // exactly one write in flight; failures don't break the chain.
  private writeChain: Promise<void> = Promise.resolve();

  /** Enqueue a write on the FIFO chain. Resolves/rejects with that write. */
  private enqueueWrite(data: string): Promise<void> {
    const write = this.writeChain.then(() => this.handle.appendFile(data, 'utf8'));
    this.writeChain = write.then(
      () => undefined,
      () => undefined,
    );
    return write;
  }

  // ── Enriched summary tracking ──────────────────────────────────────────
  private iterationCount = 0;
  private toolCallCount = 0;
  private toolErrorCount = 0;
  private toolBreakdown: Record<string, number> = {};
  private fileChangeCount = 0;
  private compactionCount = 0;
  private outcome: SessionSummary['outcome'] = undefined;

  /**
   * Scrub secrets out of conversation-turn events before they are observed
   * for the summary, written to the JSONL log, or surfaced on resume. Only
   * `user_input` / `llm_response` carry free-form user/model text; other event
   * types either have no secret-bearing content or are already scrubbed
   * upstream (tool results). Returns the event unchanged when no scrubber is
   * configured.
   */
  private scrubEvent(event: SessionEvent): SessionEvent {
    const s = this.secretScrubber;
    if (!s) return event;
    if (event.type === 'user_input') {
      return {
        ...event,
        content:
          typeof event.content === 'string' ? s.scrub(event.content) : s.scrubObject(event.content),
      };
    }
    if (event.type === 'llm_response') {
      return { ...event, content: s.scrubObject(event.content) };
    }
    return event;
  }

  private pendingFileSnapshots: Array<{
    path: string;
    action: 'created' | 'modified' | 'deleted';
    before: string | null;
    after: string | null;
  }> = [];
  /** Tracks open tool_use IDs during the current run to serialize on close for resume. */
  private openToolUses = new Set<string>();

  recordFileChange(input: {
    path: string;
    action: 'created' | 'modified' | 'deleted';
    before: string | null;
    after: string | null;
  }): void {
    this.pendingFileSnapshots.push(input);
  }

  constructor(
    public readonly id: string,
    private handle: fsp.FileHandle,
    private readonly startedAt: string,
    private readonly meta: Omit<SessionMetadata, 'startedAt'>,
    private readonly events?: EventBus | undefined,
    opts: {
      resumed?: boolean | undefined;
      dir?: string | undefined;
      filePath?: string | undefined;
      secretScrubber?: SecretScrubber | undefined;
      /** Called on close() with the finalized summary for index/sidecar writes. */
      onClose?: (((summary: SessionSummary) => void | Promise<void>)) | undefined;
    } = {},
    traceId?: string | undefined,
  ) {
    this.resumed = opts.resumed ?? false;
    // id already contains a date-prefix shard (e.g. "2026-06-06/17-46-57Z_…").
    // opts.dir is the shard directory — join with basename so the manifest
    // lives next to the JSONL file instead of creating a double-nested path.
    this.manifestFile = opts.dir ? path.join(opts.dir, `${path.basename(id)}.summary.json`) : '';
    this.filePath = opts.filePath ?? '';
    this.secretScrubber = opts.secretScrubber;
    this.onCloseCb = opts.onClose;
    this.summary = {
      id,
      title: '(empty session)',
      startedAt,
      model: meta.model ?? 'unknown',
      provider: meta.provider ?? 'unknown',
      tokenTotal: 0,
    };
    // Propagated from ContextInit.traceId via SessionWriter.traceId so that
    // storage events carry the run-level trace ID without needing a Context
    // handle in every storage operation.
    this.traceId = traceId;
  }

  get pendingToolUses(): string[] {
    return Array.from(this.openToolUses);
  }

  private async writeSessionStartLazy(): Promise<void> {
    // Write through the SAME file handle that flushBuffer() uses — avoids
    // cross-fd issues on Windows where a separate fsp.writeFile can contend
    // with the already-open append-mode handle. The handle was opened with
    // O_APPEND so this write lands at the current end-of-file regardless of
    // whether the file is empty or already contains prior session data.
    const record = `${JSON.stringify({
      type: this.resumed ? 'session_resumed' : 'session_start',
      ts: this.startedAt,
      id: this.id,
      model: this.meta.model ?? 'unknown',
      provider: this.meta.provider ?? 'unknown',
    })}\n`;
    try {
      await this.enqueueWrite(record);
    } catch {
      // best-effort
    }
  }

  async append(event: SessionEvent): Promise<void> {
    if (this.closed) return;
    await this.ensureInit();
    // Scrub before observing (the summary title is derived from user_input
    // content) and before buffering, so neither the JSONL nor the sidecar
    // ever holds a cleartext secret.
    const scrubbed = this.scrubEvent(event);
    // observeForSummary MUST run synchronously here — the summary counters
    // (toolCallCount, tokenIn/Out, outcome) drive the .summary.json sidecar
    // and the session index. Deferring observation to flush time would leave
    // the summary stale if close() fires before the next timer tick.
    this.observeForSummary(scrubbed);
    this.writeBuffer.push(scrubbed);

    if (this.writeBuffer.length >= FileSessionWriter.FLUSH_SIZE) {
      // Buffer full — flush immediately. Cancel any pending timer so we
      // don't double-flush on the next tick.
      if (this.flushTimer) {
        clearTimeout(this.flushTimer);
        this.flushTimer = null;
      }
      await this.flushBuffer();
    } else {
      this.scheduleFlush();
    }
  }

  async appendBatch(events: SessionEvent[]): Promise<void> {
    if (this.closed || events.length === 0) return;
    await this.ensureInit();
    for (const event of events) {
      const scrubbed = this.scrubEvent(event);
      this.observeForSummary(scrubbed);
      this.writeBuffer.push(scrubbed);
    }
    if (this.writeBuffer.length >= FileSessionWriter.FLUSH_SIZE) {
      if (this.flushTimer) {
        clearTimeout(this.flushTimer);
        this.flushTimer = null;
      }
      await this.flushBuffer();
    } else {
      this.scheduleFlush();
    }
  }

  /**
   * Flush buffered events to disk immediately. Critical events
   * (user_input, llm_response) call this so they survive SIGKILL/crash
   * instead of sitting in the in-memory buffer for up to 500ms.
   *
   * Idempotent — cancels any pending timer and writes whatever has
   * accumulated in the buffer. Safe to call even when the buffer
   * is empty (no-op).
   */
  async flush(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    await this.flushBuffer();
  }

  /** Schedule a deferred flush. No-op if a timer is already pending. */
  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      /* v8 ignore start -- defensive: flushBuffer logs its own errors; this guards the timer callback */
      this.flushBuffer().catch(() => {
        // flushBuffer already logs via the throttled-warning path;
        // this catch prevents an unhandled rejection in the timer callback.
      });
      /* v8 ignore stop */
    }, FileSessionWriter.FLUSH_INTERVAL_MS);
  }

  /**
   * Flush all buffered events to disk as a single appendFile call.
   * Errors use the same throttled-warning pattern the old per-event
   * append path used — one warning every 5s with a suppressed count.
   * On failure the buffer is cleared (events are best-effort, same as
   * the old per-event path where a failed write was silently dropped).
   */
  private async flushBuffer(): Promise<void> {
    if (this.writeBuffer.length === 0) return;
    const eventCount = this.writeBuffer.length;
    const batch = this.writeBuffer.map((e) => JSON.stringify(e)).join('\n') + '\n';
    this.writeBuffer = [];
    const t0 = Date.now();
    let outcome: 'success' | 'failure' = 'success';
    let errorMsg: string | undefined;
    try {
      await this.enqueueWrite(batch);
    } catch (err) {
      outcome = 'failure';
      errorMsg = toErrorMessage(err);
      this.appendFailCount += eventCount;
      const now = Date.now();
      if (now - this.lastAppendWarnAt > 5000) {
        const suppressed = this.appendFailCount - 1;
        const tail = suppressed > 0 ? ` (+${suppressed} suppressed)` : '';
        console.warn(
          '[session] flush failed:',
          toErrorMessage(err),
          tail,
        );
        this.lastAppendWarnAt = now;
        this.appendFailCount = 0;
      }
    } finally {
      this.events?.emit('storage.write', {
        sessionId: this.id,
        store: 'session',
        filePath: this.filePath,
        operation: 'flush',
        outcome,
        durationMs: Date.now() - t0,
        ...(errorMsg !== undefined ? { error: errorMsg } : {}),
        ...(eventCount !== undefined ? { eventCount } : {}),
        ...(this.traceId !== undefined ? { traceId: this.traceId } : {}),
      });
    }
  }

  private observeForSummary(event: SessionEvent): void {
    // Track open tool uses so we can serialize them on close for resume.
    // The authoritative source is the llm_response content (a core event,
    // always written at every audit level); the legacy 'tool_use' event is
    // kept for alternate writers that still emit it.
    if (event.type === 'llm_response') {
      for (const block of event.content) {
        if (block.type === 'tool_use') this.openToolUses.add(block.id);
      }
    }
    if (event.type === 'tool_use') {
      this.openToolUses.add(event.id);
    } else if (event.type === 'tool_call_start') {
      this.toolCallCount++;
      this.toolBreakdown[event.name] = (this.toolBreakdown[event.name] ?? 0) + 1;
    } else if (event.type === 'tool_result') {
      this.openToolUses.delete(event.id);
      if (event.isError) {
        this.toolErrorCount++;
        this.outcome = 'error';
      }
    } else if (event.type === 'file_snapshot') {
      this.fileChangeCount += event.files.length;
    } else if (event.type === 'compaction') {
      this.compactionCount++;
    }
    // Error events (provider errors, execution errors) mark the session as failed.
    if (event.type === 'error' || event.type === 'provider_error') {
      this.outcome = 'error';
    }
    if (event.type === 'user_input' && this.summary.title === '(empty session)') {
      this.summary = { ...this.summary, title: userInputTitle(event.content) };
    } else if (event.type === 'llm_response') {
      this.tokenIn += event.usage.input;
      this.tokenOut += event.usage.output;
      this.summary = { ...this.summary, tokenTotal: this.tokenIn + this.tokenOut };
    } else if (event.type === 'session_end') {
      const total = event.usage.input + event.usage.output;
      if (total > 0) this.summary = { ...this.summary, tokenTotal: total };
    } else if (event.type === 'in_flight_start') {
      this.iterationCount++;
    }
  }

  async close(): Promise<void> {
    // Idempotent AND awaitable: concurrent/repeat callers share the same
    // promise, so nobody proceeds (e.g. to tear down the session directory)
    // while the first close is still flushing.
    if (this.closePromise) return this.closePromise;
    this.closePromise = this.doClose();
    return this.closePromise;
  }

  private async doClose(): Promise<void> {
    this.closed = true;
    // Flush any buffered events before finalizing. The summary counters
    // (toolCallCount, tokenIn/Out, outcome) are already up to date because
    // observeForSummary runs synchronously on every append, but the JSONL
    // must have all events on disk before we write the .summary.json sidecar.
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    await this.flushBuffer();
    // Drain any write enqueued outside flushBuffer (e.g. the lazy
    // session_start record) before the handle is closed.
    await this.writeChain;
    // Finalize the summary before writing.
    this.summary = {
      ...this.summary,
      endedAt: new Date().toISOString(),
      iterationCount: this.iterationCount,
      toolCallCount: this.toolCallCount,
      toolErrorCount: this.toolErrorCount,
      fileChangeCount: this.fileChangeCount,
      compactionCount: this.compactionCount > 0 ? this.compactionCount : undefined,
      toolBreakdown:
        { ...this.toolBreakdown },
      outcome: this.outcome ?? 'completed',
    };
    // Emit storage.write for the manifest sidecar.
    if (this.manifestFile) {
      const t0 = Date.now();
      let outcome: 'success' | 'failure' = 'success';
      let errorMsg: string | undefined;
      try {
        await atomicWrite(this.manifestFile, JSON.stringify(this.summary), { mode: 0o600 });
      } catch (err) {
        outcome = 'failure';
        errorMsg = toErrorMessage(err);
        // manifest write is best-effort
      } finally {
        this.events?.emit('storage.write', {
          sessionId: this.id,
          store: 'session',
          filePath: this.manifestFile,
          operation: 'close',
          outcome,
          durationMs: Date.now() - t0,
          ...(errorMsg !== undefined ? { error: errorMsg } : {}),
          ...(this.traceId !== undefined ? { traceId: this.traceId } : {}),
        });
      }
    }
    // Notify the store so it can update the session index. Await so the
    // index write completes before close() resolves — otherwise the
    // fire-and-forget _index.jsonl append races callers that tear down the
    // session directory right after close() (e.g. ENOTEMPTY on Windows).
    // Emit storage.write here so it carries this.traceId; the actual I/O
    // is delegated to onCloseCb (appendToIndex) which no longer emits.
    const idxT0 = Date.now();
    let idxOutcome: 'success' | 'failure' = 'success';
    let idxError: string | undefined;
    try {
      await this.onCloseCb?.(this.summary);
      /* v8 ignore start -- best-effort: appendToIndex swallows its own errors */
    } catch (err) {
      idxOutcome = 'failure';
      idxError = toErrorMessage(err);
      // best-effort
    } finally {
      /* v8 ignore stop */
      this.events?.emit('storage.write', {
        sessionId: this.summary.id,
        store: 'session',
        filePath: this.filePath,
        operation: 'index_append',
        outcome: idxOutcome,
        durationMs: Date.now() - idxT0,
        ...(idxError !== undefined ? { error: idxError } : {}),
        ...(this.traceId !== undefined ? { traceId: this.traceId } : {}),
      });
    }
    try {
      await this.handle.close();
    } catch {
      // ignore
    }
  }

  async writeCheckpoint(promptIndex: number, promptPreview: string): Promise<void> {
    const fileCount = this.pendingFileSnapshots.length;
    if (fileCount > 0) {
      await this.writeFileSnapshot(promptIndex, [...this.pendingFileSnapshots]);
      this.pendingFileSnapshots = [];
    }
    await this.append({
      type: 'checkpoint',
      ts: new Date().toISOString(),
      promptIndex,
      promptPreview,
    });
    this.events?.emit('checkpoint.written', {
      promptIndex,
      promptPreview,
      ts: new Date().toISOString(),
      fileCount,
    });
  }

  async writeFileSnapshot(
    promptIndex: number,
    files: import('../types/session.js').FileSnapshot[],
  ): Promise<void> {
    await this.append({
      type: 'file_snapshot',
      ts: new Date().toISOString(),
      promptIndex,
      files,
    });
  }

  async truncateToCheckpoint(targetPromptIndex: number): Promise<number> {
    /* v8 ignore next -- defensive: filePath is always set for a live writer */
    if (!this.filePath) return 0;
    // Flush buffered events to disk before reading — otherwise the in-memory
    // events that haven't hit the JSONL yet would be invisible to the
    // truncation logic and would be silently dropped by the rewrite.
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    await this.flushBuffer();
    // Drain the write chain so no in-flight write straddles the
    // close → rename → reopen sequence below.
    await this.writeChain;
    const raw = await fsp.readFile(this.filePath, 'utf8');
    const lines = raw.split('\n');
    const kept: string[] = [];
    let removedCount = 0;

    let targetCheckpointLine = -1;
    let afterTarget = false;

    for (let i = 0; i < lines.length; i++) {
      const line = expectDefined(lines[i]);
      if (!line.trim()) continue;

      let event: { type?: string | undefined; promptIndex?: number | undefined };
      try {
        event = JSON.parse(line);
      } catch {
        kept.push(line);
        continue;
      }

      if (event.type === 'checkpoint') {
        if ((event as { promptIndex: number }).promptIndex === targetPromptIndex) {
          targetCheckpointLine = kept.length;
          afterTarget = true;
        } else if ((event as { promptIndex: number }).promptIndex > targetPromptIndex) {
          afterTarget = true;
        }
      }

      if (event.promptIndex !== undefined && event.promptIndex > targetPromptIndex) {
        removedCount++;
      } else if (event.promptIndex === undefined) {
        if (!afterTarget || targetCheckpointLine === -1) {
          kept.push(line);
        } else {
          removedCount++;
        }
      } else {
        kept.push(line);
      }
    }

    const truncated = kept.join('\n');
    // Windows EPERM fix: close the append-mode handle, write via temp file
    // and rename, then reopen. This is needed because rename() fails on
    // Windows when the target has an open file handle.
    const tmpPath = `${this.filePath}.rewind.tmp`;
    await fsp.writeFile(tmpPath, truncated + '\n', 'utf8');
    try {
      await this.handle.close();
      await fsp.rename(tmpPath, this.filePath);
      // Re-open in append mode for continued use of this file.
      this.handle = await fsp.open(this.filePath, 'a', 0o600);
      /* v8 ignore start -- defensive: close/rename/reopen of a just-written temp file */
    } catch (err) {
      await fsp.unlink(tmpPath).catch(() => undefined);
      throw err;
    }
    /* v8 ignore stop */

    await this.append({
      type: 'rewound',
      ts: new Date().toISOString(),
      toPromptIndex: targetPromptIndex,
      revertedFiles: [],
    });

    this.events?.emit('session.rewound', {
      toPromptIndex: targetPromptIndex,
      revertedFiles: [],
      removedEvents: removedCount,
    });

    return removedCount;
  }

  async clearSession(): Promise<void> {
    /* v8 ignore next -- defensive: filePath is always set for a live writer */
    if (!this.filePath) return;
    // Discard any buffered events — the caller is explicitly resetting the
    // session to a clean slate. Cancel the timer so it doesn't fire and
    // append stale events to the freshly-cleared file.
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.writeBuffer = [];
    // Let any in-flight append land first — otherwise it would re-append
    // stale events AFTER the reset record below.
    await this.writeChain;
    const record = `${JSON.stringify({
      type: 'session_start',
      ts: new Date().toISOString(),
      id: this.id,
      model: this.meta.model ?? 'unknown',
      provider: this.meta.provider ?? 'unknown',
    })}\n`;
    await fsp.writeFile(this.filePath, record, 'utf8');
  }

  /**
   * Idea #1 — write an in-flight marker. The agent loop should call
   * this at the start of each long-running operation; a matching
   * `clearInFlightMarker` follows on clean exit. A stale marker
   * (no end) is what `SessionRecovery.detectStale` looks for.
   */
  async writeInFlightMarker(context: string): Promise<void> {
    if (!context || context.length > 500) {
      throw new Error('In-flight context must be 1..500 chars');
    }
    await this.append({
      type: 'in_flight_start',
      ts: new Date().toISOString(),
      context,
    });
    this.events?.emit('in_flight.started', { context, ts: new Date().toISOString() });
  }

  /**
   * Idea #1 — close the in-flight marker. Idempotent in spirit
   * (you can call it after a successful iteration even if you
   * didn't open one this round) — but the session log records
   * every call so postmortem tooling can see "the agent finished
   * cleanly X times, then died without finishing Y".
   */
  async clearInFlightMarker(reason: 'clean' | 'aborted' | 'recovered'): Promise<void> {
    await this.append({
      type: 'in_flight_end',
      ts: new Date().toISOString(),
      reason,
    });
    this.events?.emit('in_flight.ended', { reason, ts: new Date().toISOString() });
  }
}

function userInputTitle(content: string | ContentBlock[]): string {
  const text =
    typeof content === 'string'
      ? content
      : content
          .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
          .map((b) => b.text)
          .join(' ');
  return (text || '(non-text input)').slice(0, 60);
}
