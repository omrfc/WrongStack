import { spawn } from 'node:child_process';
import { color, WrongStackError, ERROR_CODES } from '@wrongstack/core';
import type { SlashCommand } from '@wrongstack/core';
import type { SlashCommandContext } from './index.js';

export { generateCommitMessageWithLLM } from './commit-llm.js';

/**
 * Run git commands.
 */
async function runGit(args: string[], cwd: string): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    return await new Promise((resolve, reject) => {
      const child = spawn('git', args, {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout?.on('data', (d) => { stdout += d; });
      child.stderr?.on('data', (d) => { stderr += d; });
      child.on('error', (err) => {
        reject(new WrongStackError({
          message: `Failed to run git: ${err.message}`,
          code: ERROR_CODES.TOOL_EXECUTION_FAILED,
          subsystem: 'tool',
          context: { command: 'git', args, cwd },
          cause: err,
        }));
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

// ── LLM-powered commit message generation ──────────────────────────

interface CommitLLMOpts {
  provider: { complete(req: unknown, opts: { signal: AbortSignal }): Promise<{ content: unknown[] }> };
  model: string;
}

/**
 * Generate a proper commit message by asking the LLM to analyze the diff.
 * Falls back to heuristics on failure.
 */
async function generateCommitMessageWithLLM(
  diff: string,
  opts: CommitLLMOpts,
): Promise<string> {
  const systemPrompt =
    'You are a helpful assistant that generates concise, conventional-commit-formatted git commit messages. ' +
    'Analyze the provided diff and output ONLY the commit message (no explanation, no quotes). ' +
    'Format: <type>(<scope>): <short description> — <type> is one of: feat, fix, docs, style, refactor, test, chore, perf, ci, build, temp. ' +
    'If the diff contains multiple unrelated changes, pick the most important one. ' +
    'Keep the description under 72 characters. Example: feat(cli): add /commit LLM integration';

  const userPrompt = `Here is the git diff:\n\n${diff}`;

  try {
    const signal = new AbortController();
    const timeout = setTimeout(() => signal.abort(), 15_000);

    const resp = await opts.provider.complete(
      {
        model: opts.model,
        system: [{ type: 'text', text: systemPrompt }],
        messages: [{ role: 'user', content: [{ type: 'text', text: userPrompt }] }],
        maxTokens: 80,
        temperature: 0.3,
      },
      { signal: signal.signal },
    );
    clearTimeout(timeout);

    const contentBlocks = resp.content as Array<{ type: string; text?: string }>;
    const text = contentBlocks.find((b) => b.type === 'text')?.text ?? '';
    const message = text.trim().split('\n')[0]!;

    if (message.length > 0 && message.length < 200) {
      return message;
    }
  } catch {
    // LLM call failed — fall through to heuristics
  }

  // Fallback: use heuristics via the existing function
  return 'chore: update';
}

// ── Heuristics ──────────────────────────────────────────────────────

/**
 * Detect conventional commit type from diff stats.
 */
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

/**
 * Generate a conventional commit message from git diff (heuristics only).
 */
async function generateCommitMessageHeuristics(cwd: string): Promise<string> {
  // Get diff stats
  const statsResult = await runGit(['diff', '--stat'], cwd);
  if (statsResult.code !== 0) return 'chore: update';

  // Get list of changed files
  const nameResult = await runGit(['diff', '--name-only'], cwd);
  const files = nameResult.stdout.split('\n').filter(Boolean);

  // Detect commit type
  const commitType = detectCommitType(statsResult.stdout);

  // Generate scope from primary directory
  let scope = '';
  if (files.length > 0) {
    const primary = files[0]!.split('/')[0];
    if (primary && primary !== 'packages' && primary !== 'apps' && primary !== 'node_modules') {
      scope = `(${primary})`;
    }
  }

  // Generate message
  if (files.length === 0) {
    return `${commitType}${scope}: update`;
  }

  if (files.length <= 3) {
    const summary = files.map((f) => f.split('/').pop()).join(', ');
    return `${commitType}${scope}: ${summary}`;
  }

  const summary =
    files.slice(0, 3).map((f) => f.split('/').pop()).join(', ') + ` and ${files.length - 3} more`;
  return `${commitType}${scope}: ${summary}`;
}

/**
 * Check if there are uncommitted changes.
 */
async function hasUncommittedChanges(cwd: string): Promise<boolean> {
  const result = await runGit(['status', '--porcelain'], cwd);
  return result.stdout.trim().length > 0;
}

/**
 * Check if git repo exists.
 */
async function isGitRepo(cwd: string): Promise<boolean> {
  const result = await runGit(['rev-parse', '--git-dir'], cwd);
  return result.code === 0;
}

export function buildCommitCommand(
  _opts: SlashCommandContext,
  generateCommitMessage?: (diff: string) => Promise<string>,
): SlashCommand {
  return {
    name: 'commit',
    description: 'Stage all changes and commit with auto-generated message.',
    aliases: ['gc'],
    async run(args, ctx) {
      const cwd = ctx?.cwd ?? process.cwd();

      // Check if git repo
      if (!(await isGitRepo(cwd))) {
        return { message: 'Not a git repository.' };
      }

      // Check for uncommitted changes
      if (!(await hasUncommittedChanges(cwd))) {
        return { message: 'Nothing to commit (working tree clean).' };
      }

      // Parse flags
      const dryRun = args.includes('--dry-run') || args.includes('-n');
      const noLlm = args.includes('--no-llm');

      // Generate commit message — try LLM first, then fall back to heuristics
      let message: string;
      if (!noLlm && generateCommitMessage) {
        const diffResult = await runGit(['diff'], cwd);
        const diff = diffResult.stdout;
        try {
          message = await generateCommitMessage(diff);
        } catch {
          // LLM failed — silently fall back to heuristics
          message = await generateCommitMessageHeuristics(cwd);
        }
      } else {
        message = await generateCommitMessageHeuristics(cwd);
      }

      if (dryRun) {
        return {
          message: `Would commit:\n\n  ${color.green(message)}\n\n${color.dim('(dry-run — no actual commit)')}`,
        };
      }

      // Stage all changes
      const stageResult = await runGit(['add', '.'], cwd);
      if (stageResult.code !== 0) {
        return { message: `Stage failed: ${stageResult.stderr}` };
      }

      // Commit
      const commitResult = await runGit(['commit', '-m', message], cwd);
      if (commitResult.code !== 0) {
        return { message: `Commit failed: ${commitResult.stderr}` };
      }

      // Get commit hash
      const hashResult = await runGit(['rev-parse', '--short', 'HEAD'], cwd);
      const hash = hashResult.stdout.trim();

      // Ask about push
      const pushResult = await runGit(['remote'], cwd);
      const hasRemote = pushResult.stdout.trim().length > 0;

      let pushMsg = '';
      if (hasRemote) {
        pushMsg = `\n\n${color.dim('Tip: Run /push to push to remote')}`;
      }

      return {
        message: `${color.green('✓')} Committed: ${color.bold(message)}\n  ${color.dim(hash)}${pushMsg}`,
      };
    },
  };
}

export function buildGitcheckCommand(_opts: SlashCommandContext): SlashCommand {
  return {
    name: 'gitcheck',
    description: 'Check for uncommitted changes (for system prompt integration).',
    aliases: ['gcstatus'],
    async run(_args, ctx) {
      const cwd = ctx?.cwd ?? process.cwd();

      if (!(await isGitRepo(cwd))) {
        return { message: '' };
      }

      if (!(await hasUncommittedChanges(cwd))) {
        return { message: '' };
      }

      const statusResult = await runGit(['status', '--porcelain'], cwd);
      const lines = statusResult.stdout.split('\n').filter(Boolean);
      const count = lines.length;

      if (count === 0) return { message: '' };

      return {
        message: `⚠ ${color.yellow(`${count} uncommitted change${count > 1 ? 's' : ''}`)} — consider /commit`,
      };
    },
  };
}

export function buildPushCommand(_opts: SlashCommandContext): SlashCommand {
  return {
    name: 'push',
    description: 'Push to remote after commit.',
    async run(args, ctx) {
      const cwd = ctx?.cwd ?? process.cwd();

      if (!(await isGitRepo(cwd))) {
        return { message: 'Not a git repository.' };
      }

      const dryRun = args.includes('--dry-run') || args.includes('-n');
      const force = args.includes('--force') || args.includes('-f');

      const remoteResult = await runGit(['remote'], cwd);
      const remotes = remoteResult.stdout.split('\n').filter(Boolean);

      if (remotes.length === 0) {
        return { message: 'No remote configured. Add one with: git remote add origin <url>' };
      }

      if (dryRun) {
        return {
          message: `Would push to ${remotes.join(', ')}${force ? ' (force)' : ''}\n${color.dim('(dry-run)')}`,
        };
      }

      const branchResult = await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
      const branch = branchResult.stdout.trim() || 'main';

      const pushArgs = ['push'];
      if (force) pushArgs.push('--force');
      pushArgs.push(...remotes, branch);

      const pushResult = await runGit(pushArgs, cwd);
      if (pushResult.code !== 0) {
        return { message: `Push failed: ${pushResult.stderr}` };
      }

      return {
        message: `${color.green('✓')} Pushed to ${remotes.join(', ')} (${branch})`,
      };
    },
  };
}