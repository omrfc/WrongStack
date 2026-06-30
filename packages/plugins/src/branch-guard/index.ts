/**
 * branch-guard plugin — PreToolUse hook that blocks commits, pushes,
 * and merges to protected branches (default: main, master).
 *
 * Tools registered:
 * - branch_guard_status : Show protected branches, mode, and counters.
 *
 * Hooks registered:
 * - PreToolUse with matcher `bash|git_autocommit`. Inspects the tool
 *   input for git commit / push / merge / rebase commands (bash) or
 *   the tool call itself (git_autocommit). If the current branch is
 *   protected, the call is blocked with a clear reason.
 *
 * Config (`config.extensions['branch-guard']`):
 *
 * ```jsonc
 * {
 *   "branches": ["main", "master"],  // protected branch names
 *   "mode": "block",                 // "block" | "warn"
 *   "blockMerge": true,              // also block merges into protected
 *   "blockPush": true,               // also block pushes from protected
 *   "blockCommit": true              // also block commits on protected
 * }
 * ```
 *
 * @public
 */
import type { Plugin } from '@wrongstack/core';
import { execSync } from 'node:child_process';

const API_VERSION = '^0.1.10';

// ---------------------------------------------------------------------------
// Module-scope state (H1 audit pattern)
// ---------------------------------------------------------------------------

const state = {
  invocationCount: 0,
  blockCount: 0,
  warnCount: 0,
  hookUnregister: null as null | (() => void),
  lastBlock: null as null | {
    tool: string;
    branch: string;
    command: string;
    when: string;
  },
};

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

interface BranchGuardConfig {
  /** Branch names that are protected (no commits/pushes/merges). */
  branches: string[];
  /** Action: "block" refuses, "warn" injects context. */
  mode: 'block' | 'warn';
  /** Block commits on protected branches. */
  blockCommit: boolean;
  /** Block pushes from protected branches. */
  blockPush: boolean;
  /** Block merges into protected branches. */
  blockMerge: boolean;
}

const DEFAULTS: BranchGuardConfig = {
  branches: ['main', 'master'],
  mode: 'block',
  blockCommit: true,
  blockPush: true,
  blockMerge: true,
};

function readConfig(raw: unknown): BranchGuardConfig {
  if (!raw || typeof raw !== 'object') return { ...DEFAULTS };
  const r = raw as Record<string, unknown>;
  const branches = Array.isArray(r['branches'])
    ? (r['branches'] as unknown[]).filter((b): b is string => typeof b === 'string')
    : DEFAULTS.branches;
  return {
    branches: branches.length > 0 ? branches : DEFAULTS.branches,
    mode: r['mode'] === 'warn' ? 'warn' : 'block',
    blockCommit: r['blockCommit'] !== false,
    blockPush: r['blockPush'] !== false,
    blockMerge: r['blockMerge'] !== false,
  };
}

// ---------------------------------------------------------------------------
// Git helpers
// ---------------------------------------------------------------------------

/**
 * Get the current git branch name. Returns null if not a git repo
 * or git is unavailable.
 */
function getCurrentBranch(cwd?: string): string | null {
  try {
    const branch = execSync('git branch --show-current', {
      encoding: 'utf-8',
      timeout: 3_000,
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    return branch || null;
  } catch {
    return null;
  }
}

/**
 * Check if the working tree has uncommitted changes (staged or unstaged).
 * Uses `git status --porcelain` — any non-empty output means dirty tree.
 * Returns false if not a git repo or the command fails (best-effort).
 */
function detectUncommittedChanges(cwd?: string): boolean {
  try {
    const output = execSync('git status --porcelain', {
      encoding: 'utf-8',
      timeout: 3_000,
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    return output.length > 0;
  } catch {
    return false;
  }
}

/**
 * Check if a bash command string contains a git operation that
 * modifies the branch history.
 */
interface GitCommandMatch {
  type: 'commit' | 'push' | 'merge';
  /** The matched substring (for display). */
  snippet: string;
}

function detectGitCommand(command: string): GitCommandMatch | null {
  // Normalize whitespace for matching.
  const cmd = command.trim();

  // git commit (but NOT git commit-tree or similar)
  if (/\bgit\s+commit\b/.test(cmd)) {
    return { type: 'commit', snippet: cmd.slice(0, 120) };
  }
  // git push
  if (/\bgit\s+push\b/.test(cmd)) {
    return { type: 'push', snippet: cmd.slice(0, 120) };
  }
  // git merge (but NOT git merge-base, git merge-file as standalone tool)
  if (/\bgit\s+merge\s/.test(cmd)) {
    return { type: 'merge', snippet: cmd.slice(0, 120) };
  }
  return null;
}

/**
 * Check if a git operation type should be blocked based on config.
 */
function shouldBlock(op: 'commit' | 'push' | 'merge', cfg: BranchGuardConfig): boolean {
  if (op === 'commit') return cfg.blockCommit;
  if (op === 'push') return cfg.blockPush;
  if (op === 'merge') return cfg.blockMerge;
  return false;
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

const plugin: Plugin = {
  name: 'branch-guard',
  version: '0.1.0',
  description: 'Pre-tool hook that blocks commits, pushes, and merges to protected branches (default: main, master)',
  apiVersion: API_VERSION,
  capabilities: { tools: true, hooks: true },
  defaultConfig: { ...DEFAULTS },
  configSchema: {
    type: 'object',
    properties: {
      branches: {
        type: 'array',
        items: { type: 'string' },
        default: ['main', 'master'],
        description: 'Branch names that are protected.',
      },
      mode: {
        type: 'string',
        enum: ['block', 'warn'],
        default: 'block',
        description: '"block" refuses the call; "warn" injects context but lets it through.',
      },
      blockCommit: { type: 'boolean', default: true, description: 'Block commits on protected branches.' },
      blockPush: { type: 'boolean', default: true, description: 'Block pushes from protected branches.' },
      blockMerge: { type: 'boolean', default: true, description: 'Block merges into protected branches.' },
    },
  },

  setup(api) {
    // Idempotent re-init (H1 pattern).
    state.invocationCount = 0;
    state.blockCount = 0;
    state.warnCount = 0;
    state.hookUnregister = null;
    state.lastBlock = null;

    const cfg = readConfig(api.config.extensions?.['branch-guard']);
    const cwd = typeof process.cwd === 'function' ? process.cwd() : undefined;
    const protectedSet = new Set(cfg.branches);

    const hook = (input: {
      toolName?: string | undefined;
      toolInput?: unknown;
    }): { decision?: 'block' | 'allow' | undefined; reason?: string; additionalContext?: string } | void => {
      const toolName = input.toolName ?? '';
      const inp = (input.toolInput ?? {}) as Record<string, unknown>;
      state.invocationCount += 1;

      // Determine the git operation from the tool call.
      let gitOp: GitCommandMatch | null = null;

      if (toolName === 'git_autocommit') {
        // The git-autocommit plugin's tool is a direct commit.
        gitOp = { type: 'commit', snippet: 'git_autocommit' };
      } else if (toolName === 'bash') {
        const command = inp['command'] as string | undefined;
        if (typeof command !== 'string') return;
        gitOp = detectGitCommand(command);
      }

      if (!gitOp) return; // not a git commit/push/merge — let it through
      if (!shouldBlock(gitOp.type, cfg)) return; // config says don't block this op type

      // Check current branch.
      const branch = getCurrentBranch(cwd);
      if (!branch) return; // can't determine branch — don't block
      if (!protectedSet.has(branch)) return; // not protected — let it through

      // Protected branch + blocked operation → act.
      const when = new Date().toISOString();
      const opVerb = gitOp.type === 'commit' ? 'committing to' : gitOp.type === 'push' ? 'pushing from' : 'merging into';

      // Check for uncommitted changes so we can suggest stash.
      const hasUncommitted = detectUncommittedChanges(cwd);

      // Build a helpful suggestion: stash + branch + commit + pop.
      const suggestionParts: string[] = [];
      if (hasUncommitted) {
        suggestionParts.push('git stash');
      }
      suggestionParts.push('git checkout -b feat/my-change');
      if (hasUncommitted) {
        suggestionParts.push('git stash pop');
      }
      suggestionParts.push(`git ${gitOp.type} ...`);
      const suggestion = suggestionParts.join(' → ');

      const reason =
        `branch-guard: refused to ${gitOp.type} on protected branch '${branch}'. ` +
        `You're on a protected branch. Use a feature branch instead.\n` +
        (hasUncommitted
          ? `You have uncommitted changes. Safe workflow:\n  ${suggestion}\n`
          : `Safe workflow:\n  ${suggestion}\n`) +
        `Protected branches: ${cfg.branches.join(', ')}.`;

      state.lastBlock = { tool: toolName, branch, command: gitOp.snippet, when };

      if (cfg.mode === 'block') {
        state.blockCount += 1;
        return {
          decision: 'block',
          reason,
        };
      }

      // mode === 'warn'
      state.warnCount += 1;
      return {
        decision: 'allow',
        additionalContext:
          `\n⚠️ branch-guard: you are ${opVerb} protected branch '${branch}'. ` +
          (hasUncommitted
            ? `You have uncommitted changes — consider \`git stash\` before switching branches. `
            : '') +
          `Use a feature branch instead. Protected: ${cfg.branches.join(', ')}.`,
      };
    };

    state.hookUnregister = api.registerHook('PreToolUse', 'bash|git_autocommit', hook);

    // --- branch_guard_status tool ---
    api.tools.register({
      name: 'branch_guard_status',
      description:
        'Reports branch-guard state: protected branches, mode, and per-session invocation/block/warn counters.',
      inputSchema: { type: 'object', properties: {} },
      permission: 'auto',
      category: 'Git',
      mutating: false,
      async execute() {
        return {
          ok: true,
          branches: cfg.branches,
          mode: cfg.mode,
          blockCommit: cfg.blockCommit,
          blockPush: cfg.blockPush,
          blockMerge: cfg.blockMerge,
          counters: {
            invocations: state.invocationCount,
            blocks: state.blockCount,
            warns: state.warnCount,
          },
          lastBlock: state.lastBlock,
        };
      },
    });

    api.log.info('branch-guard plugin loaded', {
      version: '0.1.0',
      branches: cfg.branches,
      mode: cfg.mode,
    });
  },

  teardown(api) {
    if (state.hookUnregister) {
      try {
        state.hookUnregister();
      } catch {
        // best-effort
      }
      state.hookUnregister = null;
    }
    const final = {
      invocations: state.invocationCount,
      blocks: state.blockCount,
      warns: state.warnCount,
    };
    state.invocationCount = 0;
    state.blockCount = 0;
    state.warnCount = 0;
    state.lastBlock = null;
    api.log.info('branch-guard: teardown complete', { final });
  },

  async health() {
    return {
      ok: true,
      message:
        state.lastBlock === null
          ? `branch-guard: ${state.invocationCount} invocation(s), ${state.blockCount} block(s)`
          : `branch-guard: last block on '${state.lastBlock.branch}' (${state.lastBlock.command}) at ${state.lastBlock.when}`,
      counters: {
        invocations: state.invocationCount,
        blocks: state.blockCount,
        warns: state.warnCount,
      },
      lastBlock: state.lastBlock,
    };
  },
};

export default plugin;
