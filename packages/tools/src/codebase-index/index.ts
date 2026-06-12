/**
 * @wrongstack/tools – Codebase Index
 *
 * Three tools for building and querying a symbol index:
 *
 *   `codebase-index`  — run the indexer (full or incremental)
 *   `codebase-search` — BM25-ranked symbol search
 *   `codebase-stats`  — index health and statistics
 *
 * Storage: `~/.wrongstack/projects/<hash>/codebase-index/index.db`
 *          (outside the repo — no gitignore needed)
 * Parser:  TypeScript Compiler API (ts-morph-free, uses `typescript` directly)
 * Ranking: Okapi BM25 with k1=1.5, b=0.75
 */

export { codebaseIndexTool } from './codebase-index-tool.js';
export { codebaseSearchTool } from './codebase-search-tool.js';
export { codebaseStatsTool } from './codebase-stats-tool.js';

// Indexer entry point + background coordinator (used by CLI auto-index wiring
// and the file-watcher plugin's autoIndex path).
export { runIndexer } from './indexer.js';
export {
  runStartupIndex,
  enqueueReindex,
  isIndexableFile,
  cancelPendingReindexes,
  isIndexReady,
  isIndexing,
  getIndexState,
  onIndexStateChange,
  searchCodebaseIndex,
  codebaseIndexStats,
  shutdownCodebaseIndexHost,
} from './background-indexer.js';

// Circuit breaker guarding every index run (startup, incremental, manual).
// `resetIndexCircuitBreaker` is the manual-recovery hook for /codebase-reindex.
export {
  IndexCircuitBreaker,
  indexCircuitBreaker,
  resetIndexCircuitBreaker,
  CircuitOpenError,
  IndexTimeoutError,
} from './circuit-breaker.js';
export type { CircuitState, CircuitSnapshot } from './circuit-breaker.js';

// Re-export shared internal helpers so external consumers (e.g. plug-lsp)
// can use them without importing from implementation detail files.
export { IndexStore, resolveIndexDir, codebaseIndexDirOverride } from './writer.js';
export {
  tokenise,
  buildIndexableText,
  buildBm25Index,
} from './bm25.js';
export {
  internalKindToLspKind,
  lspKindToInternalKind,
} from './lsp-kind.js';

// Re-export shared types
export type {
  Symbol,
  SymbolKind,
  SymbolLang,
  FileSymbols,
  FileMeta,
  IndexStats,
  IndexResult,
  SearchResult,
} from './schema.js';
export { SCHEMA_VERSION } from './schema.js';