/**
 * Execution-location-agnostic index operations.
 *
 * One implementation, two callers: the index worker thread (production —
 * synchronous SQLite and the TypeScript parser can never block the main
 * thread / terminal UI there) and the inline fallback inside the host (tests,
 * `WRONGSTACK_INDEX_INLINE=1`, or runtimes where the worker file is missing).
 *
 * Every operation opens its own short-lived IndexStore, exactly like the old
 * per-call code paths did — there is no connection state to share, which keeps
 * multi-project usage trivially correct and crash recovery simple.
 */

import type { Context } from '@wrongstack/core';
import { runIndexer } from './indexer.js';
import type { IndexResult, IndexStats, SymbolKind, SymbolLang } from './schema.js';
import type { IndexOpArgs, SearchOpArgs, SearchOpResult, StatsOpArgs } from './worker-protocol.js';
import { IndexStore } from './writer.js';

/** A run with no live agent Context — `runIndexer` only reads `opts`. */
function stubCtx(projectRoot: string): Context {
  return {
    projectRoot,
    cwd: projectRoot,
    messages: [],
    todos: [],
    readFiles: new Set<string>(),
    fileMtimes: new Map<string, number>(),
  } as unknown as Context;
}

export interface ServiceHooks {
  signal?: AbortSignal | undefined;
  onProgress?: ((current: number, total: number) => void) | undefined;
}

/** Full or per-file index run. */
export async function indexService(
  args: IndexOpArgs,
  hooks: ServiceHooks = {},
): Promise<IndexResult> {
  return runIndexer(stubCtx(args.projectRoot), {
    projectRoot: args.projectRoot,
    indexDir: args.indexDir,
    files: args.files,
    force: args.force,
    langs: args.langs,
    ignore: args.ignore,
    signal: hooks.signal,
    onProgress: hooks.onProgress,
  });
}

/** Ranked symbol search (FTS5 inside SQLite; BM25 fallback without FTS5). */
export function searchService(args: SearchOpArgs): SearchOpResult {
  const store = new IndexStore(args.projectRoot, { indexDir: args.indexDir });
  try {
    return store.searchRanked(
      args.query,
      {
        kind: args.kind as SymbolKind | undefined,
        lang: args.lang as SymbolLang | undefined,
        file: args.file,
        lspKind: args.lspKind,
      },
      args.limit,
    );
  } finally {
    store.close();
  }
}

/** Index health and statistics. */
export function statsService(args: StatsOpArgs): IndexStats {
  const store = new IndexStore(args.projectRoot, { indexDir: args.indexDir });
  try {
    return store.getStats();
  } finally {
    store.close();
  }
}
