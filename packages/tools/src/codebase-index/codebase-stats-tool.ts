/**
 * `codebase-stats` tool — report index health and statistics.
 *
 * Usage: codebase-stats({})
 *
 * Returns: { totalSymbols, totalFiles, byLang, byKind, lastIndexed, sizeBytes, version }
 */

import type { Tool } from '@wrongstack/core';
import { codebaseIndexStats, getIndexState } from './background-indexer.js';
import { SCHEMA_VERSION } from './schema.js';
import { codebaseIndexDirOverride } from './writer.js';

export const codebaseStatsTool: Tool<Record<string, never>, CodebaseStatsOutput> = {
  name: 'codebase-stats',
  category: 'Project',
  description:
    'Return health and statistics about the current symbol index (total symbols, files, language/kind breakdown, size, last update). Useful to decide whether to re-index.',
  usageHint:
    'CALL BEFORE HEAVY CODEBASE-SEARCH WORK:\n\n' +
    '- Use to see if the index is up-to-date or needs a refresh.\n' +
    '- No arguments required.\n' +
    '- Helps avoid wasting tokens on searches against a stale index.\n' +
    'Lightweight and safe to call frequently.',
  permission: 'auto',
  mutating: false,
  capabilities: ['fs.read'],
  timeoutMs: 5_000,
  inputSchema: {
    type: 'object',
    properties: {},
    additionalProperties: false,
  },
  async execute(_input, ctx, execOpts) {
    const idxState = getIndexState();
    if (!idxState.ready) {
      return {
        totalSymbols: 0,
        totalFiles: 0,
        byLang: {},
        byKind: {},
        lastIndexed: null,
        sizeBytes: 0,
        indexPath: '',
        version: SCHEMA_VERSION,
        indexStatus: idxState.indexing
          ? `Indexing in progress (${idxState.currentFile}/${idxState.totalFiles} files).`
          : 'Index not yet built.',
      };
    }

    // Fetched via the index host (worker thread when available) — the main
    // thread never opens SQLite here.
    const stats = await codebaseIndexStats(
      { projectRoot: ctx.projectRoot, indexDir: codebaseIndexDirOverride(ctx) },
      { signal: execOpts?.signal },
    );

    if (idxState.indexing) {
      return {
        ...stats,
        indexStatus: `Index refresh in progress (${idxState.currentFile}/${idxState.totalFiles} files). Stats may be incomplete.`,
      };
    }

    const circuit = idxState.circuit;
    return {
      totalSymbols: stats.totalSymbols,
      totalFiles: stats.totalFiles,
      byLang: stats.byLang,
      byKind: stats.byKind,
      lastIndexed: stats.lastIndexed,
      sizeBytes: stats.sizeBytes,
      indexPath: stats.indexPath,
      version: stats.version,
      ...(circuit.state === 'open'
        ? {
            indexStatus:
              `Indexing is paused after repeated failures (last: ${circuit.lastFailure ?? 'unknown'}); ` +
              `auto-retry in ${Math.ceil(circuit.cooldownRemainingMs / 1000)}s, or run /codebase-reindex. Stats reflect the last successful build.`,
          }
        : {}),
    };
  },
};

interface CodebaseStatsOutput {
  totalSymbols: number;
  totalFiles: number;
  byLang: Record<string, number>;
  byKind: Record<string, number>;
  lastIndexed: number | null;
  sizeBytes: number;
  indexPath: string;
  version: number;
  /** Non-empty when the index is not ready or is still building. */
  indexStatus?: string | undefined;
}
