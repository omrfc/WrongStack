import { safeParse } from '@wrongstack/core';

/**
 * Attempt to close an incomplete JSON object string by auto-closing braces
 * and completing any unclosed double-quoted string values. This handles the
 * common streaming truncation case where the JSON stream ends mid-object
 * (e.g. `{"old_string": "line1\nline2` without the closing `"}` and `}`).
 *
 * Returns the completed string on best-effort, or the original if nothing
 * meaningful could be salvaged.
 */
function completePartialObject(s: string): string {
  let result = s;

  const trimmed = result.trim();
  if (!trimmed.startsWith('{')) return s;

  // Close unclosed braces (up to 3 passes for nested structures).
  for (let pass = 0; pass < 3; pass++) {
    let braceDepth = 0;
    let inString = false;
    let escaped = false;
    let foundClose = true;

    for (const ch of result) {
      if (escaped) { escaped = false; continue; }
      if (ch === '\\') { escaped = true; continue; }
      if (ch === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (ch === '{') { braceDepth++; foundClose = false; }
      else if (ch === '}') {
        braceDepth--;
        if (braceDepth === 0) foundClose = true;
      }
    }

    if (foundClose || braceDepth <= 0) break;
    result += '}'.repeat(braceDepth);
  }

  // If it now parses, return the brace-closed version.
  if (safeParse(result).ok) return result;

  // Detect if we ended inside an unclosed string value.
  // Walk the string end looking for context.
  let inString = false;
  let escaped = false;
  for (let i = result.length - 1; i >= 0; i--) {
    const ch = result[i];
    if (escaped) { escaped = false; continue; }
    if (ch === '\\') { escaped = true; continue; }
    if (ch === '"') {
      // Look at what follows this quote outside strings
      let nextNonWs: string | undefined;
      for (let j = i + 1; j < result.length; j++) {
        const nc = result[j];
        if (nc === ' ' || nc === '\t' || nc === '\n' || nc === '\r') continue;
        nextNonWs = result[j];
        break;
      }
      if (nextNonWs === ':') {
        // This quote opens a key — the NEXT unescaped quote should close it
        inString = true;
        continue;
      } else if (nextNonWs === ',' || nextNonWs === '}') {
        if (inString) { inString = false; continue; }
      }
    }
  }

  // If still inside a string, close it and any unclosed braces.
  if (inString) {
    result = result.trimEnd();
    if (result.endsWith('\\')) result = result.slice(0, -1);
    let depth = 0;
    for (const ch of result) {
      if (ch === '{') depth++;
      else if (ch === '}') depth = Math.max(0, depth - 1);
    }
    result += '"' + '}'.repeat(Math.max(1, depth));
  }

  return result;
}

/**
 * Parse a tool-call arguments JSON blob into a canonical
 * `Record<string, unknown>`.
 *
 * Why this exists: providers stream tool-call arguments as raw JSON strings
 * accumulated over multiple `delta` events. Once complete, callers want a
 * dictionary. Naive `JSON.parse` plus `as Record<string, unknown>` is unsafe
 * — a buggy provider, a proxy that rewrites payloads, or a future API change
 * can yield `null`, an array, or a number, all of which would
 * type-check fine but crash downstream tool executors that index into the
 * input by key.
 *
 * Result contract:
 *   - Valid JSON object → returned as-is, typed as `Record<string, unknown>`.
 *   - Valid JSON array / scalar → wrapped under `{ __raw: value }` so the
 *     tool still receives an object (the executor can detect the anomaly).
 *   - Invalid/truncated JSON → attempt partial JSON salvage (auto-close braces
 *     and strings); if that fails, return `{ __raw: rawString }` so no
 *     information is lost; the tool layer can decide whether to fail or salvage.
 *   - Empty/null input → returns `{}` (the "no arguments" case).
 */
export function parseToolInput(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {};
  let parsed = safeParse<unknown>(raw);

  // Fast path: parsed cleanly into an object
  if (parsed.ok && parsed.value && typeof parsed.value === 'object' && !Array.isArray(parsed.value)) {
    return parsed.value as Record<string, unknown>;
  }

  // Slow path: parse failed or didn't yield an object.
  // Attempt to salvage a truncated streaming JSON blob before giving up.
  if (!parsed.ok || parsed.value == null || typeof parsed.value !== 'object' || Array.isArray(parsed.value)) {
    const completed = completePartialObject(raw);
    parsed = safeParse<unknown>(completed);
  }

  if (parsed.ok && parsed.value && typeof parsed.value === 'object' && !Array.isArray(parsed.value)) {
    return parsed.value as Record<string, unknown>;
  }

  // Second salvage: if raw couldn't be parsed but looks like a string containing
  // a serialized JSON object (double-wrapped), unwrap it.
  const trimmed = raw.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    const unescaped = safeParse<unknown>(raw);
    if (unescaped.ok && typeof unescaped.value === 'string') {
      const inner = safeParse<unknown>(unescaped.value);
      if (inner.ok && inner.value && typeof inner.value === 'object' && !Array.isArray(inner.value)) {
        return inner.value as Record<string, unknown>;
      }
    }
  }

  // Salvage case: parsed value is a string (scalar) but contains a serialized
  // JSON object (common when proxies/models map OpenAI arguments string directly
  // to Anthropic input).
  if (parsed.ok && typeof parsed.value === 'string') {
    const innerTrimmed = parsed.value.trim();
    if (innerTrimmed.startsWith('{') && innerTrimmed.endsWith('}')) {
      const inner = safeParse<unknown>(innerTrimmed);
      if (inner.ok && inner.value && typeof inner.value === 'object' && !Array.isArray(inner.value)) {
        return inner.value as Record<string, unknown>;
      }
    }
  }

  // Give up — wrap under the sentinel key so the tool still receives an object.
  // Prefer the parsed scalar/array value (so a valid `[1,2,3]` / `42` / `"x"`
  // is preserved structurally); fall back to the original raw string when the
  // input couldn't be parsed at all. No information is lost either way.
  const fallback = parsed.ok ? parsed.value : undefined;
  return { __raw: fallback ?? raw };
}