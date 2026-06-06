import * as fs from 'node:fs/promises';
import {
  AGENT_CATALOG,
  MATRIX_PHASE_KEYS,
  type ModelMatrixEntry,
  type ProviderConfig,
  type SecretVault,
  type SlashCommand,
  atomicWrite,
  color,
  decryptConfigSecrets,
  encryptConfigSecrets,
  matrixKeyKind,
} from '@wrongstack/core';
import type { SlashCommandContext } from './index.js';

/** No-op vault: round-trips already-encrypted fields untouched. We never
 *  read or write secrets here (the matrix holds none), so we must NOT
 *  decrypt/re-encrypt the providers block — that would mangle stored keys. */
const noOpVault: SecretVault = {
  encrypt: (v) => v,
  decrypt: (v) => v,
  isEncrypted: () => false,
};

/** A provider is selectable when it has a stored key, a key list, or a
 *  populated env var. Mirrors `hasApiKey` but config-only (no registry). */
function providerHasKey(entry: ProviderConfig | undefined): boolean {
  if (!entry) return false;
  if (typeof entry.apiKey === 'string' && entry.apiKey.length > 0) return true;
  if (Array.isArray(entry.apiKeys) && entry.apiKeys.some((k) => k?.apiKey)) return true;
  if (Array.isArray(entry.envVars) && entry.envVars.some((v) => !!process.env[v])) return true;
  return false;
}

/** Provider ids the user can target — those with a key, plus the active one. */
function keyedProviderIds(config: {
  provider: string;
  providers?: Record<string, ProviderConfig>;
}): string[] {
  const ids = new Set<string>();
  if (config.provider) ids.add(config.provider);
  for (const [id, entry] of Object.entries(config.providers ?? {})) {
    if (providerHasKey(entry)) ids.add(id);
  }
  return [...ids].sort();
}

/**
 * Parse `<provider>/<model>`, `<provider> <model>`, or a bare `<model>`
 * (provider omitted → leader provider at resolve time) into a matrix entry.
 */
function parseTarget(tokens: string[]): ModelMatrixEntry | { error: string } {
  if (tokens.length >= 2) {
    return { provider: tokens[0], model: tokens.slice(1).join(' ') };
  }
  const only = tokens[0];
  if (!only) return { error: 'missing <provider>/<model>' };
  if (only.includes('/')) {
    const i = only.indexOf('/');
    return { provider: only.slice(0, i), model: only.slice(i + 1) };
  }
  return { model: only };
}

function fmtEntry(e: ModelMatrixEntry): string {
  return e.provider ? `${e.provider}/${e.model}` : `${e.model} ${color.dim('(leader provider)')}`;
}

/**
 * Read the global config, apply `mutate`, write it back atomically, and
 * mirror the change into the in-memory config store. Pure I/O — safe under
 * both the plain REPL and the Ink TUI.
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
 * `/setmodel` — view or change the active leader model and the per-task
 * model matrix. Argument-driven (never blocks on readline) so it behaves
 * identically in the REPL and the TUI. Persists to ~/.wrongstack/config.json.
 */
export function buildSetModelCommand(opts: SlashCommandContext): SlashCommand {
  const help = [
    'Usage:',
    '  /setmodel                              Show leader model + the task→model matrix',
    '  /setmodel list                         List keyed providers, their models, and valid keys',
    '  /setmodel leader <provider> <model>    Set the main (leader) model',
    '  /setmodel set <key> <provider>/<model> Pin a role/phase/* to a model',
    '  /setmodel set <key> <model>            Pin to a model on the leader provider',
    '  /setmodel clear <key>                  Remove a matrix entry',
    '',
    'Keys: a catalog role (e.g. security-scanner), a phase (' + MATRIX_PHASE_KEYS.join(', ') + '),',
    'or * for the fleet-wide default. Precedence at spawn: role → phase → * → leader.',
    '',
    'Persisted to ~/.wrongstack/config.json.',
  ].join('\n');

  function currentView(): string {
    const config = opts.configStore.get();
    const matrix = (config.modelMatrix ?? {}) as Record<string, ModelMatrixEntry>;
    const keys = Object.keys(matrix);
    const lines = [
      `${color.bold('WrongStack')} ${color.dim('— Models')}`,
      '',
      `  leader: ${color.cyan(`${config.provider}/${config.model}`)}   ${color.dim('change: /setmodel leader <provider> <model>')}`,
      '',
      `  ${color.bold('task → model matrix')} ${color.dim('(role → phase → * → leader)')}`,
    ];
    if (keys.length === 0) {
      lines.push(
        `    ${color.dim('(empty)  set one: /setmodel set <role|phase|*> <provider>/<model>')}`,
      );
    } else {
      for (const k of keys.sort()) {
        const kind = matrixKeyKind(k);
        const tag = kind === 'unknown' ? color.red('?') : color.dim(kind);
        lines.push(`    ${color.amber(k.padEnd(22))} → ${fmtEntry(matrix[k]!)}   ${tag}`);
      }
    }
    lines.push('', color.dim('  /setmodel list for valid keys · /setmodel help for usage'));
    return lines.join('\n');
  }

  return {
    name: 'setmodel',
    category: 'Config',
    description: 'View or change the leader model and the per-task model matrix.',
    help,
    async run(args) {
      const parts = args.trim().split(/\s+/).filter(Boolean);
      const sub = (parts[0] ?? '').toLowerCase();

      if (sub === 'help' || sub === '--help') return { message: this.help ?? '' };
      if (!opts.configStore || !opts.paths) {
        return { message: `${color.red('Error')} config store not available.` };
      }
      if (!sub) return { message: currentView() };

      const config = opts.configStore.get();
      const keyed = keyedProviderIds(config);
      const globalConfigPath = opts.paths.globalConfig;

      if (sub === 'list') {
        const provLines = keyed.map((id) => {
          const models = config.providers?.[id]?.models ?? [];
          const ms = models.length ? models.join(', ') : color.dim('(any model id accepted)');
          return `    ${color.cyan(id.padEnd(16))} ${ms}`;
        });
        const roles = Object.keys(AGENT_CATALOG).sort();
        return {
          message: [
            `${color.bold('Keyed providers')} ${color.dim('(targets for /setmodel)')}`,
            ...(provLines.length ? provLines : [`    ${color.dim('none — add a key first')}`]),
            '',
            `${color.bold('Phases')}: ${MATRIX_PHASE_KEYS.join(', ')}`,
            `${color.bold('Default')}: *`,
            '',
            `${color.bold('Roles')} ${color.dim(`(${roles.length})`)}:`,
            `    ${roles.join(', ')}`,
          ].join('\n'),
        };
      }

      try {
        if (sub === 'leader') {
          const provider = parts[1];
          const model = parts.slice(2).join(' ');
          if (!provider || !model) {
            return { message: `${color.amber('Usage:')} /setmodel leader <provider> <model>` };
          }
          if (!keyed.includes(provider)) {
            return {
              message: `${color.red('Provider not available')}: "${provider}". Keyed: ${keyed.join(', ') || '(none)'}. ${color.dim('/setmodel list')}`,
            };
          }
          const decrypted = await patchGlobalConfig(globalConfigPath, (cfg) => {
            cfg.provider = provider;
            cfg.model = model;
          });
          opts.configStore.update({
            provider: decrypted.provider as string,
            model: decrypted.model as string,
          });
          return { message: `${color.green('✓')} leader → ${color.cyan(`${provider}/${model}`)}` };
        }

        if (sub === 'set') {
          const key = parts[1];
          if (!key) {
            return {
              message: `${color.amber('Usage:')} /setmodel set <role|phase|*> <provider>/<model>`,
            };
          }
          if (matrixKeyKind(key) === 'unknown') {
            return {
              message: `${color.red('Unknown key')}: "${key}". Use * , a phase (${MATRIX_PHASE_KEYS.join(', ')}), or a role. ${color.dim('/setmodel list')}`,
            };
          }
          const parsed = parseTarget(parts.slice(2));
          if ('error' in parsed) {
            return { message: `${color.amber('Usage:')} /setmodel set ${key} <provider>/<model>` };
          }
          if (parsed.provider && !keyed.includes(parsed.provider)) {
            return {
              message: `${color.red('Provider not available')}: "${parsed.provider}". Keyed: ${keyed.join(', ') || '(none)'}.`,
            };
          }
          const decrypted = await patchGlobalConfig(globalConfigPath, (cfg) => {
            const matrix = { ...((cfg.modelMatrix as Record<string, ModelMatrixEntry>) ?? {}) };
            matrix[key] = parsed.provider
              ? { provider: parsed.provider, model: parsed.model }
              : { model: parsed.model };
            cfg.modelMatrix = matrix;
          });
          opts.configStore.update({
            modelMatrix: decrypted.modelMatrix as Record<string, ModelMatrixEntry>,
          });
          return { message: `${color.green('✓')} ${color.amber(key)} → ${fmtEntry(parsed)}` };
        }

        if (sub === 'clear') {
          const key = parts[1];
          if (!key) return { message: `${color.amber('Usage:')} /setmodel clear <key>` };
          const existing = (config.modelMatrix ?? {}) as Record<string, ModelMatrixEntry>;
          if (!(key in existing)) {
            return { message: `${color.amber('No matrix entry')} for "${key}".` };
          }
          const decrypted = await patchGlobalConfig(globalConfigPath, (cfg) => {
            const matrix = { ...((cfg.modelMatrix as Record<string, ModelMatrixEntry>) ?? {}) };
            delete matrix[key];
            cfg.modelMatrix = matrix;
          });
          opts.configStore.update({
            modelMatrix: decrypted.modelMatrix as Record<string, ModelMatrixEntry>,
          });
          return { message: `${color.green('✓')} cleared ${color.amber(key)}` };
        }

        return {
          message: `${color.red('Unknown subcommand')} "${sub}". Try ${color.dim('/setmodel')}, ${color.dim('/setmodel set <key> <provider>/<model>')}, or ${color.dim('/setmodel help')}.`,
        };
      } catch (err) {
        return {
          message: `${color.red('setmodel error')}: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    },
  };
}
