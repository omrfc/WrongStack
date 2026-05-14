/**
 * Shared token estimation with JSON.stringify caching.
 * Avoids repeated stringification of tool input objects.
 */

const RoughTokenEstimate = (text: string): number => Math.max(1, Math.ceil(text.length / 4));

/**
 * Cache of computed estimates keyed by the input object. WeakMap so cache
 * entries get GC'd alongside the inputs and we don't pin tool inputs in
 * memory after the agent moves on. Previously the cache was an in-place
 * `__tokenEstimate` property on the input object itself — which threw on
 * frozen/sealed inputs and silently mutated objects the caller still owns.
 */
const ESTIMATE_CACHE = new WeakMap<object, number>();

/**
 * Estimate tokens for a tool_use block input.
 * Caches the stringified result keyed by the input object to avoid
 * repeated JSON.stringify calls during context window checks.
 */
export function estimateToolInputTokens(input: unknown): number {
  if (typeof input === 'string') return RoughTokenEstimate(input);
  if (input === null || typeof input !== 'object') {
    return RoughTokenEstimate(String(input));
  }
  const cached = ESTIMATE_CACHE.get(input);
  if (cached !== undefined) return cached;
  const estimate = RoughTokenEstimate(JSON.stringify(input));
  ESTIMATE_CACHE.set(input, estimate);
  return estimate;
}

/**
 * Estimate tokens for a tool_result content.
 */
export function estimateToolResultTokens(content: string | unknown): number {
  if (typeof content === 'string') return RoughTokenEstimate(content);
  return RoughTokenEstimate(JSON.stringify(content));
}

/**
 * Estimate tokens for a text block.
 */
export function estimateTextTokens(text: string): number {
  return RoughTokenEstimate(text);
}