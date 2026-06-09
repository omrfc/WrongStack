import { color } from '@wrongstack/core';
import type { Context, SlashCommand } from '@wrongstack/core';
import type { SlashCommandContext } from './index.js';
import { execFileSync } from 'node:child_process';

/**
 * Collect project context for the suggestion subagent.
 * Goal: give the subagent enough breadcrumbs to generate useful suggestions
 * without overwhelming it with raw message dumps.
 */
function collectContext(opts: { cwd: string; projectRoot: string }): string {
  const parts: string[] = [];

  // ── Git status ──────────────────────────────────────────────────────────
  try {
    const gitStatus = execFileSync('git', ['status', '--short', '--branch'], {
      cwd: opts.projectRoot,
      encoding: 'utf8',
      timeout: 5000,
      windowsHide: true,
    }).trim();
    if (gitStatus) {
      parts.push('### Git Status', '```', gitStatus, '```');
    }
  } catch {
    // not a git repo or git unavailable
  }

  // ── Working directory hint ──────────────────────────────────────────────
  parts.push(`Working directory: ${opts.cwd}`);
  parts.push(`Project root: ${opts.projectRoot}`);

  return parts.join('\n');
}

/**
 * Build the subagent task prompt for suggestion generation.
 */
function buildSuggestPrompt(contextText: string): string {
  return [
    '## Suggest Next Steps',
    '',
    'Based on the current project state below, generate 3-5 actionable next-step',
    'suggestions. Each suggestion must be a single imperative sentence that can be',
    'executed immediately. Be specific — mention file names, tool names, or commands',
    'when relevant. Do NOT include preamble, explanation, or wrap in code blocks.',
    '',
    'Rules:',
    '- One suggestion per line, prefixed with the number (e.g. "1. Run tests...")',
    '- Order by priority: most impactful first',
    '- Suggestions should be independent — user can pick any subset',
    '- If nothing is needed, say "No pending actions — everything is up to date."',
    '',
    contextText || '(No project context available — suggest generic next steps.)',
    '',
    'Output format (strict — no other text):',
    '1. First suggestion here',
    '2. Second suggestion here',
    '3. Third suggestion here',
  ].join('\n');
}

export function buildSuggestCommand(opts: SlashCommandContext): SlashCommand {
  return {
    name: 'suggest',
    aliases: ['next-steps', 'what-next'],
    category: 'Agent',
    description: 'Generate context-aware next-step suggestions for the current session.',
    argsHint: '[--fast]',
    help: [
      'Usage:',
      '  /suggest           Generate suggestions using a lightweight subagent',
      '  /suggest --fast    Heuristic-only suggestions (no subagent, instant)',
      '',
      'Analyzes the current session state (git status, working directory, recent',
      'activity) and generates 3-5 actionable next-step suggestions. Suggestions',
      'are stored and can be selected with `/next 1`, `/next 1 2 3`, etc.',
      '',
      'Use `/next list` to see the current suggestions at any time.',
    ].join('\n'),
    async run(args: string, _ctx: Context) {
      const trimmed = args.trim().toLowerCase();
      const fast = /\b(--fast|-f)\b/.test(trimmed);

      // ── Fast path: heuristic suggestions (no subagent) ──────────────────
      if (fast) {
        const suggestions = generateHeuristicSuggestions(opts);
        opts.onSuggestions?.(suggestions);
        const display = formatSuggestions(suggestions);
        return { message: display };
      }

      // ── Full path: subagent-powered suggestions ─────────────────────────
      if (!opts.onSpawnAndWait) {
        // Fall back to heuristic if subagent not available
        const suggestions = generateHeuristicSuggestions(opts);
        opts.onSuggestions?.(suggestions);
        const display = formatSuggestions(suggestions) + '\n' +
          color.dim('(Heuristic fallback — multi-agent not enabled)');
        return { message: display };
      }

      const contextText = collectContext({
        cwd: opts.cwd,
        projectRoot: opts.projectRoot,
      });

      const task = buildSuggestPrompt(contextText);

      opts.renderer.write(color.dim('Generating suggestions...'));

      try {
        const raw = await opts.onSpawnAndWait(task, {
          name: 'suggest',
        });

        // Parse the subagent output — extract numbered lines
        const suggestions = parseSuggestions(raw);
        if (suggestions.length === 0) {
          const fallback = ['No pending actions — everything is up to date.'];
          opts.onSuggestions?.(fallback);
          return { message: formatSuggestions(fallback) };
        }

        opts.onSuggestions?.(suggestions);
        return { message: formatSuggestions(suggestions) };
      } catch (err) {
        const msg = `Suggestion generation failed: ${err instanceof Error ? err.message : String(err)}`;
        opts.renderer.writeWarning(msg);
        return { message: msg };
      }
    },
  };
}

/**
 * Parse subagent output into suggestion lines.
 * Handles various output formats:
 *   "1. Suggestion text"
 *   "- Suggestion text"
 *   "1) Suggestion text"
 */
function parseSuggestions(raw: string): string[] {
  const lines = raw.split('\n').map((l) => l.trim()).filter(Boolean);

  // Try numbered format first: "1. text" or "1) text"
  const numbered = lines
    .filter((l) => /^\d+[.)]\s/.test(l))
    .map((l) => l.replace(/^\d+[.)]\s*/, '').trim());

  if (numbered.length > 0) return numbered.slice(0, 5);

  // Try bullet format: "- text" or "* text"
  const bullets = lines
    .filter((l) => /^[-*•]\s/.test(l))
    .map((l) => l.replace(/^[-*•]\s*/, '').trim());

  if (bullets.length > 0) return bullets.slice(0, 5);

  // Fallback: take the first 5 non-empty lines that look like suggestions
  return lines
    .filter((l) => l.length > 10 && !l.startsWith('#') && !l.startsWith('```'))
    .slice(0, 5);
}

/**
 * Generate heuristic suggestions without an LLM subagent.
 * Fast, deterministic, good enough for common patterns.
 */
function generateHeuristicSuggestions(opts: SlashCommandContext): string[] {
  const suggestions: string[] = [];

  try {
    const gitStatus = execFileSync('git', ['status', '--short'], {
      cwd: opts.projectRoot,
      encoding: 'utf8',
      timeout: 5000,
      windowsHide: true,
    }).trim();

    if (gitStatus) {
      const staged = gitStatus.split('\n').filter((l) => /^[MADRC]/.test(l)).length;
      const unstaged = gitStatus.split('\n').filter((l) => /^.[MADRC]/.test(l)).length;
      const untracked = gitStatus.split('\n').filter((l) => l.startsWith('??')).length;

      if (staged > 0) {
        suggestions.push(`Commit ${staged} staged file(s) with a descriptive message`);
      }
      if (unstaged > 0) {
        suggestions.push(`Stage and review ${unstaged} modified file(s)`);
      }
      if (untracked > 0) {
        suggestions.push(`Review ${untracked} untracked file(s) — add to git or .gitignore`);
      }
    }
  } catch {
    // not a git repo
  }

  // Generic fallback if nothing found
  if (suggestions.length === 0) {
    suggestions.push('Review recent changes with a diff');
    suggestions.push('Run the test suite to verify everything passes');
    suggestions.push('Check for lint or type errors');
  }

  return suggestions.slice(0, 5);
}

/**
 * Format suggestions for display in the REPL/TUI.
 */
function formatSuggestions(suggestions: string[]): string {
  if (suggestions.length === 0) {
    return color.dim('No suggestions available.');
  }

  const lines = [
    `  ${color.cyan('💡 Next steps')}  ${color.dim('(use /next 1, /next 2, or /next 1 2 3)')}`,
    '',
  ];

  for (let i = 0; i < suggestions.length; i++) {
    const num = color.bold(`${i + 1}.`);
    const text = suggestions[i] ?? '';
    lines.push(`  ${num} ${text}`);
  }

  return lines.join('\n');
}
