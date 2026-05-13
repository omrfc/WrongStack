import type { ModelsRegistry, ResolvedProvider } from '@wrongstack/core';
import { color } from '@wrongstack/core';
import type { TerminalRenderer } from './renderer.js';
import type { ReadlineInputReader } from './input-reader.js';

export interface PickerResult {
  provider: string;
  model: string;
}

/**
 * Interactive provider + model picker. Lists all supported providers
 * grouped by wire family, lets the user pick one, then shows that
 * provider's models for a second pick. Returns the chosen pair or
 * undefined if the user bails out.
 */
export async function runPicker(deps: {
  modelsRegistry: ModelsRegistry;
  renderer: TerminalRenderer;
  reader: ReadlineInputReader;
}): Promise<PickerResult | undefined> {
  const { modelsRegistry, renderer, reader } = deps;

  renderer.write(`\n${color.bold(theme.primary('WrongStack') + color.dim(' — Provider & Model Selection'))}\n`);
  renderer.write(color.dim('Loading provider catalog…\n'));

  let providers: ResolvedProvider[];
  try {
    providers = await modelsRegistry.listProviders();
  } catch {
    renderer.writeError('Failed to load provider catalog. Pass --provider and --model to skip the picker.');
    return undefined;
  }

  // Only show supported providers (filter out unsupported wire families)
  const supported = providers.filter((p) => p.family !== 'unsupported');
  if (supported.length === 0) {
    renderer.writeError('No supported providers found in catalog.');
    return undefined;
  }

  // Group by family for nicer display
  const families = new Map<string, ResolvedProvider[]>();
  for (const p of supported) {
    const list = families.get(p.family) ?? [];
    list.push(p);
    families.set(p.family, list);
  }

  // Build a flat numbered list (family → providers)
  const ordered: Array<{ provider: ResolvedProvider; index: number }> = [];
  const familyOrder = ['anthropic', 'openai', 'google', 'openai-compatible'];
  let idx = 1;
  renderer.write('\n');
  for (const fam of familyOrder) {
    const list = families.get(fam);
    if (!list || list.length === 0) continue;
    renderer.write(`  ${color.bold(fam)}\n`);
    for (const p of list) {
      const envFound = p.envVars.some((v) => process.env[v]);
      const marker = envFound ? color.green('●') : color.dim('○');
      renderer.write(`  ${color.dim(`${idx}.`.padStart(4))} ${marker} ${p.id.padEnd(22)} ${color.dim(p.name)}\n`);
      ordered.push({ provider: p, index: idx });
      idx++;
    }
  }

  renderer.write(
    `\n  ${color.dim('● = API key detected in env    ○ = no key found (you may need `wstack auth` later)')}\n`,
  );

  // Pick provider
  const providerAnswer = (await reader.readLine(`\n${color.amber('?')} Select provider (1-${ordered.length}): `)).trim();
  if (!providerAnswer) {
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
    return pickModel(byId.provider, modelsRegistry, renderer, reader);
  }

  const chosen = ordered[providerIdx - 1];
  if (!chosen) return undefined;
  return pickModel(chosen.provider, modelsRegistry, renderer, reader);
}

async function pickModel(
  provider: ResolvedProvider,
  registry: ModelsRegistry,
  renderer: TerminalRenderer,
  reader: ReadlineInputReader,
): Promise<PickerResult | undefined> {
  renderer.write(`\n  ${color.bold(provider.name)} ${color.dim(`(${provider.id})`)} models:\n\n`);

  const models = [...provider.models].sort((a, b) =>
    (b.release_date ?? '').localeCompare(a.release_date ?? ''),
  );

  if (models.length === 0) {
    renderer.writeError('  No models listed for this provider in the catalog.');
    return undefined;
  }

  // Show paginated — up to 30 at a time
  const pageSize = 30;
  let offset = 0;
  const selected: string | undefined = undefined;

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
      renderer.write(
        `  ${color.dim(`${num}.`.padStart(5))} ${m.id.padEnd(44)} ${color.dim(ctx)}  ${color.dim(cost.padEnd(14))} ${capStr}\n`,
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

  // All shown, final prompt
  const answer = (
    await reader.readLine(`\n${color.amber('?')} Select model (1-${models.length}): `)
  ).trim();
  if (!answer) {
    renderer.write(color.dim('Cancelled.\n'));
    return undefined;
  }
  return resolveModelSelection(answer, models, provider, registry, renderer, reader);
}

async function resolveModelSelection(
  answer: string,
  models: import('@wrongstack/core').ModelsDevModel[],
  provider: ResolvedProvider,
  registry: ModelsRegistry,
  renderer: TerminalRenderer,
  reader: ReadlineInputReader,
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

  // Ask to save as default
  const save = await askYesNo(
    reader,
    `${color.amber('?')} Save as default provider/model?`,
    true,
  );
  if (save) {
    // We return a flag so the caller can persist to config
    return { provider: provider.id, model: modelId };
  }

  return { provider: provider.id, model: modelId };
}

// --- Helpers ---

// Simple theme alias (avoids importing the full theme module just for one color)
const theme = { primary: color.amber };

async function askYesNo(
  reader: ReadlineInputReader,
  prompt: string,
  defaultYes: boolean,
): Promise<boolean> {
  const hint = defaultYes ? 'Y/n' : 'y/N';
  const answer = (await reader.readLine(`${prompt} ${color.dim(`[${hint}]`)} `)).trim().toLowerCase();
  if (!answer) return defaultYes;
  return answer === 'y' || answer === 'yes';
}

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
