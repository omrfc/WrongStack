import { expectDefined } from './expect-defined.js';
/**
 * Glob pattern → concrete file path expansion.
 *
 * Supports: *, **, ?, [...]
 * Does NOT support brace expansion {a,b}.
 *
 * Returns the input as-is if it contains no glob metacharacters.
 * On Windows, both / and \ are accepted as path separators.
 */

import * as fsp from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
const GLOB_CHARS = new Set(['*', '?', '[']);
const IS_WINDOWS = process.platform === 'win32';
const SEP = IS_WINDOWS ? '\\' : '/';

function isGlob(p: string): boolean {
  for (const c of p) {
    if (GLOB_CHARS.has(c)) return true;
  }
  return false;
}

function globToRegex(pat: string): RegExp {
  let i = 0;
  let re = '^';
  while (i < pat.length) {
    const c = expectDefined(pat[i]);
    if (c === '*') {
      if (pat[i + 1] === '*') {
        re += '.*';
        i += 2;
        if (pat[i] === '/') i++;
      } else {
        re += '[^/\\\\]*';
        i++;
      }
    } else if (c === '?') {
      re += '[^/\\\\]';
      i++;
    } else if (c === '[') {
      let cls = '[';
      i++;
      if (pat[i] === '!' || pat[i] === '^') {
        cls += '^';
        i++;
      }
      while (i < pat.length && pat[i] !== ']') {
        const ch = pat[i] ?? '';
        if (ch === '\\') cls += '\\\\';
        else if (ch === ']' || ch === '^') cls += `\\${ch}`;
        else cls += ch;
        i++;
      }
      cls += ']';
      re += cls;
      i++;
    } else {
      re += c.replace(/[.+^${}()|\\]/g, '\\$&');
      i++;
    }
  }
  return new RegExp(re + '$');
}

function baseDir(pat: string): string {
  let i = pat.length - 1;
  while (i >= 0 && !GLOB_CHARS.has(expectDefined(pat[i])) && pat[i] !== SEP && pat[i] !== '/') i--;
  const cut = i >= 0 ? pat.lastIndexOf(SEP, i) : pat.lastIndexOf('/', i);
  return cut < 0 ? '.' : pat.slice(0, cut);
}

/**
 * Resolve `pattern` to the set of concrete file paths it matches.
 * Literal paths (no glob chars) are returned as-is.
 *
 * @example
 * await expandGlob('src/**\/*.ts')  // → ['src/a.ts', 'src/b/c.ts', ...]
 * await expandGlob('foo.txt')       // → ['foo.txt']
 */
export async function expandGlob(pattern: string): Promise<string[]> {
  if (!isGlob(pattern)) return [pattern];

  const results = new Set<string>();
  const abs = isAbsolute(pattern);
  const base = abs ? baseDir(pattern) : baseDir(pattern);
  const relPat = base === '.' ? pattern : pattern.slice(base.length + 1);

  async function walk(dir: string, pat: string): Promise<void> {
    let entries: string[];
    try {
      entries = await fsp.readdir(dir);
    } catch {
      return;
    }

    const firstGlob = pat.search(/[*?[\[]/);

    if (firstGlob < 0) {
      const re = globToRegex(pat);
      for (const e of entries) {
        if (re.test(e)) {
          const full = `${dir}${SEP}${e}`;
          results.add(abs ? resolve(full) : full);
        }
      }
      return;
    }

    const before = pat.slice(0, firstGlob);
    const rest = pat.slice(firstGlob);

    if (before.endsWith('**')) {
      // Match at current dir then recurse into subdirs
      await walk(dir, rest);
      for (const e of entries) {
        const full = `${dir}${SEP}${e}`;
        try {
          const stat = await fsp.stat(full);
          if (stat.isDirectory()) await walk(full, rest);
        } catch {
          /* skip inaccessible */
        }
      }
    } else if (before === '') {
      // Pattern starts with a glob char — match files in current dir only
      const re = globToRegex(rest);
      for (const e of entries) {
        if (re.test(e)) {
          const full = `${dir}${SEP}${e}`;
          results.add(abs ? resolve(full) : full);
        }
      }
    } else {
      // Literal segment(s) before the glob — descend into matching subdir
      const seg = before.replace(/[*?[\]]/g, '').replace(/\/$/, '');
      if (entries.includes(seg)) {
        const full = `${dir}${SEP}${seg}`;
        try {
          const stat = await fsp.stat(full);
          if (stat.isDirectory()) await walk(full, rest);
        } catch {
          /* skip */
        }
      }
    }
  }

  await walk(base === '.' ? '.' : base, relPat);
  return [...results];
}
