import { spawn } from 'node:child_process';
import { statSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
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
  | 'reset'
  | 'worktree';

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
  /** worktree action: list, add, remove, prune */
  worktreeAction?: 'list' | 'add' | 'remove' | 'prune';
  /** path for worktree add/remove (e.g. "../wt-feature-xyz") */
  worktreePath?: string;
  /** create new branch when adding worktree */
  newBranch?: boolean;
  /** force operation (e.g. worktree remove --force) */
  force?: boolean;
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
    'Run git commands. Wraps common operations: status, log, diff, commit, branch, checkout, stash, push, pull, fetch, reset, worktree.',
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
          'worktree',
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
      worktreeAction: {
        type: 'string',
        enum: ['list', 'add', 'remove', 'prune'],
        description: 'Worktree action: list, add, remove, prune',
      },
      worktreePath: {
        type: 'string',
        description: 'Path for worktree add/remove (e.g. "../wt-feature-xyz")',
      },
      newBranch: {
        type: 'boolean',
        description: 'Create new branch when adding worktree',
      },
      force: {
        type: 'boolean',
        description: 'Force operation (e.g. worktree remove --force)',
      },
    },
    required: ['command'],
  },
  async execute(input, ctx, opts) {
    if (!input?.command) throw new Error('git: command is required');

    if (input.command === 'commit' && !input.message) {
      return {
        command: 'commit',
        stdout: '',
        stderr: 'git commit requires a message (-m flag)',
        exitCode: 1,
        truncated: false,
      };
    }

    // Validate worktree paths/branches before touching the filesystem: reject
    // flag injection and any path that escapes the project root.
    if (input.command === 'worktree') {
      const guard = validateWorktreeInput(input, ctx.projectRoot);
      if (guard) return guard;
    }

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

/**
 * Reject worktree inputs that could inject git flags or escape the project
 * root. Returns a `GitOutput` describing the rejection, or `null` if safe.
 */
function validateWorktreeInput(input: GitInput, projectRoot: string): GitOutput | null {
  const reject = (stderr: string): GitOutput => ({
    command: 'worktree',
    stdout: '',
    stderr,
    exitCode: 1,
    truncated: false,
  });

  // Flag injection: a leading '-' would be parsed as a git option.
  if (input.branch?.startsWith('-')) return reject(`unsafe branch name: ${input.branch}`);
  if (input.worktreePath?.startsWith('-')) {
    return reject(`unsafe worktree path: ${input.worktreePath}`);
  }

  // Path escape: add/remove targets must resolve inside the project root.
  if (
    (input.worktreeAction === 'add' || input.worktreeAction === 'remove') &&
    input.worktreePath
  ) {
    const root = resolve(projectRoot);
    const abs = resolve(root, input.worktreePath);
    if (abs !== root && !abs.startsWith(root + sep)) {
      return reject(`unsafe worktree path (escapes project root): ${input.worktreePath}`);
    }
  }

  return null;
}

function findGitDir(cwd: string, projectRoot: string): string | null {
  const root = projectRoot;
  let dir = cwd;
  for (let i = 0; i < 20; i++) {
    try {
      const stat = statSync(`${dir}/.git`);
      // A normal repo has a `.git` directory; a linked worktree has a `.git`
      // *file* (gitlink pointing at the main repo). Accept both so the tool
      // operates inside a worktree when a subagent's cwd is a worktree dir.
      if (stat.isDirectory() || stat.isFile()) return dir;
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
    case 'worktree':
      switch (input.worktreeAction) {
        case 'list':
          return ['worktree', 'list'];
        case 'add': {
          // git worktree add [-b <new-branch>] <path> [<commit-ish>]
          // The path comes BEFORE the branch/commit-ish. With --newBranch the
          // branch is the name to create (`-b <branch> <path>`); without it the
          // branch is an existing branch/commit to check out (`<path> <branch>`).
          if (!input.worktreePath) return ['worktree', 'list'];
          const add = ['worktree', 'add'];
          if (input.newBranch && input.branch) add.push('-b', input.branch);
          add.push(input.worktreePath);
          if (!input.newBranch && input.branch) add.push(input.branch);
          return add;
        }
        case 'remove':
          return [
            'worktree',
            'remove',
            ...(input.force ? ['--force'] : []),
            input.worktreePath ?? '',
          ].filter(Boolean);
        case 'prune':
          return ['worktree', 'prune'];
        default:
          return ['worktree', 'list'];
      }
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
