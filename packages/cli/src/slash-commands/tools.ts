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
      const all = opts.toolRegistry.listWithOwner();
      const header =
        `  ${color.dim(fit('tool', 28))} ` +
        `${color.dim(fit('owner', 28))} ` +
        `${color.dim(fit('rw', 4))} ` +
        `${color.dim(fit('perm', 8))} ` +
        color.dim('description');
      const lines = all.map(({ tool, owner }) => {
        const mode = getToolDescriptionMode(opts.toolRegistry, tool.name);
        const rw = tool.mutating ? color.yellow(fit('mut', 4)) : color.cyan(fit('ro', 4));
        return (
          `  ${fit(tool.name, 28)} ` +
          `${color.dim(fit(`[${owner}]`, 28))} ` +
          `${rw} ` +
          `${color.dim(fit(tool.permission, 8))} ` +
          formatDescriptionMode(mode)
        );
      });
      const msg = `${color.bold('Tools')} (${all.length}) ${color.dim('description detail via /tool <name> simple|extend')}:\n${header}\n${lines.join('\n')}\n`;
      opts.renderer.write(msg);
      return { message: msg };
    },
  };
}
