import type { Capabilities, CustomModelDefinition, ModelsRegistry } from '@wrongstack/core';
import { capabilitiesForFamily } from './family-capabilities.js';

/**
 * Resolve capabilities for a (provider, model) pair using the family default
 * as a baseline and overlaying per-model facts from the ModelsRegistry.
 *
 * Priority chain (highest first):
 *  1. customModels[modelId].capabilities  — user-defined per-model overrides
 *  2. model facts from registry           — sub-fields AND-ed with base
 *  3. family default                      — e.g. 32K for openai-compatible
 */
export async function capabilitiesFor(
  registry: ModelsRegistry,
  providerId: string,
  modelId: string,
  customModels?: Record<string, CustomModelDefinition>,
): Promise<Capabilities> {
  const provider = await registry.getProvider(providerId);
  const base = capabilitiesForFamily(provider?.family ?? 'unsupported');

  // User-defined custom model overrides take top priority when present.
  const customDef = customModels?.[modelId];
  const customCaps = customDef?.capabilities;

  const model = await registry.getModel(providerId, modelId);

  // Without any model info at all, return base (possibly with custom overrides).
  if (!model && !customCaps) return { ...base };

  // maxContext resolution:
  //  1. customCaps.maxContext              — user explicitly overrides
  //  2. model.capabilities.maxContext      — registry getModel()
  //  3. raw model limit.context            — direct provider.models fallback
  //  4. base.maxContext                    — family default
  const rawModel = provider?.models.find((m) => m.id === modelId);
  const catalogMaxContext =
    model?.capabilities.maxContext ||
    rawModel?.limit?.context ||
    rawModel?.limit?.output ||
    base.maxContext;

  // Per-field priority: customCaps (if set) → model facts AND-ed with base → base.
  // AND-ing with base is conservative: a model can't have a capability the
  // wire family doesn't support. Custom overrides skip this guard because
  // the user explicitly opted in.
  const modelTools = model?.capabilities.tools ?? false;
  const modelVision = model?.capabilities.vision ?? false;
  const modelReasoning = model?.capabilities.reasoning ?? false;

  return {
    ...base,
    // Capability booleans: AND model facts with base unless custom overrides
    tools: customCaps?.tools ?? (modelTools && base.tools),
    parallelTools: customCaps?.parallelTools ?? (modelTools && base.parallelTools),
    vision: customCaps?.vision ?? (modelVision && base.vision),
    reasoning: customCaps?.reasoning ?? modelReasoning,
    // Scalar fields: custom override wins, then catalog, then base
    maxContext: customCaps?.maxContext ?? catalogMaxContext,
    streaming: customCaps?.streaming ?? base.streaming,
    promptCache: customCaps?.promptCache ?? base.promptCache,
    systemPrompt: customCaps?.systemPrompt ?? base.systemPrompt,
    jsonMode: customCaps?.jsonMode ?? base.jsonMode,
    cacheControl: customCaps?.cacheControl ?? base.cacheControl,
  };
}
