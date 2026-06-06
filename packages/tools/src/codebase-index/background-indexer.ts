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

/** Current indexing progress: { currentFile, totalFiles, ready, indexing }. */
export function getIndexState(): {
  ready: boolean;
  indexing: boolean;
  currentFile: number;
  totalFiles: number;
  lastError: string | null;
} {
  return {
    ready: _ready,
    indexing: _indexing,
    currentFile: _currentFile,
    totalFiles: _totalFiles,
    lastError: _lastError,
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
  indexDir?: string;
  force?: boolean;
}): Promise<IndexResult> {
  _indexing = true;
  _currentFile = 0;
  _totalFiles = 0;
  _lastError = null;
  emitState();

  try {
    const result = await withMutex(() =>
      runIndexer(stubCtx(opts.projectRoot), {
        projectRoot: opts.projectRoot,
        indexDir: opts.indexDir,
        force: opts.force,
      }),
    );
    _ready = true;
    return result;
  } catch (err) {
    _lastError = err instanceof Error ? err.message : String(err);
    _ready = true; // index is "ready" in the sense that we won't try again; downstream tools will see lastError
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
  indexDir?: string;
  debounceMs?: number;
  onError?: (err: unknown) => void;
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
      void withMutex(() =>
        runIndexer(stubCtx(opts.projectRoot), {
          projectRoot: opts.projectRoot,
          files: [file],
          indexDir: opts.indexDir,
        }),
      ).catch((err) => opts.onError?.(err));
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
