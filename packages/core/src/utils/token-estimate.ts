/**
 * Shared token estimation with JSON.stringify caching.
 * Avoids repeated stringification of tool input objects.
 */

const RoughTokenEstimate = (text: string): number => Math.max(1, Math.ceil(text.length / 4));

/**
 * Cache of computed estimates keyed by the stringified input — not the
 * input object itself. Previously the cache was keyed by the input object
 * via WeakMap, but JSON.stringify() produces a new object reference each
 * call so the cache never hit. Now we use a Map with string keys so that
 * repeated stringifications of the same structure share a single entry.
 */
const ESTIMATE_CACHE = new Map<string, number>();

const ESTIMATE_CACHE_MAX_SIZE = 10_000;

function getCachedEstimate(key: string, compute: () => number): number {
  const existing = ESTIMATE_CACHE.get(key);
  if (existing !== undefined) return existing;
  if (ESTIMATE_CACHE.size >= ESTIMATE_CACHE_MAX_SIZE) {
    // Evict oldest quarter when at capacity — simple LRU-ish policy.
    const keys = [...ESTIMATE_CACHE.keys()];
    for (let i = 0; i < Math.floor(ESTIMATE_CACHE_MAX_SIZE / 4); i++) {
      ESTIMATE_CACHE.delete(keys[i]!);
    }
  }
  const estimate = compute();
  ESTIMATE_CACHE.set(key, estimate);
  return estimate;
}

/**
 * Estimate tokens for a tool_use block input.
 * Caches the stringified result keyed by the stable string representation
 * to avoid repeated JSON.stringify calls during context window checks.
 */
export function estimateToolInputTokens(input: unknown): number {
  if (typeof input === 'string') return RoughTokenEstimate(input);
  if (input === null || typeof input !== 'object') {
    return RoughTokenEstimate(String(input));
  }
  const key = JSON.stringify(input);
  return getCachedEstimate(key, () => RoughTokenEstimate(key));
}

/**
 * Estimate tokens for a tool_result content.
 */
export function estimateToolResultTokens(content: string | unknown): number {
  if (typeof content === 'string') return RoughTokenEstimate(content);
  const key = JSON.stringify(content);
  return getCachedEstimate(key, () => RoughTokenEstimate(key));
}

/**
 * Estimate tokens for a text block.
 */
export function estimateTextTokens(text: string): number {
  return RoughTokenEstimate(text);
}
