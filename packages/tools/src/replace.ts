import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import {
  atomicWrite,
  detectNewlineStyle,
  toStyle,
  normalizeToLf,
  compileGlob,
  unifiedDiff,
} from '@wrongstack/core';
import type { Tool, Context } from '@wrongstack/core';
import { isBinaryBuffer, safeResolve } from './_util.js';
import { compileUserRegex } from './_regex.js';

interface ReplaceInput {
  pattern: string;
  replacement: string;
  files: string | string[];
  glob?: string;
  replace_all?: boolean;
  dry_run?: boolean;
}

interface ReplaceOutput {
  files_modified: number;
  total_replacements: number;
  results: { path: string; replacements: number; diff?: string }[];
  dry_run: boolean;
}

const DEFAULT_IGNORE = ['node_modules', '.git', 'dist', 'build', '.next', 'coverage'];

export const replaceTool: Tool<ReplaceInput, ReplaceOutput> = {
  name: 'replace',
  description:
    'Batch replace a pattern across multiple files matched by glob. Returns diff for each modified file.',
  usageHint:
    'Use `glob` for broad patterns (e.g. "**/*.ts"). Set `dry_run: true` to preview without modifying. `files` can be a single path, comma-separated list, or glob pattern.',
  permission: 'confirm',
  mutating: true,
  timeoutMs: 30_000,
  inputSchema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Regex pattern to match' },
      replacement: { type: 'string', description: 'Replacement string' },
      files: {
        type: 'string',
        description: 'File(s) to target: single path, comma-separated list, or glob pattern',
      },
      glob: { type: 'string', description: 'Additional glob filter (e.g. "*.ts")' },
      replace_all: { type: 'boolean', description: 'Replace all occurrences in each file (default: true)' },
      dry_run: { type: 'boolean', description: 'Preview changes without writing' },
    },
    required: ['pattern', 'replacement', 'files'],
  },
  async execute(input: ReplaceInput, ctx: Context) {
    if (!input?.pattern) throw new Error('replace: pattern is required');
    if (input.replacement === undefined) throw new Error('replace: replacement is required');
    if (!input?.files) throw new Error('replace: files is required');

    const replaceAll = input.replace_all ?? true;
    // L-8 (audit) fix: when replace_all is false we previously still used the
    // 'g' flag, so both branches replaced every occurrence. Build flags from
    // replaceAll for correct semantics.
    const compiled = compileUserRegex(input.pattern, replaceAll ? 'g' : '');
    if (!compiled.ok) {
      throw new Error(`replace: ${compiled.reason}`);
    }
    const re = compiled.regex;
    const globRe = input.glob ? compileGlob(input.glob) : null;
    const dryRun = input.dry_run ?? false;

    const filesInput = Array.isArray(input.files) ? input.files.join(',') : input.files;
    const fileList = await resolveFiles(filesInput, ctx, globRe);

    const results: ReplaceOutput['results'] = [];
    let totalReplacements = 0;

    for (const absPath of fileList) {
      // Use lstat to detect symlinks. resolveFiles already applies
      // safeResolve, but a symlink with a target outside the project
      // root would still pass that string check — explicitly skip it
      // so we never read or write through a link.
      const lstat = await fs.lstat(absPath).catch((err) => {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw err;
      });
      if (!lstat || !lstat.isFile()) continue;
      if (lstat.isSymbolicLink()) continue;

      // Cross-check via realpath: if the resolved target lives outside the
      // project root (e.g. a bind mount or a parent-dir traversal we missed),
      // skip rather than rewrite through it.
      let realPath: string;
      try {
        realPath = await fs.realpath(absPath);
      } catch {
        continue;
      }
      const rel = path.relative(ctx.projectRoot, realPath);
      if (rel.startsWith('..') || path.isAbsolute(rel)) continue;

      // Now stat the real target so we use its mode for atomicWrite.
      const stat = await fs.stat(realPath).catch(() => null);
      if (!stat || !stat.isFile()) continue;

      let content: string;
      try {
        const buf = await fs.readFile(realPath);
        if (isBinaryBuffer(buf)) continue;
        content = buf.toString('utf8');
      } catch {
        continue;
      }

      const style = detectNewlineStyle(content);
      const contentLf = normalizeToLf(content);
      re.lastIndex = 0;
      const matches = [...contentLf.matchAll(re)];
      if (matches.length === 0) continue;

      // The 'g' flag on `re` is set iff replaceAll, so a single replace()
      // call covers both modes: with 'g' it replaces every match, without
      // it replaces only the first. matchAll already returns the correct
      // count for both modes — replaceAll=true → all matches, false → at
      // most one — so totalReplacements is accurate either way.
      const newContentLf = contentLf.replace(re, input.replacement);
      re.lastIndex = 0;
      totalReplacements += matches.length;

      if (!dryRun) {
        const newContent = toStyle(newContentLf, style);
        // Write to the real path (already validated inside project root)
        // so atomicWrite's temp-and-rename can't be redirected through a
        // freshly-planted symlink at absPath.
        await atomicWrite(realPath, newContent, { mode: stat.mode & 0o777 });
      }

      const diff = dryRun || matches.length > 0
        ? unifiedDiff(content, toStyle(newContentLf, style), { fromFile: absPath, toFile: absPath })
        : undefined;

      results.push({
        path: absPath,
        replacements: matches.length,
        diff,
      });
    }

    return {
      files_modified: results.length,
      total_replacements: totalReplacements,
      results,
      dry_run: dryRun,
    };
  },
};

async function resolveFiles(
  filesInput: string,
  ctx: Context,
  extraGlob?: RegExp | null,
): Promise<string[]> {
  const base = ctx.cwd;
  const normalized = filesInput.trim();

  if (normalized.startsWith('**/') || normalized.startsWith('*') || normalized.includes('**')) {
    return await globFiles(normalized, base, extraGlob);
  }

  const parts = normalized.split(',').map((s) => s.trim()).filter(Boolean);
  const resolved: string[] = [];

  for (const p of parts) {
    const absPath = safeResolve(p, ctx);
    const stat = await fs.stat(absPath).catch(() => null);
    if (stat?.isFile()) {
      resolved.push(absPath);
    }
  }

  return resolved;
}

async function globFiles(pattern: string, base: string, extraGlob?: RegExp | null): Promise<string[]> {
  const { spawn } = await import('node:child_process');
  const results: string[] = [];

  const rgAvailable = await checkRg();
  if (rgAvailable) {
    try {
      const { promise } = spawnRgFind(pattern, base);
      return await promise;
    } catch {
      // fall through
    }
  }

  return await globNative(pattern, base, extraGlob);
}

function checkRg(): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const p = spawn('rg', ['--version'], { stdio: 'ignore' });
      p.on('error', () => resolve(false));
      p.on('close', (code) => resolve(code === 0));
    } catch {
      resolve(false);
    }
  });
}

function spawnRgFind(pattern: string, base: string): { promise: Promise<string[]> } {
  const args = ['--files', '--glob', pattern, base];
  const child = spawn('rg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let buf = '';
  child.stdout?.on('data', (chunk: Buffer) => { buf += chunk.toString(); });
  return {
    promise: new Promise((resolve, reject) => {
      child.on('error', reject);
      child.on('close', () => {
        resolve(buf.split('\n').filter(Boolean));
      });
    }),
  };
}

async function globNative(pattern: string, base: string, extraGlob?: RegExp | null): Promise<string[]> {
  const results: string[] = [];
  const globRe = compileGlob(pattern);

  const walk = async (dir: string): Promise<void> => {
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (DEFAULT_IGNORE.includes(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        await walk(full);
      } else if (e.isFile()) {
        const name = e.name;
        if (globRe.test(name) || globRe.test(full)) {
          if (extraGlob && !extraGlob.test(name) && !extraGlob.test(full)) continue;
          results.push(full);
        }
        globRe.lastIndex = 0;
        if (extraGlob) extraGlob.lastIndex = 0;
      }
    }
  };

  await walk(base);
  return results;
}