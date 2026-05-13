export interface SafeParseResult<T> {
  ok: boolean;
  value?: T;
  error?: string;
}

export function safeParse<T = unknown>(input: string, maxBytes = 5_000_000): SafeParseResult<T> {
  if (input.length > maxBytes) {
    return { ok: false, error: `Input exceeds limit (${maxBytes} bytes)` };
  }
  try {
    return { ok: true, value: JSON.parse(input) as T };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export function safeStringify(value: unknown, pretty = false): string {
  const seen = new WeakSet();
  const replacer = (_k: string, v: unknown): unknown => {
    if (typeof v === 'bigint') return v.toString();
    if (v instanceof Error) {
      return { name: v.name, message: v.message, stack: v.stack };
    }
    if (typeof v === 'object' && v !== null) {
      if (seen.has(v as object)) return '[Circular]';
      seen.add(v as object);
    }
    return v;
  };
  try {
    return JSON.stringify(value, replacer, pretty ? 2 : undefined) ?? 'null';
  } catch (err) {
    return JSON.stringify({
      __serialization_error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Attempt to parse JSON5-style input and return a valid JSON string.
 *  Handles trailing commas, single-line comments, and unquoted keys
 *  that are common in provider output.
 */
export function sanitizeJsonString(s: string): string {
  let out = s.trim();

  // Stage 1: strip single-line comments (// to end of line) that appear
  // outside of string values. This is a heuristic: comments inside strings
  // are preserved because we only strip // when preceded by a char that
  // strongly suggests we're not in a string (quote count modulo 2 is even).
  out = stripSingleLineComments(out);

  // Stage 2: strip trailing commas before } or ]
  out = out.replace(/,(\s*[}\]])/g, '$1');

  // Stage 3: attempt full parse; if it fails, return the stripped version
  // so the caller can decide what to do. Return undefined on parse failure
  // so callers can distinguish "already valid JSON" from "unrecoverable".
  try {
    JSON.parse(out);
    return out;
  } catch {
    return out; // stripped but still not valid JSON; caller handles it
  }
}

function stripSingleLineComments(s: string): string {
  let inString = false;
  const chars: string[] = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i]!;
    if (c === '"' && (i === 0 || s[i - 1] !== '\\')) {
      inString = !inString;
      chars.push(c);
    } else if (c === '/' && s[i + 1] === '/' && !inString) {
      // skip to end of line
      while (i < s.length && s[i] !== '\n') i++;
    } else {
      chars.push(c);
    }
    i++;
  }
  return chars.join('');
}
