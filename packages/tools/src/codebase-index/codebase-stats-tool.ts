/**
 * `codebase-stats` tool — report index health and statistics.
 *
 * Usage: codebase-stats({})
 *
 * Returns: { totalSymbols, totalFiles, byLang, byKind, lastIndexed, sizeBytes, version }
 */

import type { Tool } from '@wrongstack/core';
import { IndexStore, codebaseIndexDirOverride } from './writer.js';
import { getIndexState } from './background-indexer.js';
import { SCHEMA_VERSION } from './schema.js';

export const codebaseStatsTool: Tool<Record<string, never>, CodebaseStatsOutput> = {
  name: 'codebase-stats',
  category: 'Project',
  description: 'Return health and statistics about the current symbol index (total symbols, files, language/kind breakdown, size, last update). Useful to decide whether to re-index.',
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
  async execute(_input, ctx) {
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
    if (idxState.indexing) {
      // Still serve real stats but note they may be incomplete.
      const store = new IndexStore(ctx.projectRoot, { indexDir: codebaseIndexDirOverride(ctx) });
      try {
        const stats = store.getStats();
        return {
          ...stats,
          indexStatus: `Index refresh in progress (${idxState.currentFile}/${idxState.totalFiles} files). Stats may be incomplete.`,
        };
      } finally {
        store.close();
      }
    }

    const store = new IndexStore(ctx.projectRoot, { indexDir: codebaseIndexDirOverride(ctx) });
    try {
      const stats = store.getStats();
      return {
        totalSymbols: stats.totalSymbols,
        totalFiles: stats.totalFiles,
        byLang: stats.byLang,
        byKind: stats.byKind,
        lastIndexed: stats.lastIndexed,
        sizeBytes: stats.sizeBytes,
        indexPath: stats.indexPath,
        version: stats.version,
      };
    } finally {
      store.close();
    }
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
  indexStatus?: string;
}