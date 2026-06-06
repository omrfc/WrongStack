import { color } from '@wrongstack/core';
import type { SlashCommand } from '@wrongstack/core';
import type { SlashCommandContext } from './index.js';

export function buildToolsCommand(opts: SlashCommandContext): SlashCommand {
  return {
    name: 'tools',
    category: 'Inspect',
    description: 'List registered tools.',
    async run() {
      const all = opts.toolRegistry.listWithOwner();
      const lines = all.map(
        ({ tool, owner }) =>
          `  ${tool.name.padEnd(28)} ${color.dim(`[${owner}]`)} ${tool.mutating ? color.yellow('mut') : color.cyan('ro')} ${color.dim(tool.permission)}`,
      );
      const msg = `${color.bold('Tools')} (${all.length}):\n${lines.join('\n')}\n`;
      opts.renderer.write(msg);
      return { message: msg };
    },
  };
}
