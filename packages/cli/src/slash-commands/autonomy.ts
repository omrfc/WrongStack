import { color } from '@wrongstack/core';
import type { SlashCommand } from '@wrongstack/core';
import type { SlashCommandContext } from './index.js';

export type AutonomyMode = 'off' | 'suggest' | 'auto';

export function buildAutonomyCommand(opts: SlashCommandContext): SlashCommand {
  return {
    name: 'autonomy',
    description: 'Toggle or query autonomy mode (self-driving agent).',
    help: [
      'Usage:',
      '  /autonomy           Show current autonomy status',
      '  /autonomy off       Disabled — agent stops after each turn (default)',
      '  /autonomy suggest   Show next-step suggestions after each turn',
      '  /autonomy on        Auto-continue — agent picks next step and proceeds',
      '  /autonomy toggle    Cycle: off → suggest → auto → off',
      '',
      'Modes:',
      '  off      — Normal interactive mode. Agent stops and waits.',
      '  suggest  — After each turn, agent suggests next steps. You pick.',
      '  auto     — After each turn, agent picks the best next step and continues.',
      '             Runs indefinitely until you press Esc or Ctrl+C.',
      '',
      'In auto mode the agent works autonomously. Press Esc to redirect,',
      'Ctrl+C to stop. The agent suggests context-aware next steps based on',
      'the conversation history.',
    ].join('\n'),
    async run(args) {
      const arg = args.trim().toLowerCase();

      if (!opts.onAutonomy) {
        const msg = 'Autonomy mode is not available in this session.';
        opts.renderer.writeWarning(msg);
        return { message: msg };
      }

      // No argument — show current status
      if (!arg) {
        const current = opts.onAutonomy();
        const labels: Record<AutonomyMode, string> = {
          off: `${color.green('OFF')} ${color.dim('(agent stops after each turn)')}`,
          suggest: `${color.cyan('SUGGEST')} ${color.dim('(shows next-step suggestions)')}`,
          auto: `${color.yellow('AUTO')} ${color.dim('(self-driving — Esc to redirect, Ctrl+C to stop)')}`,
        };
        const msg = `Autonomy mode: ${labels[current]}`;
        opts.renderer.write(msg);
        return { message: msg };
      }

      // Explicit set
      let newMode: AutonomyMode;
      if (arg === 'on' || arg === 'enable' || arg === 'true' || arg === 'auto') {
        newMode = 'auto';
      } else if (arg === 'off' || arg === 'disable' || arg === 'false') {
        newMode = 'off';
      } else if (arg === 'suggest' || arg === 'suggestions') {
        newMode = 'suggest';
      } else if (arg === 'toggle' || arg === 'cycle') {
        const current = opts.onAutonomy() ?? 'off';
        const cycle: AutonomyMode[] = ['off', 'suggest', 'auto'];
        newMode = cycle[(cycle.indexOf(current) + 1) % cycle.length] ?? 'off';
      } else {
        const msg = `Unknown argument: ${arg}. Use /autonomy on, /autonomy off, /autonomy suggest, or /autonomy toggle.`;
        opts.renderer.writeWarning(msg);
        return { message: msg };
      }

      opts.onAutonomy(newMode);
      const labels: Record<AutonomyMode, string> = {
        off: `${color.green('OFF')} — agent stops after each turn`,
        suggest: `${color.cyan('SUGGEST')} — shows next-step suggestions after each turn`,
        auto: `${color.yellow('AUTO')} — self-driving, agent continues automatically`,
      };
      const msg = `Autonomy mode: ${labels[newMode]}`;
      opts.renderer.write(msg);
      return { message: msg };
    },
  };
}
