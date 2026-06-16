import type { SlashCommand } from '@wrongstack/core';
import { color, noOpVault } from '@wrongstack/core';
import { persistTelegramConfig } from '../settings-menu.js';
import { parseSubcommand, unknownSubcommand } from './helpers.js';
import type { SlashCommandContext } from './index.js';
import { toErrorMessage } from '@wrongstack/core/utils';

/**
 * Toggleable notification settings for the Telegram plugin.
 *
 * These map 1:1 to the boolean / numeric fields in
 * `TelegramPluginConfig` (packages/telegram/src/config.ts) and are
 * persisted to `extensions.telegram` in the global config via
 * `persistTelegramConfig`.
 *
 * The plugin reads these ONCE at `setup()` time, so a change takes effect
 * on the next restart — this is called out in every success message.
 */
const HELP = [
  'Usage:',
  '  /telegram-settings                      Show current Telegram notification settings',
  '  /telegram-settings session-end on|off   Notify on session end',
  '  /telegram-settings delegate on|off      Notify when a delegated subagent finishes',
  '  /telegram-settings long-tool <ms|off>   Notify for tools slower than <ms> (0/off = disabled)',
  '  /telegram-settings poll <seconds>       Bot polling interval (1–60)',
  '  /telegram-settings chat <chatId>        Default chat for notifications',
  '',
  'Aliases: /tg-settings',
  '',
  'Settings take effect after restarting WrongStack (the plugin reads them at startup).',
].join('\n');

export function buildTelegramSettingsCommand(opts: SlashCommandContext): SlashCommand {
  function currentView(): string {
    const config = opts.configStore.get() as {
      extensions?: { telegram?: Record<string, unknown> } | undefined;
    };
    const tg = config.extensions?.telegram ?? {};
    const sessionEnd = tg.notifyOnSessionEnd === true;
    const delegate = tg.notifyOnDelegate !== false; // default true
    const longToolMs = typeof tg.longToolThresholdMs === 'number' ? tg.longToolThresholdMs : 30_000;
    const longTool = longToolMs > 0 ? `${longToolMs}ms` : 'off';
    const poll = typeof tg.pollIntervalSec === 'number' ? `${tg.pollIntervalSec}s` : '2s';
    const chat =
      tg.notifyChatId !== undefined && tg.notifyChatId !== null
        ? String(tg.notifyChatId)
        : 'not set';
    const hasToken = typeof tg.botToken === 'string' && tg.botToken.length > 0;

    return [
      `${color.bold('Telegram')} ${color.dim('— Notification Settings')}`,
      '',
      `  session end:     ${sessionEnd ? color.cyan('on') : color.dim('off')}   ${color.dim('change: /telegram-settings session-end on|off')}`,
      `  delegate done:   ${delegate ? color.cyan('on') : color.dim('off')}   ${color.dim('change: /telegram-settings delegate on|off')}`,
      `  long tool:       ${color.cyan(longTool)}   ${color.dim('change: /telegram-settings long-tool <ms|off>')}`,
      `  poll interval:   ${color.cyan(poll)}   ${color.dim('change: /telegram-settings poll <seconds>')}`,
      `  notify chat:     ${color.cyan(chat)}   ${color.dim('change: /telegram-settings chat <chatId>')}`,
      '',
      hasToken
        ? color.dim('  Bot token configured. Restart to apply changes.')
        : `${color.amber('⚠')}  No bot token configured. Run: /telegram-setup <botToken> [chatId]`,
    ].join('\n');
  }

  return {
    name: 'telegram-settings',
    category: 'Config',
    aliases: ['tg-settings'],
    description: 'Toggle which agent events are reported to Telegram.',
    argsHint: '[session-end|delegate|long-tool|poll|chat <value>]',
    help: HELP,

    async run(args) {
      const { cmd: sub, rest } = parseSubcommand(args);

      if (sub === 'help' || sub === '--help' || sub === '-h') {
        return { message: HELP };
      }

      if (!opts.configStore || !opts.paths?.globalConfig) {
        return { message: `${color.red('Error')} config store not available.` };
      }

      if (!sub) {
        return { message: currentView() };
      }

      const persistDeps = {
        configStore: opts.configStore,
        globalConfigPath: opts.paths.globalConfig,
        vault: noOpVault as Parameters<typeof persistTelegramConfig>[0]['vault'],
      };

      try {
        if (sub === 'session-end') {
          const raw = (rest[0] ?? '').toLowerCase();
          if (!['on', 'off'].includes(raw)) {
            return { message: `${color.amber('Usage:')} /telegram-settings session-end on|off` };
          }
          const on = raw === 'on';
          await persistTelegramConfig(persistDeps, (tg) => {
            tg.notifyOnSessionEnd = on;
          });
          return {
            message: `${color.green('✓')} session-end → ${on ? color.cyan('on') : color.dim('off')}   ${color.dim('restart to apply')}`,
          };
        }

        if (sub === 'delegate') {
          const raw = (rest[0] ?? '').toLowerCase();
          if (!['on', 'off'].includes(raw)) {
            return { message: `${color.amber('Usage:')} /telegram-settings delegate on|off` };
          }
          const on = raw === 'on';
          await persistTelegramConfig(persistDeps, (tg) => {
            tg.notifyOnDelegate = on;
          });
          return {
            message: `${color.green('✓')} delegate → ${on ? color.cyan('on') : color.dim('off')}   ${color.dim('restart to apply')}`,
          };
        }

        if (sub === 'long-tool') {
          const raw = rest[0];
          if (raw === undefined) {
            return {
              message: `${color.amber('Usage:')} /telegram-settings long-tool <ms|off>   ${color.dim('(0 or off disables)')}`,
            };
          }
          if (raw === 'off') {
            await persistTelegramConfig(persistDeps, (tg) => {
              tg.longToolThresholdMs = 0;
            });
            return {
              message: `${color.green('✓')} long-tool → ${color.dim('off')}   ${color.dim('restart to apply')}`,
            };
          }
          const ms = Number.parseInt(raw, 10);
          if (Number.isNaN(ms) || ms < 0) {
            return {
              message: `${color.red('Invalid number')}: "${raw}". Enter milliseconds, e.g. /telegram-settings long-tool 15000`,
            };
          }
          await persistTelegramConfig(persistDeps, (tg) => {
            tg.longToolThresholdMs = ms;
          });
          return {
            message: `${color.green('✓')} long-tool → ${color.cyan(`${ms}ms`)}   ${color.dim('restart to apply')}`,
          };
        }

        if (sub === 'poll') {
          const raw = rest[0];
          if (raw === undefined) {
            return { message: `${color.amber('Usage:')} /telegram-settings poll <seconds>   ${color.dim('(1–60)')}` };
          }
          const sec = Number.parseInt(raw, 10);
          if (Number.isNaN(sec) || sec < 1 || sec > 60) {
            return {
              message: `${color.red('Invalid value')}: "${raw}". Enter seconds between 1 and 60.`,
            };
          }
          await persistTelegramConfig(persistDeps, (tg) => {
            tg.pollIntervalSec = sec;
          });
          return {
            message: `${color.green('✓')} poll → ${color.cyan(`${sec}s`)}   ${color.dim('restart to apply')}`,
          };
        }

        if (sub === 'chat') {
          const raw = rest[0];
          if (!raw) {
            return { message: `${color.amber('Usage:')} /telegram-settings chat <chatId>` };
          }
          const chatId = /^\d+$/.test(raw) ? Number(raw) : raw;
          await persistTelegramConfig(persistDeps, (tg) => {
            tg.notifyChatId = chatId;
          });
          return {
            message: `${color.green('✓')} notify chat → ${color.cyan(raw)}   ${color.dim('restart to apply')}`,
          };
        }

        return {
          message: `${color.red('Unknown setting')} "${sub}". ${unknownSubcommand(sub, ['session-end', 'delegate', 'long-tool', 'poll', 'chat'], 'telegram-settings')}`,
        };
      } catch (err) {
        return {
          message: `${color.red('Settings error')}: ${toErrorMessage(err)}`,
        };
      }
    },
  };
}
