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

/**
 * Rough estimate of tokens in a tool definition (name + description + schema).
 * Accounts for the JSON-serialized inputSchema which is sent to the API
 * but NOT included in roughEstimate(content).
 */
export function estimateToolDefTokens(tool: { name: string; description?: string; inputSchema: unknown }): number {
  return RoughTokenEstimate(tool.name) +
    RoughTokenEstimate(tool.description ?? '') +
    RoughTokenEstimate(JSON.stringify(tool.inputSchema));
}

/**
 * Estimate the total API request token count: system prompt + tool definitions
 * + conversation messages. Use this for context-window bar calculations
 * instead of roughEstimate (which only counts messages).
 *
 * The overhead ratio (overhead / messages) varies by conversation length:
 *   - Short conversations (< 10 messages): ~30-50% overhead (large system+tools)
 *   - Medium (10-50 messages): ~15-30%
 *   - Long (> 50 messages): ~5-15%
 *
 * Returns { messages, systemPrompt, tools, total } for debugging display.
 */
export interface RequestTokenBreakdown {
  messages: number;
  systemPrompt: number;
  tools: number;
  total: number;
}

export function estimateRequestTokens(
  messages: unknown,
  systemPrompt: unknown,
  tools: { name: string; description?: string; inputSchema: unknown }[],
): RequestTokenBreakdown {
  // Messages: apply the same logic as roughEstimate
  let messagesTokens = 0;
  if (typeof messages === 'string') {
    messagesTokens = RoughTokenEstimate(messages);
  } else if (Array.isArray(messages)) {
    for (const m of messages) {
      if (typeof m === 'object' && m !== null && 'content' in m) {
        const content = (m as { content: unknown }).content;
        if (typeof content === 'string') {
          messagesTokens += RoughTokenEstimate(content);
        } else if (Array.isArray(content)) {
          for (const b of content) {
            if (typeof b === 'object' && b !== null) {
              if ((b as { type?: string }).type === 'text') {
                messagesTokens += RoughTokenEstimate((b as { text: string }).text);
              } else {
                messagesTokens += RoughTokenEstimate(JSON.stringify(b));
              }
            }
          }
        }
      }
    }
  }

  // System prompt
  let systemTokens = 0;
  if (typeof systemPrompt === 'string') {
    systemTokens = RoughTokenEstimate(systemPrompt);
  } else if (Array.isArray(systemPrompt)) {
    for (const b of systemPrompt) {
      if (typeof b === 'object' && b !== null && (b as { type?: string }).type === 'text') {
        systemTokens += RoughTokenEstimate((b as { text: string }).text);
      }
    }
  }

  // Tool definitions
  let toolsTokens = 0;
  for (const t of tools) {
    toolsTokens += estimateToolDefTokens(t);
  }

  return {
    messages: messagesTokens,
    systemPrompt: systemTokens,
    tools: toolsTokens,
    total: messagesTokens + systemTokens + toolsTokens,
  };
}
