import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { hashRequest, stableStringify } from '../../src/replay/hash.js';
import { ReplayLogStore } from '../../src/storage/replay-log-store.js';
import { ReplayProviderRunner } from '../../src/replay/replay-provider-runner.js';
import type { ProviderRunner, RunProviderOptions } from '../../src/types/provider-runner.js';
import type { Request, Response } from '../../src/types/provider.js';

function makeRequest(overrides: Partial<Request> = {}): Request {
  return {
    model: 'claude-test',
    system: [{ type: 'text', text: 'You are a helpful assistant.' }],
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    maxTokens: 1024,
    temperature: 0,
    ...overrides,
  };
}

function makeResponse(overrides: Partial<Response> = {}): Response {
  return {
    content: [{ type: 'text', text: 'hello' }],
    stopReason: 'end_turn',
    usage: { input: 10, output: 5 },
    model: 'claude-test',
    ...overrides,
  };
}

describe('hashRequest', () => {
  it('produces a stable sha256-prefixed hash for the same request', () => {
    const a = makeRequest();
    const b = makeRequest();
    expect(hashRequest(a)).toBe(hashRequest(b));
    expect(hashRequest(a)).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('hash changes when model changes', () => {
    const a = makeRequest();
    const b = makeRequest({ model: 'claude-other' });
    expect(hashRequest(a)).not.toBe(hashRequest(b));
  });

  it('hash changes when message content changes', () => {
    const a = makeRequest();
    const b = makeRequest({
      messages: [{ role: 'user', content: [{ type: 'text', text: 'bye' }] }],
    });
    expect(hashRequest(a)).not.toBe(hashRequest(b));
  });

  it('hash changes when system prompt changes', () => {
    const a = makeRequest();
    const b = makeRequest({ system: [{ type: 'text', text: 'different' }] });
    expect(hashRequest(a)).not.toBe(hashRequest(b));
  });

  it('hash changes when tools change', () => {
    const a = makeRequest();
    const b = makeRequest({
      tools: [
        {
          name: 'read',
          description: 'Read a file',
          inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
        },
      ],
    });
    expect(hashRequest(a)).not.toBe(hashRequest(b));
  });

  it('hash is stable across key insertion order (deep sort)', () => {
    const a = {
      model: 'm',
      system: undefined,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }],
      maxTokens: 100,
      tools: undefined,
    } as unknown as Request;
    const b = {
      maxTokens: 100,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }],
      model: 'm',
    } as unknown as Request;
    expect(hashRequest(a)).toBe(hashRequest(b));
  });

  it('stableStringify sorts nested object keys', () => {
    const a = stableStringify({ b: 1, a: { d: 2, c: 3 } });
    const b = stableStringify({ a: { c: 3, d: 2 }, b: 1 });
    expect(a).toBe(b);
  });

  it('stableStringify preserves array order (arrays are sequences)', () => {
    expect(stableStringify([1, 2, 3])).toBe('[1,2,3]');
    expect(stableStringify([3, 2, 1])).toBe('[3,2,1]');
  });
});

// ── ReplayLogStore ────────────────────────────────────────────────────────

describe('ReplayLogStore', () => {
  let dir: string;
  let store: ReplayLogStore;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'replay-log-'));
    store = new ReplayLogStore({ dir });
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('returns empty when no file exists', async () => {
    expect(await store.load('s1')).toEqual([]);
    expect(await store.lookup('s1', 'sha256:00')).toBeNull();
  });

  it('records a request/response and looks it up by computed hash', async () => {
    const req = makeRequest();
    const res = makeResponse();
    const hash = await store.record({ sessionId: 's1', request: req, response: res });
    expect(hash).toMatch(/^sha256:/);
    const entry = await store.lookup('s1', hash);
    expect(entry).not.toBeNull();
    expect(entry!.request.model).toBe('claude-test');
    expect(entry!.response.content[0]).toMatchObject({ type: 'text', text: 'hello' });
    expect(typeof entry!.ts).toBe('string');
  });

  it('record is idempotent on hash — second call for same hash is a no-op', async () => {
    const req = makeRequest();
    const res1 = makeResponse({ content: [{ type: 'text', text: 'first' }] });
    const res2 = makeResponse({ content: [{ type: 'text', text: 'second' }] });
    const h1 = await store.record({ sessionId: 's1', request: req, response: res1 });
    const h2 = await store.record({ sessionId: 's1', request: req, response: res2 });
    expect(h1).toBe(h2);
    const entries = await store.load('s1');
    expect(entries).toHaveLength(1);
    expect(entries[0]!.response.content[0]).toMatchObject({ text: 'first' });
  });

  it('persists across store instances', async () => {
    const req = makeRequest();
    await store.record({ sessionId: 's1', request: req, response: makeResponse() });
    const store2 = new ReplayLogStore({ dir });
    const entries = await store2.load('s1');
    expect(entries).toHaveLength(1);
  });

  it('isolates sessions — recording for s1 does not leak to s2', async () => {
    const req = makeRequest();
    await store.record({ sessionId: 's1', request: req, response: makeResponse() });
    expect(await store.load('s2')).toEqual([]);
    const hash = hashRequest(req);
    expect(await store.lookup('s2', hash)).toBeNull();
  });

  it('rejects path-traversal session ids', async () => {
    await expect(store.load('../escape')).rejects.toThrow(/invalid sessionid/i);
  });

  it('corrupt JSON line is skipped (does not crash load)', async () => {
    await fs.writeFile(
      path.join(dir, 's1.replay.jsonl'),
      '{"hash":"sha256:00","ts":"2026-01-01T00:00:00Z","request":{"model":"m","messages":[],"maxTokens":1},"response":{"content":[],"stopReason":"end_turn","usage":{"input":0,"output":0},"model":"m"}}\n{not json\n',
      'utf8',
    );
    // Bypass the in-memory cache by creating a fresh store.
    const store2 = new ReplayLogStore({ dir });
    const entries = await store2.load('s1');
    expect(entries).toHaveLength(1);
  });

  it('serializes concurrent records to the same session (no lost writes)', async () => {
    const N = 20;
    await Promise.all(
      Array.from({ length: N }, (_, i) =>
        store.record({
          sessionId: 's1',
          request: makeRequest({ messages: [{ role: 'user', content: [{ type: 'text', text: `m${i}` }] }] }),
          response: makeResponse(),
        }),
      ),
    );
    const entries = await store.load('s1');
    expect(entries).toHaveLength(N);
  });
});

// ── ReplayProviderRunner ──────────────────────────────────────────────────

function fakeRunOpts(req: Request): RunProviderOptions {
  return {
    provider: { name: 'fake', sendMessage: vi.fn() } as never,
    request: req,
    signal: new AbortController().signal,
    ctx: {} as never,
    events: { emit: vi.fn() } as never,
    retry: { shouldRetry: () => false, delayMs: () => 0 } as never,
    logger: { debug() {}, warn() {}, info() {}, error() {} } as never,
  };
}

function makeInner(response: Response): ProviderRunner & { calls: number } {
  const inner = {
    calls: 0,
    async run(): Promise<Response> {
      inner.calls++;
      return response;
    },
  };
  return inner as never;
}

describe('ReplayProviderRunner', () => {
  let dir: string;
  let log: ReplayLogStore;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'replay-runner-'));
    log = new ReplayLogStore({ dir });
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('mode=record: calls inner and persists the result', async () => {
    const inner = makeInner(makeResponse());
    const runner = new ReplayProviderRunner(inner, { log, sessionId: 's1', mode: 'record' });
    const req = makeRequest();
    const r1 = await runner.run(fakeRunOpts(req));
    expect(r1.content[0]).toMatchObject({ text: 'hello' });
    expect(inner.calls).toBe(1);
    // Reload from a fresh store to confirm persistence.
    const log2 = new ReplayLogStore({ dir });
    const entries = await log2.load('s1');
    expect(entries).toHaveLength(1);
  });

  it('mode=replay: serves the cached response without calling inner', async () => {
    const req = makeRequest();
    // Pre-record an entry.
    await log.record({ sessionId: 's1', request: req, response: makeResponse() });
    const inner = makeInner(makeResponse({ content: [{ type: 'text', text: 'fresh' }] }));
    const runner = new ReplayProviderRunner(inner, { log, sessionId: 's1', mode: 'replay' });
    const r = await runner.run(fakeRunOpts(req));
    expect(r.content[0]).toMatchObject({ text: 'hello' }); // cached, not 'fresh'
    expect(inner.calls).toBe(0);
  });

  it('mode=replay: throws when the request hash has no recorded entry', async () => {
    const inner = makeInner(makeResponse());
    const runner = new ReplayProviderRunner(inner, { log, sessionId: 's1', mode: 'replay' });
    await expect(runner.run(fakeRunOpts(makeRequest()))).rejects.toThrow(
      /no recorded response for hash sha256:/,
    );
    expect(inner.calls).toBe(0);
  });

  it('mode=auto: serves cached when present, records when not', async () => {
    const reqA = makeRequest({ messages: [{ role: 'user', content: [{ type: 'text', text: 'a' }] }] });
    const reqB = makeRequest({ messages: [{ role: 'user', content: [{ type: 'text', text: 'b' }] }] });
    // Pre-record reqA only.
    await log.record({ sessionId: 's1', request: reqA, response: makeResponse() });
    const inner = makeInner(makeResponse({ content: [{ type: 'text', text: 'fresh' }] }));
    const runner = new ReplayProviderRunner(inner, { log, sessionId: 's1', mode: 'auto' });
    // reqA is cached — should not call inner.
    const rA = await runner.run(fakeRunOpts(reqA));
    expect(rA.content[0]).toMatchObject({ text: 'hello' });
    // reqB is not cached — should call inner and record.
    const rB = await runner.run(fakeRunOpts(reqB));
    expect(rB.content[0]).toMatchObject({ text: 'fresh' });
    expect(inner.calls).toBe(1);
    // Now reqB is recorded; a second call serves from cache.
    const inner2 = makeInner(makeResponse({ content: [{ type: 'text', text: 'fresh-2' }] }));
    const runner2 = new ReplayProviderRunner(inner2, { log, sessionId: 's1', mode: 'auto' });
    const rB2 = await runner2.run(fakeRunOpts(reqB));
    expect(rB2.content[0]).toMatchObject({ text: 'fresh' });
    expect(inner2.calls).toBe(0);
  });

  it('mode=record: calls inner on every request, but the log is deduped by hash', async () => {
    const inner = makeInner(makeResponse({ content: [{ type: 'text', text: 'each-call' }] }));
    const runner = new ReplayProviderRunner(inner, { log, sessionId: 's1', mode: 'record' });
    const req = makeRequest();
    await runner.run(fakeRunOpts(req));
    await runner.run(fakeRunOpts(req));
    // Both calls hit the inner provider (record mode always delegates).
    expect(inner.calls).toBe(2);
    // The log dedupes by hash — only one entry survives, even though
    // we recorded twice. This keeps the file small and means a
    // subsequent replay mode run for the same session finds the
    // recorded response on the first call.
    const entries = await log.load('s1');
    expect(entries).toHaveLength(1);
  });
});

// ── ReplayLogStore.list ─────────────────────────────────────────────────────

describe('ReplayLogStore.list', () => {
  let dir: string;
  let store: ReplayLogStore;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'replay-list-'));
    store = new ReplayLogStore({ dir });
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('returns an empty array when the dir does not exist', async () => {
    const empty = new ReplayLogStore({ dir: path.join(dir, 'no-such') });
    expect(await empty.list()).toEqual([]);
  });

  it('returns sessions with replay logs, sorted by sessionId', async () => {
    await store.record({ sessionId: 'b', request: makeRequest(0), response: makeResponse() });
    await store.record({ sessionId: 'a', request: makeRequest(1), response: makeResponse() });
    const all = await store.list();
    expect(all.map((r) => r.sessionId)).toEqual(['a', 'b']);
    expect(all.every((r) => r.entryCount === 1)).toBe(true);
  });

  it('ignores sidecar files (annotations / session JSONL)', async () => {
    await store.record({ sessionId: 'replay-one', request: makeRequest(0), response: makeResponse() });
    // These are NOT replay logs.
    await fs.writeFile(path.join(dir, 'replay-one.annotations.json'), '{}', 'utf8');
    await fs.writeFile(path.join(dir, 'replay-one.jsonl'), '', 'utf8');
    const all = await store.list();
    expect(all).toHaveLength(1);
    expect(all[0]!.sessionId).toBe('replay-one');
  });

  it('reports accurate entry count after multiple records (deduped by hash)', async () => {
    const req = makeRequest(0);
    // Three records with the same hash dedupe to one entry.
    await store.record({ sessionId: 's', request: req, response: makeResponse() });
    await store.record({ sessionId: 's', request: req, response: makeResponse() });
    await store.record({ sessionId: 's', request: req, response: makeResponse() });
    const all = await store.list();
    expect(all[0]!.entryCount).toBe(1);
  });
});

// ── ReplayLogStore rotation (maxEntries) ──────────────────────────────────────

describe('ReplayLogStore rotation', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'replay-rotation-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('keeps all entries when below the cap (default 1000)', async () => {
    const store = new ReplayLogStore({ dir });
    for (let i = 0; i < 50; i++) {
      await store.record({
        sessionId: 's1',
        request: makeRequest({ messages: [{ role: 'user', content: [{ type: 'text', text: `m${i}` }] }] }),
        response: makeResponse(),
      });
    }
    const all = await store.load('s1');
    expect(all).toHaveLength(50);
  });

  it('evicts the oldest entries when the cap is exceeded', async () => {
    const store = new ReplayLogStore({ dir, maxEntries: 5 });
    // Record 8 entries (cap = 5). The oldest 3 should be evicted.
    for (let i = 0; i < 8; i++) {
      await store.record({
        sessionId: 's1',
        request: makeRequest({ messages: [{ role: 'user', content: [{ type: 'text', text: `m${i}` }] }] }),
        response: makeResponse(),
      });
    }
    const all = await store.load('s1');
    expect(all).toHaveLength(5);
    // Insertion order: requests 0..7. After eviction of 0..2, kept
    // entries are for requests 3..7.
    for (let i = 0; i < 5; i++) {
      const hash = hashRequest(makeRequest({ messages: [{ role: 'user', content: [{ type: 'text', text: `m${i + 3}` }] }] }));
      expect(all[i]!.hash).toBe(hash);
    }
  });

  it('respects maxEntries=Infinity to disable rotation', async () => {
    const store = new ReplayLogStore({ dir, maxEntries: Infinity });
    for (let i = 0; i < 30; i++) {
      await store.record({
        sessionId: 's1',
        request: makeRequest({ messages: [{ role: 'user', content: [{ type: 'text', text: `m${i}` }] }] }),
        response: makeResponse(),
      });
    }
    expect(await store.load('s1')).toHaveLength(30);
  });

  it('rotation is per-session — other sessions are untouched', async () => {
    const store = new ReplayLogStore({ dir, maxEntries: 3 });
    for (let i = 0; i < 4; i++) {
      await store.record({
        sessionId: 'a',
        request: makeRequest({ messages: [{ role: 'user', content: [{ type: 'text', text: `a${i}` }] }] }),
        response: makeResponse(),
      });
    }
    await store.record({
      sessionId: 'b',
      request: makeRequest({ messages: [{ role: 'user', content: [{ type: 'text', text: 'b0' }] }] }),
      response: makeResponse(),
    });
    // a should be capped to 3; b should have 1.
    expect(await store.load('a')).toHaveLength(3);
    expect(await store.load('b')).toHaveLength(1);
  });

  it('survives a fresh store instance (rotation persists across reloads)', async () => {
    const store1 = new ReplayLogStore({ dir, maxEntries: 3 });
    for (let i = 0; i < 5; i++) {
      await store1.record({
        sessionId: 's1',
        request: makeRequest({ messages: [{ role: 'user', content: [{ type: 'text', text: `m${i}` }] }] }),
        response: makeResponse(),
      });
    }
    const store2 = new ReplayLogStore({ dir, maxEntries: 3 });
    const all = await store2.load('s1');
    expect(all).toHaveLength(3);
  });
});
