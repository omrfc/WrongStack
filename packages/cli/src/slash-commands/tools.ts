import type { SlashCommand } from '@wrongstack/core';
import { color, getToolDescriptionMode } from '@wrongstack/core';
import type { SlashCommandContext } from './index.js';

function fit(text: string, width: number): string {
  if (text.length <= width) return text.padEnd(width);
  return `${text.slice(0, Math.max(0, width - 3))}...`;
}

function formatDescriptionMode(mode: 'extend' | 'simple'): string {
  const raw = `desc:${mode}`;
  return mode === 'simple' ? color.amber(raw) : color.dim(raw);
}

export function buildToolsCommand(opts: SlashCommandContext): SlashCommand {
  return {
    name: 'tools',
    category: 'Inspect',
    description: 'List registered tools.',
    async run() {
      const reg = opts.toolRegistry;
      const all = reg.listWithOwner();
      const disabled = reg.listDisabled();
      const header =
        `  ${color.dim(fit('tool', 28))} ` +
        `${color.dim(fit('owner', 28))} ` +
        `${color.dim(fit('rw', 4))} ` +
        `${color.dim(fit('perm', 8))} ` +
        `${color.dim(fit('status', 10))} ` +
        color.dim('description');
      const lines = all.map(({ tool, owner }) => {
        const mode = getToolDescriptionMode(reg, tool.name);
        const rw = tool.mutating ? color.yellow(fit('mut', 4)) : color.cyan(fit('ro', 4));
        const status = reg.isDisabled(tool.name) ? color.red('disabled') : color.green('active');
        return (
          `  ${fit(tool.name, 28)} ` +
          `${color.dim(fit(`[${owner}]`, 28))} ` +
          `${rw} ` +
          `${color.dim(fit(tool.permission, 8))} ` +
          `${fit(status, 10)} ` +
          formatDescriptionMode(mode)
        );
      });
      const extra =
        disabled.length > 0
          ? `\n${color.dim(`${disabled.length} tool(s) disabled. Use /tool enable <name> or /tool enable-all to restore.`)}`
          : '';
      const msg = `${color.bold('Tools')} (${all.length} active, ${disabled.length} disabled) ${color.dim('description detail via /tool <name> simple|extend')}:\n${header}\n${lines.join('\n')}${extra}\n`;
      opts.renderer.write(msg);
      return { message: msg };
    },
  };
}
