import * as fs from 'node:fs/promises';
import {
  type CustomModelDefinition,
  type SecretVault,
  type SlashCommand,
  atomicWrite,
  color,
  decryptConfigSecrets,
  encryptConfigSecrets,
} from '@wrongstack/core';
import type { SlashCommandContext } from './index.js';

/** No-op vault: round-trips already-encrypted fields untouched. */
const noOpVault: SecretVault = {
  encrypt: (v) => v,
  decrypt: (v) => v,
  isEncrypted: () => false,
};

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
    if (fileExists) {
      throw new Error(`Config at ${globalConfigPath} is not valid JSON: ${(err as Error).message}`);
    }
    parsed = {};
  }
  const decrypted = decryptConfigSecrets(parsed, noOpVault) as Record<string, unknown>;
  mutate(decrypted);
  const encrypted = encryptConfigSecrets(decrypted, noOpVault);
  await atomicWrite(globalConfigPath, JSON.stringify(encrypted, null, 2), { mode: 0o600 });
  return decrypted;
}

function fmtModel(id: string, def: CustomModelDefinition): string {
  const parts: string[] = [];
  if (def.provider) parts.push(`${color.dim('provider:')} ${color.cyan(def.provider)}`);
  if (def.name) parts.push(`${color.dim('name:')} ${def.name}`);
  const caps = def.capabilities;
  if (caps) {
    if (caps.maxContext) parts.push(`${color.dim('maxContext:')} ${color.yellow(String(caps.maxContext))}`);
    const flags: string[] = [];
    if (caps.tools) flags.push('tools');
    if (caps.vision) flags.push('vision');
    if (caps.reasoning) flags.push('reasoning');
    if (caps.streaming) flags.push('streaming');
    if (caps.jsonMode) flags.push('json');
    if (flags.length) parts.push(`${color.dim('caps:')} ${flags.join(', ')}`);
  }
  if (def.maxOutput) parts.push(`${color.dim('maxOutput:')} ${color.yellow(String(def.maxOutput))}`);
  return `    ${color.amber(id)}  ${parts.join('  ')}`;
}

function safeAt(arr: string[], idx: number): string {
  const v = arr[idx];
  if (v === undefined) throw new Error(`Missing value at position ${idx}`);
  return v;
}

function parseFlags(tokens: string[]): {
  modelId: string;
  def?: Partial<CustomModelDefinition>;
  error?: string;
} {
  let modelId = '';
  const caps: Record<string, unknown> = {};
  let provider: string | undefined;
  let name: string | undefined;
  let maxOutput: number | undefined;

  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i] ?? '';
    if (t.startsWith('--')) {
      const key = t.slice(2);
      switch (key) {
        case 'provider':
          provider = safeAt(tokens, ++i);
          break;
        case 'name':
          name = safeAt(tokens, ++i);
          break;
        case 'max-context':
          caps.maxContext = Number(safeAt(tokens, ++i));
          break;
        case 'max-output':
          maxOutput = Number(safeAt(tokens, ++i));
          break;
        case 'tools':
          caps.tools = true;
          break;
        case 'vision':
          caps.vision = true;
          break;
        case 'streaming':
          caps.streaming = true;
          break;
        case 'reasoning':
          caps.reasoning = true;
          break;
        case 'json-mode':
          caps.jsonMode = true;
          break;
        default:
          return { modelId: '', error: `Unknown flag: --${key}` };
      }
    } else if (!t.startsWith('-') && !modelId) {
      modelId = t;
    }
    i++;
  }

  if (!modelId) return { modelId: '', error: 'missing model id' };

  const hasCaps = Object.keys(caps).length > 0;
  const def: Partial<CustomModelDefinition> = {};
  if (provider !== undefined) def.provider = provider;
  if (name !== undefined) def.name = name;
  if (maxOutput !== undefined) def.maxOutput = maxOutput;
  if (hasCaps) def.capabilities = caps as CustomModelDefinition['capabilities'];

  return { modelId, def: Object.keys(def).length ? def : undefined };
}

/**
 * `/models` — manage custom model definitions.
 *
 * Subcommands:
 *   /models                          List custom model definitions
 *   /models add <id> [flags]         Add or update a custom model
 *   /models remove <id>              Remove a custom model
 *
 * Flags for `add`:
 *   --provider <id>     Owning provider (optional)
 *   --name "Display"    Display name
 *   --max-context <N>   Override max context window
 *   --max-output <N>    Override max output tokens
 *   --tools             Mark model as tool-capable
 *   --vision            Mark model as vision-capable
 *   --reasoning         Mark model as reasoning-capable
 *   --streaming         Mark model as supporting streaming
 *   --json-mode         Mark model as supporting JSON mode
 */
export function buildModelsCommand(opts: SlashCommandContext): SlashCommand {
  const help = [
    'Usage:',
    '  /models                              List custom model definitions',
    '  /models add <id> [flags]             Add or update a custom model',
    '  /models remove <id>                  Remove a custom model',
    '',
    'Flags for add:',
    '  --provider <id>      Owning provider',
    '  --name "Display"     Display name',
    '  --max-context <N>    Context window override',
    '  --max-output <N>     Max output tokens',
    '  --tools              Tool-capable',
    '  --vision             Vision-capable',
    '  --streaming          Streaming support',
    '  --reasoning          Reasoning support',
    '  --json-mode          JSON mode support',
    '',
    'Persisted to ~/.wrongstack/config.json.',
  ].join('\n');

  return {
    name: 'models',
    category: 'Config',
    description: 'Manage custom model definitions.',
    help,
    async run(args) {
      const parts = args.trim().split(/\s+/).filter(Boolean);
      const sub = (parts[0] ?? '').toLowerCase();

      if (sub === 'help' || sub === '--help') return { message: help };
      if (!opts.configStore || !opts.paths) {
        return { message: `${color.red('Error')} config store not available.` };
      }

      const config = opts.configStore.get();
      const globalConfigPath = opts.paths.globalConfig;

      // ---- LIST ----
      if (!sub) {
        const models = (config.models ?? {}) as Record<string, CustomModelDefinition>;
        const ids = Object.keys(models);
        if (ids.length === 0) {
          return {
            message: [
              `${color.bold('Custom Models')} ${color.dim('(none defined)')}`,
              '',
              color.dim('  Add one: /models add <id> --max-context 128000 --tools'),
            ].join('\n'),
          };
        }
        return {
          message: [
            `${color.bold('Custom Models')} ${color.dim(`(${ids.length})`)}`,
            ...ids.sort().map((id) => fmtModel(id, models[id])),
          ].join('\n'),
        };
      }

      try {
        // ---- ADD ----
        if (sub === 'add') {
          const { modelId, def, error } = parseFlags(parts.slice(1));
          if (error) {
            return { message: `${color.red('Error')}: ${error}. ${color.dim('/models help')}` };
          }
          if (!def && !error) {
            return { message: `${color.amber('Usage:')} /models add <id> [--max-context N] [--tools] ... ${color.dim('/models help')}` };
          }

          const existingModels = (config.models ?? {}) as Record<string, CustomModelDefinition>;
          const existed = modelId in existingModels;
          const decrypted = await patchGlobalConfig(globalConfigPath, (cfg) => {
            const models = { ...((cfg.models as Record<string, CustomModelDefinition>) ?? {}) };
            models[modelId] = {
              ...models[modelId],
              ...def,
              capabilities: {
                ...models[modelId]?.capabilities,
                ...def?.capabilities,
              },
            } as CustomModelDefinition;
            cfg.models = models;
          });
          opts.configStore.update({
            models: decrypted.models as Record<string, CustomModelDefinition>,
          });
          return { message: `${color.green('✓')} ${color.amber(modelId)} ${existed ? 'updated' : 'added'}.` };
        }

        // ---- REMOVE ----
        if (sub === 'remove' || sub === 'rm') {
          const modelId = parts[1];
          if (!modelId) {
            return { message: `${color.amber('Usage:')} /models remove <id>` };
          }
          const existing = (config.models ?? {}) as Record<string, CustomModelDefinition>;
          if (!(modelId in existing)) {
            return { message: `${color.amber('Not found')}: custom model "${modelId}" is not defined.` };
          }
          const decrypted = await patchGlobalConfig(globalConfigPath, (cfg) => {
            const models = { ...((cfg.models as Record<string, CustomModelDefinition>) ?? {}) };
            delete models[modelId];
            cfg.models = models;
          });
          opts.configStore.update({
            models: decrypted.models as Record<string, CustomModelDefinition>,
          });
          return { message: `${color.green('✓')} removed ${color.amber(modelId)}` };
        }

        return {
          message: `${color.red('Unknown subcommand')} "${sub}". Try ${color.dim('/models')}, ${color.dim('/models add')}, or ${color.dim('/models help')}.`,
        };
      } catch (err) {
        return {
          message: `${color.red('models error')}: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    },
  };
}
