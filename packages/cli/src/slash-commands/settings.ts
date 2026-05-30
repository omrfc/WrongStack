import { type SecretVault, color } from '@wrongstack/core';
import type { SlashCommand } from '@wrongstack/core';
import { persistAutonomySetting } from '../settings-menu.js';
import type { SlashCommandContext } from './index.js';

/** No-op vault that passes values through unchanged.
 *  Used when the config file has no encrypted fields yet. */
const noOpVault: SecretVault = {
  encrypt: (v) => v,
  decrypt: (v) => v,
  isEncrypted: () => false,
};

function formatDelay(ms: number): string {
  if (ms >= 60_000) return `${Math.round(ms / 60_000)}m`;
  if (ms === 0) return 'disabled';
  return `${Math.round(ms / 1000)}s`;
}

/**
 * `/settings` — view or change persisted settings.
 *
 * Deliberately argument-driven and non-blocking: it never calls `reader.readLine`.
 * A blocking readline menu cannot run under the Ink TUI (Ink owns stdin in raw
 * mode), where it would hang invisibly and the renderer would fight Ink's frame.
 * Returning a single `{ message }` works identically in the plain REPL and the TUI.
 */
export function buildSettingsCommand(opts: SlashCommandContext): SlashCommand {
  const help = [
    'Usage:',
    '  /settings                     Show current settings',
    '  /settings delay <seconds>     Auto-proceed delay in auto mode (0 disables)',
    '  /settings mode <off|suggest|auto>   Default autonomy mode at startup',
    '  /settings defaults            Show built-in default values',
    '',
    'Settings are persisted to ~/.wrongstack/config.json.',
  ].join('\n');

  function currentView(): string {
    const autonomy = opts.configStore.get().autonomy as
      | { autoProceedDelayMs?: number; defaultMode?: string }
      | undefined;
    const delay = autonomy?.autoProceedDelayMs ?? 45_000;
    const mode = autonomy?.defaultMode ?? 'off';
    return [
      `${color.bold('WrongStack')} ${color.dim('— Settings')}`,
      '',
      `  auto-proceed delay:    ${color.cyan(formatDelay(delay))}   ${color.dim('change: /settings delay <seconds>')}`,
      `  default autonomy mode: ${color.cyan(mode)}   ${color.dim('change: /settings mode off|suggest|auto')}`,
      '',
      color.dim('  Persisted to ~/.wrongstack/config.json · /settings help for more'),
    ].join('\n');
  }

  return {
    name: 'settings',
    description: 'View or change settings (auto-proceed delay, default autonomy mode).',
    help,
    async run(args) {
      const parts = args.trim().split(/\s+/).filter(Boolean);
      const sub = (parts[0] ?? '').toLowerCase();

      if (sub === 'help' || sub === '--help') {
        return { message: this.help ?? '' };
      }

      if (!opts.configStore || !opts.paths) {
        return { message: `${color.red('Error')} config store not available.` };
      }

      // No args → show current settings (works in REPL and TUI).
      if (!sub) {
        return { message: currentView() };
      }

      if (sub === 'defaults') {
        return {
          message: [
            `${color.bold('Default Values')}`,
            '',
            `  auto-proceed delay:    ${color.cyan('45s')} ${color.dim('(WRONGSTACK_AUTO_PROCEED_DELAY_MS env)')}`,
            `  default autonomy mode: ${color.cyan('off')}`,
            `  iteration timeout:     ${color.cyan('5 min')}`,
            `  session timeout:       ${color.cyan('30 min')}`,
            `  max iterations:        ${color.cyan('100')}`,
          ].join('\n'),
        };
      }

      const persistDeps = {
        configStore: opts.configStore,
        globalConfigPath: opts.paths.globalConfig,
        vault: noOpVault,
      };

      try {
        if (sub === 'delay') {
          const raw = parts[1];
          if (raw === undefined) {
            return {
              message: `${color.amber('Usage:')} /settings delay <seconds>   ${color.dim('(0 disables)')}`,
            };
          }
          const seconds = Number.parseFloat(raw);
          if (Number.isNaN(seconds) || seconds < 0) {
            return {
              message: `${color.red('Invalid number')}: "${raw}". Enter seconds, e.g. /settings delay 30`,
            };
          }
          const ms = Math.round(seconds * 1000);
          await persistAutonomySetting(persistDeps, (autonomy) => {
            autonomy.autoProceedDelayMs = ms;
          });
          return { message: `${color.green('✓')} auto-proceed delay → ${formatDelay(ms)}` };
        }

        if (sub === 'mode') {
          const raw = (parts[1] ?? '').toLowerCase();
          const modes = ['off', 'suggest', 'auto'];
          if (!modes.includes(raw)) {
            return { message: `${color.amber('Usage:')} /settings mode off|suggest|auto` };
          }
          await persistAutonomySetting(persistDeps, (autonomy) => {
            autonomy.defaultMode = raw as 'off' | 'suggest' | 'auto';
          });
          return { message: `${color.green('✓')} default autonomy → ${color.bold(raw)}` };
        }

        return {
          message: `${color.red('Unknown setting')} "${sub}". Try ${color.dim('/settings')}, ${color.dim('/settings delay <s>')}, or ${color.dim('/settings mode <m>')}.`,
        };
      } catch (err) {
        return {
          message: `${color.red('Settings error')}: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    },
  };
}
