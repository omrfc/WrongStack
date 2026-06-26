import type { SlashCommand } from '@wrongstack/core';
import { color, noOpVault } from '@wrongstack/core';
import { getProcessRegistry } from '@wrongstack/tools';
import { deriveFsAccessPair, persistAutonomySetting, persistConfigSetting } from '../settings-menu.js';
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
    '  /settings fs-access unrestricted|project   File-tool access scope (project = confine to project root)',
    '  /settings refine on|off       Enable/disable prompt refinement',
    '  /settings refine-delay <seconds>   Countdown duration for refine preview',
    '  /settings refine-language original|english   Default language for refinement',
    '  /settings semver-part patch|minor|major|auto   Default part for /semver and the semver_bump tool',
    '  /settings breaker on|off   Enable/disable the process circuit breaker (gates bash/exec)',
    '  /settings breaker-timeout <seconds>   Auto kill/reset delay when the breaker trips (0 = manual)',
    '  /settings context-mode balanced|frugal|deep|archival   Context window policy',
    '  /settings context-strategy hybrid|intelligent|selective   Compactor strategy',
    '  /settings context-auto-compact on|off   Auto-compact context when thresholds crossed',
    '  /settings token-saving off|minimal|light|medium|aggressive   Token-saving mode',
    '  /settings max-concurrent <n>   Max concurrent subagents (0 = default)',
    '  /settings title-animation on|off   Terminal title animation',
    '  /settings reasoning auto|on|off   Reasoning mode (auto = provider default)',
    '  /settings reasoning-effort none|minimal|low|medium|high|xhigh|max   Reasoning effort',
    '  /settings reasoning-preserve on|off   Preserve thinking across turns',
    '  /settings cache-ttl 5m|1h   Prompt cache TTL (Anthropic)',
    '  /settings hq on|off           Enable/disable HQ client publishing',
    '  /settings hq-url <url>        HQ URL for remote clients (http://host:3499)',
    '  /settings hq-token <token>    HQ client token for remote clients',
    '  /settings hq-raw on|off       Send raw content previews to HQ',
    '  /settings defaults            Show built-in default values',
    '',
    'Settings are persisted to the active config scope: global (~/.wrongstack/config.json) or project (<project>/.wrongstack/config.json).',
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
    const fsAccess =
      opts.configStore.get().tools?.restrictToProjectRoot === true ? 'project' : 'unrestricted';
    const enhanceEnabled = autonomy?.enhance ?? true;
    const enhanceDelay = autonomy?.enhanceDelayMs ?? 60_000;
    const enhanceLanguage = (autonomy?.enhanceLanguage as string) ?? 'original';
    const semverPart =
      ((
        opts.configStore.get().extensions?.['semver-bump'] as Record<string, unknown> | undefined
      )?.['defaultPart'] as string) ?? 'patch';
    const cb = opts.configStore.get().circuitBreaker;
    const breakerEnabled = cb?.enabled === true;
    const breakerTimeout = cb?.autoKillResetMs ?? 60_000;
    const context = opts.configStore.get().context as never as Record<string, unknown> | undefined;
    const contextMode = (context?.mode as string) ?? 'balanced';
    const contextStrategy = (context?.strategy as string) ?? 'hybrid';
    const contextAutoCompact = context?.autoCompact !== false; // default true
    const features = opts.configStore.get().features as never as Record<string, unknown> | undefined;
    const tokenSavingTier = (features?.tokenSavingMode as string) ?? 'off';
    const maxConcurrent = opts.configStore.get().maxConcurrent ?? 4;
    const modelRuntime = opts.configStore.get().modelRuntime as
      | { reasoning?: { mode?: string; effort?: string; preserve?: boolean }; cache?: { ttl?: string } }
      | undefined;
    const reasoningMode = modelRuntime?.reasoning?.mode ?? 'auto';
    const reasoningEffort = modelRuntime?.reasoning?.effort ?? '(unset)';
    const reasoningPreserve = modelRuntime?.reasoning?.preserve === true;
    const cacheTtl = modelRuntime?.cache?.ttl ?? 'default';
    const hq = (opts.configStore.get() as { hq?: unknown }).hq as
      | { enabled?: boolean; url?: string; token?: string; rawContent?: boolean; projectAlias?: string }
      | undefined;
    const hqEnabled = hq?.enabled === true;
    const hqUrl = hq?.url ?? '(auto/local)';
    const hqToken = hq?.token ? `${hq.token.slice(0, 6)}…${hq.token.slice(-4)} (${hq.token.length} chars)` : '(auto/local)';
    const persistedTo =
      configScope === 'project'
        ? '<project>/.wrongstack/config.json'
        : '~/.wrongstack/config.json';
    return [
      `${color.bold('WrongStack')} ${color.dim('— Settings')}`,
      '',
      `  auto-proceed delay:    ${color.cyan(formatDelay(delay))}   ${color.dim('change: /settings delay <seconds>')}`,
      `  default autonomy mode: ${color.cyan(mode)}   ${color.dim('change: /settings mode off|suggest|auto')}`,
      `  launch hints:          ${hints ? color.cyan('on') : color.dim('off')}   ${color.dim('change: /settings hints on|off')}`,
      `  debug stream:         ${debugStream ? color.cyan('on') : color.dim('off')}   ${color.dim('change: /settings debug-stream on|off')}`,
      `  config scope:         ${color.cyan(configScope)}   ${color.dim('change: /settings config-scope global|project')}`,
      `  filesystem access:   ${color.cyan(fsAccess)}   ${color.dim('change: /settings fs-access unrestricted|project')}`,
      `  refine:              ${enhanceEnabled ? color.cyan('on') : color.dim('off')}   ${color.dim('change: /settings refine on|off')}`,
      `  refine-delay:        ${color.cyan(formatDelay(enhanceDelay))}   ${color.dim('change: /settings refine-delay <seconds>')}`,
      `  refine-language:     ${color.cyan(enhanceLanguage)}   ${color.dim('change: /settings refine-language original|english')}`,
      `  semver default part: ${color.cyan(semverPart)}   ${color.dim('change: /settings semver-part patch|minor|major|auto')}`,
      `  circuit breaker:     ${breakerEnabled ? color.cyan('on') : color.dim('off')} (kill/reset ${breakerTimeout > 0 ? formatDelay(breakerTimeout) : color.dim('manual')})   ${color.dim('change: /settings breaker on|off')}`,
      `  context mode:        ${color.cyan(contextMode)}   ${color.dim('change: /settings context-mode balanced|frugal|deep|archival')}`,
      `  context strategy:    ${color.cyan(contextStrategy)}   ${color.dim('change: /settings context-strategy hybrid|intelligent|selective')}`,
      `  context auto-compact: ${contextAutoCompact ? color.cyan('on') : color.dim('off')}   ${color.dim('change: /settings context-auto-compact on|off')}`,
      `  token-saving:       ${color.cyan(tokenSavingTier)}   ${color.dim('change: /settings token-saving off|minimal|light|medium|aggressive')}`,
      `  max-concurrent:     ${color.cyan(maxConcurrent === 0 ? 'default' : String(maxConcurrent))}   ${color.dim('change: /settings max-concurrent <n>')}`,
      `  reasoning mode:     ${color.cyan(reasoningMode)}   ${color.dim('change: /settings reasoning auto|on|off')}`,
      `  reasoning effort:   ${color.cyan(reasoningEffort)}   ${color.dim('change: /settings reasoning-effort <level>')}`,
      `  reasoning preserve: ${reasoningPreserve ? color.cyan('on') : color.dim('off')}   ${color.dim('change: /settings reasoning-preserve on|off')}`,
      `  cache TTL:          ${color.cyan(cacheTtl)}   ${color.dim('change: /settings cache-ttl 5m|1h')}`,
      `  HQ publishing:     ${hqEnabled ? color.cyan('on') : color.dim('off')}   ${color.dim('change: /settings hq on|off')}`,
      `  HQ URL:            ${color.cyan(hqUrl)}   ${color.dim('change: /settings hq-url <url>')}`,
      `  HQ token:          ${color.cyan(hqToken)}   ${color.dim('change: /settings hq-token <token>')}`,
      `  HQ raw content:    ${hq?.rawContent === true ? color.cyan('on') : color.dim('off')}   ${color.dim('change: /settings hq-raw on|off')}`,
      '',
      color.dim(`  Persisted to ${persistedTo} · /settings help for more`),
    ].join('\n');
  }

  return {
    name: 'settings',
    category: 'Config',
    description:
      'View or change settings (auto-proceed, autonomy, context, features, token-saving).',
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
            `  max concurrent:        ${color.cyan('4')}`,
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
        if (sub === 'hq') {
          const raw = (rest[0] ?? '').toLowerCase();
          if (!['on', 'off'].includes(raw)) {
            return { message: `${color.amber('Usage:')} /settings hq on|off` };
          }
          const on = raw === 'on';
          await persistConfigSetting({ ...persistDeps, forceGlobal: true }, (cfg) => {
            const hq = (cfg.hq as Record<string, unknown> | undefined) ?? {};
            hq.enabled = on;
            cfg.hq = hq;
          });
          return { message: `${color.green('✓')} HQ publishing → ${on ? color.cyan('on') : color.dim('off')}` };
        }

        if (sub === 'hq-url') {
          const raw = rest.join(' ').trim();
          if (!raw) return { message: `${color.amber('Usage:')} /settings hq-url <http://host:3499>` };
          try {
            const url = new URL(raw);
            if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('bad protocol');
          } catch {
            return { message: `${color.red('Invalid URL')}: ${raw}` };
          }
          await persistConfigSetting({ ...persistDeps, forceGlobal: true }, (cfg) => {
            const hq = (cfg.hq as Record<string, unknown> | undefined) ?? {};
            hq.url = raw;
            hq.enabled = true;
            cfg.hq = hq;
          });
          return { message: `${color.green('✓')} HQ URL → ${color.cyan(raw)}` };
        }

        if (sub === 'hq-token') {
          const token = rest.join(' ').trim();
          if (!token) return { message: `${color.amber('Usage:')} /settings hq-token <client-token>` };
          await persistConfigSetting({ ...persistDeps, forceGlobal: true }, (cfg) => {
            const hq = (cfg.hq as Record<string, unknown> | undefined) ?? {};
            hq.token = token;
            hq.enabled = true;
            cfg.hq = hq;
          });
          return { message: `${color.green('✓')} HQ token saved ${color.dim('(global config)')}` };
        }

        if (sub === 'hq-raw') {
          const raw = (rest[0] ?? '').toLowerCase();
          if (!['on', 'off'].includes(raw)) {
            return { message: `${color.amber('Usage:')} /settings hq-raw on|off` };
          }
          const on = raw === 'on';
          await persistConfigSetting({ ...persistDeps, forceGlobal: true }, (cfg) => {
            const hq = (cfg.hq as Record<string, unknown> | undefined) ?? {};
            hq.rawContent = on;
            cfg.hq = hq;
          });
          return { message: `${color.green('✓')} HQ raw content → ${on ? color.cyan('on') : color.dim('off')}` };
        }

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

        if (sub === 'fs-access') {
          const raw = (rest[0] ?? '').toLowerCase();
          if (!['unrestricted', 'project'].includes(raw)) {
            return { message: `${color.amber('Usage:')} /settings fs-access unrestricted|project` };
          }
          const restrict = raw === 'project';
          // Single source of truth for the inverse pair — see
          // deriveFsAccessPair in settings-menu.ts for the precedence
          // rules. The picker, the slash command, and the cli-main
          // live-apply path all use this helper so they cannot drift.
          const fsAccess = deriveFsAccessPair({ restrictFsToRoot: restrict });
          await persistConfigSetting(persistDeps, (cfg) => {
            const tools = (cfg.tools as Record<string, unknown> | undefined) ?? {};
            tools.restrictToProjectRoot = fsAccess!.restrictToProjectRoot;
            cfg.tools = tools;
            // Dual-write the new canonical key in sync (inverse of restrict).
            const features = (cfg.features as Record<string, unknown> | undefined) ?? {};
            features.allowOutsideProjectRoot = fsAccess!.allowOutsideProjectRoot;
            cfg.features = features;
          });
          const label = restrict
            ? `${color.cyan('project')} — file tools confined to the project root`
            : `${color.cyan('unrestricted')} — file tools may access paths outside the project root`;
          return {
            message: `${color.green('✓')} filesystem access → ${label}   ${color.dim('(restart or re-open the session to apply)')}`,
          };
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

        if (sub === 'breaker') {
          const raw = (rest[0] ?? '').toLowerCase();
          if (!['on', 'off'].includes(raw)) {
            return { message: `${color.amber('Usage:')} /settings breaker on|off` };
          }
          const on = raw === 'on';
          await persistConfigSetting(persistDeps, (cfg) => {
            const cb = (cfg as Record<string, unknown>).circuitBreaker as
              | Record<string, unknown>
              | undefined;
            (cfg as Record<string, unknown>).circuitBreaker = { ...(cb ?? {}), enabled: on };
          });
          // Flip the runtime singleton so the toggle takes effect immediately
          // (no restart needed) — same pattern as debug-stream.
          getProcessRegistry().setBreakerConfig({ enabled: on });
          return {
            message: `${color.green('✓')} circuit breaker → ${on ? color.cyan('on') : color.dim('off')}   ${color.dim(on ? 'bash/exec gated on repeated failures; trips arm the kill/reset countdown' : 'bash/exec always proceed')}`,
          };
        }

        if (sub === 'breaker-timeout') {
          const raw = rest[0];
          if (raw === undefined) {
            return {
              message: `${color.amber('Usage:')} /settings breaker-timeout <seconds>   ${color.dim('(0 = manual recovery only)')}`,
            };
          }
          const seconds = Number.parseFloat(raw);
          if (Number.isNaN(seconds) || seconds < 0) {
            return {
              message: `${color.red('Invalid number')}: "${raw}". Enter seconds, e.g. /settings breaker-timeout 60`,
            };
          }
          const ms = Math.round(seconds * 1000);
          await persistConfigSetting(persistDeps, (cfg) => {
            const cb = (cfg as Record<string, unknown>).circuitBreaker as
              | Record<string, unknown>
              | undefined;
            (cfg as Record<string, unknown>).circuitBreaker = { ...(cb ?? {}), autoKillResetMs: ms };
          });
          getProcessRegistry().setBreakerConfig({ autoKillResetMs: ms });
          return {
            message: `${color.green('✓')} breaker kill/reset timeout → ${ms > 0 ? formatDelay(ms) : color.dim('manual')}   ${color.dim(ms > 0 ? 'statusline shows a countdown when the breaker trips' : 'breaker trips require /kill reset')}`,
          };
        }

        if (sub === 'context-mode') {
          const raw = (rest[0] ?? '').toLowerCase();
          const modes = ['balanced', 'frugal', 'deep', 'archival'];
          if (!modes.includes(raw)) {
            return { message: `${color.amber('Usage:')} /settings context-mode balanced|frugal|deep|archival` };
          }
          await persistConfigSetting(persistDeps, (cfg) => {
            const ctx = (cfg.context as Record<string, unknown>) ?? {};
            ctx.mode = raw;
            cfg.context = ctx;
          });
          return {
            message: `${color.green('✓')} context mode → ${color.cyan(raw)}   ${color.dim('context window policy')}`,
          };
        }

        if (sub === 'context-strategy') {
          const raw = (rest[0] ?? '').toLowerCase();
          const strategies = ['hybrid', 'intelligent', 'selective'];
          if (!strategies.includes(raw)) {
            return { message: `${color.amber('Usage:')} /settings context-strategy hybrid|intelligent|selective` };
          }
          await persistConfigSetting(persistDeps, (cfg) => {
            const ctx = (cfg.context as Record<string, unknown>) ?? {};
            ctx.strategy = raw;
            cfg.context = ctx;
          });
          return {
            message: `${color.green('✓')} context strategy → ${color.cyan(raw)}   ${color.dim('compactor strategy')}`,
          };
        }

        if (sub === 'context-auto-compact') {
          const raw = (rest[0] ?? '').toLowerCase();
          if (!['on', 'off'].includes(raw)) {
            return { message: `${color.amber('Usage:')} /settings context-auto-compact on|off` };
          }
          const on = raw === 'on';
          await persistConfigSetting(persistDeps, (cfg) => {
            const ctx = (cfg.context as Record<string, unknown>) ?? {};
            ctx.autoCompact = on;
            cfg.context = ctx;
          });
          return {
            message: `${color.green('✓')} context auto-compact → ${on ? color.cyan('on') : color.dim('off')}   ${color.dim('auto-compact context when thresholds crossed')}`,
          };
        }

        if (sub === 'token-saving') {
          const raw = (rest[0] ?? '').toLowerCase();
          const tiers = ['off', 'minimal', 'light', 'medium', 'aggressive'];
          if (!tiers.includes(raw)) {
            return { message: `${color.amber('Usage:')} /settings token-saving off|minimal|light|medium|aggressive` };
          }
          await persistConfigSetting(persistDeps, (cfg) => {
            const feat = (cfg.features as Record<string, unknown>) ?? {};
            feat.tokenSavingMode = raw;
            cfg.features = feat;
          });
          return {
            message: `${color.green('✓')} token-saving → ${color.cyan(raw)}   ${color.dim('token-saving mode')}`,
          };
        }

        if (sub === 'max-concurrent') {
          const raw = rest[0];
          if (raw === undefined) {
            return {
              message: `${color.amber('Usage:')} /settings max-concurrent <n>   ${color.dim('(0 = default)')}`,
            };
          }
          const n = Number.parseInt(raw, 10);
          if (Number.isNaN(n) || n < 0) {
            return {
              message: `${color.red('Invalid number')}: "${raw}". Enter a non-negative integer (0 = default)`,
            };
          }
          await persistConfigSetting(persistDeps, (cfg) => {
            cfg.maxConcurrent = n;
          });
          return {
            message: `${color.green('✓')} max-concurrent → ${color.cyan(n === 0 ? 'default' : String(n))}   ${color.dim('max concurrent subagents')}`,
          };
        }

        if (sub === 'title-animation') {
          const raw = (rest[0] ?? '').toLowerCase();
          if (!['on', 'off'].includes(raw)) {
            return { message: `${color.amber('Usage:')} /settings title-animation on|off` };
          }
          const on = raw === 'on';
          await persistConfigSetting(persistDeps, (cfg) => {
            cfg.titleAnimation = on;
          });
          return {
            message: `${color.green('✓')} title animation → ${on ? color.cyan('on') : color.dim('off')}   ${color.dim('terminal title animation')}`,
          };
        }

        if (sub === 'reasoning') {
          const raw = (rest[0] ?? '').toLowerCase();
          const modes = ['auto', 'on', 'off'];
          if (!modes.includes(raw)) {
            return { message: `${color.amber('Usage:')} /settings reasoning auto|on|off` };
          }
          await persistConfigSetting(persistDeps, (cfg) => {
            const mr = (cfg as Record<string, unknown>).modelRuntime as
              | Record<string, unknown>
              | undefined;
            const reasoning = (mr?.reasoning as Record<string, unknown> | undefined) ?? {};
            reasoning.mode = raw;
            (cfg as Record<string, unknown>).modelRuntime = { ...mr, reasoning };
          });
          return { message: `${color.green('✓')} reasoning mode → ${color.bold(raw)}` };
        }

        if (sub === 'reasoning-effort') {
          const raw = (rest[0] ?? '').toLowerCase();
          const efforts = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
          if (!efforts.includes(raw)) {
            return {
              message: `${color.amber('Usage:')} /settings reasoning-effort none|minimal|low|medium|high|xhigh|max`,
            };
          }
          await persistConfigSetting(persistDeps, (cfg) => {
            const mr = (cfg as Record<string, unknown>).modelRuntime as
              | Record<string, unknown>
              | undefined;
            const reasoning = (mr?.reasoning as Record<string, unknown> | undefined) ?? {};
            reasoning.effort = raw;
            (cfg as Record<string, unknown>).modelRuntime = { ...mr, reasoning };
          });
          return { message: `${color.green('✓')} reasoning effort → ${color.bold(raw)}` };
        }

        if (sub === 'reasoning-preserve') {
          const raw = (rest[0] ?? '').toLowerCase();
          if (!['on', 'off'].includes(raw)) {
            return { message: `${color.amber('Usage:')} /settings reasoning-preserve on|off` };
          }
          const on = raw === 'on';
          await persistConfigSetting(persistDeps, (cfg) => {
            const mr = (cfg as Record<string, unknown>).modelRuntime as
              | Record<string, unknown>
              | undefined;
            const reasoning = (mr?.reasoning as Record<string, unknown> | undefined) ?? {};
            reasoning.preserve = on;
            (cfg as Record<string, unknown>).modelRuntime = { ...mr, reasoning };
          });
          return {
            message: `${color.green('✓')} reasoning preserve → ${on ? color.cyan('on') : color.dim('off')}`,
          };
        }

        if (sub === 'cache-ttl') {
          const raw = (rest[0] ?? '').toLowerCase();
          if (!['5m', '1h'].includes(raw)) {
            return { message: `${color.amber('Usage:')} /settings cache-ttl 5m|1h` };
          }
          await persistConfigSetting(persistDeps, (cfg) => {
            const mr = (cfg as Record<string, unknown>).modelRuntime as
              | Record<string, unknown>
              | undefined;
            (cfg as Record<string, unknown>).modelRuntime = { ...mr, cache: { ttl: raw } };
          });
          return { message: `${color.green('✓')} cache TTL → ${color.bold(raw)}` };
        }

        return {
          message: `${color.red('Unknown setting')} "${sub}". ${unknownSubcommand(sub, ['delay', 'mode', 'hints', 'debug-stream', 'config-scope', 'fs-access', 'refine', 'refine-delay', 'refine-language', 'semver-part', 'breaker', 'breaker-timeout', 'context-mode', 'context-strategy', 'context-auto-compact', 'token-saving', 'max-concurrent', 'title-animation', 'reasoning', 'reasoning-effort', 'reasoning-preserve', 'cache-ttl', 'defaults'], 'settings')}`,
        };
      } catch (err) {
        return {
          message: `${color.red('Settings error')}: ${toErrorMessage(err)}`,
        };
      }
    },
  };
}
