import { expectDefined } from '@wrongstack/core';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { Tool, ToolStreamEvent } from '@wrongstack/core';
import { buildChildEnv, compileGlob } from '@wrongstack/core';
import { capSubject, compileUserRegex } from './_regex.js';
import { isBinaryBuffer, safeResolve } from './_util.js';
interface GrepInput {
  pattern: string;
  path?: string | undefined;
  glob?: string | undefined;
  output_mode?: 'content' | 'files_with_matches' | 'count' | undefined;
  context_lines?: number | undefined;
  case_insensitive?: boolean | undefined;
  limit?: number | undefined;
}

interface GrepOutput {
  matches: string[];
  count: number;
  truncated: boolean;
  used: 'rg' | 'native';
}

const DEFAULT_IGNORE = ['node_modules', '.git', 'dist', 'build', '.next', 'coverage'];

export const grepTool: Tool<GrepInput, GrepOutput> = {
  name: 'grep',
  category: 'Search',
  description:
    'Search across files using a regular expression. This is one of the primary code search tools. ' +
    'Prefers ripgrep for speed and features when available.',
  usageHint:
    'POWERFUL CODE SEARCH TOOL:\n\n' +
    '- `pattern` is a regular expression.\n' +
    '- Use `output_mode: "content"` (default) to get matching lines with context.\n' +
    '- Use `"files_with_matches"` when you only need the list of files.\n' +
    '- Use `"count"` for quick statistics.\n' +
    '- `glob` and `path` let you narrow the search scope significantly.\n' +
    '- Always prefer this over `bash grep` when searching code.',
  permission: 'auto',
  mutating: false,
  capabilities: ['fs.read'],
  maxOutputBytes: 131_072,
  timeoutMs: 10_000,
  inputSchema: {
    type: 'object',
    properties: {
      pattern: {
        type: 'string',
        description: 'Regular expression pattern to search for in file contents.',
      },
      path: {
        type: 'string',
        description: 'Limit search to this directory or file (relative to project root).',
      },
      glob: {
        type: 'string',
        description: 'Glob filter for which files to include (e.g. "**/*.ts", "src/**").',
      },
      output_mode: {
        type: 'string',
        enum: ['content', 'files_with_matches', 'count'],
        description: 'Return style: detailed matches, just file list, or count only.',
      },
      context_lines: {
        type: 'integer',
        description: 'How many lines of surrounding context to include with each match.',
      },
      case_insensitive: {
        type: 'boolean',
        description: 'Ignore case when matching.',
      },
      limit: {
        type: 'integer',
        description: 'Maximum number of matches to return.',
      },
    },
    required: ['pattern'],
  },
  async execute(input, ctx, opts) {
    let final: GrepOutput | undefined;
    const executeStream = grepTool.executeStream;
    if (!executeStream) throw new Error('grepTool: stream execution unavailable');
    for await (const ev of executeStream(input, ctx, opts)) {
      if (ev.type === 'final') final = ev.output;
    }
    if (!final) throw new Error('grep: stream ended without final event');
    return final;
  },
  async *executeStream(input, ctx, opts): AsyncGenerator<ToolStreamEvent<GrepOutput>> {
    if (!input?.pattern) throw new Error('grep: pattern is required');
    const base = input.path ? safeResolve(input.path, ctx) : ctx.cwd;
    const mode = input.output_mode ?? 'content';
    const limit = Math.max(1, Math.min(input.limit ?? 200, 2000));
    const validation = compileUserRegex(input.pattern, input.case_insensitive ? 'i' : '');
    if (!validation.ok) {
      throw new Error(`grep: ${validation.reason}`);
    }

    const rgAvailable = await detectRg(opts.signal);
    if (rgAvailable) {
      try {
        yield* runRgStream(input, base, mode, limit, opts.signal);
        return;
      } catch {
        // fall through to native
      }
    }
    yield { type: 'log', text: 'Falling back to native grep…' };
    const out = await runNative(input, base, mode, limit, opts.signal);
    yield { type: 'final', output: out };
  },
};

async function detectRg(signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const p = spawn('rg', ['--version'], { env: buildChildEnv(), stdio: 'ignore', signal });
      p.on('error', () => resolve(false));
      p.on('close', (code) => resolve(code === 0));
    } catch {
      resolve(false);
    }
  });
}

async function* runRgStream(
  input: GrepInput,
  base: string,
  mode: 'content' | 'files_with_matches' | 'count',
  limit: number,
  signal: AbortSignal,
): AsyncGenerator<ToolStreamEvent<GrepOutput>> {
  const args: string[] = ['--no-heading'];
  if (input.case_insensitive) args.push('-i');
  if (mode === 'files_with_matches') args.push('-l');
  if (mode === 'count') args.push('-c');
  if (mode === 'content') {
    args.push('-n');
    if (input.context_lines) args.push('-C', String(input.context_lines));
  }
  for (const ignored of DEFAULT_IGNORE) {
    args.push('--glob', `!${ignored}/**`, '--glob', `!**/${ignored}/**`);
  }
  if (input.glob) args.push('--glob', input.glob);
  args.push('--', input.pattern, base);

  const matches: string[] = [];
  let buf = '';
  let totalLines = 0;
  let totalCount = 0;
  let batchSinceFlush = 0;
  const FLUSH_AT = 16; // yield a partial_output every 16 matches
  // Cap on the in-progress line buffer. Without this, a single huge "line"
  // (e.g. a file with no newlines under a symlink) plus a fast producer
  // would let `buf` grow unbounded. 1 MB comfortably holds any realistic
  // grep hit; beyond that we kill the child and surface a truncation.
  const MAX_BUF_BYTES = 1_000_000;
  let bufOverflow = false;

  const child = spawn('rg', args, { signal, env: buildChildEnv(), stdio: ['ignore', 'pipe', 'pipe'] });

  type Chunk = { kind: 'out' | 'close' | 'error'; data: string };
  const queue: Chunk[] = [];
  let waiter: (() => void) | undefined;
  const wake = () => {
    if (waiter) {
      const w = waiter;
      waiter = undefined;
      w();
    }
  };
  child.stdout?.on('data', (c) => {
    queue.push({ kind: 'out', data: c.toString() });
    wake();
  });
  child.on('error', (e) => {
    queue.push({ kind: 'error', data: e.message });
    wake();
  });
  child.on('close', () => {
    queue.push({ kind: 'close', data: '' });
    wake();
  });

  let pendingBatch: string[] = [];
  let errored = false;
  for (;;) {
    while (queue.length === 0) {
      await new Promise<void>((r) => {
        waiter = r;
      });
    }
    const c = expectDefined(queue.shift());
    if (c.kind === 'error') {
      errored = true;
      continue;
    }
    if (c.kind === 'close') break;
    buf += c.data;
    // Guard against a pathological producer (e.g. matching a huge binary
    // without newlines) pinning memory. Kill the child and mark the result
    // truncated; whatever we already captured stays intact.
    if (buf.length > MAX_BUF_BYTES && !bufOverflow) {
      bufOverflow = true;
      buf = buf.slice(-MAX_BUF_BYTES);
      try {
        child.kill('SIGTERM');
      } catch {
        /* ignore */
      }
    }
    const idx = buf.lastIndexOf('\n');
    if (idx === -1) continue;
    const ready = buf.slice(0, idx);
    buf = buf.slice(idx + 1);
    for (const line of ready.split('\n')) {
      if (!line) continue;
      totalLines++;
      if (mode === 'count') totalCount += parseRgCountLine(line);
      if (matches.length < limit) {
        matches.push(line);
        pendingBatch.push(line);
        batchSinceFlush++;
      }
    }
    if (batchSinceFlush >= FLUSH_AT) {
      yield {
        type: 'partial_output',
        text: pendingBatch.join('\n'),
        data: { matches_so_far: matches.length },
      };
      pendingBatch = [];
      batchSinceFlush = 0;
    }
  }

  if (buf.trim()) {
    for (const line of buf.split('\n')) {
      if (!line) continue;
      totalLines++;
      if (mode === 'count') totalCount += parseRgCountLine(line);
      if (matches.length < limit) {
        matches.push(line);
        pendingBatch.push(line);
      }
    }
  }
  if (pendingBatch.length > 0) {
    yield {
      type: 'partial_output',
      text: pendingBatch.join('\n'),
      data: { matches_so_far: matches.length },
    };
  }
  if (errored) throw new Error('rg: spawn error');

  yield {
    type: 'final',
    output: {
      matches,
      count: mode === 'count' ? totalCount : totalLines,
      truncated: totalLines > limit || bufOverflow,
      used: 'rg',
    },
  };
}

function parseRgCountLine(line: string): number {
  const idx = line.lastIndexOf(':');
  if (idx === -1) return 0;
  const n = Number.parseInt(line.slice(idx + 1), 10);
  return Number.isFinite(n) ? n : 0;
}

async function runNative(
  input: GrepInput,
  base: string,
  mode: 'content' | 'files_with_matches' | 'count',
  limit: number,
  signal: AbortSignal,
): Promise<GrepOutput> {
  const flags = input.case_insensitive ? 'i' : '';
  const compiled = compileUserRegex(input.pattern, flags);
  if (!compiled.ok) {
    throw new Error(`grep: ${compiled.reason}`);
  }
  const re = compiled.regex;
  const globRe = input.glob ? compileGlob(input.glob) : null;
  const matches: string[] = [];
  const fileMatches = new Map<string, number>();
  let total = 0;
  let stopped = false;

  const walk = async (dir: string): Promise<void> => {
    if (stopped || signal.aborted) return;
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (stopped) return;
      if (DEFAULT_IGNORE.includes(e.name)) continue;
      // Skip symlinks entirely. fs.Dirent.isDirectory/isFile return the
      // symlink's TYPE without resolving, but following the link into
      // arbitrary places (e.g. ~/.ssh) is the security concern. Tools
      // that genuinely need to traverse symlinks should opt in explicitly.
      if (e.isSymbolicLink()) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        await walk(full);
      } else if (e.isFile()) {
        if (globRe && !globRe.test(e.name) && !globRe.test(full)) continue;
        if (globRe) globRe.lastIndex = 0;
        try {
          const stat = await fs.stat(full);
          if (stat.size > 1_000_000) continue;
          const head = await fs.readFile(full);
          if (isBinaryBuffer(head)) continue;
          const text = head.toString('utf8');
          const lines = text.split(/\r?\n/);
          let fileHits = 0;
          for (let i = 0; i < lines.length; i++) {
            const ln = capSubject(lines[i] ?? '');
            re.lastIndex = 0;
            if (re.test(ln)) {
              fileHits++;
              total++;
              if (mode === 'content' && matches.length < limit) {
                matches.push(`${full}:${i + 1}:${ln}`);
              }
            }
          }
          if (fileHits > 0) {
            fileMatches.set(full, fileHits);
            if (mode === 'files_with_matches' && matches.length < limit) {
              matches.push(full);
            }
            if (mode === 'count' && matches.length < limit) {
              matches.push(`${full}:${fileHits}`);
            }
          }
          if (matches.length >= limit) stopped = true;
        } catch {
          // skip read errors
        }
      }
    }
  };
  await walk(base);

  return {
    matches,
    count: total,
    truncated: stopped,
    used: 'native',
  };
}
