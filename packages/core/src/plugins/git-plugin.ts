import { spawn } from 'node:child_process';
import { color } from '../utils/color.js';
import { ERROR_CODES, WrongStackError } from '../types/errors.js';
import type { Plugin } from '../types/plugin.js';
import type { SlashCommand, Context } from '../index.js';

/**
 * GitPlugin — built-in git helpers.
 *
 * Registers `/commit`, `/gitcheck` and `/push`. First-party ("official")
 * plugin, so the commands keep their bare names and `gc` / `gcstatus` aliases.
 * `/commit` generates an LLM commit message from the session provider when one
 * is available, falling back to diff heuristics. No configuration required.
 */
export function createGitPlugin(): Plugin {
  return {
    name: 'wstack-git',
    version: '1.0.0',
    description: 'Git helpers: /commit (LLM message), /gitcheck, /push',
    apiVersion: '^0.1',
    capabilities: { slashCommands: true },
    defaultConfig: {},

    setup(api) {
      api.slashCommands.register(buildCommitCommand());
      api.slashCommands.register(buildGitcheckCommand());
      api.slashCommands.register(buildPushCommand());
      api.log.info('[git] loaded — /commit, /gitcheck, /push available');
    },

    teardown(api) {
      api.slashCommands.unregister('commit');
      api.slashCommands.unregister('gitcheck');
      api.slashCommands.unregister('push');
      api.log.info('[git] unloaded');
    },

    async health() {
      return { ok: true, message: 'git helpers ready' };
    },
  };
}

// ── git child process ───────────────────────────────────────────────

async function runGit(
  args: string[],
  cwd: string,
): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    return await new Promise((resolve, reject) => {
      const child = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout?.on('data', (d) => {
        stdout += d;
      });
      child.stderr?.on('data', (d) => {
        stderr += d;
      });
      child.on('error', (err) => {
        reject(
          new WrongStackError({
            message: `Failed to run git: ${err.message}`,
            code: ERROR_CODES.TOOL_EXECUTION_FAILED,
            subsystem: 'tool',
            context: { command: 'git', args, cwd },
            cause: err,
          }),
        );
      });
      child.on('close', (code) => resolve({ stdout, stderr, code: code ?? 0 }));
    });
  } catch (err) {
    if (err instanceof WrongStackError) throw err;
    throw new WrongStackError({
      message: err instanceof Error ? err.message : String(err),
      code: ERROR_CODES.TOOL_EXECUTION_FAILED,
      subsystem: 'tool',
      context: { command: 'git', args, cwd },
      cause: err,
    });
  }
}

async function isGitRepo(cwd: string): Promise<boolean> {
  const result = await runGit(['rev-parse', '--git-dir'], cwd);
  return result.code === 0;
}

async function hasUncommittedChanges(cwd: string): Promise<boolean> {
  const result = await runGit(['status', '--porcelain'], cwd);
  return result.stdout.trim().length > 0;
}

// ── commit message generation ───────────────────────────────────────

/**
 * Provider shape needed to draft a commit message. Mirrors the session
 * provider's `complete()` — we access it structurally so the plugin doesn't
 * depend on the concrete Provider type.
 */
interface CommitLLMProvider {
  complete(
    req: {
      model: string;
      system?: { type: 'text'; text: string }[];
      messages: { role: string; content: { type: 'text'; text: string }[] }[];
      maxTokens: number;
      temperature?: number;
    },
    opts: { signal: AbortSignal },
  ): Promise<{ content: unknown; model?: string }>;
}

function asLLMProvider(provider: unknown): CommitLLMProvider | null {
  if (provider && typeof (provider as CommitLLMProvider).complete === 'function') {
    return provider as CommitLLMProvider;
  }
  return null;
}

/**
 * Ask the LLM to draft a conventional-commit message from the diff. Returns
 * null on any failure so the caller can fall back to heuristics.
 */
async function generateCommitMessageWithLLM(
  diff: string,
  provider: CommitLLMProvider,
  model: string,
): Promise<string | null> {
  const systemPrompt =
    'You are a helpful assistant that generates concise, conventional-commit-formatted git commit messages. ' +
    'Analyze the provided diff and output ONLY the commit message (no explanation, no quotes). ' +
    'Format: <type>(<scope>): <short description> — <type> is one of: feat, fix, docs, style, refactor, test, chore, perf, ci, build, temp. ' +
    'If the diff contains multiple unrelated changes, pick the most important one. ' +
    'Keep the description under 72 characters. Example: feat(cli): add /commit LLM integration';

  try {
    const ac = new AbortController();
    const timeout = setTimeout(() => ac.abort(), 15_000);
    const resp = await provider.complete(
      {
        model,
        system: [{ type: 'text', text: systemPrompt }],
        messages: [
          { role: 'user', content: [{ type: 'text', text: `Here is the git diff:\n\n${diff}` }] },
        ],
        maxTokens: 80,
        temperature: 0.3,
      },
      { signal: ac.signal },
    );
    clearTimeout(timeout);

    const raw = resp.content;
    const text = Array.isArray(raw)
      ? ((raw[0] as { type: string; text?: string })?.text ?? '')
      : typeof raw === 'object' && raw !== null
        ? ((raw as { type: string; text?: string }).text ?? '')
        : String(raw ?? '');
    const message = text.trim().split('\n')[0] ?? '';
    if (message.length > 0 && message.length < 200) return message;
  } catch {
    // fall through to heuristics
  }
  return null;
}

function detectCommitType(stats: string): string {
  const lines = stats.split('\n');
  const hasTestFiles = lines.some(
    (l) => l.includes('_test.') || l.includes('.test.') || l.includes('.spec.'),
  );
  const hasDocs = lines.some(
    (l) =>
      l.includes('README') || l.includes('CHANGELOG') || l.includes('docs/') || l.includes('.md'),
  );
  const hasConfig = lines.some(
    (l) => l.includes('config') || l.includes('tsconfig') || l.includes('.json'),
  );
  if (hasTestFiles) return 'test';
  if (hasDocs) return 'docs';
  if (hasConfig) return 'chore';
  return 'feat';
}

async function generateCommitMessageHeuristics(cwd: string): Promise<string> {
  const statsResult = await runGit(['diff', '--stat'], cwd);
  if (statsResult.code !== 0) return 'chore: update';

  const nameResult = await runGit(['diff', '--name-only'], cwd);
  const files = nameResult.stdout.split('\n').filter(Boolean);
  const commitType = detectCommitType(statsResult.stdout);

  let scope = '';
  if (files.length > 0) {
    const primary = files[0]!.split('/')[0];
    if (primary && primary !== 'packages' && primary !== 'apps' && primary !== 'node_modules') {
      scope = `(${primary})`;
    }
  }

  if (files.length === 0) return `${commitType}${scope}: update`;
  if (files.length <= 3) {
    const summary = files.map((f) => f.split('/').pop()).join(', ');
    return `${commitType}${scope}: ${summary}`;
  }
  const summary = `${files
    .slice(0, 3)
    .map((f) => f.split('/').pop())
    .join(', ')} and ${files.length - 3} more`;
  return `${commitType}${scope}: ${summary}`;
}

// ── commands ────────────────────────────────────────────────────────

export function buildCommitCommand(): SlashCommand {
  return {
    name: 'commit',
    description: 'Stage all changes and commit with auto-generated message.',
    aliases: ['gc'],
    async run(args: string, ctx: Context) {
      const cwd = ctx?.cwd ?? process.cwd();

      if (!(await isGitRepo(cwd))) return { message: 'Not a git repository.' };
      if (!(await hasUncommittedChanges(cwd))) {
        return { message: 'Nothing to commit (working tree clean).' };
      }

      const dryRun = args.includes('--dry-run') || args.includes('-n');
      const noLlm = args.includes('--no-llm');

      // Draft message — LLM from the session provider first, heuristics on any
      // failure (no provider, timeout, empty result).
      let message: string | null = null;
      const provider = noLlm ? null : asLLMProvider(ctx?.provider);
      if (provider && ctx?.model) {
        const diff = (await runGit(['diff'], cwd)).stdout;
        message = await generateCommitMessageWithLLM(diff, provider, ctx.model);
      }
      if (!message) message = await generateCommitMessageHeuristics(cwd);

      if (dryRun) {
        return {
          message: `Would commit:\n\n  ${color.green(message)}\n\n${color.dim('(dry-run — no actual commit)')}`,
        };
      }

      const stageResult = await runGit(['add', '.'], cwd);
      if (stageResult.code !== 0) return { message: `Stage failed: ${stageResult.stderr}` };

      const commitResult = await runGit(['commit', '-m', message], cwd);
      if (commitResult.code !== 0) return { message: `Commit failed: ${commitResult.stderr}` };

      const hash = (await runGit(['rev-parse', '--short', 'HEAD'], cwd)).stdout.trim();
      const hasRemote = (await runGit(['remote'], cwd)).stdout.trim().length > 0;
      const pushMsg = hasRemote ? `\n\n${color.dim('Tip: Run /push to push to remote')}` : '';

      return {
        message: `${color.green('✓')} Committed: ${color.bold(message)}\n  ${color.dim(hash)}${pushMsg}`,
      };
    },
  };
}

export function buildGitcheckCommand(): SlashCommand {
  return {
    name: 'gitcheck',
    description: 'Check for uncommitted changes (for system prompt integration).',
    aliases: ['gcstatus'],
    async run(_args: string, ctx: Context) {
      const cwd = ctx?.cwd ?? process.cwd();
      if (!(await isGitRepo(cwd))) return { message: '' };
      if (!(await hasUncommittedChanges(cwd))) return { message: '' };

      const statusResult = await runGit(['status', '--porcelain'], cwd);
      const count = statusResult.stdout.split('\n').filter(Boolean).length;
      if (count === 0) return { message: '' };

      return {
        message: `⚠ ${color.yellow(`${count} uncommitted change${count > 1 ? 's' : ''}`)} — consider /commit`,
      };
    },
  };
}

export function buildPushCommand(): SlashCommand {
  return {
    name: 'push',
    description: 'Push to remote after commit.',
    async run(args: string, ctx: Context) {
      const cwd = ctx?.cwd ?? process.cwd();
      if (!(await isGitRepo(cwd))) return { message: 'Not a git repository.' };

      const dryRun = args.includes('--dry-run') || args.includes('-n');
      const force = args.includes('--force') || args.includes('-f');

      const remotes = (await runGit(['remote'], cwd)).stdout.split('\n').filter(Boolean);
      if (remotes.length === 0) {
        return { message: 'No remote configured. Add one with: git remote add origin <url>' };
      }

      if (dryRun) {
        return {
          message: `Would push to ${remotes.join(', ')}${force ? ' (force)' : ''}\n${color.dim('(dry-run)')}`,
        };
      }

      const branch = (await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], cwd)).stdout.trim() || 'main';
      const pushArgs = ['push'];
      if (force) pushArgs.push('--force');
      pushArgs.push(...remotes, branch);

      const pushResult = await runGit(pushArgs, cwd);
      if (pushResult.code !== 0) return { message: `Push failed: ${pushResult.stderr}` };

      return { message: `${color.green('✓')} Pushed to ${remotes.join(', ')} (${branch})` };
    },
  };
}
