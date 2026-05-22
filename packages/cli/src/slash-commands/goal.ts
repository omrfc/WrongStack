import { color } from '@wrongstack/core';
import {
  emptyGoal,
  formatGoal,
  goalFilePath,
  loadGoal,
  saveGoal,
} from '@wrongstack/core';
import type { SlashCommand } from '@wrongstack/core';
import { buildGoalPreamble } from '@wrongstack/tui';
import type { SlashCommandContext } from './index.js';

const KNOWN_VERBS = new Set([
  '',
  'show',
  'status',
  'set',
  'new',
  'clear',
  'reset',
  'journal',
  'log',
]);

export function buildGoalCommand(opts: SlashCommandContext): SlashCommand {
  return {
    name: 'goal',
    description:
      'Set, inspect, or clear the long-running autonomous mission used by /autonomy eternal.',
    help: [
      'Usage:',
      '  /goal                     Show current goal + recent journal',
      '  /goal set <text>          Set a new goal (overwrites previous)',
      '  /goal clear               Clear the goal (stops eternal mode if running)',
      '  /goal status              Same as /goal (alias)',
      '  /goal journal [N]         Show last N journal entries (default 25)',
      '',
      'Goals live in <projectRoot>/.wrongstack/goal.json and persist across sessions.',
      'A goal is the prerequisite for /autonomy eternal — the engine consults it on',
      'every iteration to decide what to do next.',
    ].join('\n'),
    async run(args) {
      const trimmed = args.trim();
      const [verbRaw, ...rest] = trimmed.split(/\s+/);
      const verb = (verbRaw ?? '').toLowerCase();
      const restJoined = rest.join(' ').trim();
      const goalPath = goalFilePath(opts.projectRoot);

      // If the first token isn't a known verb, treat the entire args
      // string as the goal text — `/goal rewrite the auth module` should
      // work the same as `/goal set rewrite the auth module`. This makes
      // the merged /goal compatible with the TUI's former plain-text form.
      const verbForDispatch = verb && !KNOWN_VERBS.has(verb) ? 'set' : verb;
      const setText = verbForDispatch === 'set' && !KNOWN_VERBS.has(verb) ? trimmed : restJoined;

      switch (verbForDispatch) {
        case '':
        case 'show':
        case 'status': {
          const current = await loadGoal(goalPath);
          if (!current) {
            const msg = 'No goal set. Use `/goal set <mission text>` to create one.';
            opts.renderer.write(msg);
            return { message: msg };
          }
          const msg = formatGoal(current);
          opts.renderer.write(msg);
          return { message: msg };
        }

        case 'set':
        case 'new': {
          if (!setText) {
            const msg = 'Usage: /goal set <mission text>';
            opts.renderer.writeWarning(msg);
            return { message: msg };
          }
          const existing = await loadGoal(goalPath);
          // Preserve journal across goal replacement — useful as audit trail.
          // The new mission gets a fresh setAt but keeps the prior iterations
          // count so journal entries remain sequentially numbered.
          const next = existing
            ? { ...existing, goal: setText, setAt: new Date().toISOString(), lastActivityAt: new Date().toISOString() }
            : emptyGoal(setText);
          await saveGoal(goalPath, next);
          const shortGoal = setText.length > 80 ? `${setText.slice(0, 80)}…` : setText;
          const msg = `🎯 ${color.green('Goal locked:')} ${shortGoal}\n${color.dim(`Stored in ${goalPath} — Esc / /steer to redirect, Ctrl+C to stop.`)}`;
          opts.renderer.write(msg);
          // Inject the lock-in preamble so the next turn runs with full-
          // autonomy framing — same behavior the TUI's former /goal had.
          return { message: msg, runText: buildGoalPreamble(setText) };
        }

        case 'clear':
        case 'reset': {
          const existing = await loadGoal(goalPath);
          if (!existing) {
            const msg = 'No goal to clear.';
            opts.renderer.write(msg);
            return { message: msg };
          }
          // Soft-clear: mark engine stopped so any running engine exits next cycle,
          // and write a sentinel goal that the engine treats as "no work".
          // We *delete* the file rather than zero it out so loadGoal() returns null
          // and the engine's runOneIteration() short-circuits to stopRequested.
          const { unlink } = await import('node:fs/promises');
          try {
            await unlink(goalPath);
          } catch {
            // best-effort
          }
          if (opts.onEternalStop) opts.onEternalStop();
          const msg = `${color.amber('Goal cleared.')} Eternal mode will stop on next cycle.`;
          opts.renderer.write(msg);
          return { message: msg };
        }

        case 'journal':
        case 'log': {
          const current = await loadGoal(goalPath);
          if (!current) {
            const msg = 'No goal set.';
            opts.renderer.write(msg);
            return { message: msg };
          }
          const n = restJoined ? Math.max(1, Number.parseInt(restJoined, 10) || 25) : 25;
          if (current.journal.length === 0) {
            const msg = 'Journal is empty.';
            opts.renderer.write(msg);
            return { message: msg };
          }
          const tail = current.journal.slice(-n);
          const lines = tail.map((e) => {
            const mark = e.status === 'success' ? color.green('✓') : e.status === 'failure' ? color.red('✗') : e.status === 'aborted' ? color.amber('⊘') : color.dim('·');
            const note = e.note ? color.dim(` — ${e.note}`) : '';
            return `${color.dim(`#${e.iteration}`)} ${mark} ${color.dim(`[${e.source}]`)} ${e.task}${note}`;
          });
          const header = `Journal (last ${tail.length} of ${current.journal.length}):`;
          const msg = `${header}\n${lines.join('\n')}`;
          opts.renderer.write(msg);
          return { message: msg };
        }

        default: {
          // Unreachable — verbForDispatch is either '' (show), a known
          // verb, or 'set' (when the first token isn't a known verb).
          const msg = `Unknown subcommand "${verb}". Try: show | set <text> | clear | journal [N]`;
          opts.renderer.writeWarning(msg);
          return { message: msg };
        }
      }
    },
  };
}
