import type { Config, ModelsRegistry, ResolvedProvider } from '@wrongstack/core';
import { color } from '@wrongstack/core';
import type { TerminalRenderer } from './renderer.js';
import type { ReadlineInputReader } from './input-reader.js';

export interface PickerResult {
  provider: string;
  model: string;
}

/**
 * Does this provider have an API key available — either in the
 * environment (via one of its known env vars) or stored in config
 * (encrypted or plaintext)? Used to filter the picker to providers
 * the user can actually use right now.
 */
function hasApiKey(provider: ResolvedProvider, config?: Config): boolean {
  if (provider.envVars.some((v) => !!process.env[v])) return true;
  const stored = config?.providers?.[provider.id]?.apiKey;
  if (typeof stored === 'string' && stored.length > 0) return true;
  return false;
}

/**
 * Interactive provider + model picker. Lists supported providers grouped
 * by wire family — by default only those with an API key (env or stored
 * config), so you see only what you can actually launch into. Falls back
 * to the full catalog when no keys are found anywhere.
 *
 * When `defaultProvider`/`defaultModel` are passed, they're pre-selected
 * so the user can press Enter to accept the previous choice.
 */
export async function runPicker(deps: {
  modelsRegistry: ModelsRegistry;
  renderer: TerminalRenderer;
  reader: ReadlineInputReader;
  config?: Config;
  defaultProvider?: string;
  defaultModel?: string;
}): Promise<PickerResult | undefined> {
  const { modelsRegistry, renderer, reader, config, defaultProvider, defaultModel } = deps;

  renderer.write(`\n${color.bold(theme.primary('WrongStack') + color.dim(' — Provider & Model Selection'))}\n`);
  renderer.write(color.dim('Loading provider catalog…\n'));

  let providers: ResolvedProvider[];
  try {
    providers = await modelsRegistry.listProviders();
  } catch {
    renderer.writeError('Failed to load provider catalog. Pass --provider and --model to skip the picker.');
    return undefined;
  }

  // Drop unsupported wire families — they need a plugin and can't be
  // selected through this path.
  const supported = providers.filter((p) => p.family !== 'unsupported');
  if (supported.length === 0) {
    renderer.writeError('No supported providers found in catalog.');
    return undefined;
  }

  // Filter to keyed providers. If none are keyed (fresh install, no env
  // vars set), fall back to the full list and prompt the user to add a
  // key — picking a keyless provider here is still useful because the
  // very next step (`wstack auth <prov>`) needs to know which provider.
  const keyed = supported.filter((p) => hasApiKey(p, config));
  let displayList = keyed;
  let showingFallback = false;
  if (keyed.length === 0) {
    displayList = supported;
    showingFallback = true;
  }

  // Group by family for nicer display
  const families = new Map<string, ResolvedProvider[]>();
  for (const p of displayList) {
    const list = families.get(p.family) ?? [];
    list.push(p);
    families.set(p.family, list);
  }

  // Build a flat numbered list (family → providers). Track which entry
  // matches the current default so we can highlight + accept Enter.
  const ordered: Array<{ provider: ResolvedProvider; index: number }> = [];
  const familyOrder = ['anthropic', 'openai', 'google', 'openai-compatible'];
  let idx = 1;
  let defaultIdx: number | undefined;
  renderer.write('\n');
  for (const fam of familyOrder) {
    const list = families.get(fam);
    if (!list || list.length === 0) continue;
    renderer.write(`  ${color.bold(fam)}\n`);
    for (const p of list) {
      const envFound = p.envVars.some((v) => !!process.env[v]);
      const configKey =
        typeof config?.providers?.[p.id]?.apiKey === 'string' &&
        (config!.providers![p.id]!.apiKey as string).length > 0;
      // ● green = env key, ◉ cyan = stored in config, ○ dim = no key
      const marker = envFound
        ? color.green('●')
        : configKey
          ? color.cyan('◉')
          : color.dim('○');
      const isDefault = p.id === defaultProvider;
      if (isDefault) defaultIdx = idx;
      const idLabel = isDefault ? color.bold(p.id) : p.id;
      const suffix = isDefault ? color.dim(' (default)') : '';
      renderer.write(
        `  ${color.dim(`${idx}.`.padStart(4))} ${marker} ${idLabel.padEnd(22)} ${color.dim(p.name)}${suffix}\n`,
      );
      ordered.push({ provider: p, index: idx });
      idx++;
    }
  }

  if (showingFallback) {
    renderer.write(
      `\n  ${color.yellow('⚠ No API keys detected.')} ${color.dim('Pick a provider, then run `wstack auth <provider>` to add one.')}\n`,
    );
  } else {
    renderer.write(
      `\n  ${color.dim('● = env key   ◉ = stored in config   ○ = no key')}\n`,
    );
  }

  // Provider prompt. Enter on an empty line accepts the default when one
  // is present; otherwise we treat it as cancel.
  const defaultHint =
    defaultIdx !== undefined && defaultProvider
      ? ` ${color.dim(`[Enter = ${defaultProvider}]`)}`
      : '';
  const providerAnswer = (
    await reader.readLine(`\n${color.amber('?')} Select provider (1-${ordered.length})${defaultHint}: `)
  ).trim();

  if (!providerAnswer) {
    if (defaultIdx !== undefined) {
      const def = ordered[defaultIdx - 1];
      if (def) return pickModel(def.provider, modelsRegistry, renderer, reader, defaultModel);
    }
    renderer.write(color.dim('Cancelled.\n'));
    return undefined;
  }

  const providerIdx = parseInt(providerAnswer, 10);
  if (Number.isNaN(providerIdx) || providerIdx < 1 || providerIdx > ordered.length) {
    // Try matching by id
    const byId = ordered.find((o) => o.provider.id.toLowerCase() === providerAnswer.toLowerCase());
    if (!byId) {
      renderer.writeError(`Invalid selection: "${providerAnswer}"`);
      return undefined;
    }
    return pickModel(byId.provider, modelsRegistry, renderer, reader, defaultModel);
  }

  const chosen = ordered[providerIdx - 1];
  if (!chosen) return undefined;
  // Only honor the default-model hint when the user picked the default
  // provider; switching providers invalidates it.
  const modelHint = chosen.provider.id === defaultProvider ? defaultModel : undefined;
  return pickModel(chosen.provider, modelsRegistry, renderer, reader, modelHint);
}

async function pickModel(
  provider: ResolvedProvider,
  registry: ModelsRegistry,
  renderer: TerminalRenderer,
  reader: ReadlineInputReader,
  defaultModel?: string,
): Promise<PickerResult | undefined> {
  renderer.write(`\n  ${color.bold(provider.name)} ${color.dim(`(${provider.id})`)} models:\n\n`);

  const models = [...provider.models].sort((a, b) =>
    (b.release_date ?? '').localeCompare(a.release_date ?? ''),
  );

  if (models.length === 0) {
    renderer.writeError('  No models listed for this provider in the catalog.');
    return undefined;
  }

  // Find default-model index for the "Enter = default" hint.
  const defaultIdxInModels =
    defaultModel !== undefined ? models.findIndex((m) => m.id === defaultModel) : -1;

  // Show paginated — up to 30 at a time
  const pageSize = 30;
  let offset = 0;

  while (offset < models.length) {
    const page = models.slice(offset, offset + pageSize);
    for (let i = 0; i < page.length; i++) {
      const m = page[i]!;
      const num = offset + i + 1;
      const ctx = m.limit?.context ? `${(m.limit.context / 1000).toFixed(0)}k`.padStart(6) : '     ?';
      const cost =
        m.cost?.input !== undefined
          ? `$${m.cost.input}/$${m.cost.output ?? '?'}`
          : '';
      const caps: string[] = [];
      if (m.tool_call) caps.push('tools');
      if (m.reasoning) caps.push('reason');
      if (m.modalities?.input?.includes('image')) caps.push('vision');
      const capStr = caps.length > 0 ? color.dim(caps.join(',')) : '';
      const isDefault = m.id === defaultModel;
      const idLabel = isDefault ? color.bold(m.id) : m.id;
      const suffix = isDefault ? color.dim(' (default)') : '';
      renderer.write(
        `  ${color.dim(`${num}.`.padStart(5))} ${idLabel.padEnd(44)} ${color.dim(ctx)}  ${color.dim(cost.padEnd(14))} ${capStr}${suffix}\n`,
      );
    }
    offset += pageSize;

    if (offset < models.length) {
      const more = (
        await reader.readLine(
          `\n${color.amber('?')} Showing ${Math.min(offset, models.length)}/${models.length} — Enter number or ${color.dim('Enter')} for more: `,
        )
      ).trim();
      if (!more) continue; // show next page
      return resolveModelSelection(more, models, provider, registry, renderer, reader);
    }
  }

  // All shown — final prompt. Enter accepts the default model when present.
  const defaultHint =
    defaultIdxInModels >= 0 && defaultModel
      ? ` ${color.dim(`[Enter = ${defaultModel}]`)}`
      : '';
  const answer = (
    await reader.readLine(`\n${color.amber('?')} Select model (1-${models.length})${defaultHint}: `)
  ).trim();
  if (!answer) {
    if (defaultIdxInModels >= 0 && defaultModel) {
      renderer.write(
        `\n  ${color.green('✓')} ${color.bold(provider.id)} / ${color.bold(defaultModel)}\n\n`,
      );
      return { provider: provider.id, model: defaultModel };
    }
    renderer.write(color.dim('Cancelled.\n'));
    return undefined;
  }
  return resolveModelSelection(answer, models, provider, registry, renderer, reader);
}

async function resolveModelSelection(
  answer: string,
  models: import('@wrongstack/core').ModelsDevModel[],
  provider: ResolvedProvider,
  _registry: ModelsRegistry,
  renderer: TerminalRenderer,
  _reader: ReadlineInputReader,
): Promise<PickerResult | undefined> {
  const idx = parseInt(answer, 10);
  let modelId: string | undefined;

  if (!Number.isNaN(idx) && idx >= 1 && idx <= models.length) {
    modelId = models[idx - 1]!.id;
  } else {
    // Try fuzzy matching by id
    const lower = answer.toLowerCase();
    const match = models.find((m) => m.id.toLowerCase() === lower);
    if (match) {
      modelId = match.id;
    } else {
      // Partial match
      const partial = models.filter((m) => m.id.toLowerCase().includes(lower));
      if (partial.length === 1) {
        modelId = partial[0]!.id;
      } else if (partial.length > 1) {
        renderer.writeError(`"${answer}" matches multiple models. Be more specific.`);
        return undefined;
      }
    }
  }

  if (!modelId) {
    // Use as-is (user might know the exact model string)
    modelId = answer;
  }

  renderer.write(
    `\n  ${color.green('✓')} ${color.bold(provider.id)} / ${color.bold(modelId)}\n\n`,
  );

  return { provider: provider.id, model: modelId };
}

// --- Helpers ---

// Simple theme alias (avoids importing the full theme module just for one color)
const theme = { primary: color.amber };

/**
 * Save provider + model to the global config file.
 * Returns true if saved successfully.
 */
export async function saveToGlobalConfig(
  configPath: string,
  provider: string,
  model: string,
): Promise<boolean> {
  try {
    const { atomicWrite } = await import('@wrongstack/core');
    const fs = await import('node:fs/promises');

    let existing: Record<string, unknown> = {};
    try {
      const raw = await fs.readFile(configPath, 'utf8');
      existing = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      // No existing config
    }

    existing.provider = provider;
    existing.model = model;
    await atomicWrite(configPath, JSON.stringify(existing, null, 2));
    return true;
  } catch {
    return false;
  }
}
