import type { SlashCommand } from '@wrongstack/core';
import type { SlashCommandContext } from './index.js';

export function buildPluginCommand(opts: SlashCommandContext): SlashCommand {
  return {
    name: 'plugin',
    aliases: ['plugins'],
    description:
      'Manage plugins: /plugin [list|status|official|install <alias>|enable <name>|disable <name>|remove <name>]',
    argsHint: '[list|status|official|install <alias>|enable <name>|disable <name>|remove <name>]',
    help: [
      'Usage:',
      '  /plugin                         List configured plugins.',
      '  /plugin status                  Alias for list.',
      '  /plugin official                List official bundled plugins and aliases.',
      '  /plugin install <alias|package> Add and enable a plugin.',
      '  /plugin add <alias|package>     Alias for install.',
      '  /plugin enable <alias|package>  Enable a configured plugin.',
      '  /plugin disable <alias|package> Disable a configured plugin.',
      '  /plugin remove <alias|package>  Remove a plugin from config.',
      '',
      'Examples:',
      '  /plugin official',
      '  /plugin install telegram',
      '  /plugin disable lsp',
    ].join('\n'),
    async run(args) {
      if (!opts.onPlugin) {
        return { message: 'Plugin management is not available in this session.' };
      }
      return { message: await opts.onPlugin(args.trim()) };
    },
  };
}
