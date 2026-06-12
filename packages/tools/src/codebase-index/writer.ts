import { expectDefined } from '@wrongstack/core';
/**
 * SQLite storage layer for the codebase index.
 *
 * Uses `node:sqlite` (synchronous API — DatabaseSync class).
 * Database file: ~/.wrongstack/projects/<hash>/codebase-index/index.db — kept
 * out of the repo so it never clutters the working tree or needs gitignoring.
 */

import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { resolveWstackPaths } from '@wrongstack/core';
import type { FileMeta, IndexStats, Ref, SearchResult, Symbol as IndexSymbol, SymbolKind, SymbolLang } from './schema.js';
import { SCHEMA_VERSION } from './schema.js';
import { lspKindToInternalKind } from './lsp-kind.js';
const DB_FILE = 'index.db';

/**
 * Resolve the per-project index directory. By default it lives under the
 * global project dir (`~/.wrongstack/projects/<hash>/codebase-index`),
 * matching every other piece of per-project state. Callers may pass an
 * explicit `override` (used by tests and any wiring that already resolved the
 * path) to avoid touching the real home directory.
 */
export function resolveIndexDir(projectRoot: string, override?: string): string {
  return override ?? resolveWstackPaths({ projectRoot }).projectCodebaseIndex;
}

/**
 * Optional index-directory override carried on the run context's `meta` bag.
 * Production leaves it unset (the index resolves to the global per-project
 * dir); tests and bespoke wiring set `meta.codebaseIndexDir` to redirect it.
 */
export function codebaseIndexDirOverride(ctx: { meta?: Record<string, unknown> }): string | undefined {
  const v = ctx.meta?.['codebaseIndexDir'];
  return typeof v === 'string' ? v : undefined;
}

let warningSilenced = false;
/**
 * Swallow the one-time `ExperimentalWarning: SQLite ...` Node prints the first
 * time `node:sqlite` loads. Patched only once, and only filters that specific
 * warning — every other warning passes through untouched.
 */
function silenceSqliteExperimentalWarning(): void {
  if (warningSilenced) return;
  warningSilenced = true;
  const original = process.emitWarning.bind(process);
  process.emitWarning = ((warning: unknown, ...rest: unknown[]): void => {
    const msg = typeof warning === 'string' ? warning : ((warning as Error)?.message ?? '');
    const name = typeof warning === 'string' ? String(rest[0] ?? '') : ((warning as Error)?.name ?? '');
    if (/sqlite/i.test(msg) && /experimental/i.test(`${name} ${msg}`)) return;
    (original as (w: unknown, ...r: unknown[]) => void)(warning, ...rest);
  }) as typeof process.emitWarning;
}

let DatabaseSyncCtor: typeof DatabaseSync | undefined;
/**
 * Load `node:sqlite`'s `DatabaseSync` lazily. Keeping this off the module's
 * top-level import means the codebase-index tools can be registered at CLI boot
 * without eagerly loading SQLite — so a runtime that lacks `node:sqlite` (it is
 * experimental, available since Node 22.5) only fails if the index is actually
 * used, with a clear message instead of a crash on import.
 */
function loadDatabaseSync(): typeof DatabaseSync {
  if (DatabaseSyncCtor) return DatabaseSyncCtor;
  silenceSqliteExperimentalWarning();
  try {
    const req = createRequire(import.meta.url);
    DatabaseSyncCtor = (req('node:sqlite') as typeof import('node:sqlite')).DatabaseSync;
  } catch (err) {
    throw new Error(
      "The codebase index needs Node's built-in SQLite (node:sqlite), available since Node 22.5. " +
        `This runtime doesn't provide it: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return DatabaseSyncCtor;
}

export class IndexStore {
  private db: DatabaseSync;
  /** Absolute path to this project's index directory. */
  private readonly indexDir: string;

  constructor(projectRoot: string, opts: { indexDir?: string | undefined } = {}) {
    this.indexDir = resolveIndexDir(projectRoot, opts.indexDir);
    fs.mkdirSync(this.indexDir, { recursive: true });
    const Database = loadDatabaseSync();
    this.db = new Database(path.join(this.indexDir, DB_FILE));
    // Multi-process safety: several wstack surfaces (TUI, WebUI, parallel
    // terminals) share this per-project db. WAL lets readers coexist with the
    // writer, and busy_timeout bounds lock waits to a short, finite block —
    // DatabaseSync is synchronous, so an unbounded wait here would freeze the
    // whole event loop (and with it the terminal UI). Past the timeout the
    // statement throws SQLITE_BUSY, which the indexing circuit breaker counts
    // as a failure instead of wedging.
    try {
      this.db.exec('PRAGMA journal_mode = WAL');
      this.db.exec('PRAGMA busy_timeout = 1500');
    } catch {
      /* pragmas are best-effort — an old SQLite build without WAL still works */
    }
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS files (
        file TEXT PRIMARY KEY,
        lang TEXT NOT NULL,
        mtime_ms INTEGER NOT NULL,
        symbol_count INTEGER NOT NULL DEFAULT 0,
        last_indexed INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS symbols (
        id INTEGER PRIMARY KEY,
        lang TEXT NOT NULL,
        kind TEXT NOT NULL,
        name TEXT NOT NULL,
        file TEXT NOT NULL,
        line INTEGER NOT NULL,
        col INTEGER NOT NULL,
        signature TEXT NOT NULL DEFAULT '',
        doc_comment TEXT NOT NULL DEFAULT '',
        scope TEXT NOT NULL DEFAULT '',
        text TEXT NOT NULL DEFAULT '',
        file_fk TEXT NOT NULL
      );
    `);

    this.db.exec('CREATE INDEX IF NOT EXISTS idx_s_name ON symbols(name)');
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_s_kind ON symbols(kind)');
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_s_lang ON symbols(lang)');
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_s_file ON symbols(file)');

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS refs (
        id INTEGER PRIMARY KEY,
        from_id INTEGER NOT NULL,
        to_name TEXT NOT NULL,
        to_id INTEGER,
        call_type TEXT NOT NULL,
        line INTEGER NOT NULL
      );
    `);

    this.db.exec('CREATE INDEX IF NOT EXISTS idx_r_from ON refs(from_id)');
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_r_to_id ON refs(to_id)');
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_r_to_name ON refs(to_name)');
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_r_call_type ON refs(call_type)');

    const versionRows = this.db.prepare('SELECT value FROM metadata WHERE key = ?').all('version');
    if (!versionRows.length) {
      this.db.prepare('INSERT INTO metadata(key, value) VALUES (?, ?)').run('version', String(SCHEMA_VERSION));
    }
  }

  // ─── Symbol CRUD ─────────────────────────────────────────────────────────────

  insertSymbols(symbols: IndexSymbol[], nextId: number): number {
    const stmt = this.db.prepare(
      `INSERT INTO symbols(id, lang, kind, name, file, line, col, signature, doc_comment, scope, text, file_fk)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    let id = nextId;
    for (const s of symbols) {
      stmt.run(
        id++,
        s.lang,
        s.kind,
        s.name,
        s.file,
        s.line,
        s.col,
        s.signature,
        s.docComment,
        s.scope,
        s.text,
        s.file,
      );
    }
    return id;
  }

  deleteSymbolsForFile(file: string): void {
    this.db.prepare('DELETE FROM symbols WHERE file_fk = ?').run(file);
  }

  deleteFile(file: string): void {
    this.db.prepare('DELETE FROM files WHERE file = ?').run(file);
  }

  // ─── File metadata ──────────────────────────────────────────────────────────

  upsertFile(meta: FileMeta): void {
    this.db.prepare(
      `INSERT INTO files(file, lang, mtime_ms, symbol_count, last_indexed)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(file) DO UPDATE SET
         lang = excluded.lang,
         mtime_ms = excluded.mtime_ms,
         symbol_count = excluded.symbol_count,
         last_indexed = excluded.last_indexed`,
    ).run(meta.file, meta.lang, meta.mtimeMs, meta.symbolCount, meta.lastIndexed);
  }

  getFileMeta(file: string): FileMeta | null {
    const rows = this.db.prepare(
      'SELECT file, lang, mtime_ms, symbol_count, last_indexed FROM files WHERE file = ?',
    ).all(file) as { file: string; lang: string; mtime_ms: number; symbol_count: number; last_indexed: number }[];
    if (!rows.length) return null;
    const r = expectDefined(rows[0]);
    return { file: r.file, lang: r.lang as SymbolLang, mtimeMs: r.mtime_ms, symbolCount: r.symbol_count, lastIndexed: r.last_indexed };
  }

  getAllFileMetas(): FileMeta[] {
    return (this.db.prepare(
      'SELECT file, lang, mtime_ms, symbol_count, last_indexed FROM files',
    ).all() as { file: string; lang: string; mtime_ms: number; symbol_count: number; last_indexed: number }[]).map(
      (r) => ({ file: r.file, lang: r.lang as SymbolLang, mtimeMs: r.mtime_ms, symbolCount: r.symbol_count, lastIndexed: r.last_indexed }),
    );
  }

  // ─── Search ──────────────────────────────────────────────────────────────────

  search(
    query: string,
    filter?: { kind?: SymbolKind | undefined; lang?: SymbolLang | undefined; file?: string | undefined; lspKind?: number | undefined },
  ): SearchResult[] {
    const conditions: string[] = [];
    const values: unknown[] = [];

    let effectiveKind: SymbolKind | undefined = filter?.kind;
    if (filter?.lspKind !== undefined) {
      const mapped = lspKindToInternalKind(filter.lspKind);
      if (mapped !== null) {
        effectiveKind = mapped;
      } else {
        // LSP kind was explicitly provided but has no internal mapping → no results
        return [];
      }
    }

    if (effectiveKind) {
      conditions.push('kind = ?');
      values.push(effectiveKind);
    }
    if (filter?.lang) {
      conditions.push('lang = ?');
      values.push(filter.lang);
    }
    if (filter?.file) {
      conditions.push('file LIKE ?');
      values.push(`%${filter.file}%`);
    }
    if (query.trim()) {
      const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
      const tokenConds = tokens.map(() => 'text LIKE ?');
      conditions.push(`(${tokenConds.join(' OR ')})`);
      for (const t of tokens) values.push(`%${t}%`);
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const sql = `SELECT id, lang, kind, name, file, line, col, signature, doc_comment, text FROM symbols ${where}`;

    const stmt = this.db.prepare(sql);
    const rows = stmt.all(...values as (string | number)[]) as {
      id: number; lang: string; kind: string; name: string; file: string;
      line: number; col: number; signature: string; doc_comment: string; text: string;
    }[];

    return rows.map((r) => ({
      id: r.id,
      lang: r.lang as SymbolLang,
      kind: r.kind as SymbolKind,
      name: r.name,
      file: r.file,
      line: r.line,
      col: r.col,
      signature: r.signature,
      docComment: r.doc_comment,
      score: 0,
      snippet: '',
      lspKind: filter?.lspKind,
    }));
  }

  getAllIndexable(): Array<{ id: number; text: string }> {
    return (this.db.prepare('SELECT id, text FROM symbols').all() as { id: number; text: string }[]).map(
      ({ id, text }) => ({ id, text }),
    );
  }

  /**
   * Largest symbol id currently in the table (0 when empty). New ids must be
   * allocated from this, NOT from `COUNT(*)`: incremental reindexes delete a
   * changed file's rows, so the row count drops below the max id and a
   * count-based id would collide with a surviving row (UNIQUE constraint on
   * `symbols.id`). Ids may have gaps — that is fine.
   */
  getMaxSymbolId(): number {
    const rows = this.db.prepare('SELECT MAX(id) AS m FROM symbols').all() as { m: number | null }[];
    return rows[0]?.m ?? 0;
  }

  // ─── Stats ───────────────────────────────────────────────────────────────────

  getStats(): IndexStats {
    const sizeBytes = this.sizeBytes();

    const lastRows = this.db.prepare(
      "SELECT value FROM metadata WHERE key = 'last_indexed'",
    ).all() as { value: string }[];
    const lastIndexed = lastRows.length ? Number(lastRows[0]?.value) : null;

    const totalRows = this.db.prepare('SELECT COUNT(*) FROM symbols').all() as { 'COUNT(*)': number }[];
    const totalSymbols = totalRows[0] ? Number(totalRows[0]['COUNT(*)']) : 0;

    const fileRows = this.db.prepare('SELECT COUNT(*) FROM files').all() as { 'COUNT(*)': number }[];
    const totalFiles = fileRows[0] ? Number(fileRows[0]['COUNT(*)']) : 0;

    const langRows = this.db.prepare(
      'SELECT lang, COUNT(*) FROM symbols GROUP BY lang',
    ).all() as { lang: string; 'COUNT(*)': number }[];
    const byLang = {} as Record<SymbolLang, number>;
    for (const row of langRows) byLang[row.lang as SymbolLang] = Number(row['COUNT(*)']);

    const kindRows = this.db.prepare(
      'SELECT kind, COUNT(*) FROM symbols GROUP BY kind',
    ).all() as { kind: string; 'COUNT(*)': number }[];
    const byKind = {} as Record<SymbolKind, number>;
    for (const row of kindRows) byKind[row.kind as SymbolKind] = Number(row['COUNT(*)']);

    return {
      totalSymbols,
      totalFiles,
      byLang,
      byKind,
      indexPath: this.indexDir,
      lastIndexed,
      sizeBytes,
      version: SCHEMA_VERSION,
    };
  }

  setLastIndexed(ts: number): void {
    this.db.prepare(
      "INSERT OR REPLACE INTO metadata(key, value) VALUES('last_indexed', ?)",
    ).run(String(ts));
  }

  clearAll(): void {
    this.db.exec('DELETE FROM symbols');
    this.db.exec('DELETE FROM files');
    this.db.exec('DELETE FROM refs');
  }

  // ─── Ref CRUD ────────────────────────────────────────────────────────────────

  /**
   * Insert cross-references for a given source symbol id.
   * Replaces any existing refs from the same source (idempotent on re-index).
   */
  insertRefs(fromId: number, refs: Ref[]): void {
    // Delete old refs from this symbol (handles re-index)
    this.db.prepare('DELETE FROM refs WHERE from_id = ?').run(fromId);
    if (refs.length === 0) return;

    const stmt = this.db.prepare(
      `INSERT INTO refs(from_id, to_name, to_id, call_type, line)
       VALUES (?, ?, ?, ?, ?)`,
    );
    for (const ref of refs) {
      stmt.run(fromId, ref.toName, ref.toId ?? null, ref.callType, ref.line);
    }
  }

  /**
   * Delete all refs whose source symbols are in a given file.
   * Used when re-indexing a file to clear stale refs.
   */
  deleteRefsForFile(file: string): void {
    const ids = this.db.prepare(
      'SELECT id FROM symbols WHERE file = ?',
    ).all(file) as { id: number }[];
    if (!ids.length) return;
    const placeholders = ids.map(() => '?').join(',');
    this.db.prepare(`DELETE FROM refs WHERE from_id IN (${placeholders})`).run(...ids.map((r) => r.id));
  }

  /**
   * Resolve `to_name` → `to_id` for all refs that have a name but no id.
   * Call this after all symbols have been inserted to fill in cross-references.
   */
  resolveRefs(): number {
    const unresolved = this.db.prepare(
      'SELECT id, to_name FROM refs WHERE to_id IS NULL AND to_name IS NOT NULL',
    ).all() as { id: number; to_name: string }[];

    let resolved = 0;
    for (const row of unresolved) {
      const target = this.db.prepare('SELECT id FROM symbols WHERE name = ? LIMIT 1').all(row.to_name) as { id: number }[];
      const first = target[0];
      if (first) {
        this.db.prepare('UPDATE refs SET to_id = ? WHERE id = ?').run(first.id, row.id);
        resolved++;
      }
    }
    return resolved;
  }

  /**
   * Find all references TO a given symbol (who calls / uses this symbol?).
   */
  findRefsTo(symbolId: number): Ref[] {
    return (this.db.prepare(
      'SELECT id, from_id, to_name, to_id, call_type, line FROM refs WHERE to_id = ? OR to_name = (SELECT name FROM symbols WHERE id = ?)',
    ).all(symbolId, symbolId) as { id: number; from_id: number; to_name: string; to_id: number | null; call_type: string; line: number }[]).map((r) => ({
      id: r.id, fromId: r.from_id, toName: r.to_name, toId: r.to_id ?? undefined, callType: r.call_type as Ref['callType'], line: r.line,
    }));
  }

  /**
   * Find all references FROM a given symbol (what does this symbol call/use?).
   */
  findRefsFrom(symbolId: number): Ref[] {
    return (this.db.prepare(
      'SELECT id, from_id, to_name, to_id, call_type, line FROM refs WHERE from_id = ?',
    ).all(symbolId) as { id: number; from_id: number; to_name: string; to_id: number | null; call_type: string; line: number }[]).map((r) => ({
      id: r.id, fromId: r.from_id, toName: r.to_name, toId: r.to_id ?? undefined, callType: r.call_type as Ref['callType'], line: r.line,
    }));
  }

  private sizeBytes(): number {
    const dbPath = path.join(this.indexDir, DB_FILE);
    try {
      return fs.statSync(dbPath).size;
    } catch {
      return 0;
    }
  }

  close(): void {
    try { this.db.close(); } catch { /* already closed */ }
  }
}
