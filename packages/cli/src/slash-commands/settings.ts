import { color } from '@wrongstack/core';
import type { SlashCommand } from '@wrongstack/core';
import type { SlashCommandContext } from './index.js';
import { runSettingsMenu } from '../settings-menu.js';

export function buildSettingsCommand(opts: SlashCommandContext): SlashCommand {
  return {
    name: 'settings',
    description: 'Open interactive settings menu (auto-proceed delay, defaults, etc.).',
    help: [
      'Usage:',
      '  /settings          Open interactive settings menu',
      '',
      'Configurable settings:',
      '  auto-proceed delay — wait time before auto-continuing in auto mode',
      '  default autonomy mode — startup autonomy mode',
      '',
      'Settings are persisted to ~/.wrongstack/config.json.',
    ].join('\n'),
    async run(args) {
      const trimmed = args.trim().toLowerCase();
      if (trimmed === 'help' || trimmed === '--help') {
        return { message: this.help ?? '' };
      }

      if (!opts.renderer || !opts.reader) {
        return { message: `${color.red('Error')} settings menu requires a terminal (not available in headless mode).` };
      }

      if (!opts.configStore || !opts.paths) {
        return { message: `${color.red('Error')} config store not available.` };
      }

      try {
        await runSettingsMenu({
          renderer: opts.renderer,
          reader: opts.reader,
          configStore: opts.configStore,
          globalConfigPath: opts.paths.globalConfig,
        });
        return { message: `${color.green('Settings saved.')}` };
      } catch (err) {
        return { message: `${color.red('Settings error')}: ${err instanceof Error ? err.message : String(err)}` };
      }
    },
  };
}