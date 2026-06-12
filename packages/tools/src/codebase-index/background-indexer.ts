/**
 * Index host — the main-thread coordinator for all codebase-index operations.
 *
 * Production mode runs every operation (full scans, per-file reindexes,
 * searches, stats) in a dedicated worker thread (`worker.ts`), so the
 * synchronous `node:sqlite` calls and the TypeScript parser can never block
 * the main event loop — the failure mode that used to freeze terminals is
 * structurally impossible. When the built worker file is not present (tests
 * run from source, exotic runtimes) or `WRONGSTACK_INDEX_INLINE=1` is set,
 * operations fall back to running inline through the same service layer.
 *
 * Concerns owned here, in front of either execution mode:
 *
 * 1. **Serialization** — every write run (startup scan, per-edit incremental,
 *    external file-watch, manual reindex) goes through one process-wide
 *    promise-chain mutex so two runs never race the same `index.db` writer.
 * 2. **Debounce** — rapid successive edits to the same file coalesce into a
 *    single reindex, keyed per `(indexDir, file)`.
 * 3. **Watchdog** — every operation is raced against a timeout. In worker
 *    mode a timeout hard-terminates the worker (it respawns lazily on the
 *    next request); inline it aborts the run's signal. Either way the mutex
 *    chain always advances and the promise always settles.
 * 4. **Circuit breaker** — repeated failures/timeouts pause indexing instead
 *    of queuing more work behind a wedged pipeline. See circuit-breaker.ts.
 * 5. **State tracking** — ready/indexing/progress flags + change listeners
 *    for the TUI status chip and the search/stats tools' gating.
 */

import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import {
  CircuitOpenError,
  type CircuitSnapshot,
  IndexTimeoutError,
  indexCircuitBreaker,
} from './circuit-breaker.js';
import { indexService, searchService, statsService } from './index-service.js';
import type { IndexResult, IndexStats } from './schema.js';
import { detectLang } from './ts-parser.js';
import type {
  HostToWorker,
  IndexOpArgs,
  OpName,
  OpShapes,
  SearchOpArgs,
  SearchOpResult,
  StatsOpArgs,
  WorkerToHost,
} from './worker-protocol.js';

// ─── Watchdog timeouts ───────────────────────────────────────────────────────

/** Watchdog timeout for a full (startup / manual) index run. */
const DEFAULT_FULL_INDEX_TIMEOUT_MS = 120_000;
/** Watchdog timeout for a single-file incremental reindex. */
const DEFAULT_INCREMENTAL_TIMEOUT_MS = 30_000;
/** Watchdog timeout for read operations (search / stats). */
const DEFAULT_QUERY_TIMEOUT_MS = 8_000;

// ─── Indexing lifecycle state ─────────────────────────────────────────────────
// Process-wide counters so codebase-search / codebase-stats can gate on
// readiness and UIs can show an indexing indicator.
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
 * don't gate on a startup index that never ran.
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

function setIndexProgress(current: number, total: number) {
  _currentFile = current;
  _totalFiles = total;
  emitState();
}

// ─── Worker management ───────────────────────────────────────────────────────

interface PendingRpc {
  resolve: (value: unknown) => void;
  reject: (err: unknown) => void;
  onProgress?: ((current: number, total: number) => void) | undefined;
}

let worker: Worker | null = null;
let workerUnavailable = false;
let nextRpcId = 1;
const pending = new Map<number, PendingRpc>();

/**
 * Locate the built worker file. The host is bundled into several entry points
 * (`dist/index.js`, `dist/builtin.js`, `dist/codebase-index/index.js`), so the
 * worker is probed at both relative locations. From source (vitest) neither
 * `.js` exists → inline mode, which keeps tests hermetic and mockable.
 */
function resolveWorkerUrl(): URL | null {
  if (process.env['WRONGSTACK_INDEX_INLINE']) return null;
  for (const rel of ['./worker.js', './codebase-index/worker.js']) {
    try {
      const url = new URL(rel, import.meta.url);
      if (url.protocol === 'file:' && fs.existsSync(fileURLToPath(url))) return url;
    } catch {
      /* try the next candidate */
    }
  }
  return null;
}

function failAllPending(err: unknown): void {
  const entries = [...pending.values()];
  pending.clear();
  for (const p of entries) p.reject(err);
}

function ensureWorker(): Worker | null {
  if (worker) return worker;
  if (workerUnavailable) return null;
  const url = resolveWorkerUrl();
  if (!url) {
    workerUnavailable = true;
    return null;
  }
  try {
    const w = new Worker(url, { name: 'wstack-codebase-index' });
    // The worker must never keep the process alive on its own.
    w.unref();
    w.on('message', (msg: WorkerToHost) => {
      if (msg.type === 'progress') {
        pending.get(msg.id)?.onProgress?.(msg.current, msg.total);
        return;
      }
      const entry = pending.get(msg.id);
      if (!entry) return; // already timed out / cancelled
      pending.delete(msg.id);
      if (msg.ok) entry.resolve(msg.result);
      else entry.reject(new Error(msg.error));
    });
    w.on('error', (err) => {
      worker = null;
      failAllPending(err);
    });
    w.on('exit', () => {
      if (worker === w) worker = null;
      failAllPending(new Error('codebase-index worker exited'));
    });
    worker = w;
    return w;
  } catch {
    // Spawn failed (no worker_threads, sandbox, …) — fall back to inline for
    // the rest of the process lifetime.
    workerUnavailable = true;
    return null;
  }
}

/** Hard-kill a wedged worker. It respawns lazily on the next operation. */
function terminateWorker(reason: unknown): void {
  const w = worker;
  worker = null;
  failAllPending(reason);
  if (w) void w.terminate().catch(() => {});
}

/**
 * Tear down the index host (worker + pending debounces). Call on process
 * shutdown; safe to call when nothing is running.
 */
export function shutdownCodebaseIndexHost(): void {
  cancelPendingReindexes();
  terminateWorker(new Error('codebase-index host shut down'));
  workerUnavailable = false; // a future call may spawn a fresh worker
}

interface CallOpts {
  timeoutMs: number;
  signal?: AbortSignal | undefined;
  onProgress?: ((current: number, total: number) => void) | undefined;
}

/**
 * Run one operation, in the worker when available, inline otherwise. Both
 * paths share the watchdog: the returned promise ALWAYS settles within
 * `timeoutMs`, and a timeout in worker mode terminates the (possibly wedged
 * in synchronous code) worker — something an in-process watchdog can never do.
 */
function callIndexOp<O extends OpName>(
  op: O,
  args: OpShapes[O]['args'],
  opts: CallOpts,
): Promise<OpShapes[O]['result']> {
  const w = ensureWorker();
  if (!w) return callInline(op, args, opts);

  return new Promise<OpShapes[O]['result']>((resolve, reject) => {
    const id = nextRpcId++;

    const timer = setTimeout(() => {
      pending.delete(id);
      const err = new IndexTimeoutError(
        `Index ${op} exceeded its ${opts.timeoutMs}ms watchdog timeout`,
      );
      // A wedged worker (synchronous sqlite wait, pathological parse) cannot
      // be cooperatively cancelled — kill it; it respawns on the next call.
      terminateWorker(err);
      reject(err);
    }, opts.timeoutMs);
    timer.unref?.();

    const onAbort = () => {
      // Cooperative cancel; the worker aborts the op's signal and responds
      // with an error. The watchdog stays armed as the backstop.
      w.postMessage({ type: 'cancel', id } satisfies HostToWorker);
    };
    if (opts.signal?.aborted) onAbort();
    else opts.signal?.addEventListener('abort', onAbort, { once: true });

    const cleanup = () => {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
    };
    pending.set(id, {
      resolve: (v) => {
        cleanup();
        resolve(v as OpShapes[O]['result']);
      },
      reject: (e) => {
        cleanup();
        reject(e);
      },
      onProgress: opts.onProgress,
    });

    w.postMessage({ type: 'request', id, op, args } satisfies HostToWorker);
  });
}

/** Inline fallback: same service code, raced against the same watchdog. */
async function callInline<O extends OpName>(
  op: O,
  args: OpShapes[O]['args'],
  opts: CallOpts,
): Promise<OpShapes[O]['result']> {
  const ac = new AbortController();
  const onOuterAbort = () => ac.abort(opts.signal?.reason ?? new Error('Indexing cancelled'));
  if (opts.signal?.aborted) onOuterAbort();
  else opts.signal?.addEventListener('abort', onOuterAbort, { once: true });

  let timer: ReturnType<typeof setTimeout> | undefined;
  const watchdog = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const err = new IndexTimeoutError(
        `Index ${op} exceeded its ${opts.timeoutMs}ms watchdog timeout`,
      );
      ac.abort(err);
      reject(err);
    }, opts.timeoutMs);
    timer.unref?.();
  });

  const job = async (): Promise<OpShapes[O]['result']> => {
    switch (op) {
      case 'index':
        return (await indexService(args as IndexOpArgs, {
          signal: ac.signal,
          onProgress: opts.onProgress,
        })) as OpShapes[O]['result'];
      case 'search':
        return searchService(args as SearchOpArgs) as OpShapes[O]['result'];
      case 'stats':
        return statsService(args as StatsOpArgs) as OpShapes[O]['result'];
      default:
        throw new Error(`unknown index op: ${String(op)}`);
    }
  };

  try {
    return await Promise.race([job(), watchdog]);
  } finally {
    if (timer) clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onOuterAbort);
  }
}

// ─── Process-wide write mutex ────────────────────────────────────────────────
// A single promise chain. Each enqueued job awaits the previous one's settle
// (success OR failure) before running, so a thrown job never wedges the chain.
// Only write runs (index) take the mutex; searches/stats are WAL reads.
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
  // queuing yet another run behind a possibly-wedged pipeline.
  if (!indexCircuitBreaker.allowRequest()) throw circuitOpenError();

  _indexing = true;
  emitState();

  try {
    const result = await withMutex(() => {
      // Reset counters inside the mutex — if runStartupIndex is called twice
      // concurrently, the second caller must not clobber a running index's
      // progress counters.
      _currentFile = 0;
      _totalFiles = 0;
      _lastError = null;
      return callIndexOp(
        'index',
        {
          projectRoot: opts.projectRoot,
          indexDir: opts.indexDir,
          force: opts.force,
          langs: opts.langs,
        },
        {
          timeoutMs: opts.timeoutMs ?? DEFAULT_FULL_INDEX_TIMEOUT_MS,
          signal: opts.signal,
          onProgress: setIndexProgress,
        },
      );
    });
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
        callIndexOp(
          'index',
          { projectRoot: opts.projectRoot, files: [file], indexDir: opts.indexDir },
          { timeoutMs: opts.timeoutMs ?? DEFAULT_INCREMENTAL_TIMEOUT_MS },
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

/**
 * Ranked symbol search against the index. The query runs in the index worker
 * (or inline in fallback mode) — the main thread never opens SQLite. Reads
 * don't take the write mutex (WAL readers don't block the writer) and don't
 * feed the circuit breaker; a wedged read still trips the watchdog, which
 * recycles the worker.
 */
export async function searchCodebaseIndex(
  args: SearchOpArgs,
  opts: { timeoutMs?: number | undefined; signal?: AbortSignal | undefined } = {},
): Promise<SearchOpResult> {
  return callIndexOp('search', args, {
    timeoutMs: opts.timeoutMs ?? DEFAULT_QUERY_TIMEOUT_MS,
    signal: opts.signal,
  });
}

/** Index health/statistics, fetched off the main thread like searches. */
export async function codebaseIndexStats(
  args: StatsOpArgs,
  opts: { timeoutMs?: number | undefined; signal?: AbortSignal | undefined } = {},
): Promise<IndexStats> {
  return callIndexOp('stats', args, {
    timeoutMs: opts.timeoutMs ?? DEFAULT_QUERY_TIMEOUT_MS,
    signal: opts.signal,
  });
}
