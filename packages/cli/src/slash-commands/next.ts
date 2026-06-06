import { color } from '@wrongstack/core';
import type { SlashCommand } from '@wrongstack/core';
import type { SlashCommandContext } from './index.js';

/**
 * `/next` — toggle next-task prediction.
 *
 * When enabled, the REPL runs a lightweight single-shot LLM prediction after
 * each completed turn and shows the 1-3 most likely next steps (display-only —
 * nothing is executed). The toggle is persisted to config so it survives
 * restarts. Mirrors the `/yolo` query/set wiring (`opts.onNextPredict`).
 */
export function buildNextCommand(opts: SlashCommandContext): SlashCommand {
  return {
    name: 'next',
    category: 'Config',
    description: 'Toggle next-task prediction — show likely next steps after each turn.',
    argsHint: '[on|off|toggle]',
    help: [
      'Usage:',
      '  /next            Show whether next-task prediction is on or off',
      '  /next on         Enable — after each turn, show 1-3 predicted next steps',
      '  /next off        Disable (default)',
      '  /next toggle     Flip the current state',
      '',
      'Predictions are informational only. They come from a cheap single-shot',
      'model call (no tools, no context replay) and are never run automatically —',
      'copy or retype one to act on it. The setting persists across sessions.',
    ].join('\n'),
    async run(args) {
      if (!opts.onNextPredict) {
        const msg = 'Next-task prediction is not available in this session.';
        opts.renderer.writeWarning(msg);
        return { message: msg };
      }

      const arg = args.trim().toLowerCase();
      const current = opts.onNextPredict();

      const label = (on: boolean): string =>
        on
          ? `${color.cyan('ON')} ${color.dim('(predicted next steps shown after each turn)')}`
          : `${color.green('OFF')} ${color.dim('(no predictions)')}`;

      // No argument — report status.
      if (!arg || arg === 'status') {
        const msg = `Next-task prediction: ${label(current)}`;
        opts.renderer.write(msg);
        return { message: msg };
      }

      let target: boolean;
      if (arg === 'on' || arg === 'enable' || arg === 'true') {
        target = true;
      } else if (arg === 'off' || arg === 'disable' || arg === 'false') {
        target = false;
      } else if (arg === 'toggle' || arg === 'cycle') {
        target = !current;
      } else {
        const msg = `Unknown argument: ${arg}. Use /next on, off, or toggle.`;
        opts.renderer.writeWarning(msg);
        return { message: msg };
      }

      const now = opts.onNextPredict(target);
      const msg = `Next-task prediction: ${label(now)}`;
      opts.renderer.write(msg);
      return { message: msg };
    },
  };
}
