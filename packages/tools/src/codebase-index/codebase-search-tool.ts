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
 */

import type { Tool } from '@wrongstack/core';
import { IndexStore, codebaseIndexDirOverride } from './writer.js';
import { buildBm25Index, buildIndexableText, tokenise } from './bm25.js';
import type { SearchResult, SymbolKind, SymbolLang } from './schema.js';
import { getIndexState } from './background-indexer.js';

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
        description: 'Filter by symbol kind: class, function, interface, method, const, let, var, property, type, enum',
      },
      lang: {
        type: 'string',
        description: 'Filter by language: ts, tsx, js, jsx',
      },
      lspKind: {
        type: 'integer',
        description: 'Filter by LSP SymbolKind number (e.g. 5=Class, 12=Function, 11=Interface, 10=Enum)',
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
  async execute(input, ctx) {
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
      return {
        results: [],
        total: 0,
        query: input.query,
        indexStatus: `Index build failed: ${state.lastError}. Try /codebase-reindex.`,
      };
    }

    const store = new IndexStore(ctx.projectRoot, { indexDir: codebaseIndexDirOverride(ctx) });
    try {
      const limit = Math.min(input.limit ?? 20, 100);

      // 1. Get initial candidates from SQLite (broad filter)
      const candidates = store.search(input.query, {
        kind: input.kind as SymbolKind | undefined,
        lang: input.lang as SymbolLang | undefined,
        file: input.file,
        lspKind: input.lspKind,
      });

      if (candidates.length === 0) {
        return { results: [], total: 0, query: input.query };
      }

      // 2. Build BM25 index over candidates
      // Use buildIndexableText to split camelCase names so queries like
      // "complex" match "complexOperation" (split → "complex Operation")
      const indexable = candidates.map((c) => ({
        id: c.id,
        text: buildIndexableText(c.name, c.signature, c.docComment),
      }));
      const bm25 = buildBm25Index(indexable);

      // 3. Score and rank
      const scored = bm25.score(input.query, (id) => candidates.some((c) => c.id === id));

      // 4. Sort descending by score and take top N
      scored.sort((a, b) => b.score - a.score);
      const top = scored.slice(0, limit);

      const qTokens = tokenise(input.query);

      const results: SearchResult[] = top.map(({ id, score }) => {
        const c = candidates.find((c) => c.id === id)!;
        const snippet = bm25.extractSnippet(id, qTokens);
        return {
          ...c,
          score,
          snippet,
        };
      });

      return {
        results,
        total: candidates.length,
        query: input.query,
      };
    } finally {
      store.close();
    }
  },
};

// ─── Types ─────────────────────────────────────────────────────────────────────

interface CodebaseSearchInput {
  query: string;
  kind?: string;
  lang?: string;
  file?: string;
  limit?: number;
  lspKind?: number;
}

interface CodebaseSearchOutput {
  results: SearchResult[];
  total: number;  // total candidates before limit
  query: string;
  /** Non-empty when the index blocked the search (not ready, indexing, failed). */
  indexStatus?: string;
}
