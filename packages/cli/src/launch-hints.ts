/**
 * Launch-time feature hints. Shown once per CLI launch — after the
 * provider/model/mode/YOLO prompts have resolved and right before the
 * REPL or TUI starts — to remind users what slash commands, flags, and
 * runtime controls this build ships with. Suppress with `--no-hints` or
 * `WRONGSTACK_NO_HINTS=1`.
 *
 * Rather than dumping every category at once, each launch shows ONE
 * category and rotates to the next on the following launch (round-robin
 * via a tiny persisted cursor). So you see Autonomy one boot, the fleet
 * the next, MCP/plugins after that — bite-sized, and the whole set still
 * comes around quickly. `/help` lists everything on demand.
 *
 * The list is intentionally hand-curated rather than auto-derived from
 * the slash-command registry: a one-line blurb tuned for each entry
 * lands better than `command.description` boilerplate.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { color } from '@wrongstack/core';
import type { TerminalRenderer } from './renderer.js';

interface Hint {
  readonly key: string;
  readonly blurb: string;
}

interface HintGroup {
  readonly title: string;
  readonly items: readonly Hint[];
}

const GROUPS: readonly HintGroup[] = [
  {
    title: 'Autonomy',
    items: [
      { key: '/goal <text>', blurb: 'lock in a verifiable mission — only Esc / Ctrl+C interrupt' },
      { key: '/autonomy eternal', blurb: 'sense → decide → execute → reflect loop until you stop it' },
      { key: '--eternal', blurb: 'boot directly into the eternal-autonomy engine' },
      { key: '/autonomy on|suggest', blurb: 'self-driving: auto-pick next step or just suggest it' },
    ],
  },
  {
    title: 'Multi-agent / fleet',
    items: [
      { key: '--director "<task>"', blurb: 'one-line LLM-driven fleet kickoff with 8 orchestration tools' },
      { key: '/director', blurb: 'promote the current session to director mode at runtime' },
      { key: '/spawn -p <prov> -m <model> -n <name> <task>', blurb: 'launch a single subagent (any provider/model)' },
      { key: '/fleet status|usage|kill|log|manifest', blurb: 'inspect and control the running subagent fleet' },
    ],
  },
  {
    title: 'Steering',
    items: [
      { key: 'Esc (while busy)', blurb: 'soft interrupt — next message carries a STEERING preamble' },
      { key: '/steer <text>', blurb: 'mid-flight redirect, works when Esc is eaten by tmux' },
      { key: '/btw <note>', blurb: 'non-aborting nudge — agent folds it in at its next step' },
      { key: 'Ctrl+C × 1 / × 2 / × 3', blurb: 'cancel iteration · force-exit Ink · hard exit(130)' },
    ],
  },
  {
    title: 'Modes & context',
    items: [
      { key: '/mode', blurb: 'switch persona: code-reviewer, debugger, architect, tester, devops, …' },
      { key: '/model', blurb: 'two-step provider → model picker, hot-swap at runtime' },
      { key: '/yolo on|off|toggle', blurb: 'auto-approve every tool call without restart' },
      { key: '/context mode frugal|balanced|deep|archival', blurb: 'pick how aggressively history is trimmed' },
      { key: '/compact', blurb: 'manually compact the in-flight context window' },
      { key: '/plan show|add|start|done', blurb: 'strategic roadmap, survives /resume across sessions' },
    ],
  },
  {
    title: 'Daily ops',
    items: [
      { key: '@<query>  /  Alt+V  /  /image', blurb: 'fuzzy file picker · paste clipboard image (TUI)' },
      { key: '/mcp  ·  wstack mcp add <name>', blurb: 'connect MCP servers (stdio / SSE / streamable-http)' },
      { key: '/plugin install|enable|disable <name>', blurb: 'manage plugins (telegram, lsp, …)' },
      { key: '/skill  ·  /init  ·  /commit', blurb: 'list skills · scaffold AGENTS.md · LLM-drafted git commit' },
      { key: '/diag  ·  /usage  ·  wstack resume <id>', blurb: 'diagnostics · token & cost totals · continue any session' },
    ],
  },
] as const;

/**
 * Total number of hints across all groups. Exported so callers can
 * assert "≥ 20" in tests without re-counting.
 */
export const HINT_COUNT: number = GROUPS.reduce((n, g) => n + g.items.length, 0);

/** Number of rotating categories. */
export const HINT_GROUP_COUNT: number = GROUPS.length;

/** Category titles, in rotation order. Exported for tests. */
export const HINT_GROUP_TITLES: readonly string[] = GROUPS.map((g) => g.title);

function shouldSuppress(flags: Record<string, string | boolean>): boolean {
  if (flags['no-hints'] === true) return true;
  if (flags['hints'] === false) return true;
  const env = process.env.WRONGSTACK_NO_HINTS;
  if (env && env !== '0' && env.toLowerCase() !== 'false') return true;
  return false;
}

export interface LaunchHintOptions {
  /**
   * File holding the rotation cursor. When set, each call advances it so
   * consecutive launches show different categories (round-robin). Missing
   * or unreadable file starts the rotation at the first category.
   */
  readonly cursorFile?: string;
  /**
   * Force a specific category index (wraps around). Overrides the cursor.
   * Mainly for tests and `--hints`-style explicit selection.
   */
  readonly groupIndex?: number;
}

const wrap = (n: number): number => ((n % GROUPS.length) + GROUPS.length) % GROUPS.length;

/**
 * Pick the category to show. Priority: explicit `groupIndex` → persisted
 * round-robin cursor → random. Advancing the cursor is best-effort; any
 * filesystem error falls back to a random category so a boot is never
 * blocked on hint bookkeeping.
 */
function pickGroupIndex(opts: LaunchHintOptions): number {
  if (typeof opts.groupIndex === 'number') return wrap(opts.groupIndex);
  if (opts.cursorFile) {
    try {
      let current = 0;
      try {
        const parsed = Number.parseInt(fs.readFileSync(opts.cursorFile, 'utf8').trim(), 10);
        if (Number.isFinite(parsed)) current = wrap(parsed);
      } catch {
        // No cursor yet — start at the first category.
      }
      fs.mkdirSync(path.dirname(opts.cursorFile), { recursive: true });
      fs.writeFileSync(opts.cursorFile, String(wrap(current + 1)));
      return current;
    } catch {
      // Fall through to random on any FS error.
    }
  }
  return Math.floor(Math.random() * GROUPS.length);
}

/**
 * Print one rotating category of launch hints to `renderer`. No-op when
 * suppressed via `--no-hints` or `WRONGSTACK_NO_HINTS=1`.
 */
export function printLaunchHints(
  renderer: Pick<TerminalRenderer, 'write'>,
  flags: Record<string, string | boolean>,
  opts: LaunchHintOptions = {},
): void {
  if (shouldSuppress(flags)) return;

  const idx = pickGroupIndex(opts);
  const group = GROUPS[idx];
  if (!group) return;

  const lines: string[] = [];
  lines.push('');
  lines.push(
    `  ${color.cyan('◆')} ${color.bold(group.title)} ${color.dim(`(${idx + 1}/${GROUPS.length} · more each launch)`)}`,
  );
  for (const item of group.items) {
    lines.push(`     ${color.bold(item.key)}  ${color.dim('—')} ${color.dim(item.blurb)}`);
  }
  lines.push('');
  lines.push(
    `  ${color.dim(`${color.bold('/help')} lists everything · hide with ${color.bold('--no-hints')}`)}`,
  );
  lines.push('');

  renderer.write(`${lines.join('\n')}\n`);
}
