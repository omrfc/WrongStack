/**
 * Automatic codebase-index wiring.
 *
 * Keeps the `codebase-search` symbol index fresh without the user ever calling
 * `codebase-index` by hand. Three behaviors, each gated by `config.indexing`:
 *
 *   1. onSessionStart — a blocking incremental index at boot, with a visible
 *      one-line summary (the "show").
 *   2. onEdit         — a `toolCall` middleware that reindexes files the agent
 *      writes/edits via tools, in the background (debounced).
 *   3. watchExternal  — an `fs.watch` on the project root that reindexes files
 *      changed outside the agent (e.g. the user's editor).
 *
 * All three funnel through `@wrongstack/tools`' background indexer, which
 * serializes every run on one mutex (the SQLite writer is synchronous, so
 * concurrent runs would risk `SQLITE_BUSY`) and debounces per file.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
  AgentPipelines,
  Context,
  IndexingConfig,
  Logger,
  ToolCallPipelinePayload,
} from '@wrongstack/core';
import {
  cancelPendingReindexes,
  enqueueReindex,
  isIndexableFile,
  runStartupIndex,
  shutdownCodebaseIndexHost,
} from '@wrongstack/tools';

/** Mutating builtin tools whose input carries a single `file_path`. */
const FILE_EDIT_TOOLS = new Set(['write', 'edit', 'multi-edit', 'notebook-edit']);

/** Directories never worth watching/indexing (mirrors the indexer's own ignore set). */
const IGNORE_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  'coverage',
  '.turbo',
  '__snapshots__',
  '.nyc_output',
]);

function isIgnored(rel: string): boolean {
  return rel.split(/[/\\]/).some((seg) => IGNORE_DIRS.has(seg));
}

export interface CodebaseIndexingDeps {
  config: { indexing?: IndexingConfig | undefined };
  context: Context;
  pipelines: AgentPipelines;
  projectRoot: string;
  logger: Logger;
}

/**
 * Wire up automatic indexing. Returns a `dispose()` that stops the watcher and
 * cancels pending reindexes — call it on process teardown.
 */
export async function setupCodebaseIndexing(deps: CodebaseIndexingDeps): Promise<() => void> {
  const { config, context, pipelines, projectRoot, logger } = deps;
  const idx = config.indexing;
  // No config block (e.g. --bare) → opt out entirely.
  if (!idx) return () => {};

  const debounceMs = idx.debounceMs ?? 400;
  const onError = (err: unknown) =>
    logger.debug(`codebase auto-index failed: ${err instanceof Error ? err.message : String(err)}`);

  // 1. Background startup index. The prompt is available immediately; the
  //    index runs asynchronously and the TUI already tracks progress via
  //    getIndexState()/onIndexStateChange() — the status bar chip "⚙ indexing
  //    N/M" appears during the build and disappears when it finishes.
  //    We must NOT write directly to stderr here because it bypasses Ink's
  //    rendering and pushes the input area into native scrollback history.
  if (idx.onSessionStart) {
    void runStartupIndex({ projectRoot, signal: context.signal, timeoutMs: idx.indexTimeoutMs })
      .then((r) => {
        logger.info(
          `codebase index ready: ${r.symbolsIndexed} symbols · ${r.filesIndexed} files · ${r.durationMs}ms`,
        );
      })
      .catch((err) => {
        logger.warn(
          `codebase index (startup) failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
  }

  // 2. Reindex agent tool edits.
  if (idx.onEdit) {
    pipelines.toolCall.use({
      name: 'CodebaseAutoIndex',
      // Non-core owner → the pipeline error boundary swallows failures instead
      // of failing the turn (see wiring/pipeline.ts).
      owner: 'codebase-index',
      handler: async (
        payload: ToolCallPipelinePayload,
        next: (v: ToolCallPipelinePayload) => Promise<ToolCallPipelinePayload>,
      ) => {
        try {
          const tool = payload.tool;
          if (tool?.mutating && FILE_EDIT_TOOLS.has(tool.name)) {
            const fp = (payload.toolUse.input as { file_path?: unknown | undefined })?.file_path;
            if (typeof fp === 'string' && fp.length > 0) {
              const abs = path.resolve(payload.ctx.cwd, fp);
              if (isIndexableFile(abs)) {
                enqueueReindex({ projectRoot, files: [abs], debounceMs, onError });
              }
            }
          }
        } catch {
          // Never let index bookkeeping interfere with the tool result.
        }
        return next(payload);
      },
    });
  }

  // 3. Watch the project root for external editor changes.
  let watcher: fs.FSWatcher | undefined;
  if (idx.watchExternal) {
    try {
      watcher = fs.watch(projectRoot, { recursive: true }, (_event, filename) => {
        if (!filename) return;
        const rel = filename.toString();
        if (isIgnored(rel)) return;
        const abs = path.resolve(projectRoot, rel);
        if (!isIndexableFile(abs)) return;
        enqueueReindex({ projectRoot, files: [abs], debounceMs, onError });
      });
      watcher.on('error', (err) => logger.debug(`codebase index watcher error: ${err}`));
      // Don't keep the process alive solely for the watcher.
      (watcher as unknown as { unref?: () => void }).unref?.();
    } catch (err) {
      // Recursive watch is unsupported on some platforms — degrade gracefully.
      logger.debug(
        `codebase index watcher unavailable: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // Reference context so the binding is used even when onEdit is off (keeps the
  // dependency explicit; ctx.cwd is read inside the middleware).
  void context;

  return () => {
    try {
      watcher?.close();
    } catch {
      /* ignore */
    }
    cancelPendingReindexes();
    // Stops the index worker thread too (it is unref'd, but an explicit stop
    // keeps teardown deterministic).
    shutdownCodebaseIndexHost();
  };
}
