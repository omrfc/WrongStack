import type {
  Capabilities,
  Config,
  CustomModelDefinition,
  ModelsRegistry,
  Provider,
  ProviderConfig,
} from '@wrongstack/core';
import { mergeCustomModelDefs } from '@wrongstack/core';
import { capabilitiesFor } from '@wrongstack/providers';

/**
 * Config-only OAuth/subscription wire families → the canonical models.dev
 * provider that lists the same models. Lets us resolve the real per-model
 * context window (these families aren't published in the catalog themselves).
 */
const SIBLING_CATALOG: Record<string, string> = {
  'anthropic-oauth': 'anthropic',
  'openai-codex': 'openai',
  'github-copilot': 'openai',
};

export interface ResolveMaxContextInput {
  modelsRegistry?: ModelsRegistry | undefined;
  config: {
    provider?: string | undefined;
    model?: string | undefined;
    baseUrl?: string | undefined;
    context?: { effectiveMaxContext?: number | undefined } | undefined;
    providers?: Config['providers'] | undefined;
    models?: Record<string, CustomModelDefinition> | undefined;
  };
  provider: Provider;
  /** Provider config actually used to construct `provider` (important for aliases). */
  runtimeProviderConfig?: ProviderConfig | undefined;
  providerId: string;
  modelId: string;
}

/**
 * Resolve the max context WrongStack should use for compaction/status UI.
 *
 * Priority chain (first hit wins):
 *  1. config.context.effectiveMaxContext        — explicit session/global value
 *  2. providers.<id>.capabilities.maxContext    — explicit per-provider override
 *  3. sibling catalog for OAuth families        — anthropic-oauth/openai-codex/
 *     github-copilot share their models with a canonical models.dev provider
 *     (anthropic/openai) but aren't themselves listed, so resolve the real
 *     per-model window there (e.g. Opus 4.8 → 1M, gpt-5.5 → 1.05M)
 *  4. models.dev catalog (capabilitiesFor → getModel) — the published per-model
 *     window, keyed by provider (e.g. 1M for an OpenRouter model)
 *  5. provider.capabilities.maxContext          — family default (may be 0)
 *
 * Returns 0 when the context window cannot be determined — callers should
 * treat this as "unknown" and disable auto-compaction rather than guessing.
 *
 * A configured `baseUrl` only changes the wire endpoint, NOT the model's
 * published context window, so it does NOT by itself suppress the catalog:
 * adding a catalog provider persists its own canonical `apiBase` as `baseUrl`
 * (e.g. OpenRouter → https://openrouter.ai/api/v1), which is not a custom proxy.
 * Only a baseUrl that DIVERGES from the catalog apiBase (a local proxy/gateway
 * whose real window may be smaller) skips the catalog — and even then the
 * explicit overrides (1) and (2) can raise the window back.
 */
export async function resolveRuntimeMaxContext(input: ResolveMaxContextInput): Promise<number> {
  const explicitContext = positiveNumber(input.config.context?.effectiveMaxContext);
  if (explicitContext) return explicitContext;

  const providerConfig = input.runtimeProviderConfig ?? input.config.providers?.[input.providerId];
  const providerOverride = positiveNumber(readConfiguredMaxContext(providerConfig));
  if (providerOverride) return providerOverride;

  // OAuth/subscription families (Sign in with Claude/ChatGPT/Copilot) aren't in
  // the models.dev catalog under their own id, but they serve the SAME models as
  // a canonical catalog provider. Resolve the real per-model window there. The
  // configured baseUrl is an auth/proxy endpoint (api.anthropic.com, a Copilot
  // proxy, …), not a context-shrinking gateway, so we bypass the divergence
  // guard that the generic catalog path applies below.
  const sibling = providerConfig?.family ? SIBLING_CATALOG[providerConfig.family] : undefined;
  if (sibling && input.modelsRegistry) {
    const mergedModels = mergeCustomModelDefs(providerConfig?.customModels, input.config.models);
    const caps = await capabilitiesFor(
      input.modelsRegistry,
      sibling,
      input.modelId,
      mergedModels,
    ).catch(() => undefined);
    const siblingMax = positiveNumber(caps?.maxContext);
    if (siblingMax) return siblingMax;

    const directModel = await input.modelsRegistry
      .getModel(sibling, input.modelId)
      .catch(() => undefined);
    const directMax = positiveNumber(directModel?.capabilities.maxContext);
    if (directMax) return directMax;
  }

  // Resolve alias → catalog id so registry lookups hit the real provider. The
  // launch id (input.providerId) may be a user alias whose `type` points at the
  // catalog provider (mirrors `wstack models <provider>`).
  const catalogId =
    providerConfig?.type && providerConfig.type !== input.providerId
      ? providerConfig.type
      : input.providerId;

  if (input.modelsRegistry) {
    const topLevelBaseUrlApplies = input.providerId === input.config.provider;
    const configuredBaseUrl =
      providerConfig?.baseUrl ?? (topLevelBaseUrlApplies ? input.config.baseUrl : undefined);

    // A baseUrl only suppresses the catalog when it points somewhere OTHER than
    // the provider's canonical endpoint. When unset, or equal to the catalog
    // apiBase, the model's published window still applies.
    let divergesFromCatalog = false;
    if (configuredBaseUrl) {
      const resolved = await safeGetProvider(input.modelsRegistry, catalogId);
      divergesFromCatalog =
        normalizeBaseUrl(configuredBaseUrl) !== normalizeBaseUrl(resolved?.apiBase);
    }

    if (!divergesFromCatalog) {
      // Phase 1 — capabilitiesFor(): merges per-model catalog facts with family
      // defaults. This is the preferred path; for models with catalog data it
      // returns the authoritative limit (e.g. 1M for deepseek-v4-pro).
      const mergedModels = mergeCustomModelDefs(providerConfig?.customModels, input.config.models);
      const caps = await capabilitiesFor(
        input.modelsRegistry,
        catalogId,
        input.modelId,
        mergedModels,
      ).catch(() => undefined);
      const catalogMax = positiveNumber(caps?.maxContext);
      if (catalogMax) return catalogMax;

      // Phase 2 — direct getModel() retry. If capabilitiesFor threw due to a
      // transient registry issue (stale cache, race on model refresh), a direct
      // model lookup may still succeed.
      const directModel = await input.modelsRegistry
        .getModel(catalogId, input.modelId)
        .catch(() => undefined);
      const directMax = positiveNumber(directModel?.capabilities.maxContext);
      if (directMax) return directMax;
    }
  }

  // All catalog lookups exhausted — return the provider's raw capabilities.
  // This may be 0 for catch-all families like openai-compatible, which
  // signals "unknown context window" to callers.
  return positiveNumber(input.provider.capabilities.maxContext) ?? 0;
}

/**
 * `getProvider` lookup that swallows BOTH synchronous throws (e.g. a partial
 * registry stub without the method) and async rejections, returning undefined.
 */
async function safeGetProvider(
  registry: ModelsRegistry,
  id: string,
): Promise<{ apiBase?: string | undefined } | undefined> {
  try {
    return await registry.getProvider(id);
  } catch {
    return undefined;
  }
}

/** Lowercase + strip trailing slashes so apiBase comparison is stable. */
function normalizeBaseUrl(url: string | undefined): string {
  if (!url) return '';
  return url.trim().toLowerCase().replace(/\/+$/, '');
}

function readConfiguredMaxContext(providerConfig: unknown): number | undefined {
  if (!providerConfig || typeof providerConfig !== 'object') return undefined;
  const capabilities = (providerConfig as { capabilities?: unknown | undefined }).capabilities;
  if (!capabilities || typeof capabilities !== 'object') return undefined;
  return (capabilities as Partial<Capabilities>).maxContext;
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}
