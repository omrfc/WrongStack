import type { Message } from '../types/messages.js';
import { compactToolDefinitionForWire } from './tool-wire-compact.js';

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
interface CalState {
  ratio: number; // current calibration multiplier (actual / estimated)
  count: number; // number of samples recorded
  prevEst: number; // estimated tokens from the most recent estimateRequestTokens call
}

/** EWM α — higher = faster adaptation, more volatile. */
const CAL_ALPHA = 0.3;

/**
 * Calibration is keyed so that, in a multi-agent / model-switching process,
 * each (provider, model) tokenizer gets its own ratio instead of all of them
 * collapsing onto one shared number. Callers that don't pass a key use the
 * shared `__global__` bucket — that preserves the original single-session
 * behavior and keeps all existing call sites working unchanged.
 */
const CALIBRATION_GLOBAL_KEY = '__global__';
const _cals = new Map<string, CalState>();

function calState(key: string): CalState {
  let state = _cals.get(key);
  if (!state) {
    state = { ratio: 1.0, count: 0, prevEst: 0 };
    _cals.set(key, state);
  }
  return state;
}

const MIN_SAMPLES_FOR_CALIBRATION = 3;

/**
 * Fallback chars/token ratios per model family for providers that don't return
 * usage data. Used when `recordActualUsage` receives zero/negative tokens and
 * we have enough samples to trust the fallback. Keys are lowercase prefixes.
 */
const MODEL_FAMILY_RATIO: Record<string, number> = {
  // Anthropic: ~3.8-4.0 chars/token depending on model
  claude: 3.8,
  // OpenAI: ~4.0 chars/token
  'gpt-4': 4.0,
  'gpt-3.5': 4.0,
  // Google: ~3.5 chars/token
  gemini: 3.5,
  // DeepSeek: ~3.5 chars/token
  deepseek: 3.5,
};

/**
 * Cache of computed estimates keyed by the stringified input — not the
 * input object itself. Previously the cache was keyed by the input object
 * via WeakMap, but JSON.stringify() produces a new object reference each
 * call so the cache never hit. Now we use a Map with string keys so that
 * repeated stringifications of the same structure share a single entry.
 */
const ESTIMATE_CACHE = new Map<string, number>();

const ESTIMATE_CACHE_MAX_SIZE = 50_000;

function getCachedEstimate(key: string, compute: (key: string) => number): number {
  const existing = ESTIMATE_CACHE.get(key);
  if (existing !== undefined) return existing;
  if (ESTIMATE_CACHE.size >= ESTIMATE_CACHE_MAX_SIZE) {
    // Evict oldest half when at capacity — O(1) instead of O(n) iteration.
    // 5 000 surviving entries still give a high cache hit rate for the
    // common case of repeated context-window checks on the same messages.
    for (const k of ESTIMATE_CACHE.keys()) {
      if (ESTIMATE_CACHE.size <= Math.floor(ESTIMATE_CACHE_MAX_SIZE / 2)) break;
      ESTIMATE_CACHE.delete(k);
    }
  }
  const estimate = compute(key);
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
  // JSON.stringify is called once to form the cache key; RoughTokenEstimate
  // is deferred only on cache miss (compute callback), not wrapped unnecessarily.
  return getCachedEstimate(JSON.stringify(input), (key) => RoughTokenEstimate(key));
}

/**
 * Estimate tokens for a tool_result content.
 */
export function estimateToolResultTokens(content: string | unknown): number {
  if (typeof content === 'string') return RoughTokenEstimate(content);
  return getCachedEstimate(JSON.stringify(content), (key) => RoughTokenEstimate(key));
}

/**
 * Estimate tokens for a text block.
 */
export function estimateTextTokens(text: string): number {
  return RoughTokenEstimate(text);
}

/**
 * Compute and cache the token estimate for a single message. This is the
 * canonical per-message estimator — called once by ConversationState on
 * append/replace so the O(n·m) content-block walk happens at mutation time,
 * not on every context-pressure check.
 */
export function computeMessageTokens(msg: Message): number {
  if (typeof msg.content === 'string') return estimateTextTokens(msg.content);
  let total = 0;
  for (const b of msg.content) {
    if (b.type === 'text') total += estimateTextTokens(b.text);
    else if (b.type === 'tool_use') total += estimateToolInputTokens(b.input);
    else if (b.type === 'tool_result') total += estimateToolResultTokens(b.content);
    else total += RoughTokenEstimate(JSON.stringify(b));
  }
  return total;
}

/**
 * Estimate tokens for an array of messages (text + tool I/O), using the shared
 * 3.5 chars/token basis. This is the single canonical message-array estimator —
 * compactors, the context_manager tool, and the `/context` display all route
 * through it so the number a user sees matches the number compaction decides on.
 *
 * When a message carries a pre-computed `_estTokens` field (set by
 * ConversationState on append/replace), it is used directly instead of
 * re-walking the content blocks — turning the O(n·m) scan into an O(n)
 * sum for fully-cached arrays.
 */
export function estimateMessageTokens(messages: readonly Message[]): number {
  let total = 0;
  for (const m of messages) {
    if (typeof m._estTokens === 'number' && m._estTokens > 0) {
      total += m._estTokens;
      continue;
    }
    total += computeMessageTokens(m);
  }
  return total;
}

/**
 * Rough estimate of tokens in a tool definition (name + description + schema).
 * Accounts for the JSON-serialized inputSchema which is sent to the API
 * but NOT included in roughEstimate(content).
 */
export function estimateToolDefTokens(tool: {
  name: string;
  description?: string | undefined;
  inputSchema: unknown;
}): number {
  // Fast path: pre-computed by ToolRegistry at registration time.
  const cached = (tool as { _estDefTokens?: number | undefined })._estDefTokens;
  if (typeof cached === 'number' && cached > 0) return cached;

  const compact = compactToolDefinitionForWire(tool);
  return (
    RoughTokenEstimate(tool.name) +
    RoughTokenEstimate(compact.description) +
    RoughTokenEstimate(JSON.stringify(compact.inputSchema))
  );
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
  calibrationKey: string = CALIBRATION_GLOBAL_KEY,
): RequestTokenBreakdown {
  // Messages: apply the same logic as roughEstimate
  let messagesTokens = 0;
  if (typeof messages === 'string') {
    messagesTokens = RoughTokenEstimate(messages);
  } else if (Array.isArray(messages)) {
    for (const m of messages) {
      if (typeof m === 'object' && m !== null && 'content' in m) {
        // Fast path: pre-computed per-message token estimate (set by
        // ConversationState on append/replace). Skips the O(m) content-block
        // walk entirely for cached messages.
        const cached = (m as { _estTokens?: number | undefined })._estTokens;
        if (typeof cached === 'number' && cached > 0) {
          messagesTokens += cached;
          continue;
        }
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
      if (
        typeof b === 'object' &&
        b !== null &&
        (b as { type?: string | undefined }).type === 'text'
      ) {
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
  calState(calibrationKey).prevEst = total;

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
 * When `estimatedInputTokens` is omitted, falls back to the keyed bucket's
 * `prevEst` for backward compatibility with callers that don't have the
 * pre-flight value. `calibrationKey` selects the per-(provider,model) bucket
 * (defaults to the shared global bucket).
 */
export function recordActualUsage(
  actualInputTokens: number,
  estimatedInputTokens?: number,
  calibrationKey: string = CALIBRATION_GLOBAL_KEY,
): void {
  if (actualInputTokens <= 0) return;
  const cal = calState(calibrationKey);
  const est = estimatedInputTokens ?? cal.prevEst;
  if (est <= 0) return;

  const sampleRatio = actualInputTokens / est;
  if (cal.count === 0) {
    cal.ratio = sampleRatio;
  } else {
    // EWM: new = α * sample + (1-α) * old  →  α=0.3 = fast initial converge
    cal.ratio = CAL_ALPHA * sampleRatio + (1 - CAL_ALPHA) * cal.ratio;
  }
  // Sanity bound: keep the rolling ratio within [0.5, 1.5] so a sequence
  // of bad samples can't blow up the calibration for everyone.
  cal.ratio = Math.min(1.5, Math.max(0.5, cal.ratio));
  cal.count++;
}

/**
 * Returns the current calibration state for a bucket. Exposed for debugging
 * and tests — not needed by normal callers.
 */
export function getCalibrationState(calibrationKey: string = CALIBRATION_GLOBAL_KEY): {
  ratio: number;
  count: number;
  calibrated: boolean;
} {
  const cal = calState(calibrationKey);
  return {
    ratio: cal.ratio,
    count: cal.count,
    calibrated: cal.count >= MIN_SAMPLES_FOR_CALIBRATION,
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
  calibrationKey: string = CALIBRATION_GLOBAL_KEY,
): RequestTokenBreakdown {
  const result = estimateRequestTokens(messages, systemPrompt, tools, calibrationKey);
  const cal = calState(calibrationKey);

  if (cal.count >= MIN_SAMPLES_FOR_CALIBRATION) {
    const safeRatio = Math.min(1.5, Math.max(0.5, cal.ratio));
    return {
      messages: Math.round(result.messages * safeRatio),
      systemPrompt: Math.round(result.systemPrompt * safeRatio),
      tools: Math.round(result.tools * safeRatio),
      total: Math.round(result.total * safeRatio),
    };
  }

  // No calibration samples yet — fall back to model-family ratio if available,
  // otherwise use the uncalibrated estimate (ratio = 1.0).
  const fallbackRatio = getModelFamilyRatio(calibrationKey);
  if (fallbackRatio !== null) {
    return {
      messages: Math.round(result.messages * fallbackRatio),
      systemPrompt: Math.round(result.systemPrompt * fallbackRatio),
      tools: Math.round(result.tools * fallbackRatio),
      total: Math.round(result.total * fallbackRatio),
    };
  }

  return result;
}

/** Look up the fallback chars/token ratio for a calibration key (e.g. "provider/model"). */
function getModelFamilyRatio(calibrationKey: string): number | null {
  const lower = calibrationKey.toLowerCase();
  for (const [family, ratio] of Object.entries(MODEL_FAMILY_RATIO)) {
    if (lower.includes(family)) return ratio / 3.5; // MODEL_FAMILY_RATIO is chars/token, we need multiplier
  }
  return null;
}

/**
 * Resets calibration state. Primarily for tests that run in the same
 * process and need a clean slate between suites. With no argument it clears
 * every bucket (including the global one); pass a key to reset just that bucket.
 */
export function resetCalibration(calibrationKey?: string): void {
  if (calibrationKey === undefined) {
    _cals.clear();
    return;
  }
  _cals.delete(calibrationKey);
}
