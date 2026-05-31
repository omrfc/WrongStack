import { spawn } from 'node:child_process';
import { statSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { buildChildEnv } from '@wrongstack/core';
import type { Tool } from '@wrongstack/core';
import { unifiedDiff } from '@wrongstack/core';
import { safeResolve } from './_util.js';

interface DiffInput {
  path?: string;
  files?: string | string[];
  a?: string;
  b?: string;
  staged?: boolean;
  mode?: 'unified' | 'side-by-side' | 'stat';
  context?: number;
}

interface DiffOutput {
  diff: string;
  files: string[];
  truncated: boolean;
  mode: string;
}

export const diffTool: Tool<DiffInput, DiffOutput> = {
  name: 'diff',
  category: 'Filesystem',
  description:
    'Show differences between files, commits, or branches. Supports staged vs working tree.',
  usageHint:
    'Use `files` for file paths, `a`/`b` for commit refs, `staged` for git index. `mode`: unified (default), stat, side-by-side.',
  permission: 'auto',
  mutating: false,
  timeoutMs: 10_000,
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Working directory for diff' },
      files: {
        type: 'string',
        description: 'File(s) to diff: single path, comma-separated, or "**/*.ts" glob',
      },
      a: { type: 'string', description: 'First commit/branch/ref (for git diff)' },
      b: { type: 'string', description: 'Second commit/branch/ref (for git diff)' },
      staged: { type: 'boolean', description: 'Diff staged changes only' },
      mode: {
        type: 'string',
        enum: ['unified', 'side-by-side', 'stat'],
        description: 'Output mode (default: unified)',
      },
      context: { type: 'integer', description: 'Context lines for unified diff (default: 3)' },
    },
  },
  async execute(input, ctx, opts) {
    if (input.a !== undefined || input.b !== undefined) {
      return await gitDiff(input, ctx, opts.signal);
    }

    return await fileDiff(input, ctx, opts.signal);
  },
};

async function gitDiff(
  input: DiffInput,
  ctx: import('@wrongstack/core').Context,
  signal: AbortSignal,
): Promise<DiffOutput> {
  // Flag injection: a/b are passed as positional args BEFORE the `--`
  // separator, so a leading '-' would be parsed as a git option. The most
  // dangerous is `--output=<path>`, which makes `git diff` write to an
  // arbitrary path (outside the project root, with no confirmation since this
  // tool is permission:'auto'). Reject leading-dash refs unconditionally —
  // mirrors the guard in git.ts (validateWorktreeInput) and install.ts.
  if (input.a?.startsWith('-')) {
    throw new Error(`diff: unsafe ref "${input.a}" — refs may not begin with '-' (flag injection)`);
  }
  if (input.b?.startsWith('-')) {
    throw new Error(`diff: unsafe ref "${input.b}" — refs may not begin with '-' (flag injection)`);
  }

  const gitDir = findGitDir(ctx.cwd);
  if (!gitDir) {
    return { diff: '', files: [], truncated: false, mode: 'unified' };
  }

  const args: string[] = ['diff', '--no-color'];
  if (input.staged) args.push('--staged');
  if (input.a) args.push(input.a);
  if (input.b) args.push(input.b);
  if (input.files) {
    const files = Array.isArray(input.files) ? input.files : input.files.split(',');
    args.push('--', ...files.map((f) => f.trim()));
  }

  const result = await runGit(args, gitDir, signal);
  return {
    diff: result.stdout,
    files: [],
    truncated: result.stdout.length > 100_000,
    mode: 'unified',
  };
}

function findGitDir(cwd: string): string | null {
  let dir = cwd;
  for (let i = 0; i < 20; i++) {
    try {
      const stat = statSync(path.join(dir, '.git'));
      if (stat.isDirectory()) return dir;
    } catch {
      // continue
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function runGit(
  args: string[],
  cwd: string,
  signal: AbortSignal,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';

    const child = spawn('git', args, {
      cwd,
      signal,
      env: buildChildEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout?.on('data', (c) => {
      stdout += c.toString();
    });
    child.stderr?.on('data', (c) => {
      stderr += c.toString();
    });
    child.on('close', (code) => resolve({ stdout, stderr, exitCode: code ?? 0 }));
    child.on('error', (e) => resolve({ stdout: '', stderr: e.message, exitCode: 1 }));
  });
}

async function fileDiff(
  input: DiffInput,
  ctx: import('@wrongstack/core').Context,
  signal: AbortSignal,
): Promise<DiffOutput> {
  const baseDir = input.path ? safeResolve(input.path, ctx) : ctx.cwd;
  const context = input.context ?? 3;

  const files = input.files
    ? (Array.isArray(input.files) ? input.files : input.files.split(','))
        .map((f) => f.trim())
        .filter(Boolean)
    : [];

  if (files.length === 0) {
    return {
      diff: 'No files specified',
      files: [],
      truncated: false,
      mode: input.mode ?? 'unified',
    };
  }

  const results: string[] = [];

  for (const file of files) {
    const absPath = safeResolve(file, ctx);
    const stat = await fs.stat(absPath).catch(() => null);
    if (!stat?.isFile()) continue;

    const content = await fs.readFile(absPath, 'utf8');
    const lines = content.split(/\r?\n/);
    results.push(`--- ${file}\n+++ ${file}\n${formatUnified(lines, context)}`);
  }

  return {
    diff: results.join('\n'),
    files,
    truncated: false,
    mode: input.mode ?? 'unified',
  };
}

function formatUnified(lines: string[], context: number): string {
  return lines.map((line, i) => ` ${line}`).join('\n');
}
