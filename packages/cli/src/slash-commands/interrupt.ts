import { color, type SlashCommand } from '@wrongstack/core';
import type { SlashCommandContext } from './index.js';

/**
 * `/interrupt` (aliases `/stop`, `/int`) — stop the current run and every
 * subagent without reaching for ESC / Ctrl+C. Aborts the in-flight leader run
 * via the surface-installed `interruptController` and kills the whole fleet via
 * `onFleetKill`. `/interrupt all` is the same thing, spelled explicitly.
 *
 * In the TUI and WebUI a slash command dispatches even mid-run, so this stops a
 * run that is wedged retrying a 429. In the plain REPL the prompt is blocked
 * while a run is in flight, so there `/interrupt` is mostly useful at the prompt
 * (Ctrl+C remains the mid-run path — it now also stops the fleet).
 */
export function buildInterruptCommand(opts: SlashCommandContext): SlashCommand {
  return {
    name: 'interrupt',
    aliases: ['stop', 'int'],
    category: 'Run',
    description: 'Stop the current run and all subagents (leader + fleet).',
    argsHint: '[all]',
    help: [
      'Usage:',
      '  /interrupt        Abort the current leader run and stop all subagents',
      '  /interrupt all    Same — stop everything (leader + fleet)',
      '',
      'Aliases: /stop, /int. In the TUI/WebUI this works mid-run; in the plain',
      'REPL use it at the prompt (Ctrl+C interrupts a run in flight).',
    ].join('\n'),
    async run() {
      const aborted = opts.interruptController?.abortLeader() ?? false;
      const killed = opts.onFleetKill?.() ?? 0;

      if (!aborted && killed === 0) {
        return { message: color.dim('  Nothing to interrupt — no run in progress.') };
      }

      const parts: string[] = [];
      if (aborted) parts.push('leader run');
      if (killed > 0) parts.push(`${killed} subagent${killed === 1 ? '' : 's'}`);
      return { message: color.yellow(`  ↯ Interrupted ${parts.join(' + ')}.`) };
    },
  };
}
