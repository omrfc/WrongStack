/**
 * Attempt to close an incomplete JSON object string by auto-closing braces
 * and completing any unclosed double-quoted string values. This handles the
 * common streaming truncation case where the JSON stream ends mid-object
 * (e.g. `{"old_string": "line1\nline2` without the closing `"}` and `}`).
 *
 * Returns the completed string on best-effort, or the original if no useful
 * salvage was possible.
 */
export function completePartialObject(s: string): string {
  let result = s;

  const trimmed = result.trim();
  if (!trimmed.startsWith('{')) return s;

  // --- Pass 1: close unclosed braces (up to 3 passes for nesting) ---
  for (let pass = 0; pass < 3; pass++) {
    let braceDepth = 0;
    let inString = false;
    let escaped = false;
    let foundClose = false;

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

  if (tryParse(result).ok) return result;

  // --- Pass 2: detect unclosed string value ---
  // Walk backwards through the string tracking whether we are inside a
  // quoted string value. A quote is a CLOSING quote when followed by
  // `,` or `}` — it is an OPENING quote when followed by `:` (key name).
  // When followed by end-of-string (undefined), it may be either; we
  // use the "already inside a string" toggle to disambiguate.
  let inString = false;
  let escaped = false;
  for (let i = result.length - 1; i >= 0; i--) {
    const ch = result[i];
    if (escaped) { escaped = false; continue; }
    if (ch === '\\') { escaped = true; continue; }
    if (ch === '"') {
      // Look at the next non-whitespace character AFTER this quote.
      let nextNonWs: string | undefined;
      for (let j = i + 1; j < result.length; j++) {
        const nc = result[j];
        if (nc === ' ' || nc === '\t' || nc === '\n' || nc === '\r') continue;
        nextNonWs = result[j];
        break;
      }

      if (nextNonWs === ':') {
        // This quote belongs to a key name — skip it (not a value delimiter).
        continue;
      } else {
        // This quote is followed by `,`, `}`, or end-of-string.
        // Flip the in-string state: a closing quote takes us out, an
        // opening quote (value string) takes us in.
        inString = !inString;
        continue;
      }
    }
  }

  // If we are still inside a string, close it and any unclosed braces.
  if (inString) {
    result = result.trimEnd();
    // Strip trailing backslash (might be an incomplete escape sequence).
    if (result.endsWith('\\')) result = result.slice(0, -1);
    // Count open braces to know how many to close.
    let depth = 0;
    for (const ch of result) {
      if (ch === '{') depth++;
      else if (ch === '}') depth = Math.max(0, depth - 1);
    }
    result += '"' + '}'.repeat(Math.max(1, depth));
  }

  return result;
}

function tryParse(s: string): { ok: true; value: unknown } | { ok: false } {
  try { return { ok: true, value: JSON.parse(s) }; }
  catch { return { ok: false }; }
}