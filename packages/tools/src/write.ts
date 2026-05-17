import * as fs from 'node:fs/promises';
import { atomicWrite, unifiedDiff } from '@wrongstack/core';
import type { Tool } from '@wrongstack/core';
import { safeResolve } from './_util.js';

interface WriteInput {
  path: string;
  content: string;
}

interface WriteOutput {
  path: string;
  bytes_written: number;
  created: boolean;
  diff?: string;
}

export const writeTool: Tool<WriteInput, WriteOutput> = {
  name: 'write',
  category: 'Filesystem',
  description: 'Write or overwrite a file. For existing files, prefer `edit` over `write`.',
  usageHint:
    'Use `write` for new files or full replacements. For partial edits use `edit`. Existing files must have been `read` first in this session.',
  permission: 'confirm',
  mutating: true,
  timeoutMs: 5_000,
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      content: { type: 'string' },
    },
    required: ['path', 'content'],
  },
  async execute(input, ctx) {
    if (!input?.path) throw new Error('write: path is required');
    if (input.content === undefined) throw new Error('write: content is required');
    const absPath = safeResolve(input.path, ctx);

    let existed = false;
    let prev = '';
    try {
      const stat = await fs.stat(absPath);
      existed = stat.isFile();
      if (existed) {
        if (!ctx.hasRead(absPath)) {
          // User approved this write (confirm → yes/always) but ctx has no
          // read record. The model may call write without a prior explicit
          // read. Read the file now so we can compute the diff and honor
          // the user's intent to overwrite.
          prev = await fs.readFile(absPath, 'utf8');
          ctx.recordRead(absPath, stat.mtimeMs);
        } else {
          prev = await fs.readFile(absPath, 'utf8');
        }
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw err;
      }
    }

    await atomicWrite(absPath, input.content);

    const diff = existed
      ? unifiedDiff(prev, input.content, { fromFile: input.path, toFile: input.path })
      : `+++ ${input.path}\n+ (new file, ${input.content.split('\n').length} lines)`;

    const stat = await fs.stat(absPath);
    ctx.recordRead(absPath, stat.mtimeMs);

    return {
      path: absPath,
      bytes_written: Buffer.byteLength(input.content, 'utf8'),
      created: !existed,
      diff,
    };
  },
};
