/**
 * Main indexing orchestrator.
 *
 * Given a project root and a list of files:
 * 1. Parse each file with the appropriate parser (TS, Go, Python, Rust, JSON, YAML)
 * 2. Delete old symbols for changed/deleted files
 * 3. Insert new symbols
 * 4. Update file metadata
 * 5. Return index statistics
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { Dirent, Stats } from 'node:fs';
import type { Context } from '@wrongstack/core';
import { compileGlob } from '@wrongstack/core';
import type { FileMeta, IndexResult, Symbol as IndexSymbol } from './schema.js';
import { IndexStore } from './writer.js';
import { parseSymbols as parseTs, detectLang } from './ts-parser.js';
import { parseSymbols as parseGo } from './go-parser.js';
import { parseSymbols as parsePy } from './py-parser.js';
import { parseSymbols as parseRs } from './rs-parser.js';
import { parseSymbols as parseJson } from './json-parser.js';
import { parseSymbols as parseYaml } from './yaml-parser.js';

const DEFAULT_IGNORE = [
  'node_modules', '.git', 'dist', 'build', '.next', 'coverage',
  '.turbo', '__snapshots__', '.nyc_output',
];

interface IndexerOptions {
  projectRoot: string;
  files?: string[];
  force?: boolean;
  langs?: string[];
  ignore?: string[];
}

async function findSourceFiles(
  projectRoot: string,
  ignore: string[],
): Promise<string[]> {
  const results: string[] = [];
  const ignoreSet = new Set([...DEFAULT_IGNORE, ...ignore]);
  // compileGlob does not support brace expansion — use one pattern per extension
  const globs = [
    { ext: '.ts',   pat: compileGlob('**/*.ts') },
    { ext: '.tsx',  pat: compileGlob('**/*.tsx') },
    { ext: '.js',   pat: compileGlob('**/*.js') },
    { ext: '.jsx',  pat: compileGlob('**/*.jsx') },
    { ext: '.go',   pat: compileGlob('**/*.go') },
    { ext: '.py',   pat: compileGlob('**/*.py') },
    { ext: '.rs',   pat: compileGlob('**/*.rs') },
    { ext: '.json', pat: compileGlob('**/*.json') },
    { ext: '.yaml', pat: compileGlob('**/*.yaml') },
    { ext: '.yml',  pat: compileGlob('**/*.yml') },
  ];

  const walk = async (dir: string): Promise<void> => {
    let entries: Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (ignoreSet.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        await walk(full);
      } else if (e.isFile()) {
        // Normalize to forward-slash relative path for pattern matching
        const rel = path.relative(projectRoot, full).replace(/\\/g, '/');
        const ext = path.extname(e.name);
        for (const { ext: extName, pat } of globs) {
          if (ext === extName && (pat.test(rel) || pat.test(e.name))) {
            results.push(full);
            break;
          }
        }
      }
    }
  };

  await walk(projectRoot);
  return results;
}

/** Dispatch to the correct parser based on language. */
async function parseFile(
  file: string,
  content: string,
  lang: string,
): Promise<ReturnType<typeof parseTs>> {
  switch (lang) {
    case 'ts':
    case 'tsx':
    case 'js':
    case 'jsx':
      return parseTs({ file, content, lang: lang as 'ts' | 'tsx' | 'js' | 'jsx' });
    case 'go':
      return parseGo({ file, content, lang: 'go' });
    case 'py':
      return parsePy({ file, content, lang: 'py' });
    case 'rs':
      return parseRs({ file, content, lang: 'rs' });
    case 'json':
      return parseJson({ file, content, lang: 'json' });
    case 'yaml':
      return parseYaml({ file, content, lang: 'yaml' });
    default:
      return { file, lang: lang as 'ts' | 'tsx' | 'js' | 'jsx', symbols: [], mtimeMs: Date.now() };
  }
}

/** Run a full or incremental index and return statistics. */
export async function runIndexer(
  _ctx: Context,
  opts: IndexerOptions,
): Promise<IndexResult> {
  const { projectRoot, force = false, langs, ignore = [] } = opts;

  const store = new IndexStore(projectRoot);
  const startMs = Date.now();
  const errors: string[] = [];
  const langStats: Record<string, number> = {};
  let filesIndexed = 0;
  let symbolsIndexed = 0;

  let files: string[];
  if (opts.files && opts.files.length > 0) {
    files = opts.files.map((f) => path.resolve(projectRoot, f));
  } else {
    files = await findSourceFiles(projectRoot, ignore);
  }

  if (langs && langs.length > 0) {
    const langSet = new Set(langs);
    files = files.filter((f) => {
      const lang = detectLang(f);
      return lang ? langSet.has(lang) : false;
    });
  }

  if (force) store.clearAll();

  // Collect existing file metadata for incremental check
  const existingMeta: Map<string, FileMeta> = new Map();
  if (!force) {
    for (const meta of store.getAllFileMetas()) existingMeta.set(meta.file, meta);
  }

  for (const file of files) {
    let stat: Stats;
    try {
      stat = await fs.stat(file);
    } catch {
      store.deleteFile(file);
      continue;
    }
    if (!stat.isFile()) continue;

    const lang = detectLang(file);
    if (!lang) continue;

    const meta = existingMeta.get(file);
    if (!force && meta && meta.mtimeMs === Math.floor(stat.mtimeMs)) {
      langStats[lang] = (langStats[lang] ?? 0) + meta.symbolCount;
      symbolsIndexed += meta.symbolCount;
      filesIndexed++;
      continue;
    }

    store.deleteSymbolsForFile(file);
    store.deleteRefsForFile(file);

    let content: string;
    try {
      content = await fs.readFile(file, 'utf8');
    } catch (e) {
      errors.push(`read error: ${file}: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }

    let parsed: ReturnType<typeof parseTs>;
    try {
      parsed = await parseFile(file, content, lang);
    } catch (e) {
      errors.push(`parse error: ${file}: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }

    if (parsed.symbols.length === 0) {
      store.upsertFile({
        file,
        lang,
        mtimeMs: Math.floor(stat.mtimeMs),
        symbolCount: 0,
        lastIndexed: Date.now(),
      });
      filesIndexed++;
      continue;
    }

    const nextId = store.getStats().totalSymbols + 1;
    const symbolsWithIds: IndexSymbol[] = parsed.symbols.map((s, i) => ({ ...s, id: nextId + i }));
    store.insertSymbols(symbolsWithIds, nextId);
    const count = symbolsWithIds.length;
    symbolsIndexed += count;
    langStats[lang] = (langStats[lang] ?? 0) + count;

    // Insert cross-references for each symbol
    if (parsed.refs && parsed.refs.length > 0) {
      for (let i = 0; i < symbolsWithIds.length; i++) {
        const sym = symbolsWithIds[i]!;
        const symRefs = parsed.refs.filter((r) => r.line === sym.line);
        if (symRefs.length > 0) {
          const refsWithFromId = symRefs.map((r) => ({ ...r, fromId: sym.id }));
          store.insertRefs(sym.id, refsWithFromId);
        }
      }
    }

    store.upsertFile({
      file,
      lang,
      mtimeMs: Math.floor(stat.mtimeMs),
      symbolCount: count,
      lastIndexed: Date.now(),
    });

    filesIndexed++;
  }

  // Remove stale entries for files deleted since last run
  for (const [file_] of existingMeta) {
    try {
      await fs.stat(file_);
    } catch {
      store.deleteFile(file_);
    }
  }

  const durationMs = Date.now() - startMs;
  store.setLastIndexed(Date.now());
  store.close();

  return {
    filesIndexed,
    symbolsIndexed,
    langStats,
    durationMs,
    errors,
  };
}