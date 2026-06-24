import { expectDefined } from '@wrongstack/core';
/**
 * Rust source symbol extraction.
 *
 * Tries to use the native `syn` crate via a cargo subproject (tools/syn-parser/).
 * Falls back to a robust regex-based extractor when cargo/syn is not available.
 *
 * The regex fallback extracts: fn, struct, enum, trait, impl, type, const, static, mod
 */

import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { FileSymbols, Symbol as IndexSymbol, SymbolLang } from './schema.js';
// ─── Public API ─────────────────────────────────────────────────────────────

export async function parseSymbols(opts: {
  file: string;
  content: string;
  lang: SymbolLang;
}): Promise<FileSymbols> {
  const { file, content, lang } = opts;

  // Try native parser first, fall back to regex
  const nativeAvailable = checkNativeParser();
  if (nativeAvailable) {
    const result = await tryNativeParse(file, content);
    if (result) return result;
  }

  return regexParse({ file, content, lang });
}

export { detectLang } from './ts-parser.js';

// ─── Native parser (syn) ─────────────────────────────────────────────────────

function checkNativeParser(): boolean {
  try {
    execFileSync('rustc', ['--version'], { stdio: 'pipe', windowsHide: true });
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
        { stdio: 'pipe', windowsHide: true },
      );
      return true;
    } catch {
      return false;
    }
  } catch {
    return false;
  }
}

async function tryNativeParse(file: string, content: string): Promise<FileSymbols | null> {
  try {
    const toolsDir = path.join(process.cwd(), 'tools');
    const crateDir = path.join(toolsDir, 'syn-parser');

    // Write source to temp file for cargo to read (async — non-blocking)
    const tmpFile = path.join(crateDir, 'src', 'input.rs');
    await fs.writeFile(tmpFile, content, 'utf8');

    // Use spawn for full async control with timeout via Promise.race + setTimeout kill
    const proc: ChildProcessWithoutNullStreams = spawn(
      'cargo',
      ['run', '--manifest-path', path.join(toolsDir, 'Cargo.toml')],
      {
        cwd: process.cwd(),
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      },
    );

    let stdout = '';
    proc.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });

    const { code } = await Promise.race([
      new Promise<{ code: number | null }>((resolve) => {
        proc.on('close', (c: number | null) => resolve({ code: c }));
      }),
      new Promise<{ code: number | null }>((_, reject) =>
        setTimeout(() => { proc.kill('SIGKILL'); reject(new Error('timeout')); }, 15_000)
      ),
    ]).catch(() => ({ code: -1 }));

    if (code === 0 && stdout.trim()) {
      const symbols: IndexSymbol[] = JSON.parse(stdout.trim());
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
    lineOffsets.push((lineOffsets[i] ?? 0) + (lines[i]?.length ?? 0) + 1);
  }

  function lineFromOffset(offset: number): number {
    let lo = 0;
    let hi = lineOffsets.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >>> 1;
      if (expectDefined(lineOffsets[mid]) <= offset) lo = mid;
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
      const name = expectDefined(match[1]);
      const offset = (match.index ?? 0);
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
