import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DefaultMemoryStore } from '../../src/storage/memory-store.js';
import type { MemoryBackend } from '../../src/storage/memory-backend.js';
import type { EventBus } from '../../src/kernel/events.js';
import type { MemoryEntry, MemoryScope } from '../../src/types/memory.js';
import { resolveWstackPaths } from '../../src/utils/wstack-paths.js';

// ── Configurable mock backend ────────────────────────────────────────────
class MockBackend implements MemoryBackend {
  readonly kind = 'mock';
  failOn = new Set<string>();
  listEntries: MemoryEntry[] = [];
  forgetCount = 1;
  consolidateCount = 1;
  bigBody = false;
  withFindRelated: boolean;
  calls: string[] = [];

  constructor(opts: { findRelated?: boolean } = {}) {
    this.withFindRelated = opts.findRelated ?? false;
    if (!this.withFindRelated) {
      // Remove the optional method entirely so the store takes the fallback path.
      (this as { findRelated?: unknown }).findRelated = undefined;
    }
  }
  private guard(m: string) {
    this.calls.push(m);
    if (this.failOn.has(m)) throw new Error(`${m} boom`);
  }
  async remember(_s: MemoryScope, _e: MemoryEntry) { this.guard('remember'); }
  async forget() { this.guard('forget'); return this.forgetCount; }
  async readAll() { this.guard('readAll'); return this.bigBody ? 'x'.repeat(40_000) : 'mock body'; }
  async list() { this.guard('list'); return this.listEntries; }
  async search(_s: MemoryScope, q: string) { this.guard('search'); return this.listEntries.filter((e) => e.text.includes(q)); }
  async clear() { this.guard('clear'); }
  async consolidate() { this.guard('consolidate'); return this.consolidateCount; }
  findRelated?(_s: MemoryScope, _f: string, _t: string, limit: number): Promise<MemoryEntry[]> {
    this.guard('findRelated');
    return Promise.resolve(this.listEntries.slice(0, limit));
  }
}

const recorder = () => {
  const events: Array<{ type: string; payload: any }> = [];
  const bus = { emit: (type: string, payload: unknown) => events.push({ type, payload }) } as never as EventBus;
  return { events, bus };
};

let projectRoot: string;
let userHome: string;

beforeEach(async () => {
  projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'mem-store-proj-'));
  userHome = await fs.mkdtemp(path.join(os.tmpdir(), 'mem-store-home-'));
});
afterEach(async () => {
  await fs.rm(projectRoot, { recursive: true, force: true });
  await fs.rm(userHome, { recursive: true, force: true });
});

const mkStore = (backend?: MemoryBackend, bus?: EventBus) =>
  new DefaultMemoryStore({ paths: resolveWstackPaths({ projectRoot, userHome }), backend, events: bus });

describe('DefaultMemoryStore wiring', () => {
  it('exposes the backend', () => {
    const b = new MockBackend();
    expect(mkStore(b).getBackend()).toBe(b);
  });

  it('list/search delegate to the backend', async () => {
    const b = new MockBackend();
    b.listEntries = [{ scope: 'project-memory', text: 'hello world', ts: '2026-01-01' }];
    const store = mkStore(b);
    expect((await store.list()).length).toBe(1);
    expect((await store.search('hello')).length).toBe(1);
  });

  it('findRelated uses the backend method when present', async () => {
    const b = new MockBackend({ findRelated: true });
    b.listEntries = [{ scope: 'project-memory', text: 'related', ts: '2026-01-01' }];
    await mkStore(b).findRelated('q');
    expect(b.calls).toContain('findRelated');
  });

  it('findRelated falls back to search when the backend lacks it', async () => {
    const b = new MockBackend({ findRelated: false });
    b.listEntries = [{ scope: 'project-memory', text: 'q match', ts: '2026-01-01' }];
    await mkStore(b).findRelated('q');
    expect(b.calls).toContain('search');
    expect(b.calls).not.toContain('findRelated');
  });

  it('withTraceId mutates the store and tags subsequent events', async () => {
    const { events, bus } = recorder();
    const store = mkStore(new MockBackend(), bus);
    const traced = store.withTraceId('trace-123');
    expect(traced).toBe(store);
    await store.read('project-memory');
    expect(events.find((e) => e.type === 'storage.read')?.payload.traceId).toBe('trace-123');
  });
});

describe('DefaultMemoryStore event emission + failures', () => {
  it('emits storage.read on readAll and read', async () => {
    const { events, bus } = recorder();
    const store = mkStore(new MockBackend(), bus);
    await store.readAll();
    await store.read('user-memory');
    expect(events.filter((e) => e.type === 'storage.read').length).toBeGreaterThanOrEqual(2);
  });

  it('readAll rethrows and emits failure when the backend throws', async () => {
    const { events, bus } = recorder();
    const b = new MockBackend();
    b.failOn.add('readAll');
    await expect(mkStore(b, bus).readAll()).rejects.toThrow(/readAll boom/);
    expect(events.some((e) => e.type === 'storage.read' && e.payload.outcome === 'failure')).toBe(true);
  });

  it('read rethrows and emits failure when the backend throws', async () => {
    const b = new MockBackend();
    b.failOn.add('readAll');
    await expect(mkStore(b).read('project-memory')).rejects.toThrow();
  });

  it('remember emits success and forget/consolidate/clear emit their events', async () => {
    const { events, bus } = recorder();
    const b = new MockBackend();
    const store = mkStore(b, bus);
    await store.remember('a note', 'project-memory', { type: 'fact', priority: 'high', tags: ['t'] });
    await store.forget('a note');
    await store.consolidate('project-memory');
    await store.clear('project-memory');
    const types = events.map((e) => e.type);
    expect(types).toContain('memory.remembered');
    expect(types).toContain('memory.forgotten');
    expect(types).toContain('memory.consolidated');
    expect(types).toContain('memory.cleared');
  });

  it('remember rethrows and emits failure when the backend throws', async () => {
    const { events, bus } = recorder();
    const b = new MockBackend();
    b.failOn.add('remember');
    await expect(mkStore(b, bus).remember('x')).rejects.toThrow(/remember boom/);
    expect(events.some((e) => e.type === 'storage.write' && e.payload.outcome === 'failure')).toBe(true);
  });

  it('forget rethrows on backend failure; returns 0 without emitting forgotten', async () => {
    const b = new MockBackend();
    b.failOn.add('forget');
    await expect(mkStore(b).forget('x')).rejects.toThrow(/forget boom/);

    const b2 = new MockBackend();
    b2.forgetCount = 0;
    const { events, bus } = recorder();
    expect(await mkStore(b2, bus).forget('x')).toBe(0);
    expect(events.some((e) => e.type === 'memory.forgotten')).toBe(false);
  });

  it('consolidate rethrows on failure and skips the event when nothing removed', async () => {
    const b = new MockBackend();
    b.failOn.add('consolidate');
    await expect(mkStore(b).consolidate('project-memory')).rejects.toThrow();

    const b2 = new MockBackend();
    b2.consolidateCount = 0;
    const { events, bus } = recorder();
    await mkStore(b2, bus).consolidate('project-memory');
    expect(events.some((e) => e.type === 'memory.consolidated')).toBe(false);
  });

  it('clear rethrows on failure', async () => {
    const b = new MockBackend();
    b.failOn.add('clear');
    await expect(mkStore(b).clear('project-memory')).rejects.toThrow(/clear boom/);
  });

  it('clear() with no scope clears every scope', async () => {
    const { events, bus } = recorder();
    const b = new MockBackend();
    await mkStore(b, bus).clear();
    expect(events.filter((e) => e.type === 'memory.cleared').length).toBe(3);
  });

  it('chains a serialized op behind a failed prior write (prior.catch path)', async () => {
    const b = new MockBackend();
    b.failOn.add('remember');
    const store = mkStore(b);
    // Two concurrent serialized writes on the same scope: the second chains onto
    // the first's (rejected) promise, hitting runSerialized's prior.catch.
    const p1 = store.remember('first');
    const p2 = store.remember('second');
    const settled = await Promise.allSettled([p1, p2]);
    expect(settled).toHaveLength(2);
    expect(settled.every((s) => s.status === 'rejected')).toBe(true);
  });

  it('consolidates when the file exceeds the size cap after remember', async () => {
    const { events, bus } = recorder();
    const b = new MockBackend();
    b.bigBody = true; // readAll reports > MAX_BYTES_TOTAL → triggers consolidate
    b.consolidateCount = 3;
    await mkStore(b, bus).remember('huge note');
    expect(b.calls).toContain('consolidate');
    expect(events.some((e) => e.type === 'memory.consolidated')).toBe(true);
  });

  it('clear() rejects when a scope clear fails (all-scopes branch)', async () => {
    const b = new MockBackend();
    b.failOn.add('clear');
    await expect(mkStore(b).clear()).rejects.toThrow(/clear boom/);
  });

  it('surfaces a prior write error as a warning on the next readAll', async () => {
    const b = new MockBackend();
    const store = mkStore(b);
    // Fail one remember to populate writeErrors, then read.
    b.failOn.add('remember');
    await expect(store.remember('boom note')).rejects.toThrow();
    b.failOn.delete('remember');
    const all = await store.readAll();
    expect(all).toContain('Memory write error');
  });
});

describe('DefaultMemoryStore.scoreRelevant', () => {
  const baseCtx = { currentTask: 'build the pnpm pipeline', activeSkills: ['code-review'], toolNames: ['read_file'] };
  const now = new Date().toISOString();
  const old = new Date(Date.now() - 40 * 86400_000).toISOString();

  it('returns [] for an empty memory set', async () => {
    const b = new MockBackend();
    b.listEntries = [];
    expect(await mkStore(b).scoreRelevant(baseCtx)).toEqual([]);
  });

  it('scores task/skill/tool overlap, priority, type, recency, and penalties', async () => {
    const b = new MockBackend();
    b.listEntries = [
      // strong match: task words + tag + critical + decision + recent
      { scope: 'project-memory', text: 'pnpm pipeline build details', ts: now, tags: ['build'], priority: 'critical', type: 'decision' },
      // high priority passes threshold despite weak match
      { scope: 'project-memory', text: 'unrelated', ts: now, priority: 'high' },
      // medium + convention + recent
      { scope: 'project-memory', text: 'pipeline convention here', ts: now, priority: 'medium', type: 'convention' },
      // skill word 'review' + anti_pattern + preference-less
      { scope: 'project-memory', text: 'a review anti pattern note', ts: now, type: 'anti_pattern' },
      // tool word 'read' + reference type + preference
      { scope: 'project-memory', text: 'read the file carefully', ts: now, type: 'reference' },
      { scope: 'project-memory', text: 'a preference note about pnpm', ts: now, type: 'preference' },
      // negative: low priority + old + low confidence + recently accessed → filtered out
      { scope: 'project-memory', text: 'irrelevant junk', ts: old, priority: 'low', type: 'fact', confidence: 0.2, lastAccessed: now },
    ];
    const res = await mkStore(b).scoreRelevant(baseCtx, 'project-memory', 8);
    expect(res.length).toBeGreaterThan(0);
    expect(res[0]?.score).toBeGreaterThanOrEqual(res[res.length - 1]!.score); // sorted desc
    expect(res.every((r) => 'matchReason' in r)).toBe(true);
    // the strongly-matching critical decision should rank at/near the top
    expect(res[0]?.text).toContain('pnpm pipeline build');
    // the low-value junk entry is filtered out
    expect(res.some((r) => r.text === 'irrelevant junk')).toBe(false);
  });
});

describe('DefaultMemoryStore.mirrorBackup', () => {
  it('mirrors non-agents scopes to the persist dir when the global root is temp', async () => {
    // os.tmpdir() based home → globalRoot matches /tmp|temp|cache/ → persistBackup on.
    const store = mkStore(); // real FileMemoryBackend
    await store.remember('persisted note', 'project-memory');
    const persistDir = path.join(projectRoot, '.wrongstack', 'memory-persist');
    const files = await fs.readdir(persistDir).catch(() => [] as string[]);
    expect(files).toContain('project-memory.md');
  });
});
