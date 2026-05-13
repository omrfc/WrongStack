/**
 * Shared token estimation with JSON.stringify caching.
 * Avoids repeated stringification of tool input objects.
 */

const RoughTokenEstimate = (text: string): number => Math.max(1, Math.ceil(text.length / 4));

/**
 * Estimate tokens for a tool_use block input.
 * Caches the stringified result on the input object itself to avoid
 * repeated JSON.stringify calls during context window checks.
 */
export function estimateToolInputTokens(input: unknown): number {
  // If input is a string already, estimate directly
  if (typeof input === 'string') return RoughTokenEstimate(input);

  // Use cached estimate if available (set by this function or by caller)
  if (
    input !== null &&
    typeof input === 'object' &&
    '__tokenEstimate' in input
  ) {
    return (input as Record<string, unknown>).__tokenEstimate as number;
  }

  const str = typeof input === 'object' ? JSON.stringify(input) : String(input);
  const estimate = RoughTokenEstimate(str);

  // Cache on object for future calls (only for plain objects)
  if (input !== null && typeof input === 'object' && !Array.isArray(input)) {
    (input as Record<string, unknown>).__tokenEstimate = estimate;
  }

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