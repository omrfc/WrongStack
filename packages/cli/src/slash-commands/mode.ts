import type { ModeStore } from '@wrongstack/core';
import type { SlashCommand } from '@wrongstack/core';
import type { SlashCommandContext } from './index.js';

export function buildModeCommand(
  opts: SlashCommandContext & { modeStore?: ModeStore },
): SlashCommand {
  return {
    name: 'mode',
    description: 'Switch or view the current mode',
    help: [
      'Usage:',
      '  /mode              Show current mode and available modes',
      '  /mode <id>         Switch to a different mode',
      '',
      'Available modes:',
      '  default     General-purpose coding assistant',
      '  brief       Fast, no-nonsense — get to the point',
      '  teach       Mentor mode — explains why, not just what',
      '  code-reviewer, code-auditor, architect, debugger, tester, devops, refactorer',
      '',
      'Example:',
      '  /mode brief    Switch to brief mode',
      '  /mode teach    Switch to teach mode',
    ].join('\n'),
    async run(args) {
      const modeStore = opts.modeStore;
      if (!modeStore) {
        return { message: 'Mode store not available in this context.' };
      }

      const modes = await modeStore.listModes();
      const active = await modeStore.getActiveMode();

      if (!args.trim()) {
        const lines = [`Current mode: ${active?.name ?? 'none'}`, '', 'Available modes:'];
        for (const m of modes) {
          const mark = m.id === active?.id ? ' [active]' : '';
          lines.push(`  ${m.id} — ${m.description}${mark}`);
        }
        return { message: lines.join('\n') };
      }

      const target = args.trim().toLowerCase();
      const targetMode = modes.find((m) => m.id === target);

      if (!targetMode) {
        const available = modes.map((m) => m.id).join(', ');
        return { message: `Unknown mode "${target}". Available: ${available}` };
      }

      await modeStore.setActiveMode(targetMode.id);
      return {
        message: `Switched to "${targetMode.name}" mode.\n${targetMode.description}`,
      };
    },
  };
}