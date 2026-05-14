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
  if (!parsed.ok) return { __raw: raw };
  const v = parsed.value;
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    return v as Record<string, unknown>;
  }
  return { __raw: v ?? raw };
}
