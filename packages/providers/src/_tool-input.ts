import { safeParse } from '@wrongstack/core';

/**
 * Parse a tool-call arguments JSON blob into a canonical
 * `Record<string, unknown>`.
 *
 * Why this exists: providers stream tool-call arguments as raw JSON strings
 * accumulated over multiple `delta` events. Once complete, callers want a
 * dictionary. Naive `JSON.parse` plus `as Record<string, unknown>` is unsafe
 * — a buggy provider, a proxy that rewrites payloads, or a future API change
 * can yield `null`, an array, a string, or a number, all of which would
 * type-check fine but crash downstream tool executors that index into the
 * input by key.
 *
 * Result contract:
 *   - Valid JSON object → returned as-is, typed as `Record<string, unknown>`.
 *   - Valid JSON array / scalar → wrapped under `{ __raw: value }` so the
 *     tool still receives an object (the executor can detect the anomaly).
 *   - Invalid JSON → returns `{ __raw: rawString }` so no information is
 *     lost; the tool layer can decide whether to fail or salvage.
 *   - Empty/null input → returns `{}` (the "no arguments" case).
 */
export function parseToolInput(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {};
  const parsed = safeParse<unknown>(raw);
  if (!parsed.ok) {
    // If raw JSON couldn't be parsed directly, but it starts/ends with quotes
    // (a string scalar containing JSON), try to unescape/parse it.
    const trimmed = raw.trim();
    if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
      const unescaped = safeParse<unknown>(raw);
      if (unescaped.ok && typeof unescaped.value === 'string') {
        const innerParsed = safeParse<unknown>(unescaped.value);
        if (innerParsed.ok && innerParsed.value && typeof innerParsed.value === 'object' && !Array.isArray(innerParsed.value)) {
          return innerParsed.value as Record<string, unknown>;
        }
      }
    }
    return { __raw: raw };
  }
  const v = parsed.value;
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    return v as Record<string, unknown>;
  }
  // Salvage case: parsed value is a string (scalar) but contains a serialized JSON object
  // (common when proxies/models map OpenAI arguments string directly to Anthropic input).
  if (typeof v === 'string') {
    const trimmed = v.trim();
    if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
      const parsed2 = safeParse<unknown>(trimmed);
      if (parsed2.ok && parsed2.value && typeof parsed2.value === 'object' && !Array.isArray(parsed2.value)) {
        return parsed2.value as Record<string, unknown>;
      }
    }
  }
  return { __raw: v ?? raw };
}
