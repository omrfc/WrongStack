import * as fs from 'node:fs/promises';
import type { Tool } from '@wrongstack/core';
import { isBinaryBuffer, safeResolveReal } from './_util.js';
import { toErrorMessage } from '@wrongstack/core/utils';

interface ReadInput {
  path: string;
  offset?: number | undefined;
  limit?: number | undefined;
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
      throw new Error(
        `read: failed to stat "${input.path}": ${toErrorMessage(err)}`,
      );
    }
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
