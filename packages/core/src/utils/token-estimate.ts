import { expectDefined } from './expect-defined.js';
/**
 * Shared token estimation with JSON.stringify caching.
 * Avoids repeated stringification of tool input objects.
 *
 * ## Calibration
 *
 * `estimateRequestTokens` uses a fixed 3.5 chars/token heuristic — a
 * conservative overestimate that prevents underestimation but reduces
 * accuracy. After each API call, call `recordActualUsage()` with the
 * real `usage.input` from the provider response. The module maintains a
 * rolling average of `actual / estimated` ratio (EWM, α=0.3) and
 * applies it to subsequent calls via `estimateRequestTokensCalibrated`.
 *
 * Calibration is per-module (shared across all callers), which is
 * sufficient: the chars/token ratio is a property of the tokenizer,
 * not the model. Uncalibrated calls (before any samples, or when
 * `recordActualUsage` is not called) fall back to the uncalibrated
 * estimate so nothing breaks.
 */

const RoughTokenEstimate = (text: string, charsPerToken = 3.5): number =>
  Math.max(1, Math.ceil(text.length / charsPerToken));

/** Calibration state: actual/estimated ratio via exponential weighted moving average. */
const _cal = {
  ratio: 1.0,     // current calibration multiplier (actual / estimated)
  count: 0,        // number of samples recorded
  prevEst: 0,     // estimated tokens from the most recent estimateRequestTokens call
  /** EWM α — higher = faster adaptation, more volatile */
  alpha: 0.3,
};

const MIN_SAMPLES_FOR_CALIBRATION = 3;

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
      ESTIMATE_CACHE.delete(expectDefined(keys[i]));
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
export function estimateToolDefTokens(tool: { name: string; description?: string | undefined; inputSchema: unknown }): number {
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
  tools: { name: string; description?: string | undefined; inputSchema: unknown }[],
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
              if ((b as { type?: string | undefined }).type === 'text') {
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
      if (typeof b === 'object' && b !== null && (b as { type?: string | undefined }).type === 'text') {
        systemTokens += RoughTokenEstimate((b as { text: string }).text);
      }
    }
  }

  // Tool definitions
  let toolsTokens = 0;
  for (const t of tools) {
    toolsTokens += estimateToolDefTokens(t);
  }

  const total = messagesTokens + systemTokens + toolsTokens;

  // Record the raw estimate for calibration: the next recordActualUsage()
  // call will pair this against the actual API usage so the rolling ratio
  // stays in sync with the real chars/token ratio of the content.
  _cal.prevEst = total;

  return {
    messages: messagesTokens,
    systemPrompt: systemTokens,
    tools: toolsTokens,
    total,
  };
}

/**
 * Record the actual API input token count after a provider call so
 * `estimateRequestTokensCalibrated` can self-correct on subsequent calls.
 *
 * Prefer passing `estimatedInputTokens` explicitly (the calibrated pre-flight
 * estimate from the middleware) — this avoids race conditions when other code
 * also calls `estimateRequestTokens` between the pre-flight and this call
 * (e.g. audit logging in agent.ts).
 *
 * When `estimatedInputTokens` is omitted, falls back to `_cal.prevEst`
 * for backward compatibility with callers that don't have the pre-flight value.
 */
export function recordActualUsage(actualInputTokens: number, estimatedInputTokens?: number): void {
  if (actualInputTokens <= 0) return;
  const est = estimatedInputTokens ?? _cal.prevEst;
  if (est <= 0) return;

  const sampleRatio = actualInputTokens / est;
  if (_cal.count === 0) {
    _cal.ratio = sampleRatio;
  } else {
    // EWM: new = α * sample + (1-α) * old  →  α=0.3 = fast initial converge
    _cal.ratio = _cal.alpha * sampleRatio + (1 - _cal.alpha) * _cal.ratio;
  }
  // Sanity bound: keep the rolling ratio within [0.5, 1.5] so a sequence
  // of bad samples can't blow up the calibration for everyone.
  _cal.ratio = Math.min(1.5, Math.max(0.5, _cal.ratio));
  _cal.count++;
}

/**
 * Returns the current calibration state. Exposed for debugging and
 * tests — not needed by normal callers.
 */
export function getCalibrationState(): { ratio: number; count: number; calibrated: boolean } {
  return {
    ratio: _cal.ratio,
    count: _cal.count,
    calibrated: _cal.count >= MIN_SAMPLES_FOR_CALIBRATION,
  };
}

/**
 * Like `estimateRequestTokens` but applies the rolling calibration factor
 * so context pressure readings converge on reality within a few iterations.
 *
 * Before any `recordActualUsage` samples are collected, returns the same
 * result as `estimateRequestTokens` (ratio = 1.0, no distortion).
 * After `MIN_SAMPLES_FOR_CALIBRATION` samples, applies the calibrated
 * multiplier capped to the range [0.5, 1.5] as a sanity bound.
 */
export function estimateRequestTokensCalibrated(
  messages: unknown,
  systemPrompt: unknown,
  tools: { name: string; description?: string | undefined; inputSchema: unknown }[],
): RequestTokenBreakdown {
  const result = estimateRequestTokens(messages, systemPrompt, tools);

  if (_cal.count >= MIN_SAMPLES_FOR_CALIBRATION) {
    const safeRatio = Math.min(1.5, Math.max(0.5, _cal.ratio));
    return {
      messages: Math.round(result.messages * safeRatio),
      systemPrompt: Math.round(result.systemPrompt * safeRatio),
      tools: Math.round(result.tools * safeRatio),
      total: Math.round(result.total * safeRatio),
    };
  }

  return result;
}

/**
 * Resets calibration state. Primarily for tests that run in the same
 * process and need a clean slate between suites.
 */
export function resetCalibration(): void {
  _cal.ratio = 1.0;
  _cal.count = 0;
  _cal.prevEst = 0;
}
