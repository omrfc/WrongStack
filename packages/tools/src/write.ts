import * as fs from 'node:fs/promises';
import { atomicWrite, unifiedDiff } from '@wrongstack/core';
import type { Tool } from '@wrongstack/core';
import { safeResolveReal } from './_util.js';

interface WriteInput {
  path: string;
  content: string;
}

interface WriteOutput {
  path: string;
  bytes_written: number;
  created: boolean;
  diff?: string | undefined;
}

export const writeTool: Tool<WriteInput, WriteOutput> = {
  name: 'write',
  category: 'Filesystem',
  description:
    'Write or completely overwrite a file on disk. ' +
    'This is a high-privilege operation. For modifying existing files, you should almost always prefer the `edit` tool instead, ' +
    'because `edit` is safer and works on the last-read version of the file.',
  usageHint:
    'RULES FOR CORRECT USAGE:\n' +
    '- Use `write` primarily for **new files** or when you want to replace the entire content.\n' +
    '- For any existing file, strongly prefer `edit` (it requires a prior `read` in the same session and is more precise).\n' +
    '- You MUST have called `read` on the file earlier in the conversation before using `write` on an existing path (the system enforces this for safety).\n' +
    '- The path is resolved relative to the project root and protected against escaping the workspace.',
  permission: 'confirm',
  mutating: true,
  timeoutMs: 5_000,
  capabilities: ['fs.write'],
  icon: 'file',
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Relative path from project root. Must not escape the project.',
      },
      content: {
        type: 'string',
        description: 'The complete new content of the file.',
      },
    },
    required: ['path', 'content'],
  },
  async execute(input, ctx) {
    if (!input?.path) throw new Error('write: path is required');
    if (input.content === undefined) throw new Error('write: content is required');
    const absPath = await safeResolveReal(input.path, ctx);

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

    // Record for session rewind
    ctx.session.recordFileChange({
      path: absPath,
      action: existed ? 'modified' : 'created',
      before: existed ? prev : null,
      after: input.content,
    });

    return {
      path: absPath,
      bytes_written: Buffer.byteLength(input.content, 'utf8'),
      created: !existed,
      diff,
    };
  },
};
