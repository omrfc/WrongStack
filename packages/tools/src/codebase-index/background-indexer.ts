/**
 * Background indexing coordinator.
 *
 * Wraps {@link runIndexer} with two concerns the agent loop and the CLI wiring
 * both need but neither should own:
 *
 * 1. **Serialization** — every reindex (startup full scan, per-edit incremental,
 *    external file-watch) goes through one process-wide promise-chain mutex.
 *    `writer.ts` opens a synchronous `node:sqlite` `DatabaseSync` connection per
 *    `IndexStore`; two concurrent `runIndexer` runs on the same `index.db` would
 *    race the writer and risk `SQLITE_BUSY`. The mutex makes them queue instead.
 *
 * 2. **Debounce** — rapid successive edits to the same file (editor autosave,
 *    multi-edit) coalesce into a single reindex, keyed per `(indexDir, file)`.
 *
 * 3. **State tracking** — exposes whether the initial index has completed (`ready`)
 *    and whether a build is in progress (`indexing`), so downstream tools
 *    (codebase-search, codebase-stats) can gate on it and UIs can show progress.
 *
 * `runIndexer` only reads `opts` (and ignores its `_ctx` parameter), so callers
 * outside the agent loop pass a minimal stub cast to the expected shape — no
 * live agent `Context` is required.
 */

import { runIndexer } from './indexer.js';
import type { IndexResult } from './schema.js';
import { detectLang } from './ts-parser.js';
import {
  CircuitOpenError,
  IndexTimeoutError,
  indexCircuitBreaker,
  type CircuitSnapshot,
} from './circuit-breaker.js';

// ─── Watchdog timeouts ───────────────────────────────────────────────────────
// Every index run is raced against a watchdog so a wedged run (hung FS,
// parser pathology, cross-process SQLite contention) can never hold the
// process-wide mutex forever — that was the failure mode that froze
// terminals: `_indexing` stuck true, every queued reindex piling up, and
// `/codebase-reindex` awaiting a promise that never settles.

/** Watchdog timeout for a full (startup / manual) index run. */
const DEFAULT_FULL_INDEX_TIMEOUT_MS = 120_000;
/** Watchdog timeout for a single-file incremental reindex. */
const DEFAULT_INCREMENTAL_TIMEOUT_MS = 30_000;

// ─── Indexing lifecycle state ─────────────────────────────────────────────────
// Process-wide counters so codebase-search / codebase-stats can gate on
// readiness and UIs can show an indexing indicator. Updated inside the
// mutex so reads from the tools are consistent with the actual build.
let _ready = false;
let _indexing = false;
let _currentFile = 0;
let _totalFiles = 0;
let _lastError: string | null = null;

/** True once the first full-project index has completed (success or failure). */
export function isIndexReady(): boolean {
  return _ready;
}

/**
 * Mark the index as ready so downstream tools (codebase-search, codebase-stats)
 * don't gate on a startup index that never ran (e.g. when runIndexer is called
 * directly via the codebase-index tool rather than through runStartupIndex).
 */
export function setIndexReady(): void {
  _ready = true;
}

/** True while an index build is actively running. */
export function isIndexing(): boolean {
  return _indexing;
}

/** Current indexing progress: { currentFile, totalFiles, ready, indexing, circuit }. */
export function getIndexState(): {
  ready: boolean;
  indexing: boolean;
  currentFile: number;
  totalFiles: number;
  lastError: string | null;
  /** Circuit-breaker state — `open` means indexing is paused after repeated failures. */
  circuit: CircuitSnapshot;
} {
  return {
    ready: _ready,
    indexing: _indexing,
    currentFile: _currentFile,
    totalFiles: _totalFiles,
    lastError: _lastError,
    circuit: indexCircuitBreaker.snapshot(),
  };
}

/**
 * Optional callback fired on every lifecycle transition (started, progress,
 * completed, failed). Plug into the event bus or a TUI dispatcher to surface
 * the indexing state in real time.
 */
type IndexStateListener = (state: ReturnType<typeof getIndexState>) => void;
let _listeners: IndexStateListener[] = [];

export function onIndexStateChange(listener: IndexStateListener): () => void {
  _listeners.push(listener);
  return () => {
    _listeners = _listeners.filter((l) => l !== listener);
  };
}

function emitState() {
  const state = getIndexState();
  for (const l of _listeners) l(state);
}

// Track progress during an index run. Called from runIndexer's inner loop.
export function _setIndexProgress(current: number, total: number) {
  _currentFile = current;
  _totalFiles = total;
  emitState();
}

/** A reindex run with no live agent Context — `runIndexer` only reads `opts`. */
type IndexerCtx = Parameters<typeof runIndexer>[0];
function stubCtx(projectRoot: string): IndexerCtx {
  return {
    projectRoot,
    cwd: projectRoot,
    messages: [],
    todos: [],
    readFiles: new Set<string>(),
    fileMtimes: new Map<string, number>(),
  } as unknown as IndexerCtx;
}

// ─── Process-wide mutex ──────────────────────────────────────────────────────
// A single promise chain. Each enqueued job awaits the previous one's settle
// (success OR failure) before running, so a thrown job never wedges the chain.
let chain: Promise<unknown> = Promise.resolve();

function withMutex<T>(job: () => Promise<T>): Promise<T> {
  const run = chain.then(job, job);
  // Keep the chain alive regardless of this job's outcome.
  chain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/**
 * Run an index job under a watchdog. The timer starts when the job actually
 * begins (i.e. inside the mutex, not while queued behind it). On timeout it
 * both aborts the job's signal — `runIndexer` polls it at yield points and
 * releases its SQLite handle — and rejects the returned promise, so the mutex
 * chain always advances even if the underlying run is wedged on something
 * uninterruptible. A wedged run that later resumes finds its signal aborted
 * and bails at the next yield.
 */
async function runGuarded<T>(
  timeoutMs: number,
  outerSignal: AbortSignal | undefined,
  job: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const ac = new AbortController();
  const onOuterAbort = () => ac.abort(outerSignal?.reason ?? new Error('Indexing cancelled'));
  if (outerSignal?.aborted) onOuterAbort();
  else outerSignal?.addEventListener('abort', onOuterAbort, { once: true });

  let timer: ReturnType<typeof setTimeout> | undefined;
  const watchdog = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const err = new IndexTimeoutError(`Index run exceeded its ${timeoutMs}ms watchdog timeout`);
      ac.abort(err);
      reject(err);
    }, timeoutMs);
    timer.unref?.();
  });

  try {
    return await Promise.race([job(ac.signal), watchdog]);
  } finally {
    if (timer) clearTimeout(timer);
    outerSignal?.removeEventListener('abort', onOuterAbort);
  }
}

/** Build the fail-fast error thrown while the circuit is open. */
function circuitOpenError(): CircuitOpenError {
  const c = indexCircuitBreaker.snapshot();
  return new CircuitOpenError(
    'Codebase indexing is temporarily paused after repeated failures' +
      (c.lastFailure ? ` (last: ${c.lastFailure})` : '') +
      (c.cooldownRemainingMs > 0
        ? `; auto-retry in ${Math.ceil(c.cooldownRemainingMs / 1000)}s`
        : '') +
      '. Use /codebase-reindex to retry now.',
  );
}

// ─── Debounce ────────────────────────────────────────────────────────────────
const DEFAULT_DEBOUNCE_MS = 400;
const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

function debounceKey(indexDir: string | undefined, file: string): string {
  return `${indexDir ?? ''}|${file}`;
}

// ─── Public API ──────────────────────────────────────────────────────────────

/** True when the file's extension maps to a language the indexer can parse. */
export function isIndexableFile(filePath: string): boolean {
  return detectLang(filePath) !== null;
}

/**
 * Run a full-project scan and await it. Used at session start and by the manual
 * `/codebase-reindex` command. Incremental by default (unchanged files skipped
 * via mtime, so repeat runs are cheap); pass `force` to clear and rebuild.
 *
 * Sets the global `_ready` flag on completion so downstream tools know the
 * index is usable.
 */
export async function runStartupIndex(opts: {
  projectRoot: string;
  indexDir?: string | undefined;
  force?: boolean | undefined;
  langs?: string[] | undefined;
  signal?: AbortSignal | undefined;
  /** Watchdog timeout for the whole run. Default: 120s. */
  timeoutMs?: number | undefined;
}): Promise<IndexResult> {
  // Circuit breaker: after repeated failures/timeouts, fail fast instead of
  // queuing yet another run behind a possibly-wedged mutex.
  if (!indexCircuitBreaker.allowRequest()) throw circuitOpenError();

  _indexing = true;
  emitState();

  try {
    const result = await withMutex(() =>
      runGuarded(opts.timeoutMs ?? DEFAULT_FULL_INDEX_TIMEOUT_MS, opts.signal, (signal) => {
        // Reset counters inside the mutex — if runStartupIndex is called
        // twice concurrently, the second caller must not clobber a running
        // index's progress counters. The mutex serializes `runIndexer`, so
        // the second call waits for the first to finish before resetting.
        _currentFile = 0;
        _totalFiles = 0;
        _lastError = null;
        return runIndexer(stubCtx(opts.projectRoot), {
          projectRoot: opts.projectRoot,
          indexDir: opts.indexDir,
          force: opts.force,
          langs: opts.langs,
          signal,
        });
      }),
    );
    _ready = true;
    indexCircuitBreaker.recordSuccess();
    return result;
  } catch (err) {
    _lastError = err instanceof Error ? err.message : String(err);
    _ready = true; // index is "ready" in the sense that we won't try again; downstream tools will see lastError
    // Caller-initiated aborts (session teardown, Ctrl+C) are not indexer
    // failures — only genuine errors and watchdog timeouts trip the breaker.
    if (!opts.signal?.aborted) indexCircuitBreaker.recordFailure(err);
    throw err;
  } finally {
    _indexing = false;
    emitState();
  }
}

/**
 * Debounced, fire-and-forget incremental reindex of specific files. Used by the
 * per-edit toolCall middleware and the external file watcher. Non-indexable
 * paths are dropped. Errors are reported via the optional `onError` callback and
 * never thrown to the caller (background work must not crash a turn).
 */
export function enqueueReindex(opts: {
  projectRoot: string;
  files: string[];
  indexDir?: string | undefined;
  debounceMs?: number | undefined;
  /** Watchdog timeout per file. Default: 30s. */
  timeoutMs?: number | undefined;
  onError?: ((err: unknown) => void) | undefined;
}): void {
  const files = opts.files.filter(isIndexableFile);
  if (files.length === 0) return;
  const ms = opts.debounceMs ?? DEFAULT_DEBOUNCE_MS;

  for (const file of files) {
    const key = debounceKey(opts.indexDir, file);
    const existing = debounceTimers.get(key);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      debounceTimers.delete(key);
      // Checked at fire time (not enqueue time) so an edit made while the
      // circuit is open is dropped instead of queuing behind a wedged mutex.
      if (!indexCircuitBreaker.allowRequest()) {
        opts.onError?.(circuitOpenError());
        return;
      }
      void withMutex(() =>
        runGuarded(opts.timeoutMs ?? DEFAULT_INCREMENTAL_TIMEOUT_MS, undefined, (signal) =>
          runIndexer(stubCtx(opts.projectRoot), {
            projectRoot: opts.projectRoot,
            files: [file],
            indexDir: opts.indexDir,
            signal,
          }),
        ),
      ).then(
        () => indexCircuitBreaker.recordSuccess(),
        (err) => {
          indexCircuitBreaker.recordFailure(err);
          opts.onError?.(err);
        },
      );
    }, ms);
    // Don't keep the event loop alive solely for a pending reindex.
    timer.unref?.();
    debounceTimers.set(key, timer);
  }
}

/** Cancel all pending debounced reindexes. For teardown / tests. */
export function cancelPendingReindexes(): void {
  for (const t of debounceTimers.values()) clearTimeout(t);
  debounceTimers.clear();
}
