import * as fs from 'node:fs/promises';
import type { Tool } from '@wrongstack/core';
import { toErrorMessage } from '@wrongstack/core/utils';
import { isBinaryBuffer, safeResolveReal } from './_util.js';

interface ReadInput {
  path: string;
  offset?: number | undefined;
  limit?: number | undefined;
  mode?: 'content' | 'summary' | undefined;
}

interface ReadOutput {
  text: string;
  total_lines: number;
  encoding: string;
  truncated: boolean;
  cached?: boolean | undefined;
  note?: string | undefined;
}

const MAX_BYTES = 5 * 1024 * 1024;

export const readTool: Tool<ReadInput, ReadOutput> = {
  name: 'read',
  category: 'Filesystem',
  description:
    'Read the contents of a file with line numbers. This is the primary way to inspect source code, configuration, or any text file before making changes. ' +
    'Lines are returned 1-indexed with a `   N| ` prefix for easy reference in edits.',
  usageHint:
    'FOUNDATIONAL TOOL — call this before almost any edit operation.\n\n' +
    'Best practices:\n' +
    '- Always read a file before using `edit`, `replace`, or `write` on it (the system often requires it for safety).\n' +
    '- Use `offset` + `limit` for very large files instead of reading everything at once.\n' +
    '- Default limit is generous (2000 lines) but can be increased.\n' +
    '- The output format is designed to be directly usable as context for `edit` operations.',
  permission: 'auto',
  mutating: false,
  capabilities: ['fs.read'],
  icon: 'file',
  maxOutputBytes: 262_144,
  timeoutMs: 5_000,
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Path to the file (relative to project root or absolute within project).',
      },
      offset: {
        type: 'integer',
        description: '1-based starting line number. Use together with `limit` for large files.',
      },
      limit: {
        type: 'integer',
        description: 'Maximum number of lines to return (default is 2000).',
      },
      mode: {
        type: 'string',
        enum: ['content', 'summary'],
        description:
          'Return full line-numbered content (default) or a compact file summary with imports/exports/symbols.',
      },
    },
    required: ['path'],
  },
  async execute(input, ctx) {
    if (!input?.path) throw new Error('read: path is required');
    const absPath = await safeResolveReal(input.path, ctx);

    let stat: Awaited<ReturnType<typeof fs.stat>>;
    try {
      stat = await fs.stat(absPath);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') throw new Error(`read: file not found "${input.path}"`);
      throw new Error(`read: failed to stat "${input.path}": ${toErrorMessage(err)}`);
    }
    if (!stat.isFile()) throw new Error(`read: "${input.path}" is not a regular file`);
    if (stat.size > MAX_BYTES) {
      throw new Error(`read: file too large (${stat.size} bytes, limit ${MAX_BYTES})`);
    }

    const offset = Math.max(1, input.offset ?? 1);
    const limit = Math.max(0, Math.min(input.limit ?? 2000, 5000));
    const prior = getReadRangeRecord(ctx, absPath);
    const requestedEnd = prior
      ? Math.min(offset + limit - 1, prior.totalLines)
      : offset + limit - 1;
    if (
      input.mode !== 'summary' &&
      limit > 0 &&
      prior &&
      coversRange(prior, stat.mtimeMs, offset, requestedEnd)
    ) {
      ctx.recordRead(absPath, stat.mtimeMs);
      return {
        text:
          `[unchanged since previous read: "${input.path}" mtime=${Math.round(stat.mtimeMs)}; ` +
          `requested lines ${offset}-${requestedEnd} were already shown. Use offset/limit for a new range if needed.]`,
        total_lines: prior.totalLines,
        encoding: 'utf8',
        truncated: requestedEnd < prior.totalLines,
        cached: true,
        note: 'Repeated read suppressed to save tokens.',
      };
    }

    const buf = await fs.readFile(absPath);
    if (isBinaryBuffer(buf)) {
      throw new Error(`read: "${input.path}" appears to be binary`);
    }

    const text = buf.toString('utf8');
    const allLines = text.split(/\r\n|\r|\n/);
    const total = allLines.length;
    if (input.mode === 'summary') {
      ctx.recordRead(absPath, stat.mtimeMs);
      rememberReadRange(ctx, absPath, stat.mtimeMs, total, 1, Math.min(total, 200));
      return {
        text: summarizeFile(input.path, stat.size, allLines),
        total_lines: total,
        encoding: 'utf8',
        truncated: total > 200,
        note: 'Summary mode returned compact structure instead of full file content.',
      };
    }
    if (limit === 0) {
      ctx.recordRead(absPath, stat.mtimeMs);
      rememberReadRange(ctx, absPath, stat.mtimeMs, total, 1, 0);
      return { text: '', total_lines: total, encoding: 'utf8', truncated: total > 0 };
    }
    // Offset past EOF: return an explicit message instead of an empty string.
    // Without this, models with weak instruction-following (e.g. k2p7) see an
    // empty result, assume the read failed transiently, and retry the exact
    // same offset indefinitely — a tight tool-use loop that burns iterations
    // and context without making progress.
    if (offset > total) {
      ctx.recordRead(absPath, stat.mtimeMs);
      rememberReadRange(ctx, absPath, stat.mtimeMs, total, total + 1, total + 1);
      return {
        text: `[offset ${offset} is past end of file "${input.path}" — file has ${total} line(s). Do not retry this offset.]`,
        total_lines: total,
        encoding: 'utf8',
        truncated: false,
      };
    }

    const slice = allLines.slice(offset - 1, offset - 1 + limit);
    const truncated = offset - 1 + slice.length < total;

    const width = String(offset + slice.length - 1).length;
    const numbered = slice
      .map((line, i) => `${String(offset + i).padStart(width, ' ')}→${line}`)
      .join('\n');

    ctx.recordRead(absPath, stat.mtimeMs);
    rememberReadRange(ctx, absPath, stat.mtimeMs, total, offset, offset + slice.length - 1);

    return {
      text: numbered,
      total_lines: total,
      encoding: 'utf8',
      truncated,
    };
  },
};

interface ReadRangeRecord {
  mtimeMs: number;
  totalLines: number;
  ranges: Array<{ start: number; end: number }>;
}

const READ_RANGES_META_KEY = 'tools.read.ranges.v1';

function getReadRanges(ctx: import('@wrongstack/core').Context): Record<string, ReadRangeRecord> {
  const existing = ctx.meta[READ_RANGES_META_KEY];
  if (existing && typeof existing === 'object' && !Array.isArray(existing)) {
    return existing as Record<string, ReadRangeRecord>;
  }
  const next: Record<string, ReadRangeRecord> = {};
  ctx.meta[READ_RANGES_META_KEY] = next;
  return next;
}

function getReadRangeRecord(
  ctx: import('@wrongstack/core').Context,
  absPath: string,
): ReadRangeRecord | undefined {
  return getReadRanges(ctx)[absPath];
}

function rememberReadRange(
  ctx: import('@wrongstack/core').Context,
  absPath: string,
  mtimeMs: number,
  totalLines: number,
  start: number,
  end: number,
): void {
  if (end < start) return;
  const ranges = getReadRanges(ctx);
  const prior = ranges[absPath];
  const nextRanges = prior && Math.abs(prior.mtimeMs - mtimeMs) <= 1 ? prior.ranges.slice() : [];
  nextRanges.push({ start, end });
  ranges[absPath] = {
    mtimeMs,
    totalLines,
    ranges: mergeRanges(nextRanges),
  };
}

function coversRange(
  record: ReadRangeRecord,
  mtimeMs: number,
  start: number,
  end: number,
): boolean {
  if (Math.abs(record.mtimeMs - mtimeMs) > 1) return false;
  return record.ranges.some((range) => range.start <= start && range.end >= end);
}

function mergeRanges(
  ranges: Array<{ start: number; end: number }>,
): Array<{ start: number; end: number }> {
  const sorted = ranges.slice().sort((a, b) => a.start - b.start);
  const merged: Array<{ start: number; end: number }> = [];
  for (const range of sorted) {
    const last = merged[merged.length - 1];
    if (!last || range.start > last.end + 1) {
      merged.push({ ...range });
      continue;
    }
    last.end = Math.max(last.end, range.end);
  }
  return merged;
}

function summarizeFile(filePath: string, bytes: number, lines: string[]): string {
  const interesting = lines
    .map((line, index) => ({ line: line.trim(), number: index + 1 }))
    .filter(({ line }) =>
      /^(import\s|export\s|class\s|interface\s|type\s|function\s|const\s+\w+\s*=|let\s+\w+\s*=|var\s+\w+\s*=|def\s+|async\s+function\s)/.test(
        line,
      ),
    )
    .slice(0, 80)
    .map(({ line, number }) => `${number}: ${line}`);
  return [
    `summary: ${filePath}`,
    `bytes=${bytes}`,
    `total_lines=${lines.length}`,
    interesting.length > 0
      ? `symbols/imports:\n${interesting.join('\n')}`
      : 'symbols/imports: (none detected)',
  ].join('\n');
}
