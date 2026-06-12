/**
 * `codebase-search` tool — search the symbol index with BM25 ranking.
 *
 * Usage: codebase-search({
 *   query: string,        // search terms
 *   kind?: string,       // class|function|interface|method|const|...
 *   lang?: string,       // ts|tsx|js|jsx|go|py|rs
 *   file?: string,       // filter to a specific file path (substring match)
 *   limit?: number,      // max results (default 20, max 100)
 * })
 *
 * Returns: [{ name, kind, lang, file, line, signature, snippet, score }, ...]
 *
 * The query executes in the index worker via FTS5 (`MATCH` + native `bm25()`)
 * — the main thread never opens SQLite, so a contended or wedged index can
 * slow this tool down but can never freeze the terminal.
 */

import type { Tool } from '@wrongstack/core';
import { getIndexState, searchCodebaseIndex } from './background-indexer.js';
import type { SearchResult } from './schema.js';
import { codebaseIndexDirOverride } from './writer.js';
export const codebaseSearchTool: Tool<CodebaseSearchInput, CodebaseSearchOutput> = {
  name: 'codebase-search',
  category: 'Project',
  description:
    'Semantic/keyword search over the indexed codebase symbols (functions, classes, interfaces, etc.). Uses BM25 ranking. ' +
    'Much more powerful and structured than raw `grep` for finding code by name or concept.',
  usageHint:
    'PREFERRED FOR CODE UNDERSTANDING:\n\n' +
    '- Use when you need to find where something is defined or used by name.\n' +
    '- `kind` filter is very useful (e.g. only functions or only interfaces).\n' +
    '- Combine with `file` filter to scope to a specific directory or module.\n' +
    'This is generally better than `grep` when you are looking for symbols rather than arbitrary text patterns.',
  permission: 'auto',
  mutating: false,
  capabilities: ['fs.read'],
  timeoutMs: 10_000,
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Search query — searches symbol names, signatures, and doc comments',
      },
      kind: {
        type: 'string',
        description:
          'Filter by symbol kind: class, function, interface, method, const, let, var, property, type, enum',
      },
      lang: {
        type: 'string',
        description: 'Filter by language: ts, tsx, js, jsx',
      },
      lspKind: {
        type: 'integer',
        description:
          'Filter by LSP SymbolKind number (e.g. 5=Class, 12=Function, 11=Interface, 10=Enum)',
      },
      file: {
        type: 'string',
        description: 'Filter to files matching this path substring',
      },
      limit: {
        type: 'integer',
        description: 'Maximum results to return (default 20, max 100)',
        minimum: 1,
        maximum: 100,
      },
    },
    required: ['query'],
  },
  async execute(input, ctx, execOpts) {
    // Gate: if the index is still building or hasn't been built yet, return a
    // clear status instead of querying partial/inconsistent data.
    const state = getIndexState();
    if (!state.ready) {
      return {
        results: [],
        total: 0,
        query: input.query,
        indexStatus: state.indexing
          ? `Indexing in progress (${state.currentFile}/${state.totalFiles} files) — retry in a moment.`
          : 'Index not yet built. The codebase is being indexed at startup — search will be available shortly.',
      };
    }
    if (state.indexing) {
      return {
        results: [],
        total: 0,
        query: input.query,
        indexStatus: `Index refresh in progress (${state.currentFile}/${state.totalFiles} files). Results may be incomplete.`,
      };
    }
    if (state.lastError) {
      const circuit = state.circuit;
      const retryHint =
        circuit.state === 'open'
          ? `Indexing is paused (circuit open, retry in ${Math.ceil(circuit.cooldownRemainingMs / 1000)}s); the user can run /codebase-reindex to retry now.`
          : 'Try /codebase-reindex.';
      return {
        results: [],
        total: 0,
        query: input.query,
        indexStatus: `Index build failed: ${state.lastError}. ${retryHint}`,
      };
    }

    const limit = Math.min(input.limit ?? 20, 100);
    const { results, total } = await searchCodebaseIndex(
      {
        projectRoot: ctx.projectRoot,
        indexDir: codebaseIndexDirOverride(ctx),
        query: input.query,
        kind: input.kind,
        lang: input.lang,
        file: input.file,
        lspKind: input.lspKind,
        limit,
      },
      { signal: execOpts?.signal },
    );
    return { results, total, query: input.query };
  },
};

// ─── Types ─────────────────────────────────────────────────────────────────────

interface CodebaseSearchInput {
  query: string;
  kind?: string | undefined;
  lang?: string | undefined;
  file?: string | undefined;
  limit?: number | undefined;
  lspKind?: number | undefined;
}

interface CodebaseSearchOutput {
  results: SearchResult[];
  total: number; // total candidates before limit
  query: string;
  /** Non-empty when the index blocked the search (not ready, indexing, failed). */
  indexStatus?: string | undefined;
}
