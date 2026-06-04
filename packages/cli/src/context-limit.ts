import type {
  Capabilities,
  Config,
  CustomModelDefinition,
  ModelsRegistry,
  Provider,
  ProviderConfig,
} from '@wrongstack/core';
import { capabilitiesFor } from '@wrongstack/providers';

export interface ResolveMaxContextInput {
  modelsRegistry?: ModelsRegistry;
  config: {
    provider?: string;
    model?: string;
    baseUrl?: string;
    context?: Pick<Config['context'], 'effectiveMaxContext'>;
    providers?: Config['providers'];
    models?: Record<string, CustomModelDefinition>;
  };
  provider: Provider;
  /** Provider config actually used to construct `provider` (important for aliases). */
  runtimeProviderConfig?: ProviderConfig;
  providerId: string;
  modelId: string;
}

/**
 * Resolve the max context WrongStack should use for compaction/status UI.
 *
 * Two-phase catalog lookup: first `capabilitiesFor()` (which overlays family
 * defaults with per-model facts from models.dev), then a direct `getModel()`
 * retry if the first attempt fails.
 *
 * Returns 0 when the context window cannot be determined — callers should
 * treat this as "unknown" and disable auto-compaction rather than guessing.
 *
 * Custom baseUrl/proxy configs skip the catalog entirely because the real
 * backend may have a smaller window than models.dev reports.
 */
export async function resolveRuntimeMaxContext(input: ResolveMaxContextInput): Promise<number> {
  const explicitContext = positiveNumber(input.config.context?.effectiveMaxContext);
  if (explicitContext) return explicitContext;

  const providerConfig = input.runtimeProviderConfig ?? input.config.providers?.[input.providerId];
  const providerOverride = positiveNumber(readConfiguredMaxContext(providerConfig));
  if (providerOverride) return providerOverride;

  const topLevelBaseUrlApplies = input.providerId === input.config.provider;
  const hasCustomBaseUrl = Boolean(
    providerConfig?.baseUrl || (topLevelBaseUrlApplies && input.config.baseUrl),
  );

  // Phase 1 — capabilitiesFor(): merges per-model catalog facts with family
  // defaults.  This is the preferred path; for models with catalog data it
  // returns the authoritative limit (e.g. 1M for deepseek-v4-pro).
  if (input.modelsRegistry && !hasCustomBaseUrl) {
    const caps = await capabilitiesFor(
      input.modelsRegistry,
      input.providerId,
      input.modelId,
      input.config.models,
    ).catch(() => undefined);
    const catalogMax = positiveNumber(caps?.maxContext);
    if (catalogMax) return catalogMax;

    // Phase 2 — direct getModel() retry.  If capabilitiesFor threw due to a
    // transient registry issue (stale cache, race on model refresh), a direct
    // model lookup may still succeed.
    const directModel = await input.modelsRegistry
      .getModel(input.providerId, input.modelId)
      .catch(() => undefined);
    const directMax = positiveNumber(directModel?.capabilities.maxContext);
    if (directMax) return directMax;
  }

  // All catalog lookups exhausted — return the provider's raw capabilities.
  // This may be 0 for catch-all families like openai-compatible, which
  // signals "unknown context window" to callers.
  return positiveNumber(input.provider.capabilities.maxContext) ?? 0;
}

function readConfiguredMaxContext(providerConfig: unknown): number | undefined {
  if (!providerConfig || typeof providerConfig !== 'object') return undefined;
  const capabilities = (providerConfig as { capabilities?: unknown }).capabilities;
  if (!capabilities || typeof capabilities !== 'object') return undefined;
  return (capabilities as Partial<Capabilities>).maxContext;
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}
