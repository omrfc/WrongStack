
import type { Tool } from '@wrongstack/core';
import { runIndexer } from './indexer.js';
import { codebaseIndexDirOverride } from './writer.js';

export const codebaseIndexTool: Tool<CodebaseIndexInput, CodebaseIndexOutput> = {
  name: 'codebase-index',
  category: 'Project',
  description:
    'Build or incrementally update the project-wide symbol index. This powers fast codebase search and understanding. ' +
    'By default it only processes files that have changed since the last indexing run.',
  usageHint:
    'IMPORTANT FOR LARGE CODEBASES:\n\n' +
    '- First run (or after major changes): consider `force: true` for a clean rebuild.\n' +
    '- Normal usage: call without arguments for fast incremental updates.\n' +
    '- Use `langs` to restrict to specific languages if you only care about certain parts of the project.\n' +
    'This tool is relatively expensive — do not call it on every turn. Use it when the index is stale or before heavy codebase-search sessions.',
  permission: 'confirm',
  mutating: true,
  capabilities: ['fs.write.outside-project'],
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
      indexDir: codebaseIndexDirOverride(ctx),
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