import type {
  Capabilities,
  Config,
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
 * Catalog model limits are only authoritative when we are talking to the
 * catalog provider's normal endpoint. If the user points a catalog id such as
 * `openai` at a custom baseUrl/proxy, the real backend may have a smaller
 * window than models.dev reports, so prefer explicit config/provider caps and
 * otherwise fall back to the constructed provider's family default.
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
  if (input.modelsRegistry && !hasCustomBaseUrl) {
    const caps = await capabilitiesFor(input.modelsRegistry, input.providerId, input.modelId).catch(
      () => undefined,
    );
    const catalogMax = positiveNumber(caps?.maxContext);
    if (catalogMax) return catalogMax;
  }

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
