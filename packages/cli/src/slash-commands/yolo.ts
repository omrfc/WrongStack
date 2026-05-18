import { color } from '@wrongstack/core';
import type { SlashCommand } from '@wrongstack/core';
import type { SlashCommandContext } from './index.js';

export function buildYoloCommand(opts: SlashCommandContext): SlashCommand {
  return {
    name: 'yolo',
    description: 'Toggle or query YOLO (auto-approve) mode.',
    help: [
      'Usage:',
      '  /yolo          Show current YOLO status',
      '  /yolo on       Enable YOLO mode (auto-approve every tool call)',
      '  /yolo off      Disable YOLO mode (restore permission prompts)',
      '  /yolo toggle   Toggle YOLO mode',
      '',
      'YOLO mode skips all permission prompts and auto-approves every tool call.',
      'Use with caution — the agent can execute any tool without asking.',
    ].join('\n'),
    async run(args) {
      const arg = args.trim().toLowerCase();

      if (!opts.onYolo) {
        const msg = 'YOLO toggle is not available in this session.';
        opts.renderer.writeWarning(msg);
        return { message: msg };
      }

      // No argument — show current status
      if (!arg) {
        const current = opts.onYolo();
        const status = current
          ? `${color.yellow('ON')} ${color.dim('(auto-approving all tool calls)')}`
          : `${color.green('OFF')} ${color.dim('(permission prompts active)')}`;
        const msg = `YOLO mode: ${status}`;
        opts.renderer.write(msg);
        return { message: msg };
      }

      // Explicit set
      let newState: boolean;
      if (arg === 'on' || arg === 'enable' || arg === 'true' || arg === '1') {
        newState = true;
      } else if (arg === 'off' || arg === 'disable' || arg === 'false' || arg === '0') {
        newState = false;
      } else if (arg === 'toggle') {
        newState = !opts.onYolo();
      } else {
        const msg = `Unknown argument: ${arg}. Use /yolo on, /yolo off, or /yolo toggle.`;
        opts.renderer.writeWarning(msg);
        return { message: msg };
      }

      opts.onYolo(newState);
      const label = newState
        ? `${color.yellow('ENABLED')} — all tool calls will be auto-approved`
        : `${color.green('DISABLED')} — permission prompts are active`;
      const msg = `YOLO mode: ${label}`;
      opts.renderer.write(msg);
      return { message: msg };
    },
  };
}
