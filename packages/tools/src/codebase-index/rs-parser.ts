/**
 * Rust source symbol extraction.
 *
 * Tries to use the native `syn` crate via a cargo subproject (tools/syn-parser/).
 * Falls back to a robust regex-based extractor when cargo/syn is not available.
 *
 * The regex fallback extracts: fn, struct, enum, trait, impl, type, const, static, mod
 */

import { execFileSync, spawnSync } from 'node:child_process';
import * as path from 'node:path';
import type { FileSymbols, Symbol as IndexSymbol, SymbolLang } from './schema.js';

// ─── Public API ─────────────────────────────────────────────────────────────

export function parseSymbols(opts: {
  file: string;
  content: string;
  lang: SymbolLang;
}): FileSymbols {
  const { file, content, lang } = opts;

  // Try native parser first, fall back to regex
  const nativeAvailable = checkNativeParser();
  if (nativeAvailable) {
    const result = tryNativeParse(file, content);
    if (result) return result;
  }

  return regexParse({ file, content, lang });
}

export { detectLang } from './ts-parser.js';

// ─── Native parser (syn) ─────────────────────────────────────────────────────

function checkNativeParser(): boolean {
  try {
    execFileSync('rustc', ['--version'], { stdio: 'pipe' });
    // Check if our syn-parser crate is available. argv-array form (no shell)
    // so a cwd path containing spaces or shell metacharacters can't break out.
    const toolsDir = path.join(process.cwd(), 'tools');
    try {
      execFileSync(
        'cargo',
        [
          'metadata',
          '--no-deps',
          '--format-version',
          '1',
          '--manifest-path',
          path.join(toolsDir, 'Cargo.toml'),
        ],
        { stdio: 'pipe' },
      );
      return true;
    } catch {
      return false;
    }
  } catch {
    return false;
  }
}

function tryNativeParse(file: string, content: string): FileSymbols | null {
  try {
    const toolsDir = path.join(process.cwd(), 'tools');
    const crateDir = path.join(toolsDir, 'syn-parser');

    // Write source to temp file for cargo to read
    const tmpFile = path.join(crateDir, 'src', 'input.rs');
    const { writeFileSync } = require('node:fs');
    writeFileSync(tmpFile, content, 'utf8');

    const result = spawnSync(
      'cargo',
      ['run', '--manifest-path', path.join(toolsDir, 'Cargo.toml')],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        timeout: 15000,
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );

    if (result.status === 0 && result.stdout) {
      const symbols: IndexSymbol[] = JSON.parse(result.stdout);
      return {
        file,
        lang: 'rs',
        symbols: symbols.map((s) => ({ ...s, id: 0, lang: 'rs' as SymbolLang })),
        mtimeMs: Date.now(),
      };
    }
  } catch {
    // Fall through to regex
  }
  return null;
}

// ─── Regex fallback parser ───────────────────────────────────────────────────

interface RustPattern {
  regex: RegExp;
  kind: IndexSymbol['kind'];
}

const RS_PATTERNS: RustPattern[] = [
  { regex: /fn\s+(\w+)\s*\([^)]*\)/g, kind: 'function' },
  { regex: /struct\s+(\w+)/g, kind: 'struct' },
  { regex: /enum\s+(\w+)/g, kind: 'enum' },
  { regex: /trait\s+(\w+)/g, kind: 'trait' },
  { regex: /impl\s+(?:<[^>]+>)?(\w+)/g, kind: 'impl' },
  { regex: /type\s+(\w+)\s*=/g, kind: 'type' },
  { regex: /const\s+(\w+)/g, kind: 'const' },
  { regex: /static\s+(\w+)/g, kind: 'static' },
  { regex: /mod\s+(\w+)/g, kind: 'mod' },
];

function regexParse(opts: { file: string; content: string; lang: SymbolLang }): FileSymbols {
  const { file, content, lang } = opts;
  const symbols: IndexSymbol[] = [];
  const lines = content.split('\n');

  // Build line offset map
  const lineOffsets: number[] = [0];
  for (let i = 0; i < lines.length; i++) {
    lineOffsets.push(lineOffsets[i]! + lines[i]!.length + 1);
  }

  function lineFromOffset(offset: number): number {
    let lo = 0;
    let hi = lineOffsets.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >>> 1;
      if (lineOffsets[mid]! <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1; // 1-based
  }

  function extractDeclaration(lineIdx: number, _match: RegExpExecArray): string {
    const line = lines[lineIdx] ?? '';
    return line.trim().slice(0, 500);
  }

  for (const pattern of RS_PATTERNS) {
    pattern.regex.lastIndex = 0;
    for (
      let match = pattern.regex.exec(content);
      match !== null;
      match = pattern.regex.exec(content)
    ) {
      const name = match[1]!;
      const offset = match.index!;
      const line = lineFromOffset(offset);
      const col = offset - (lineOffsets[line - 1] ?? 0);
      const lineIdx = line - 1;
      const signature = extractDeclaration(lineIdx, match);

      symbols.push({
        id: 0,
        lang,
        kind: pattern.kind,
        name,
        file,
        line,
        col,
        signature,
        docComment: '',
        scope: '',
        text: `${name} ${signature}`.trim(),
      });
    }
  }

  // Deduplicate by name+line
  const seen = new Set<string>();
  const deduped = symbols.filter((s) => {
    const key = `${s.name}:${s.line}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return { file, lang, symbols: deduped, mtimeMs: Date.now() };
}
