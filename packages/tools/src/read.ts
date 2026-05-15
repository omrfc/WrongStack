import * as fs from 'node:fs/promises';
import type { Tool } from '@wrongstack/core';
import { isBinaryBuffer, safeResolve } from './_util.js';

interface ReadInput {
  path: string;
  offset?: number;
  limit?: number;
}

interface ReadOutput {
  text: string;
  total_lines: number;
  encoding: string;
  truncated: boolean;
}

const MAX_BYTES = 5 * 1024 * 1024;

export const readTool: Tool<ReadInput, ReadOutput> = {
  name: 'read',
  description: 'Read the contents of a file. Lines are 1-indexed and prefixed with line numbers.',
  usageHint:
    'Read a file before editing it. Returns lines numbered like `   1→content`. Use `offset` and `limit` for large files (default reads up to 2000 lines).',
  permission: 'auto',
  mutating: false,
  maxOutputBytes: 262_144,
  timeoutMs: 5_000,
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path (absolute or relative to cwd)' },
      offset: { type: 'integer', description: '1-based line number to start from' },
      limit: { type: 'integer', description: 'Max lines to read (default 2000)' },
    },
    required: ['path'],
  },
  async execute(input, ctx) {
    if (!input?.path) throw new Error('read: path is required');
    const absPath = safeResolve(input.path, ctx);

    const stat = await fs.stat(absPath);
    if (!stat.isFile()) throw new Error(`read: "${input.path}" is not a regular file`);
    if (stat.size > MAX_BYTES) {
      throw new Error(`read: file too large (${stat.size} bytes, limit ${MAX_BYTES})`);
    }

    const buf = await fs.readFile(absPath);
    if (isBinaryBuffer(buf)) {
      throw new Error(`read: "${input.path}" appears to be binary`);
    }

    const text = buf.toString('utf8');
    const allLines = text.split(/\r\n|\r|\n/);
    const total = allLines.length;
    const offset = Math.max(1, input.offset ?? 1);
    const limit = Math.max(0, Math.min(input.limit ?? 2000, 5000));
    if (limit === 0) {
      ctx.recordRead(absPath, stat.mtimeMs);
      return { text: '', total_lines: total, encoding: 'utf8', truncated: total > 0 };
    }
    const slice = allLines.slice(offset - 1, offset - 1 + limit);
    const truncated = offset - 1 + slice.length < total;

    const width = String(offset + slice.length - 1).length;
    const numbered = slice
      .map((line, i) => `${String(offset + i).padStart(width, ' ')}→${line}`)
      .join('\n');

    ctx.recordRead(absPath, stat.mtimeMs);

    return {
      text: numbered,
      total_lines: total,
      encoding: 'utf8',
      truncated,
    };
  },
};
