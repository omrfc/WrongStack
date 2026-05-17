/**
 * Compile a user-supplied regex with conservative bounds against ReDoS.
 *
 * Duplicated from @wrongstack/tools/_regex.ts to avoid a circular
 * dependency (tools depends on core, not vice versa). Keep both copies
 * in sync if the heuristics change.
 *
 * V8's regex engine is backtracking-based and cannot interrupt a
 * synchronous match — a pattern like `(a+)+$` against a sufficiently
 * long line will pin a worker for seconds.
 */

const MAX_PATTERN_LEN = 512;

// Heuristics for catastrophic-backtracking constructs.
const DANGEROUS_PATTERNS: ReadonlyArray<RegExp> = [
  /(\([^)]*[+*][^)]*\))[+*]/, // (a+)+, (.*)+, etc
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

export function compileUserRegex(pattern: string, flags: string): CompileResult | CompileFail {
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
        reason:
          'pattern looks vulnerable to catastrophic backtracking — rewrite without nested quantifiers',
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
