import type { Mode, ModeStore, InputReader } from '@wrongstack/core';
import type { SlashCommand } from '@wrongstack/core';
import type { SlashCommandContext } from './index.js';
import { color, writeOut } from '@wrongstack/core';

/**
 * Interactive mode picker — arrow-key navigation, Enter to select, q to quit.
 * Shows all available modes with the active one marked.
 */
async function runModePicker(modeStore: ModeStore, reader: InputReader): Promise<Mode | undefined> {
  const modes = await modeStore.listModes();
  const active = await modeStore.getActiveMode();
  const activeIdx = modes.findIndex((m) => m.id === active?.id);

  let cursor = activeIdx >= 0 ? activeIdx : 0;

  const render = (currentCursor: number) => {
    const lines: string[] = [];
    lines.push(`\n${color.bold(color.amber('WrongStack') + color.dim(' — Mode Selection'))}\n`);
    lines.push(color.dim('  ↑↓ navigate   Enter select   q quit\n'));
    lines.push('');
    for (let i = 0; i < modes.length; i++) {
      const m = modes[i];
      const mark = m.id === active?.id ? color.green(' [active]') : '';
      const prefix = i === currentCursor ? color.bold('❯ ') : '  ';
      const name = i === currentCursor ? color.bold(m.name) : m.name;
      lines.push(`  ${prefix}${name}  ${color.dim(m.description)}${mark}`);
    }
    lines.push('');
    return lines.join('\n');
  };

  writeOut(render(cursor));

  // Arrow keys and Enter for selection; q to quit
  const options = [
    { key: '\x1b[A', label: '↑', value: 'up' },
    { key: '\x1b[B', label: '↓', value: 'down' },
    { key: '\r', label: 'Enter', value: 'enter' },
    { key: 'q', label: 'q', value: 'quit' },
  ];

  while (true) {
    const answer = await reader.readKey('', options);
    if (answer === 'quit') return undefined;
    if (answer === 'enter') return modes[cursor];
    if (answer === 'up') {
      cursor = cursor > 0 ? cursor - 1 : modes.length - 1;
    } else if (answer === 'down') {
      cursor = cursor < modes.length - 1 ? cursor + 1 : 0;
    }
    // Re-render at current cursor position
    writeOut('\x1b[J'); // Clear from cursor to end of screen
    writeOut(render(cursor));
  }
}

export function buildModeCommand(
  opts: SlashCommandContext & { modeStore?: ModeStore },
): SlashCommand {
  return {
    name: 'mode',
    category: 'Config',
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
    async run(args, ctx) {
      const modeStore = opts.modeStore;
      if (!modeStore) {
        return { message: 'Mode store not available in this context.' };
      }

      const modes = await modeStore.listModes();
      const active = await modeStore.getActiveMode();

      if (!args.trim()) {
        // Interactive picker when no args
        if (opts.inputReader) {
          const selected = await runModePicker(modeStore, opts.inputReader);
          if (!selected) {
            return { message: 'Mode selection cancelled.' };
          }
          await modeStore.setActiveMode(selected.id);
          ctx?.state?.setMeta?.('mode', selected.id);
          return {
            message: `Switched to "${selected.name}" mode.\n${selected.description}`,
          };
        }

        // Fallback: text list
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
      ctx?.state?.setMeta?.('mode', targetMode.id);
      return {
        message: `Switched to "${targetMode.name}" mode.\n${targetMode.description}`,
      };
    },
  };
}