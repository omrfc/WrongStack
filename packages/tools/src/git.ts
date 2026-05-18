import { spawn } from 'node:child_process';
import { statSync } from 'node:fs';
import { dirname } from 'node:path';
import { buildChildEnv } from '@wrongstack/core';
import type { Tool } from '@wrongstack/core';

type GitSubcommand =
  | 'status'
  | 'log'
  | 'diff'
  | 'commit'
  | 'branch'
  | 'checkout'
  | 'stash'
  | 'push'
  | 'pull'
  | 'fetch'
  | 'reset';

interface GitInput {
  command: GitSubcommand;
  files?: string | string[];
  dry_run?: boolean;
  /** commit message for `commit` subcommand */
  message?: string;
  /** branch name for `checkout` / `branch` */
  branch?: string;
  /** pass --graph, --oneline, --stat for `log` */
  format?: 'short' | 'oneline' | 'stat' | 'graph';
  /** limit for `log` */
  limit?: number;
}

interface GitOutput {
  command: GitSubcommand;
  stdout: string;
  stderr: string;
  exitCode: number;
  truncated: boolean;
}

const TIMEOUT_MS = 30_000;
const MAX_OUTPUT = 100_000;

export const gitTool: Tool<GitInput, GitOutput> = {
  name: 'git',
  category: 'Git',
  description:
    'Run git commands. Wraps common operations: status, log, diff, commit, branch, checkout, stash, push, pull, fetch, reset.',
  usageHint:
    'Prefer built-in subcommands over raw args. `command` is required. `message` for commits. `branch` for checkout/branch. `files` for status/diff. `format` for log.',
  permission: 'confirm',
  // Conservative: any of these may mutate. The non-mutating commands
  // (status/log/diff/branch/fetch) are still gated on `permission: 'confirm'`
  // and `MUTATING_SUBCOMMANDS` is consulted at runtime for per-call checks.
  mutating: true,
  timeoutMs: TIMEOUT_MS,
  inputSchema: {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        enum: [
          'status',
          'log',
          'diff',
          'commit',
          'branch',
          'checkout',
          'stash',
          'push',
          'pull',
          'fetch',
          'reset',
        ],
        description: 'Git subcommand',
      },
      files: {
        type: 'string',
        description:
          'File(s) for status/diff: single path, comma-separated list, or "**/*.ts" glob',
      },
      message: { type: 'string', description: 'Commit message (required for commit)' },
      branch: { type: 'string', description: 'Branch name for checkout/branch' },
      format: {
        type: 'string',
        enum: ['short', 'oneline', 'stat', 'graph'],
        description: 'Log format (default: short)',
      },
      limit: { type: 'integer', description: 'Limit for log (default: 20)' },
      dry_run: { type: 'boolean', description: 'For commit: show what would be committed' },
    },
    required: ['command'],
  },
  async execute(input, ctx, opts) {
    if (!input?.command) throw new Error('git: command is required');

    // Bound the search at projectRoot so a non-git project doesn't drift
    // into a parent repo (e.g. ~/repos/.git) and operate on the wrong tree.
    const gitDir = findGitDir(ctx.cwd, ctx.projectRoot);
    if (!gitDir) {
      return {
        command: input.command,
        stdout: '',
        stderr: 'Not in a git repository (within project root)',
        exitCode: 128,
        truncated: false,
      };
    }

    const args = buildArgs(input);
    return await runGit(args, gitDir, opts.signal);
  },
};

function findGitDir(cwd: string, projectRoot: string): string | null {
  const root = projectRoot;
  let dir = cwd;
  for (let i = 0; i < 20; i++) {
    try {
      const stat = statSync(`${dir}/.git`);
      if (stat.isDirectory()) return dir;
    } catch {
      // continue
    }
    if (dir === root) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function buildArgs(input: GitInput): string[] {
  const limit = input.limit ?? 20;
  const files = input.files
    ? (Array.isArray(input.files) ? input.files : input.files.split(','))
        .map((s: string) => s.trim())
        .filter(Boolean)
    : [];

  switch (input.command) {
    case 'status':
      return ['status', ...(files.length ? ['--', ...files] : [])];
    case 'log':
      return [
        'log',
        `--max-count=${limit}`,
        ...(input.format === 'oneline' ? ['--oneline'] : []),
        ...(input.format === 'stat' ? ['--stat'] : []),
        ...(input.format === 'graph' ? ['--oneline', '--graph', '--decorate'] : []),
        ...(input.format === 'short' || !input.format ? [] : []),
      ];
    case 'diff':
      return ['diff', '--no-color', ...(files.length ? ['--', ...files] : [])];
    case 'commit':
      return [
        'commit',
        ...(input.dry_run ? ['--dry-run', '--porcelain'] : []),
        ...(input.message ? ['-m', input.message] : []),
        ...(files.length ? ['--', ...files] : []),
      ];
    case 'branch':
      // Validate branch name: reject names starting with '-' (flag injection).
      return input.branch
        ? ['branch', ...(input.branch.startsWith('-') ? [] : [input.branch])]
        : ['branch'];
    case 'checkout':
      return [
        'checkout',
        ...(input.branch ? ['--', input.branch] : []),
        ...(files.length ? ['--', ...files] : []),
      ];
    case 'stash':
      return input.message ? ['stash', 'push', '-m', input.message] : ['stash', 'push'];
    case 'push':
      return ['push'];
    case 'pull':
      return ['pull'];
    case 'fetch':
      return ['fetch', ...(input.branch ? [input.branch] : ['--all'])];
    case 'reset':
      return ['reset'];
    default:
      return [input.command];
  }
}

function runGit(args: string[], cwd: string, signal: AbortSignal): Promise<GitOutput> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';

    const child = spawn('git', args, {
      cwd,
      signal,
      env: buildChildEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdout.length < MAX_OUTPUT) {
        stdout += chunk.toString();
      }
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < MAX_OUTPUT) {
        stderr += chunk.toString();
      }
    });

    child.on('error', (err) => {
      resolve({
        command: args[0] as GitSubcommand,
        stdout,
        stderr: err.message,
        exitCode: 1,
        truncated: stdout.length >= MAX_OUTPUT,
      });
    });

    child.on('close', (code) => {
      resolve({
        command: args[0] as GitSubcommand,
        stdout: stdout.slice(0, MAX_OUTPUT),
        stderr: stderr.slice(0, MAX_OUTPUT),
        exitCode: code ?? 1,
        truncated: stdout.length >= MAX_OUTPUT || stderr.length >= MAX_OUTPUT,
      });
    });
  });
}
