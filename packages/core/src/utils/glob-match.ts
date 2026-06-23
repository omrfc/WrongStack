import { expectDefined } from './expect-defined.js';
/**
 * Minimal glob matcher for trust patterns.
 * Supports: *, **, ?, character classes [abc], [a-z], negation [!...] or [^...].
 *
 * Compiled regexes are cached so repeated calls with the same pattern
 * avoid recompilation overhead.
 */

function escapeRegex(s: string): string {
  return s.replace(/[.+^${}()|\\]/g, '\\$&');
}

// Module-level cache to avoid recompiling the same pattern on every call.
// LRU-ish eviction keeps unbounded growth in check for long-running processes.
const COMPILED_GLOB_CACHE = new Map<string, RegExp>();
const CACHE_MAX_SIZE = 2000;

// Matches nothing — `[^\s\S]` can never be satisfied. Used as the cached
// result for patterns that fail to compile (e.g. an over-long auto-trusted
// command) so one bad trust entry degrades to "no match" instead of throwing.
const NEVER_MATCH = /[^\s\S]/;

function getCachedGlob(pattern: string): RegExp {
  const cached = COMPILED_GLOB_CACHE.get(pattern);
  if (cached) return cached;
  if (COMPILED_GLOB_CACHE.size >= CACHE_MAX_SIZE) {
    // Evict oldest 25% when at capacity
    const keys = [...COMPILED_GLOB_CACHE.keys()];
    for (let i = 0; i < Math.floor(CACHE_MAX_SIZE / 4); i++) {
      COMPILED_GLOB_CACHE.delete(expectDefined(keys[i]));
    }
  }
  let re: RegExp;
  try {
    re = compileGlob(pattern);
  } catch {
    // A pathological trust pattern (over MAX_GLOB_PATTERN_LEN — e.g. a long
    // one-liner auto-trusted in YOLO/Auto mode) must NOT throw out of every
    // subsequent permission check and break unrelated commands like `true`
    // or `ls` (#20). Cache a never-matching regex so the bad entry is inert.
    re = NEVER_MATCH;
  }
  COMPILED_GLOB_CACHE.set(pattern, re);
  return re;
}

// Cap glob pattern length to prevent excessively long compiled regexes.
const MAX_GLOB_PATTERN_LEN = 1024;

export function compileGlob(pattern: string): RegExp {
  if (pattern.length > MAX_GLOB_PATTERN_LEN) {
    throw new Error(`Glob pattern exceeds ${MAX_GLOB_PATTERN_LEN} characters`);
  }
  let i = 0;
  let re = '^';
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        // ** matches any number of chars including /
        re += '.*';
        i += 2;
        // Skip trailing slash so '**/x' matches 'x'
        if (pattern[i] === '/') i++;
      } else {
        // single * matches any chars except /
        re += '[^/]*';
        i++;
      }
    } else if (c === '?') {
      re += '[^/]';
      i++;
    } else if (c === '[') {
      let cls = '[';
      i++;
      if (pattern[i] === '!' || pattern[i] === '^') {
        cls += '^';
        i++;
      }
      while (i < pattern.length && pattern[i] !== ']') {
        const ch = pattern[i] ?? '';
        // Inside a regex class, only `]`, `\`, and `^`/`-` at boundaries need
        // escaping. We've already consumed the leading `^`; the rest are
        // literal. Escape `\` defensively and pass the rest through verbatim
        // so ranges like `a-z` continue to work.
        if (ch === '\\') {
          cls += '\\\\';
        } else if (ch === ']' || ch === '^') {
          cls += `\\${ch}`;
        } else {
          cls += ch;
        }
        i++;
      }
      cls += ']';
      re += cls;
      i++; // skip closing ]
    } else {
      re += escapeRegex(c ?? '');
      i++;
    }
  }
  re += '$';
  return new RegExp(re);
}

export function matchGlob(pattern: string, input: string): boolean {
  return getCachedGlob(pattern).test(input);
}

export function matchAny(patterns: string[], input: string): boolean {
  return patterns.some((p) => matchGlob(p, input));
}
