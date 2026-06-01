
import type { Tool } from '@wrongstack/core';
import { runIndexer } from './indexer.js';

export const codebaseIndexTool: Tool<CodebaseIndexInput, CodebaseIndexOutput> = {
  name: 'codebase-index',
  category: 'Project',
  description:
    'Build or update the symbol index for the project. Runs incrementally by default — only re-indexes files that changed since the last run.',
  usageHint:
    'Call with `force: true` to wipe and rebuild the index from scratch. Use `langs` to limit to specific languages. First call without arguments to do an incremental index.',
  permission: 'auto',
  mutating: true,
  timeoutMs: 120_000,
  inputSchema: {
    type: 'object',
    properties: {
      force: {
        type: 'boolean',
        description: 'Force a full reindex — clears the index first and reindexes all files.',
      },
      langs: {
        type: 'array',
        items: { type: 'string' },
        description: 'Limit reindex to specific languages: ts, tsx, js, jsx, go, py, rs',
      },
    },
  },
  async execute(input, ctx) {
    const result = await runIndexer(ctx, {
      projectRoot: ctx.projectRoot,
      force: input.force ?? false,
      langs: input.langs,
    });
    return result;
  },
};

// ─── Types for tool I/O ────────────────────────────────────────────────────────

interface CodebaseIndexInput {
  force?: boolean;
  langs?: string[];
}

interface CodebaseIndexOutput {
  filesIndexed: number;
  symbolsIndexed: number;
  langStats: Record<string, number>;
  durationMs: number;
  errors: string[];
}