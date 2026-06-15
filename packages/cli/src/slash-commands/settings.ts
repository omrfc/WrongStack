import type { SlashCommand } from '@wrongstack/core';
import { color, noOpVault } from '@wrongstack/core';
import { persistAutonomySetting, persistConfigSetting } from '../settings-menu.js';
import { formatDelay } from '../utils/delay-format.js';
import { parseSubcommand, unknownSubcommand } from './helpers.js';
import type { SlashCommandContext } from './index.js';
import { toErrorMessage } from '@wrongstack/core/utils';

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
    '  /settings hints on|off        Show or suppress rotating launch hints',
    '  /settings debug-stream on|off   Raw SSE hex-dump to stderr for debugging',
    '  /settings config-scope global|project   Save settings globally or per-project',
    '  /settings refine on|off       Enable/disable prompt refinement',
    '  /settings refine-delay <seconds>   Countdown duration for refine preview',
    '  /settings refine-language original|english   Default language for refinement',
    '  /settings semver-part patch|minor|major|auto   Default part for /semver and the semver_bump tool',
    '  /settings defaults            Show built-in default values',
    '',
    'Settings are persisted to ~/.wrongstack/config.json.',
  ].join('\n');

  function currentView(): string {
    const autonomy = opts.configStore.get().autonomy as
      | {
          autoProceedDelayMs?: number | undefined;
          defaultMode?: string | undefined;
          enhance?: boolean | undefined;
          enhanceDelayMs?: number | undefined;
          enhanceLanguage?: string | undefined;
        }
      | undefined;
    const delay = autonomy?.autoProceedDelayMs ?? 45_000;
    const mode = autonomy?.defaultMode ?? 'off';
    const hints = opts.configStore.get().hints !== false; // default true
    const debugStream = opts.configStore.get().debugStream === true;
    const configScope = opts.configStore.get().configScope ?? 'global';
    const enhanceEnabled = autonomy?.enhance ?? true;
    const enhanceDelay = autonomy?.enhanceDelayMs ?? 60_000;
    const enhanceLanguage = (autonomy?.enhanceLanguage as string) ?? 'original';
    const semverPart =
      ((
        opts.configStore.get().extensions?.['semver-bump'] as Record<string, unknown> | undefined
      )?.['defaultPart'] as string) ?? 'patch';
    return [
      `${color.bold('WrongStack')} ${color.dim('— Settings')}`,
      '',
      `  auto-proceed delay:    ${color.cyan(formatDelay(delay))}   ${color.dim('change: /settings delay <seconds>')}`,
      `  default autonomy mode: ${color.cyan(mode)}   ${color.dim('change: /settings mode off|suggest|auto')}`,
      `  launch hints:          ${hints ? color.cyan('on') : color.dim('off')}   ${color.dim('change: /settings hints on|off')}`,
      `  debug stream:         ${debugStream ? color.cyan('on') : color.dim('off')}   ${color.dim('change: /settings debug-stream on|off')}`,
      `  config scope:         ${color.cyan(configScope)}   ${color.dim('change: /settings config-scope global|project')}`,
      `  refine:              ${enhanceEnabled ? color.cyan('on') : color.dim('off')}   ${color.dim('change: /settings refine on|off')}`,
      `  refine-delay:        ${color.cyan(formatDelay(enhanceDelay))}   ${color.dim('change: /settings refine-delay <seconds>')}`,
      `  refine-language:     ${color.cyan(enhanceLanguage)}   ${color.dim('change: /settings refine-language original|english')}`,
      `  semver default part: ${color.cyan(semverPart)}   ${color.dim('change: /settings semver-part patch|minor|major|auto')}`,
      '',
      color.dim('  Persisted to ~/.wrongstack/config.json · /settings help for more'),
    ].join('\n');
  }

  return {
    name: 'settings',
    category: 'Config',
    description:
      'View or change settings (auto-proceed delay, default autonomy mode, launch hints).',
    help,
    async run(args) {
      const { cmd, rest } = parseSubcommand(args);
      const sub = cmd;

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
            `  launch hints:          ${color.cyan('on')}`,
            `  iteration timeout:     ${color.cyan('5 min')}`,
            `  session timeout:       ${color.cyan('30 min')}`,
            `  max iterations:        ${color.cyan('100')}`,
            `  semver default part:   ${color.cyan('patch')}`,
          ].join('\n'),
        };
      }

      const persistDeps = {
        configStore: opts.configStore,
        globalConfigPath: opts.paths.globalConfig,
        inProjectConfigPath: opts.paths.inProjectConfig,
        vault: noOpVault,
      };

      try {
        if (sub === 'delay') {
          const raw = rest[0];
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
          const raw = (rest[0] ?? '').toLowerCase();
          const modes = ['off', 'suggest', 'auto'];
          if (!modes.includes(raw)) {
            return { message: `${color.amber('Usage:')} /settings mode off|suggest|auto` };
          }
          await persistAutonomySetting(persistDeps, (autonomy) => {
            autonomy.defaultMode = raw as 'off' | 'suggest' | 'auto';
          });
          return { message: `${color.green('✓')} default autonomy → ${color.bold(raw)}` };
        }

        if (sub === 'hints') {
          const raw = (rest[0] ?? '').toLowerCase();
          if (!['on', 'off'].includes(raw)) {
            return { message: `${color.amber('Usage:')} /settings hints on|off` };
          }
          const on = raw === 'on';
          await persistConfigSetting(persistDeps, (cfg) => {
            cfg.hints = on;
          });
          return {
            message: `${color.green('✓')} launch hints → ${on ? color.cyan('on') : color.dim('off')}`,
          };
        }

        if (sub === 'debug-stream') {
          const raw = (rest[0] ?? '').toLowerCase();
          if (!['on', 'off'].includes(raw)) {
            return { message: `${color.amber('Usage:')} /settings debug-stream on|off` };
          }
          const on = raw === 'on';
          // Flip the runtime singleton — WireAdapter checks this on every
          // stream() call, so the toggle takes effect on the next request.
          const { setDebugStreamEnabled } = await import('@wrongstack/providers');
          setDebugStreamEnabled(on);
          // Persist to config so it survives restarts
          await persistConfigSetting(persistDeps, (cfg) => {
            (cfg as Record<string, unknown>).debugStream = on;
          });
          return {
            message: `${color.green('✓')} debug stream → ${on ? color.cyan('on') : color.dim('off')}   ${color.dim('raw SSE hex-dump to stderr')}`,
          };
        }

        if (sub === 'config-scope') {
          const raw = (rest[0] ?? '').toLowerCase();
          if (!['global', 'project'].includes(raw)) {
            return { message: `${color.amber('Usage:')} /settings config-scope global|project` };
          }
          await persistConfigSetting(persistDeps, (cfg) => {
            cfg.configScope = raw;
          });
          const label =
            raw === 'project'
              ? `${color.cyan('project')} — settings saved to <project>/.wrongstack/config.json`
              : `${color.cyan('global')} — settings saved to ~/.wrongstack/config.json`;
          return { message: `${color.green('✓')} config scope → ${label}` };
        }

        if (sub === 'refine') {
          const raw = (rest[0] ?? '').toLowerCase();
          if (!['on', 'off'].includes(raw)) {
            return { message: `${color.amber('Usage:')} /settings refine on|off` };
          }
          const on = raw === 'on';
          await persistAutonomySetting(persistDeps, (autonomy) => {
            (autonomy as Record<string, unknown>).enhance = on;
          });
          return {
            message: `${color.green('✓')} refine → ${on ? color.cyan('on') : color.dim('off')}   ${color.dim(on ? 'prompts will be refined before sending' : 'prompts sent verbatim')}`,
          };
        }

        if (sub === 'refine-delay') {
          const raw = rest[0];
          if (raw === undefined) {
            return { message: `${color.amber('Usage:')} /settings refine-delay <seconds>` };
          }
          const seconds = Number.parseFloat(raw);
          if (Number.isNaN(seconds) || seconds < 0) {
            return {
              message: `${color.red('Invalid number')}: "${raw}". Enter seconds, e.g. /settings refine-delay 30`,
            };
          }
          const ms = Math.round(seconds * 1000);
          await persistAutonomySetting(persistDeps, (autonomy) => {
            (autonomy as Record<string, unknown>).enhanceDelayMs = ms;
          });
          return { message: `${color.green('✓')} refine-delay → ${formatDelay(ms)}` };
        }

        if (sub === 'refine-language') {
          const raw = (rest[0] ?? '').toLowerCase();
          if (!['original', 'english'].includes(raw)) {
            return {
              message: `${color.amber('Usage:')} /settings refine-language original|english`,
            };
          }
          await persistAutonomySetting(persistDeps, (autonomy) => {
            (autonomy as Record<string, unknown>).enhanceLanguage = raw;
          });
          const label =
            raw === 'original'
              ? `${color.cyan('original')} — use the language you wrote in`
              : `${color.cyan('english')} — translate to English`;
          return { message: `${color.green('✓')} refine-language → ${label}` };
        }

        if (sub === 'semver-part') {
          const raw = (rest[0] ?? '').toLowerCase();
          const parts = ['patch', 'minor', 'major', 'auto'];
          if (!parts.includes(raw)) {
            return {
              message: `${color.amber('Usage:')} /settings semver-part patch|minor|major|auto`,
            };
          }
          // Plugin options live under extensions.<plugin-name> — the same key
          // the semver-bump plugin's configSchema validates at load time.
          // extensions is not in PROJECT_SAFE_FIELDS (plugin options may carry
          // secrets), so force the global config regardless of configScope —
          // otherwise filterSafeForProject would silently drop the write.
          await persistConfigSetting({ ...persistDeps, inProjectConfigPath: undefined }, (cfg) => {
            const ext =
              (cfg.extensions as Record<string, Record<string, unknown>> | undefined) ?? {};
            ext['semver-bump'] = { ...ext['semver-bump'], defaultPart: raw };
            cfg.extensions = ext;
          });
          return {
            message: `${color.green('✓')} semver default part → ${color.bold(raw)}   ${color.dim('saved to global config; used when /semver or semver_bump gets no explicit part')}`,
          };
        }

        return {
          message: `${color.red('Unknown setting')} "${sub}". ${unknownSubcommand(sub, ['delay', 'mode', 'hints', 'debug-stream', 'config-scope', 'refine', 'refine-delay', 'refine-language', 'semver-part', 'defaults'], 'settings')}`,
        };
      } catch (err) {
        return {
          message: `${color.red('Settings error')}: ${toErrorMessage(err)}`,
        };
      }
    },
  };
}
