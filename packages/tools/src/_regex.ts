/**
 * Compile a user-supplied regex with conservative bounds against ReDoS.
 *
 * Node's regex engine (V8) is backtracking-based and cannot interrupt a
 * synchronous match — a pattern like `(a+)+$` against a sufficiently long
 * line will pin a worker for seconds. The executor's outer `timeoutMs` only
 * fires between async boundaries, so a long regex eval inside a sync loop
 * is uninterruptible.
 *
 * We can't fully prevent ReDoS without an alternative engine (re2-wasm), but
 * we can sharply limit the blast radius:
 *
 *  1. Cap pattern length — practically all legitimate user patterns are
 *     under 256 characters. A 4 KB pattern is almost certainly malicious
 *     or a copy-paste accident.
 *  2. Reject patterns containing the most obvious super-linear structures.
 *     This is a coarse filter (false-positives are likely; we accept that
 *     for hostile-input contexts).
 *
 * Callers should additionally bound the *subject* length (e.g. by capping
 * line size before matching).
 */

const MAX_PATTERN_LEN = 512;

// Heuristics for catastrophic-backtracking constructs. Not exhaustive; bias
// toward false-positives in tools that accept LLM-generated input.
const DANGEROUS_PATTERNS: ReadonlyArray<RegExp> = [
  /(\([^)]*[+*][^)]*\))[+*]/, // (a+)+, (.*)+, etc — nested quantifier on a group with internal quantifier
  /(\(\?:[^)]*[+*][^)]*\))[+*]/, // same, with non-capturing group
];

export interface CompileResult {
  ok: true;
  regex: RegExp;
}

export interface CompileFail {
  ok: false;
  reason: string;
}

export function compileUserRegex(
  pattern: string,
  flags: string,
): CompileResult | CompileFail {
  if (typeof pattern !== 'string') {
    return { ok: false, reason: 'pattern must be a string' };
  }
  if (pattern.length === 0) {
    return { ok: false, reason: 'pattern is empty' };
  }
  if (pattern.length > MAX_PATTERN_LEN) {
    return { ok: false, reason: `pattern exceeds ${MAX_PATTERN_LEN} characters` };
  }
  for (const rx of DANGEROUS_PATTERNS) {
    if (rx.test(pattern)) {
      return {
        ok: false,
        reason: 'pattern looks vulnerable to catastrophic backtracking — rewrite without nested quantifiers',
      };
    }
  }
  try {
    return { ok: true, regex: new RegExp(pattern, flags) };
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : 'invalid regex',
    };
  }
}

/**
 * Truncate a subject line to a safe length for synchronous regex eval.
 * The cap is conservative; tools that need exact-line matching against very
 * long lines should use ripgrep externally rather than the native walker.
 */
export const MAX_SUBJECT_LEN = 64 * 1024;

export function capSubject(line: string): string {
  return line.length > MAX_SUBJECT_LEN ? line.slice(0, MAX_SUBJECT_LEN) : line;
}
