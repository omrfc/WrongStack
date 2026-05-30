import { color, type SecretVault, type InputReader, type ConfigStore } from '@wrongstack/core';
import type { SlashCommand } from '@wrongstack/core';
import type { SlashCommandContext } from './index.js';
import { runSettingsMenu } from '../settings-menu.js';

/** No-op vault that passes values through unchanged.
 *  Used when the config file has no encrypted fields yet. */
const noOpVault: SecretVault = {
  encrypt: (v) => v,
  decrypt: (v) => v,
  isEncrypted: () => false,
};

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

      if (!opts.configStore || !opts.paths) {
        return { message: `${color.red('Error')} config store not available.` };
      }

      if (!opts.reader || !opts.renderer) {
        return { message: `${color.red('Error')} settings menu requires a terminal (not available in headless mode).` };
      }

      try {
        // The menu needs concrete TerminalRenderer/ReadlineInputReader, not just
        // the core Renderer/InputReader interfaces. Cast via unknown as a safe bridge.
        // All actual methods called by the menu (readLine, write, writeError) exist
        // on the concrete types and are structurally compatible with the core interfaces.
        await runSettingsMenu({
          renderer: opts.renderer as Parameters<typeof runSettingsMenu>[0]['renderer'],
          reader: opts.reader as Parameters<typeof runSettingsMenu>[0]['reader'],
          configStore: opts.configStore,
          globalConfigPath: opts.paths.globalConfig,
          vault: noOpVault,
        });
        return { message: `${color.green('Settings saved.')}` };
      } catch (err) {
        return { message: `${color.red('Settings error')}: ${err instanceof Error ? err.message : String(err)}` };
      }
    },
  };
}