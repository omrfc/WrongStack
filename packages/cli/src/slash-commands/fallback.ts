import * as fs from 'node:fs/promises';
import {
  atomicWrite,
  color,
  decryptConfigSecrets,
  encryptConfigSecrets,
  noOpVault,
  type SlashCommand,
} from '@wrongstack/core';
import { smartDefaultFallbackChain } from '../fallback-model.js';
import type { SlashCommandContext } from './index.js';

/**
 * Read the global config, apply `mutate`, write it back atomically, and
 * mirror the change into the in-memory config store. Mirrors the helper in
 * `setmodel.ts` — pure I/O, safe under both the plain REPL and the Ink TUI.
 */
async function patchGlobalConfig(
  globalConfigPath: string,
  mutate: (cfg: Record<string, unknown>) => void,
): Promise<Record<string, unknown>> {
  let raw = '{}';
  let fileExists = true;
  try {
    raw = await fs.readFile(globalConfigPath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    fileExists = false;
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch (err) {
    if (fileExists)
      throw new Error(`Config at ${globalConfigPath} is not valid JSON: ${(err as Error).message}`);
    parsed = {};
  }
  const decrypted = decryptConfigSecrets(parsed, noOpVault) as Record<string, unknown>;
  mutate(decrypted);
  const encrypted = encryptConfigSecrets(decrypted, noOpVault);
  await atomicWrite(globalConfigPath, JSON.stringify(encrypted, null, 2), { mode: 0o600 });
  return decrypted;
}

/**
 * `/fallback` — view or change the cross-provider fallback chain that the
 * agent rotates to when the primary model is rate-limited / overloaded
 * (429/529/5xx) and its own retries are exhausted. Argument-driven (never
 * blocks on readline) so it behaves identically in the REPL and the TUI.
 * Persists to ~/.wrongstack/config.json.
 *
 * Subcommands:
 *   (none)              Show the active chain (explicit or smart-default
 *                       preview) and the smart-default toggle.
 *   add <provider/model> Append a model reference to the explicit chain.
 *   remove <n|ref>      Remove by 1-based index or by exact reference.
 *   clear               Empty the explicit chain (smart default takes over
 *                       again when `auto` is on).
 *   auto on|off         Toggle the smart default (config.fallbackAuto).
 */
export function buildFallbackCommand(opts: SlashCommandContext): SlashCommand {
  const help = [
    'Usage:',
    '  /fallback                       Show the active fallback chain + smart-default state',
    '  /fallback add <provider/model>  Append a model to the explicit chain',
    '  /fallback add <model>           Append a model on the leader provider',
    '  /fallback remove <n|ref>        Remove by 1-based index or exact reference',
    '  /fallback clear                 Empty the explicit chain',
    '  /fallback auto on|off           Toggle the auto-derived smart default',
    '',
    'When the explicit chain is empty and auto is on, a chain is derived from',
    'your other keyed providers/models so 429s recover without any setup.',
    '',
    'Persisted to ~/.wrongstack/config.json.',
  ].join('\n');

  function currentView(): string {
    const config = opts.configStore.get();
    const explicit = config.fallbackModels ?? [];
    const auto = config.fallbackAuto !== false;
    const lines = [
      `${color.bold('WrongStack')} ${color.dim('— Fallback chain')}`,
      '',
      `  ${color.bold('leader')}  ${color.cyan(`${config.provider}/${config.model}`)}`,
      '',
    ];

    if (explicit.length > 0) {
      lines.push(
        `  ${color.bold('explicit chain')} ${color.dim('(tried in order after the leader)')}`,
      );
      explicit.forEach((ref, i) => {
        lines.push(`    ${color.amber(String(i + 1).padStart(2))}. ${color.cyan(ref)}`);
      });
    } else {
      lines.push(`  ${color.bold('explicit chain')} ${color.dim('(empty)')}`);
      const preview = auto ? smartDefaultFallbackChain(config) : [];
      if (auto) {
        if (preview.length > 0) {
          lines.push(`    ${color.dim('smart default (auto-derived):')}`);
          preview.forEach((ref, i) => {
            lines.push(`    ${color.dim(`${String(i + 1).padStart(2)}. ${ref}`)}`);
          });
        } else {
          lines.push(
            `    ${color.dim('smart default: nothing usable — add models to your providers or use /fallback add')}`,
          );
        }
      }
    }

    lines.push(
      '',
      `  ${color.bold('auto')}  ${auto ? color.green('on') : color.dim('off')}  ${color.dim('/fallback auto on|off')}`,
      '',
      color.dim('  /fallback add <provider/model> · remove <n> · clear · help'),
    );
    return lines.join('\n');
  }

  return {
    name: 'fallback',
    category: 'Config',
    description: 'View or change the rate-limit fallback model chain (429/529/5xx recovery).',
    argsHint: '[add <provider/model> | remove <n> | clear | auto on|off]',
    help,
    async run(args) {
      const parts = args.trim().split(/\s+/).filter(Boolean);
      const sub = (parts[0] ?? '').toLowerCase();

      if (sub === 'help' || sub === '--help') return { message: this.help ?? '' };
      if (!opts.paths) {
        return { message: `${color.red('Error')} config paths not available.` };
      }
      if (!sub) return { message: currentView() };

      const globalConfigPath = opts.paths.globalConfig;
      const config = opts.configStore.get();
      const explicit = [...(config.fallbackModels ?? [])];

      try {
        if (sub === 'add') {
          const ref = parts.slice(1).join(' ').trim();
          if (!ref) {
            return { message: `${color.amber('Usage:')} /fallback add <provider/model>` };
          }
          if (explicit.includes(ref)) {
            return { message: `${color.amber('Already in chain')}: ${color.cyan(ref)}` };
          }
          explicit.push(ref);
          const decrypted = await patchGlobalConfig(globalConfigPath, (cfg) => {
            cfg.fallbackModels = explicit;
          });
          opts.configStore.update({ fallbackModels: decrypted.fallbackModels as string[] });
          return {
            message: `${color.green('✓')} added ${color.cyan(ref)} ${color.dim(`(chain length ${explicit.length})`)}`,
          };
        }

        if (sub === 'remove') {
          const target = parts.slice(1).join(' ').trim();
          if (!target) return { message: `${color.amber('Usage:')} /fallback remove <n|ref>` };
          if (explicit.length === 0) {
            return { message: `${color.amber('Chain is empty')} — nothing to remove.` };
          }
          let idx = -1;
          const asNum = Number.parseInt(target, 10);
          if (String(asNum) === target && asNum >= 1 && asNum <= explicit.length) {
            idx = asNum - 1;
          } else {
            idx = explicit.indexOf(target);
          }
          if (idx < 0) {
            return {
              message: `${color.red('Not found')}: "${target}". Use ${color.dim('/fallback')} to see the chain.`,
            };
          }
          const [removed] = explicit.splice(idx, 1);
          const decrypted = await patchGlobalConfig(globalConfigPath, (cfg) => {
            cfg.fallbackModels = explicit;
          });
          opts.configStore.update({ fallbackModels: decrypted.fallbackModels as string[] });
          return { message: `${color.green('✓')} removed ${color.cyan(removed ?? target)}` };
        }

        if (sub === 'clear') {
          if (explicit.length === 0) {
            return { message: `${color.amber('Chain already empty.')}` };
          }
          const decrypted = await patchGlobalConfig(globalConfigPath, (cfg) => {
            cfg.fallbackModels = [];
          });
          opts.configStore.update({ fallbackModels: decrypted.fallbackModels as string[] });
          const auto = config.fallbackAuto !== false;
          return {
            message:
              `${color.green('✓')} explicit chain cleared.` +
              (auto ? color.dim(' Smart default is on — auto-derived chain still applies.') : ''),
          };
        }

        if (sub === 'auto') {
          const val = (parts[1] ?? '').toLowerCase();
          if (val !== 'on' && val !== 'off') {
            return { message: `${color.amber('Usage:')} /fallback auto on|off` };
          }
          const next = val === 'on';
          const decrypted = await patchGlobalConfig(globalConfigPath, (cfg) => {
            cfg.fallbackAuto = next;
          });
          opts.configStore.update({ fallbackAuto: decrypted.fallbackAuto as boolean });
          return {
            message: `${color.green('✓')} smart default ${next ? color.green('on') : color.dim('off')}`,
          };
        }

        return {
          message: `${color.red('Unknown subcommand')} "${sub}". Try ${color.dim('/fallback')}, ${color.dim('/fallback add <provider/model>')}, or ${color.dim('/fallback help')}.`,
        };
      } catch (err) {
        return {
          message: `${color.red('fallback error')}: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    },
  };
}
