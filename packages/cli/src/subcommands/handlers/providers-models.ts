import * as fs from 'node:fs/promises';
import {
  type Capabilities,
  type CustomModelDefinition,
  type WireFamily,
  atomicWrite,
  color,
  decryptConfigSecrets,
  encryptConfigSecrets,
} from '@wrongstack/core';
import type { SubcommandHandler } from '../index.js';

export const providersCmd: SubcommandHandler = async (args, deps) => {
  const showAll = args.includes('--all');
  const showUnsupported = args.includes('--unsupported');
  try {
    const all = await deps.modelsRegistry.listProviders();
    const byFamily: Record<WireFamily, typeof all> = {
      anthropic: [],
      openai: [],
      'openai-compatible': [],
      google: [],
      unsupported: [],
    };
    for (const p of all) byFamily[p.family].push(p);
    const families: WireFamily[] = showUnsupported
      ? ['unsupported']
      : showAll
        ? ['anthropic', 'openai', 'google', 'openai-compatible', 'unsupported']
        : ['anthropic', 'openai', 'google', 'openai-compatible'];
    for (const family of families) {
      const list = byFamily[family];
      if (list.length === 0) continue;
      deps.renderer.write(`\n${color.bold(family)} (${list.length}):\n`);
      for (const p of list) {
        const envFound = p.envVars.some((v) => process.env[v]);
        const marker = envFound ? color.green('●') : color.dim('○');
        const envHint = p.envVars[0] ? color.dim(`[${p.envVars[0]}]`) : '';
        const note = family === 'unsupported' ? color.dim('(needs plugin)') : '';
        deps.renderer.write(
          `  ${marker} ${p.id.padEnd(20)} ${p.name.padEnd(28)} ${envHint} ${note}\n`,
        );
      }
    }
    deps.renderer.write(
      `\n${color.dim(`Current: ${deps.config.provider ?? '<unset>'} / ${deps.config.model ?? '<unset>'}. Use --all to include unsupported families.`)}\n`,
    );
    return 0;
  } catch (err) {
    deps.renderer.writeError(
      `Failed to list providers: ${err instanceof Error ? err.message : err}`,
    );
    return 1;
  }
};

/** Parse `--key value` flags from a flat args array. */
function parseFlags(args: string[]): Record<string, string | boolean> {
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq !== -1) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        const name = a.slice(2);
        if (i + 1 < args.length && !args[i + 1]!.startsWith('--')) {
          flags[name] = args[++i] ?? '';
        } else {
          flags[name] = true;
        }
      }
    }
  }
  return flags;
}

/** Filter out flag args and return only positional (non-flag) args. */
function positionals(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq === -1) {
        // If the next arg is a value (not a flag), skip it
        if (i + 1 < args.length && !args[i + 1]!.startsWith('--')) {
          i++;
        }
      }
      continue;
    }
    out.push(a);
  }
  return out;
}

const DEFAULT_PER_PAGE = 15;

export const modelsCmd: SubcommandHandler = async (args, deps) => {
  const sub = args[0];

  // ---- custom model commands ----
  if (sub === 'add') return modelsAdd(args.slice(1), deps);
  if (sub === 'remove') return modelsRemove(args.slice(1), deps);
  if (sub === 'list') return modelsList(args.slice(1), deps);

  if (sub === 'refresh') {
    deps.renderer.writeInfo('Refreshing models.dev cache…');
    try {
      const payload = await deps.modelsRegistry.refresh();
      deps.renderer.writeInfo(
        `Cached ${Object.keys(payload).length} providers to ${deps.paths.modelsCache}`,
      );
      return 0;
    } catch (err) {
      deps.renderer.writeError(`Refresh failed: ${err instanceof Error ? err.message : err}`);
      return 1;
    }
  }

  const flags = parseFlags(args);
  const search = typeof flags['search'] === 'string' ? flags['search'].toLowerCase() : '';
  const perPage =
    Number(flags['per-page']) > 0 ? Number(flags['per-page']) : DEFAULT_PER_PAGE;
  const page = Math.max(1, Number(flags['page']) || 1);

  // Use first positional arg as provider if given, else fall back to configured default.
  // Flags (--search, --page) filter/paginate the list — they don't change the provider.
  const providerId = sub ?? deps.config.provider ?? '';
  if (!providerId) {
    deps.renderer.writeError('Usage: wstack models <provider> [--search <term>] [--page N] [--per-page N]');
    return 1;
  }

  let lookupId = providerId;
  const savedAlias = deps.config.providers?.[providerId];
  if (savedAlias?.type && savedAlias.type !== providerId) lookupId = savedAlias.type;
  const provider = await deps.modelsRegistry.getProvider(lookupId);
  if (!provider) {
    deps.renderer.writeError(
      lookupId !== providerId
        ? `Alias "${providerId}" points at catalog id "${lookupId}" which is not in the cache.`
        : `Provider "${providerId}" not in catalog.`,
    );
    return 1;
  }
  if (lookupId !== providerId)
    deps.renderer.write(
      color.dim(`(showing catalog models for "${lookupId}" via alias "${providerId}")\n`),
    );
  deps.renderer.write(`${color.bold(provider.name)} ${color.dim(`(${provider.id})`)}\n`);
  if (provider.doc) deps.renderer.write(color.dim(`Docs: ${provider.doc}\n`));

  const userModels = deps.config.providers?.[providerId]?.models;
  const catalogById = new Map(provider.models.map((m) => [m.id, m]));
  const allSorted =
    userModels && userModels.length > 0
      ? userModels.map((id) => catalogById.get(id) ?? { id, name: id })
      : [...provider.models].sort((a, b) =>
          (b.release_date ?? '').localeCompare(a.release_date ?? ''),
        );

  if (userModels && userModels.length > 0)
    deps.renderer.write(color.dim(`(${userModels.length} model(s) from your saved config)\n`));

  const filtered = search
    ? allSorted.filter((m) => m.id.toLowerCase().includes(search))
    : allSorted;

  const total = filtered.length;
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  const actualPage = Math.min(page, totalPages);
  const start = (actualPage - 1) * perPage;
  const pageItems = filtered.slice(start, start + perPage);
  const end = Math.min(start + pageItems.length, total);

  // Header
  const pageHint =
    totalPages > 1
      ? color.cyan(`[page ${actualPage}/${totalPages}]`)
      : '';
  const searchHint = search
    ? color.yellow(` (filtered: "${search}" — ${total} match${total === 1 ? '' : 'es'})`)
    : color.dim(` (${total} model${total === 1 ? '' : 's'})`);
  deps.renderer.write(`${pageHint}${searchHint}\n`);

  if (pageItems.length === 0) {
    deps.renderer.write(color.dim('(no models match)\n'));
  } else {
    if (start > 0)
      deps.renderer.write(color.dim(`  ${String.fromCharCode(8593)} ${start} above\n`));
    for (const m of pageItems) {
      const caps: string[] = [];
      if ('tool_call' in m && m.tool_call) caps.push('tools');
      if ('reasoning' in m && m.reasoning) caps.push('reasoning');
      if ('modalities' in m && m.modalities?.input?.includes('image')) caps.push('vision');
      const ctx = 'limit' in m && m.limit?.context ? `${(m.limit.context / 1000).toFixed(0)}k` : '?';
      const cost =
        'cost' in m && m.cost?.input !== undefined ? `${m.cost.input}/${m.cost.output ?? '?'}` : '';
      deps.renderer.write(
        `  ${m.id.padEnd(40)} ${color.dim(ctx.padStart(6))}  ${color.dim(cost.padEnd(14))} ${color.dim(caps.join(','))}\n`,
      );
    }
    if (end < total)
      deps.renderer.write(color.dim(`  ${String.fromCharCode(8595)} ${total - end} below\n`));
  }

  // Navigation footer
  const navLines: string[] = [];
  if (totalPages > 1) {
    if (actualPage > 1) navLines.push(`--page ${actualPage - 1} (prev)`);
    if (actualPage < totalPages) navLines.push(`--page ${actualPage + 1} (next)`);
  }
  navLines.push('--search <term> (filter)');
  deps.renderer.write(color.dim(`\n${navLines.join(' · ')}\n`));

  const age = await deps.modelsRegistry.ageSeconds();
  deps.renderer.write(
    color.dim(
      `Cache age: ${isFinite(age) ? `${Math.round(age / 60)}m` : 'never fetched'}. Run \`wstack models refresh\` to update.\n`,
    ),
  );
  return 0;
};

/* ------------------------------------------------------------------ */
/*  Custom model management (top-level Config.models)                  */
/* ------------------------------------------------------------------ */

/**
 * Load → mutate → encrypt → atomic-write for the `models` section.
 */
async function mutateModelsConfig(
  deps: Parameters<SubcommandHandler>[1],
  mutator: (models: Record<string, CustomModelDefinition>) => void,
): Promise<void> {
  const vault = deps.vault;
  const configPath = deps.paths.globalConfig;
  let fileExists = true;
  let raw: string;
  try {
    raw = await fs.readFile(configPath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    fileExists = false;
    raw = '{}';
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch (err) {
    if (fileExists) {
      throw new Error(
        `Refusing to overwrite corrupt config at ${configPath} (${(err as Error).message}).`,
      );
    }
    parsed = {};
  }
  const decrypted = decryptConfigSecrets(parsed, vault) as Record<string, unknown>;
  const models = (decrypted.models as Record<string, CustomModelDefinition>) ?? {};
  mutator(models);
  decrypted.models = models;
  const encrypted = encryptConfigSecrets(decrypted, vault);
  await atomicWrite(configPath, JSON.stringify(encrypted, null, 2), { mode: 0o600 });
}

/** Parse a human-readable size like "128k", "1M", "200000" into a number. */
function parseSizeFlag(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const s = raw.trim().toLowerCase();
  const match = /^(\d+(?:\.\d+)?)\s*(k|m|b)?$/.exec(s);
  if (!match) return undefined;
  const num = Number.parseFloat(match[1]!);
  const unit = match[2];
  if (unit === 'b') return Math.round(num * 1_000_000_000);
  if (unit === 'm') return Math.round(num * 1_000_000);
  if (unit === 'k') return Math.round(num * 1000);
  return Math.round(num);
}

/** Parse a boolean flag like "--tools" / "--no-tools". */
function parseBoolFlag(
  flags: Record<string, string | boolean>,
  key: string,
): boolean | undefined {
  if (flags[key] === true || flags[key] === 'true') return true;
  if (flags[`no-${key}`] !== undefined) return false;
  return undefined;
}

async function modelsAdd(
  args: string[],
  deps: Parameters<SubcommandHandler>[1],
): Promise<number> {
  const flags = parseFlags(args);
  const pos = positionals(args);
  const modelId = pos[0];

  if (!modelId) {
    deps.renderer.writeError(
      'Usage: wstack models add <modelId> [--provider <id>] [--name <name>] ' +
        '[--max-context <N>] [--max-output <N>] [--tools] [--no-tools] ' +
        '[--vision] [--no-vision] [--reasoning] [--streaming] [--no-streaming] [--json-mode]',
    );
    return 1;
  }

  const existing = deps.config.models?.[modelId];
  if (existing) {
    deps.renderer.writeWarning(
      `Model "${modelId}" already defined. Overwriting.`,
    );
  }

  const capabilities: Partial<Capabilities> = {};
  const toolsVal = parseBoolFlag(flags, 'tools');
  if (toolsVal !== undefined) capabilities.tools = toolsVal;
  const visionVal = parseBoolFlag(flags, 'vision');
  if (visionVal !== undefined) capabilities.vision = visionVal;
  const streamingVal = parseBoolFlag(flags, 'streaming');
  if (streamingVal !== undefined) capabilities.streaming = streamingVal;
  const reasoningVal = parseBoolFlag(flags, 'reasoning');
  if (reasoningVal !== undefined) capabilities.reasoning = reasoningVal;
  const jsonModeVal = parseBoolFlag(flags, 'json-mode');
  if (jsonModeVal !== undefined) capabilities.jsonMode = jsonModeVal;

  const maxContextRaw = typeof flags['max-context'] === 'string' ? flags['max-context'] : undefined;
  const maxContext = parseSizeFlag(maxContextRaw);
  if (maxContext !== undefined) capabilities.maxContext = maxContext;

  const def: CustomModelDefinition = {};
  const nameFlag = typeof flags['name'] === 'string' ? flags['name'] : undefined;
  const providerFlag = typeof flags['provider'] === 'string' ? flags['provider'] : undefined;
  if (nameFlag) def.name = nameFlag;
  if (providerFlag) def.provider = providerFlag;
  if (Object.keys(capabilities).length > 0) def.capabilities = capabilities;

  const maxOutputRaw = typeof flags['max-output'] === 'string' ? flags['max-output'] : undefined;
  const maxOutput = parseSizeFlag(maxOutputRaw);
  if (maxOutput !== undefined) def.maxOutput = maxOutput;

  await mutateModelsConfig(deps, (models) => {
    models[modelId] = def;
  });

  deps.renderer.writeInfo(`Custom model "${modelId}" ${existing ? 'updated' : 'added'}.`);
  const capLines: string[] = [];
  if (def.capabilities) {
    for (const [k, v] of Object.entries(def.capabilities)) {
      capLines.push(`  ${k}: ${v}`);
    }
  }
  if (def.maxOutput !== undefined) capLines.push(`  maxOutput: ${def.maxOutput}`);
  if (capLines.length > 0) {
    deps.renderer.write(color.dim(capLines.join('\n') + '\n'));
  }
  return 0;
}

async function modelsRemove(
  args: string[],
  deps: Parameters<SubcommandHandler>[1],
): Promise<number> {
  const modelId = args[0];
  if (!modelId) {
    deps.renderer.writeError('Usage: wstack models remove <modelId>');
    return 1;
  }

  const existing = deps.config.models?.[modelId];
  if (!existing) {
    deps.renderer.writeError(`No custom model "${modelId}" found.`);
    return 1;
  }

  await mutateModelsConfig(deps, (models) => {
    delete models[modelId];
  });

  deps.renderer.writeInfo(`Removed custom model "${modelId}".`);
  return 0;
}

async function modelsList(
  _args: string[],
  deps: Parameters<SubcommandHandler>[1],
): Promise<number> {
  const models = deps.config.models ?? {};
  const entries = Object.entries(models);

  if (entries.length === 0) {
    deps.renderer.write(color.dim('No custom models defined.\n'));
    deps.renderer.write(color.dim('Use `wstack models add <modelId> --max-context 128k --tools`\n'));
    return 0;
  }

  deps.renderer.write(color.bold('Custom models\n'));
  for (const [id, def] of entries.sort(([a], [b]) => a.localeCompare(b))) {
    const label = def.name ?? id;
    const provider = def.provider ? ` ${color.dim(`(${def.provider})`)}` : '';
    deps.renderer.write(`  ${color.bold(label)}${provider}\n`);
    if (def.capabilities) {
      for (const [k, v] of Object.entries(def.capabilities)) {
        deps.renderer.write(`    ${color.dim(`${k}:`)} ${v}\n`);
      }
    }
    if (def.maxOutput !== undefined) {
      deps.renderer.write(`    ${color.dim('maxOutput:')} ${def.maxOutput}\n`);
    }
  }
  return 0;
}
