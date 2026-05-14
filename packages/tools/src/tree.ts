import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { Tool, ToolProgressEvent, ToolStreamEvent } from '@wrongstack/core';
import { safeResolve } from './_util.js';

const DEFAULT_IGNORE = ['node_modules', '.git', 'dist', 'build', '.next', 'coverage', '__pycache__'];

interface TreeInput {
  path?: string;
  depth?: number;
  glob?: string;
  exclude?: string[];
  show_files?: boolean;
  show_dirs?: boolean;
  show_hidden?: boolean;
}

interface TreeOutput {
  tree: string;
  total_files: number;
  total_dirs: number;
  truncated: boolean;
  path: string;
}

export const treeTool: Tool<TreeInput, TreeOutput> = {
  name: 'tree',
  description:
    'Display directory structure as an ASCII tree. Shows files and folders with indentation.',
  usageHint:
    'Set `path` (default: cwd). `depth` limits nesting (default: 3). `glob` filters files. `exclude` ignores dirs. `show_files` toggles file listing (default: true).',
  permission: 'auto',
  mutating: false,
  timeoutMs: 15_000,
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Root directory (default: cwd)' },
      depth: {
        type: 'integer',
        description: 'Max nesting depth (default: 3, 0 for unlimited)',
        minimum: 0,
        maximum: 20,
      },
      glob: { type: 'string', description: 'Filter files matching glob (e.g. "*.ts")' },
      exclude: {
        type: 'array',
        items: { type: 'string' },
        description: 'Directory names to exclude',
      },
      show_files: {
        type: 'boolean',
        description: 'Show files (default: true, false shows dirs only)',
      },
      show_dirs: {
        type: 'boolean',
        description: 'Show directories (default: true)',
      },
      show_hidden: {
        type: 'boolean',
        description: 'Show hidden files starting with . (default: false)',
      },
    },
  },
  async execute(input, ctx, opts) {
    let final: TreeOutput | undefined;
    for await (const ev of treeTool.executeStream!(input, ctx, opts)) {
      if (ev.type === 'final') final = ev.output;
    }
    if (!final) throw new Error('tree: stream ended without final event');
    return final;
  },
  async *executeStream(input, ctx): AsyncGenerator<ToolStreamEvent<TreeOutput>> {
    const basePath = input.path ? safeResolve(input.path, ctx) : ctx.cwd;
    const maxDepth = input.depth ?? 3;
    const showFiles = input.show_files ?? true;
    const showDirs = input.show_dirs ?? true;
    const showHidden = input.show_hidden ?? false;
    const exclude = new Set([...DEFAULT_IGNORE, ...(input.exclude ?? [])]);
    const filterGlob = input.glob;

    const lines: string[] = [basePath];
    const totals = { totalFiles: { value: 0 }, totalDirs: { value: 0 } };

    // Walker pushes progress into an async queue; the generator drains it.
    const queue: ToolProgressEvent[] = [];
    const FLUSH_EVERY = 200; // emit metric every 200 entries seen
    let lastEmittedTotal = 0;

    const tickProgress = () => {
      const seen = totals.totalFiles.value + totals.totalDirs.value;
      if (seen - lastEmittedTotal >= FLUSH_EVERY) {
        queue.push({
          type: 'metric',
          text: `${seen} entries`,
          data: { files: totals.totalFiles.value, dirs: totals.totalDirs.value },
        });
        lastEmittedTotal = seen;
      }
    };

    const walkPromise = walkDir(basePath, 0, {
      maxDepth,
      exclude,
      showFiles,
      showDirs,
      showHidden,
      filterGlob,
      lines,
      prefix: '',
      isLast: true,
      totalFiles: totals.totalFiles,
      totalDirs: totals.totalDirs,
      onProgress: tickProgress,
    });

    // Race the walk against periodic flushes — yield metrics while it runs.
    let walkDone = false;
    walkPromise.finally(() => {
      walkDone = true;
    });

    while (!walkDone || queue.length > 0) {
      if (queue.length > 0) {
        yield queue.shift()!;
      } else {
        // Race the walk completion against a short tick so we don't busy-
        // spin while the producer fills the queue. Previously the
        // setTimeout was never cleared when walkPromise won — one stray
        // timer per drain iteration accumulated on the event loop.
        let pollTimer: ReturnType<typeof setTimeout> | undefined;
        const poll = new Promise<void>((r) => { pollTimer = setTimeout(r, 50); });
        try {
          await Promise.race([walkPromise, poll]).catch(() => undefined);
        } finally {
          if (pollTimer) clearTimeout(pollTimer);
        }
      }
    }
    await walkPromise; // surface any error

    yield {
      type: 'final',
      output: {
        tree: lines.join('\n'),
        total_files: totals.totalFiles.value,
        total_dirs: totals.totalDirs.value,
        truncated: false,
        path: basePath,
      },
    };
  },
};

interface WalkOptions {
  maxDepth: number;
  exclude: Set<string>;
  showFiles: boolean;
  showDirs: boolean;
  showHidden: boolean;
  filterGlob?: string;
  lines: string[];
  prefix: string;
  isLast: boolean;
  totalFiles: { value: number };
  totalDirs: { value: number };
  onProgress?: () => void;
}

async function walkDir(
  dir: string,
  depth: number,
  opts: WalkOptions,
): Promise<void> {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [] as import('node:fs').Dirent[]);

  const filtered = entries.filter((e) => {
    if (!opts.showHidden && e.name.startsWith('.')) return false;
    if (opts.exclude.has(e.name)) return false;
    return true;
  });

  if (depth > 0) {
    const dirCount = filtered.filter((e) => e.isDirectory()).length;
    const fileCount = filtered.filter((e) => e.isFile()).length;
    opts.totalDirs.value += dirCount;
    opts.totalFiles.value += fileCount;
    opts.onProgress?.();
  }

  const items = filtered.sort((a, b) => {
    if (a.isDirectory() && !b.isDirectory()) return -1;
    if (!a.isDirectory() && b.isDirectory()) return 1;
    return a.name.localeCompare(b.name);
  });

  for (let i = 0; i < items.length; i++) {
    const entry = items[i];
    if (!entry) continue;
    const isLast = i === items.length - 1;
    const connector = opts.isLast ? '    ' : '│   ';
    const branch = isLast ? '└── ' : '├── ';
    const displayName = entry.name + (entry.isDirectory() ? '/' : '');

    if (!opts.showDirs && entry.isDirectory()) continue;
    if (!opts.showFiles && entry.isFile()) continue;

    opts.lines.push(opts.prefix + branch + displayName);

    if (entry.isDirectory() && (opts.maxDepth === 0 || depth < opts.maxDepth)) {
      const childPrefix = opts.prefix + connector;
      await walkDir(path.join(dir, entry.name), depth + 1, {
        ...opts,
        prefix: childPrefix,
        isLast,
      });
    }
  }
}