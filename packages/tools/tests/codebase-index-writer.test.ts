import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Symbol as IndexSymbol, SymbolKind, SymbolLang } from '../src/codebase-index/schema.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  IndexStore,
  codebaseIndexDirOverride,
  resolveIndexDir,
} from '../src/codebase-index/writer.js';

let store: IndexStore;
let tmpDir: string;

const sym = (over: Partial<IndexSymbol> & { name: string; file: string }): IndexSymbol => ({
  id: 0,
  lang: (over.lang ?? 'ts') as SymbolLang,
  kind: (over.kind ?? 'function') as SymbolKind,
  name: over.name,
  file: over.file,
  line: over.line ?? 1,
  col: over.col ?? 0,
  signature: over.signature ?? `${over.name}()`,
  docComment: over.docComment ?? '',
  scope: over.scope ?? '',
  text: over.text ?? `${over.name} ${over.kind ?? 'function'}`,
});

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-writer-'));
  store = new IndexStore(tmpDir, { indexDir: path.join(tmpDir, '.idx') });
});
afterEach(async () => {
  store.close();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('IndexStore search filters', () => {
  beforeEach(() => {
    store.insertSymbols(
      [
        sym({ name: 'UserClass', kind: 'class', lang: 'ts', file: '/p/user.ts', text: 'UserClass entity' }),
        sym({ name: 'helperFn', kind: 'function', lang: 'ts', file: '/p/util.ts', text: 'helperFn util' }),
        sym({ name: 'goThing', kind: 'function', lang: 'go', file: '/p/main.go', text: 'goThing main' }),
      ],
      1,
    );
  });

  it('filters by kind', () => {
    const r = store.search('', { kind: 'class' });
    expect(r.every((x) => x.kind === 'class')).toBe(true);
    expect(r.length).toBe(1);
  });

  it('filters by lang', () => {
    const r = store.search('', { lang: 'go' });
    expect(r.map((x) => x.name)).toEqual(['goThing']);
  });

  it('filters by file substring', () => {
    const r = store.search('', { file: 'util' });
    expect(r.map((x) => x.name)).toEqual(['helperFn']);
  });

  it('maps an lspKind to an internal kind', () => {
    const r = store.search('', { lspKind: 5 }); // 5 = Class
    expect(r.map((x) => x.name)).toEqual(['UserClass']);
  });

  it('returns nothing for an lspKind with no internal mapping', () => {
    expect(store.search('', { lspKind: 15 })).toEqual([]); // 15 = String → null
  });

  it('matches text tokens in the query', () => {
    const r = store.search('entity');
    expect(r.map((x) => x.name)).toContain('UserClass');
  });
});

describe('IndexStore searchRanked filters', () => {
  beforeEach(() => {
    store.insertSymbols(
      [
        sym({ name: 'parseConfig', kind: 'function', lang: 'ts', file: '/p/cfg.ts', text: 'parseConfig config loader' }),
        sym({ name: 'ConfigType', kind: 'type', lang: 'ts', file: '/p/types.ts', text: 'ConfigType config shape' }),
      ],
      1,
    );
  });

  it('returns nothing when the lspKind has no mapping', () => {
    const r = store.searchRanked('config', { lspKind: 15 }, 10);
    expect(r.results).toEqual([]);
    expect(r.total).toBe(0);
  });

  it('applies kind/lang/file filters', () => {
    const byKind = store.searchRanked('config', { kind: 'function' }, 10);
    expect(byKind.results.every((x) => x.kind === 'function')).toBe(true);
    const byLang = store.searchRanked('config', { lang: 'ts' }, 10);
    expect(byLang.total).toBeGreaterThan(0);
    const byFile = store.searchRanked('config', { file: 'types' }, 10);
    expect(byFile.results.every((x) => x.file.includes('types'))).toBe(true);
  });

  it('maps an lspKind to an internal kind (FTS path)', () => {
    const r = store.searchRanked('config', { lspKind: 12 }, 10); // 12 = Function
    expect(r.results.every((x) => x.kind === 'function')).toBe(true);
  });

  it('getAllIndexable returns id/text rows', () => {
    const rows = store.getAllIndexable();
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]).toHaveProperty('text');
  });
});

describe('IndexStore refs', () => {
  let callerId: number;
  let calleeId: number;

  beforeEach(() => {
    store.insertSymbols(
      [
        sym({ name: 'caller', file: '/p/a.ts' }),
        sym({ name: 'callee', file: '/p/b.ts' }),
      ],
      1,
    );
    const all = store.search('', {});
    callerId = all.find((s) => s.name === 'caller')!.id;
    calleeId = all.find((s) => s.name === 'callee')!.id;
  });

  it('inserts, resolves, and queries references by name', () => {
    store.insertRefs(callerId, [{ fromId: callerId, toName: 'callee', callType: 'call', line: 3 }]);
    const resolved = store.resolveRefs();
    expect(resolved).toBeGreaterThanOrEqual(1);

    const from = store.findRefsFrom(callerId);
    expect(from.map((r) => r.toName)).toContain('callee');

    const to = store.findRefsTo(calleeId);
    expect(to.some((r) => r.fromId === callerId)).toBe(true);
  });

  it('insertRefs with an empty list clears existing refs only', () => {
    store.insertRefs(callerId, [{ fromId: callerId, toName: 'callee', callType: 'call', line: 1 }]);
    store.insertRefs(callerId, []); // delete-only path
    expect(store.findRefsFrom(callerId)).toEqual([]);
  });

  it('deleteRefsForFile removes refs originating in that file', () => {
    store.insertRefs(callerId, [{ fromId: callerId, toName: 'callee', callType: 'call', line: 1 }]);
    store.deleteRefsForFile('/p/a.ts');
    expect(store.findRefsFrom(callerId)).toEqual([]);
  });

  it('deleteRefsForFile is a no-op for a file with no symbols', () => {
    expect(() => store.deleteRefsForFile('/p/nonexistent.ts')).not.toThrow();
  });
});

describe('IndexStore file ops + ranked fallback', () => {
  it('deleteFile removes symbols, refs, and the file row', () => {
    const next = store.insertSymbols([sym({ name: 'gone', file: '/p/gone.ts' })], 1);
    store.upsertFile({ file: '/p/gone.ts', mtimeMs: 1, lang: 'ts', symbolCount: 1, lastIndexed: 1 });
    const id = next - 1;
    store.insertRefs(id, [{ fromId: id, toName: 'x', callType: 'call', line: 1 }]);
    store.deleteFile('/p/gone.ts');
    expect(store.search('', { file: 'gone' })).toEqual([]);
    expect(store.getFileMeta('/p/gone.ts')).toBeNull();
  });

  it('getFileMeta returns null for an unknown file', () => {
    expect(store.getFileMeta('/p/never.ts')).toBeNull();
  });

  it('searchRanked with an empty query lists candidates via the fallback', () => {
    store.insertSymbols([sym({ name: 'Listed', kind: 'class', file: '/p/l.ts' })], 1);
    const r = store.searchRanked('   ', undefined, 10); // whitespace → no tokens → fallback
    expect(r.total).toBeGreaterThan(0);
    expect(r.results.length).toBeGreaterThan(0);
  });

  it('searchRanked fallback returns empty when there are no candidates', () => {
    // Whitespace query → fallback path; empty store → zero candidates → early out.
    const r = store.searchRanked('   ', undefined, 10);
    expect(r).toEqual({ results: [], total: 0 });
  });

  it('searchRanked returns empty when nothing matches', () => {
    store.insertSymbols([sym({ name: 'present', kind: 'function', file: '/p/f.ts' })], 1);
    const miss = store.searchRanked('zzznomatchzzz', undefined, 10);
    expect(miss.results).toEqual([]);
    expect(miss.total).toBe(0);
  });
});

describe('writer helpers', () => {
  it('resolveIndexDir honours an explicit override', () => {
    expect(resolveIndexDir('/p', '/custom/idx')).toBe('/custom/idx');
  });

  it('resolveIndexDir falls back to the per-project location', () => {
    expect(resolveIndexDir('/p').length).toBeGreaterThan(0); // resolved per-project dir
  });

  it('codebaseIndexDirOverride reads a string from meta, else undefined', () => {
    expect(codebaseIndexDirOverride({ meta: { codebaseIndexDir: '/x' } })).toBe('/x');
    expect(codebaseIndexDirOverride({ meta: { codebaseIndexDir: 42 } })).toBeUndefined();
    expect(codebaseIndexDirOverride({})).toBeUndefined();
  });
});

describe('IndexStore.runWithRetry', () => {
  it('returns the callback result on success', () => {
    expect(store.runWithRetry(() => 7)).toBe(7);
  });

  it('rethrows a non-lock error immediately', () => {
    expect(() => store.runWithRetry(() => {
      throw new Error('not a lock');
    })).toThrow('not a lock');
  });

  it('rethrows a non-Error throw immediately', () => {
    expect(() => store.runWithRetry(() => {
      throw 'string failure';
    })).toThrow();
  });

  it('retries a lock error then succeeds', () => {
    let calls = 0;
    const out = store.runWithRetry(() => {
      calls++;
      if (calls === 1) throw Object.assign(new Error('busy'), { code: 'SQLITE_BUSY' });
      return 'ok';
    });
    expect(out).toBe('ok');
    expect(calls).toBe(2);
  });

  it('wraps a persistent lock conflict in a LockError after exhausting retries', () => {
    expect(() => store.runWithRetry(() => {
      throw Object.assign(new Error('locked'), { sqliteCode: 6 }); // numeric SQLITE_LOCKED
    })).toThrow(/lock conflict after/);
  });

  it('detects a lock error reported only in the message', () => {
    let n = 0;
    const out = store.runWithRetry(() => {
      n++;
      if (n === 1) throw new Error('database is SQLITE_BUSY right now'); // no code, message only
      return 'recovered';
    });
    expect(out).toBe('recovered');
  });
});

describe('IndexStore stats and clear', () => {
  it('reports byLang/byKind breakdowns and a positive size', () => {
    store.insertSymbols(
      [
        sym({ name: 'A', kind: 'class', lang: 'ts', file: '/p/a.ts' }),
        sym({ name: 'B', kind: 'function', lang: 'go', file: '/p/b.go' }),
      ],
      1,
    );
    store.upsertFile({ file: '/p/a.ts', mtimeMs: 1, lang: 'ts', symbolCount: 1, lastIndexed: 2000 });
    store.setLastIndexed(123);
    const stats = store.getStats();
    expect(stats.totalSymbols).toBe(2);
    expect(stats.byLang.ts).toBeGreaterThanOrEqual(1);
    expect(stats.byKind.class).toBeGreaterThanOrEqual(1);
    expect(stats.sizeBytes).toBeGreaterThan(0);
    expect(stats.lastIndexed).toBe(123);
  });

  it('clearAll empties the index', () => {
    store.insertSymbols([sym({ name: 'X', file: '/p/x.ts' })], 1);
    store.clearAll();
    expect(store.getStats().totalSymbols).toBe(0);
  });
});
