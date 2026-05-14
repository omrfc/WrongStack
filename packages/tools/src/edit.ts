import * as fs from 'node:fs/promises';
import {
  atomicWrite,
  detectNewlineStyle,
  toStyle,
  normalizeToLf,
  unifiedDiff,
} from '@wrongstack/core';
import type { Tool } from '@wrongstack/core';
import { safeResolve } from './_util.js';

interface EditInput {
  path: string;
  old_string: string;
  new_string: string;
  /**
   * When true, replaces all occurrences of `old_string`.
   * When false (default), replaces only the first occurrence and errors
   * if more than one match exists — use this to ensure you target the
   * right location.
   */
  replace_all?: boolean;
}

interface EditOutput {
  path: string;
  replacements: number;
  diff: string;
}

export const editTool: Tool<EditInput, EditOutput> = {
  name: 'edit',
  description:
    'Make a surgical edit by replacing exact text. Fails if `old_string` is not unique unless `replace_all` is true.',
  usageHint:
    'Always `read` the file first. `old_string` must be an EXACT match (whitespace included). If multiple matches exist, either narrow `old_string` with more context or set `replace_all: true`.',
  permission: 'confirm',
  mutating: true,
  timeoutMs: 5_000,
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      old_string: { type: 'string' },
      new_string: { type: 'string' },
      replace_all: { type: 'boolean' },
    },
    required: ['path', 'old_string', 'new_string'],
  },
  async execute(input, ctx) {
    if (!input?.path) throw new Error('edit: path is required');
    if (input.old_string === undefined) throw new Error('edit: old_string is required');
    if (input.new_string === undefined) throw new Error('edit: new_string is required');
    if (input.old_string === '') throw new Error('edit: old_string cannot be empty');

    const absPath = safeResolve(input.path, ctx);
    const stat = await fs.stat(absPath).catch((err) => {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new Error(`edit: file "${input.path}" does not exist. Use \`write\` instead.`);
      }
      throw err;
    });
    if (!stat.isFile()) throw new Error(`edit: "${input.path}" is not a regular file`);

    // Read-before-write invariant
    if (!ctx.hasRead(absPath)) {
      throw new Error(
        `edit: file "${input.path}" was not read in this session. Read it first.`,
      );
    }
    // Stale-read detection. Tolerance accounts for filesystem mtime
    // resolution: ext4/APFS report ms, but Windows FAT and some network
    // filesystems quantize to 2 s. A too-tight tolerance triggers false
    // "modified externally" failures when a tool writes and re-reads the
    // same file in quick succession.
    const lastReadMtime = ctx.lastReadMtime(absPath);
    const mtimeTolerance = process.platform === 'win32' ? 2000 : 1;
    if (lastReadMtime !== undefined && stat.mtimeMs > lastReadMtime + mtimeTolerance) {
      throw new Error(`edit: file "${input.path}" was modified externally. Re-read it first.`);
    }

    const original = await fs.readFile(absPath, 'utf8');
    const style = detectNewlineStyle(original);
    const fileLf = normalizeToLf(original);
    const oldLf = normalizeToLf(input.old_string);
    const newLf = normalizeToLf(input.new_string);

    if (oldLf === newLf) {
      return {
        path: absPath,
        replacements: 0,
        diff: '(no-op: old and new are identical)',
      };
    }

    let count = 0;
    let idx = fileLf.indexOf(oldLf);
    const matches: number[] = [];
    while (idx !== -1) {
      matches.push(idx);
      count++;
      idx = fileLf.indexOf(oldLf, idx + 1);
    }

    if (count === 0) {
      const hint = findSimilarity(fileLf, oldLf);
      throw new Error(
        `edit: no match for old_string in "${input.path}".${
          hint ? ` Nearest match near line ${hint}.` : ''
        }`,
      );
    }

    if (count > 1 && !input.replace_all) {
      const lines = lineNumbersFor(fileLf, matches);
      throw new Error(
        `edit: old_string matched ${count} times in "${input.path}" (lines: ${lines.join(', ')}). ` +
          `Add more context to make it unique, or set replace_all: true.`,
      );
    }

    const newFileLf = input.replace_all
      ? fileLf.split(oldLf).join(newLf)
      : fileLf.replace(oldLf, newLf);
    const newFile = toStyle(newFileLf, style);

    await atomicWrite(absPath, newFile, { mode: stat.mode & 0o777 });
    const updated = await fs.stat(absPath);
    ctx.recordRead(absPath, updated.mtimeMs);

    const diff = unifiedDiff(original, newFile, {
      fromFile: input.path,
      toFile: input.path,
    });

    return {
      path: absPath,
      replacements: input.replace_all ? count : 1,
      diff,
    };
  },
};

function lineNumbersFor(text: string, indices: number[]): number[] {
  const out: number[] = [];
  let pos = 0;
  let line = 1;
  for (const target of indices) {
    while (pos < target) {
      if (text.charCodeAt(pos) === 0x0a) line++;
      pos++;
    }
    out.push(line);
  }
  return out;
}

function findSimilarity(haystack: string, needle: string): number | undefined {
  if (needle.length < 20) return undefined;
  const probe = needle.slice(0, Math.min(40, needle.length));
  const idx = haystack.indexOf(probe);
  if (idx === -1) return undefined;
  let line = 1;
  for (let i = 0; i < idx; i++) {
    if (haystack.charCodeAt(i) === 0x0a) line++;
  }
  return line;
}
