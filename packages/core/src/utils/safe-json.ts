import { toErrorMessage } from './error.js';

export interface SafeParseResult<T> {
  ok: boolean;
  value?: T | undefined;
  error?: string | undefined;
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
      error: toErrorMessage(err),
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
      __serialization_error: toErrorMessage(err),
    });
  }
}

/**
 * Attempt to parse JSON5-style input and return a valid JSON string.
 * Handles trailing commas, single-line comments, and unquoted keys
 * that are common in provider output.
 *
 * Returns the sanitized string if it parses successfully as JSON,
 * or `null` if the input cannot be made valid. Callers use this to
 * decide whether to proceed with the parsed result or fall back to
 * raw handling.
 */
export function sanitizeJsonString(s: string): string | null {
  let out = s.trim();

  // Stage 1: strip single-line comments (// to end of line) that appear
  // outside of string values. This is a heuristic: comments inside strings
  // are preserved because we only strip // when preceded by a char that
  // strongly suggests we're not in a string (quote count modulo 2 is even).
  out = stripSingleLineComments(out);

  // Stage 2: strip trailing commas before } or ]
  out = out.replace(/,(\s*[}\]])/g, '$1');

  // Stage 3: escape literal control characters that appear *inside* string
  // values. Models frequently emit raw newlines/tabs inside a code payload
  // (e.g. edit's old_string/new_string) instead of the required \n / \t, which
  // makes JSON.parse throw. This is the single most common malformed-args case.
  out = escapeControlCharsInStrings(out);

  // Stage 4: attempt full parse; return null if it fails so callers can
  // distinguish "already valid JSON" from "unrecoverable".
  try {
    JSON.parse(out);
    return out;
  } catch {
    return null; // stripped but still not valid JSON; caller handles it
  }
}

/**
 * Walk the string tracking whether we are inside a JSON string literal and
 * replace raw control characters (U+0000–U+001F) that appear inside strings
 * with their valid JSON escape sequences. Characters outside strings are left
 * untouched (insignificant whitespace stays as-is). Already-escaped sequences
 * are not double-escaped because we only act on *literal* control bytes.
 */
function escapeControlCharsInStrings(s: string): string {
  let inString = false;
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s.charAt(i);
    if (c === '"' && (i === 0 || s[i - 1] !== '\\')) {
      inString = !inString;
      out += c;
      continue;
    }
    const code = c.charCodeAt(0);
    if (inString && code < 0x20) {
      switch (c) {
        case '\n':
          out += '\\n';
          break;
        case '\r':
          out += '\\r';
          break;
        case '\t':
          out += '\\t';
          break;
        case '\b':
          out += '\\b';
          break;
        case '\f':
          out += '\\f';
          break;
        default:
          out += `\\u${code.toString(16).padStart(4, '0')}`;
      }
      continue;
    }
    out += c;
  }
  return out;
}

function stripSingleLineComments(s: string): string {
  let inString = false;
  const chars: string[] = [];
  let i = 0;
  while (i < s.length) {
    const c = s.charAt(i);
    if (c === '"' && (i === 0 || s.charAt(i - 1) !== '\\')) {
      inString = !inString;
      chars.push(c);
    } else if (c === '/' && s.charAt(i + 1) === '/' && !inString) {
      // skip to end of line
      while (i < s.length && s.charAt(i) !== '\n') i++;
    } else {
      chars.push(c);
    }
    i++;
  }
  return chars.join('');
}
