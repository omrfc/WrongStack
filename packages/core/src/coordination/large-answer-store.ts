/**
 * LargeAnswerStore — prevents `ask_subagent` results from bloating the
 * director's context window.
 *
 * Problem: `ask_subagent` returns full subagent responses as tool_result
 * content. A single response can be 10-50K+ tokens. When the director
 * calls `ask` multiple times, these accumulate in ctx.messages and can
 * push context pressure past 100%, causing provider overflow errors or
 * silent quality degradation.
 *
 * Solution: responses above `sizeThreshold` chars are stored here
 * (in-memory Map keyed by stable id). The tool result returns only a
 * compact summary + the store key. Callers retrieve the full result
 * via `retrieveAnswer(key)` when they need it.
 *
 * The store is scoped to a single Director.run() lifecycle.
 * It is NOT persisted — if the process crashes the results are lost,
 * which is acceptable since the subagent already finished and the
 * summary is in context.
 */

export interface AnswerEntry {
  key: string;
  value: unknown;
  size: number;
  storedAt: number;
}

export class LargeAnswerStore {
  /**
   * Responses above this size (in characters) are stored out-of-context.
   * Below this, the full answer is returned inline (no overhead).
   * Default: 2000 chars ≈ 400-600 tokens.
   */
  readonly sizeThreshold: number;

  private readonly store = new Map<string, AnswerEntry>();

  constructor(sizeThreshold = 2000) {
    this.sizeThreshold = sizeThreshold;
  }

  /**
   * Store a value, returning a summary + key for inline use.
   * If the value is below sizeThreshold, returns it as-is (no store entry).
   */
  storeAnswer(value: unknown): { key?: string; summary: string; inline: boolean } {
    if (value === undefined || value === null) {
      return { summary: String(value), inline: true };
    }

    const serialized = typeof value === 'string' ? value : JSON.stringify(value);
    const size = serialized.length;

    if (size <= this.sizeThreshold) {
      return { summary: serialized.slice(0, 500), inline: true };
    }

    // Stable key derived from content hash — same value always gets same key
    // within this store's lifetime.
    const key = `a-${hashStr(serialized)}`;

    this.store.set(key, {
      key,
      value,
      size,
      storedAt: Date.now(),
    });

    const summary = serialized.slice(0, 300) + (serialized.length > 300 ? '...' : '');
    return {
      key,
      summary: `[stored: ${size} chars — use roll_up or ask_result tool to retrieve, key=${key}]`,
      inline: false,
    };
  }

  /**
   * Retrieve a previously stored answer by its key.
   * Returns undefined if the key is unknown or the store was cleared.
   */
  retrieveAnswer(key: string): unknown | undefined {
    return this.store.get(key)?.value;
  }

  /**
   * Check if a key exists in the store.
   */
  hasAnswer(key: string): boolean {
    return this.store.has(key);
  }

  /** Number of stored entries. */
  get size(): number {
    return this.store.size;
  }

  /** Total characters stored. */
  get totalChars(): number {
    let total = 0;
    for (const e of this.store.values()) total += e.size;
    return total;
  }

  /** Clear all stored entries. Call at the end of a director run. */
  clear(): void {
    this.store.clear();
  }
}

/** Fast string hash for stable key derivation. Not cryptographic. */
function hashStr(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = (h * 33) ^ s.charCodeAt(i);
  }
  return (h >>> 0).toString(36);
}
