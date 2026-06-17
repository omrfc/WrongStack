import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DefaultSessionStore } from '../../src/index.js';

// Restores 100% s/f/l after the storage.* observability + toErrorMessage
// refactor reshaped session-store.ts and stripped prior coverage. Drives the
// emit/error/edge paths the main suites don't reach; wires an events stub so
// the storage.* emit object-literals (and their conditional spreads) evaluate.

let tmp: string;
let events: { emit: ReturnType<typeof vi.fn> };
let store: DefaultSessionStore;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-sess-cov-'));
  events = { emit: vi.fn() };
  store = new DefaultSessionStore({ dir: tmp, events: events as never });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(tmp, { recursive: true, force: true });
});

const now = () => new Date().toISOString();

describe('DefaultSessionStore — observability + edge coverage', () => {
  it('evicts the oldest load-cache entry when at capacity', async () => {
    const w = await store.create({ id: 'e51', model: 'm', provider: 'p' });
    await w.append({ type: 'user_input', ts: now(), content: 'hi' });
    await w.close();
    const cache = (store as unknown as { _loadCache: Map<string, unknown> })._loadCache;
    for (let i = 0; i < 50; i++) {
      cache.set(`dummy-${i}`, { mtimeMs: 0, size: 0, data: {} });
    }
    expect(cache.size).toBe(50);
    await store.load('e51');
    expect(cache.has('e51')).toBe(true);
    expect(cache.has('dummy-0')).toBe(false);
  });

  it('emits a cache_hit on a repeated load', async () => {
    const w = await store.create({ id: 'ch', model: 'm', provider: 'p' });
    await w.append({ type: 'user_input', ts: now(), content: 'hi' });
    await w.close();
    await store.load('ch');
    events.emit.mockClear();
    await store.load('ch');
    expect(events.emit.mock.calls.some((c) => c[0] === 'storage.cache_hit')).toBe(true);
  });

  it('auto-compacts the index once the append threshold is crossed', async () => {
    (store as unknown as { indexAppendCount: number }).indexAppendCount = 29;
    const w = await store.create({ id: 'compact-trigger', model: 'm', provider: 'p' });
    await w.append({ type: 'user_input', ts: now(), content: 'go' });
    await w.close();
    const idx = await fs.readFile(path.join(tmp, '_index.jsonl'), 'utf8');
    expect(idx).toContain('compact-trigger');
  });

  it('records a failure when compactIndex cannot write its temp file', async () => {
    const indexFile = path.join(tmp, '_index.jsonl');
    await fs.writeFile(
      indexFile,
      JSON.stringify({ id: 'a', title: 't', startedAt: now(), model: 'm', provider: 'p', tokenTotal: 0 }) + '\n',
      'utf8',
    );
    await fs.mkdir(`${indexFile}.compact.tmp`, { recursive: true });
    events.emit.mockClear();
    await (store as unknown as { compactIndex(): Promise<void> }).compactIndex();
    const writeFail = events.emit.mock.calls.find(
      (c) => c[0] === 'storage.write' && (c[1] as { operation?: string }).operation === 'compact',
    );
    expect(writeFail).toBeDefined();
    expect((writeFail?.[1] as { outcome?: string }).outcome).toBe('failure');
  });

  it('collectSessionIds returns empty for an unreadable directory', async () => {
    const ids = await (
      store as unknown as { collectSessionIds(dir: string): Promise<string[]> }
    ).collectSessionIds(path.join(tmp, 'does', 'not', 'exist'));
    expect(ids).toEqual([]);
  });

  it('summaryFor rebuilds a damaged session into a fallback summary', async () => {
    await fs.mkdir(path.join(tmp, 'dmg.jsonl'), { recursive: true });
    const summary = await (
      store as unknown as { summaryFor(id: string): Promise<{ id: string; title: string }> }
    ).summaryFor('dmg');
    expect(summary.id).toBe('dmg');
    expect(summary.title).toBe('(damaged)');
  });

  it('emits storage.error when the summary fallback cannot persist the manifest', async () => {
    await fs.writeFile(
      path.join(tmp, 'dmg2.jsonl'),
      JSON.stringify({ type: 'session_start', ts: now(), id: 'dmg2', model: 'm', provider: 'p' }) + '\n',
      'utf8',
    );
    await fs.mkdir(path.join(tmp, 'dmg2.summary.json'), { recursive: true });
    events.emit.mockClear();
    await (store as unknown as { summaryFor(id: string): Promise<unknown> }).summaryFor('dmg2');
    const err = events.emit.mock.calls.find(
      (c) => c[0] === 'storage.error' && (c[1] as { operation?: string }).operation === 'summary_fallback',
    );
    expect(err).toBeDefined();
  });

  it('warns but continues when a sidecar deletion fails with a non-ENOENT error', async () => {
    const w = await store.create({ id: 'del1', model: 'm', provider: 'p' });
    await w.append({ type: 'user_input', ts: now(), content: 'x' });
    await w.close();
    await fs.mkdir(path.join(tmp, 'del1.plan.json'), { recursive: true });
    await store.delete('del1');
    await expect(fs.stat(path.join(tmp, 'del1.jsonl'))).rejects.toBeDefined();
  });

  it('list() returns [] when the store directory cannot be ensured', async () => {
    const filePath = path.join(tmp, 'a-file');
    await fs.writeFile(filePath, 'not a dir', 'utf8');
    const badStore = new DefaultSessionStore({ dir: filePath });
    expect(await badStore.list()).toEqual([]);
  });

  it('records a failed manifest write during writer close (best-effort)', async () => {
    const w = await store.create({ id: 'mc', model: 'm', provider: 'p' });
    await w.append({ type: 'user_input', ts: now(), content: 'x' });
    await fs.mkdir(path.join(tmp, 'mc.summary.json'), { recursive: true });
    events.emit.mockClear();
    await w.close();
    const closeWrite = events.emit.mock.calls.find(
      (c) =>
        c[0] === 'storage.write' &&
        (c[1] as { operation?: string }).operation === 'close' &&
        (c[1] as { outcome?: string }).outcome === 'failure',
    );
    expect(closeWrite).toBeDefined();
  });
});
