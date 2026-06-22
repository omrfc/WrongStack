import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionMemoryConsolidator } from '../../src/storage/memory-consolidator.js';
import type { Context } from '../../src/core/context.js';
import type { RunResult } from '../../src/core/agent-types.js';
import type { MemoryStore } from '../../src/types/memory.js';
import type { Provider } from '../../src/types/provider.js';

const mkStore = () =>
  ({
    list: vi.fn(async () => [] as never[]),
    remember: vi.fn(async () => {}),
    forget: vi.fn(async () => 1),
  }) as never as MemoryStore & {
    list: ReturnType<typeof vi.fn>;
    remember: ReturnType<typeof vi.fn>;
    forget: ReturnType<typeof vi.fn>;
  };

const mkProvider = (text: string): Provider =>
  ({
    complete: vi.fn(async () => ({ content: [{ type: 'text', text }], stopReason: 'end_turn' })),
  }) as never as Provider;

const ctx = (provider?: Provider): Context => ({ provider, model: 'haiku' }) as never as Context;

const result = (over: Partial<RunResult> = {}): RunResult =>
  ({ status: 'done', finalText: 'a meaningful session summary text', iterations: 5, ...over }) as RunResult;

let store: ReturnType<typeof mkStore>;
beforeEach(() => {
  store = mkStore();
});
afterEach(() => vi.restoreAllMocks());

describe('SessionMemoryConsolidator early returns', () => {
  it('skips non-done sessions', async () => {
    const c = new SessionMemoryConsolidator({ memoryStore: store });
    await c.afterRun(ctx(mkProvider('{}')), result({ status: 'error' }));
    expect(store.list).not.toHaveBeenCalled();
  });

  it('skips sessions with trivial final text', async () => {
    const c = new SessionMemoryConsolidator({ memoryStore: store });
    await c.afterRun(ctx(mkProvider('{}')), result({ finalText: 'short' }));
    expect(store.list).not.toHaveBeenCalled();
  });

  it('skips sessions below the iteration floor', async () => {
    const c = new SessionMemoryConsolidator({ memoryStore: store, minIterations: 5 });
    await c.afterRun(ctx(mkProvider('{}')), result({ iterations: 2 }));
    expect(store.list).not.toHaveBeenCalled();
  });

  it('skips when there is no provider', async () => {
    const c = new SessionMemoryConsolidator({ memoryStore: store });
    await c.afterRun(ctx(undefined), result());
    expect(store.list).not.toHaveBeenCalled();
  });

  it('skips when the provider has no complete method', async () => {
    const c = new SessionMemoryConsolidator({ memoryStore: store });
    await c.afterRun(ctx({} as Provider), result());
    expect(store.list).not.toHaveBeenCalled();
  });
});

describe('SessionMemoryConsolidator operations', () => {
  it('applies add/edit/delete operations and logs a summary', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    store.list.mockResolvedValue([
      { scope: 'project-memory', text: 'old fact', ts: '2026-01-01T00:00:00Z' },
    ] as never);
    const ops = {
      operations: [
        { action: 'add', text: 'new fact', type: 'fact', priority: 'high', tags: ['x'] },
        { action: 'edit', query: 'old', text: 'updated fact', type: 'fact' },
        { action: 'delete', query: 'gone' },
      ],
    };
    const c = new SessionMemoryConsolidator({ memoryStore: store, provider: mkProvider(JSON.stringify(ops)) });
    await c.afterRun(ctx(), result());

    expect(store.remember).toHaveBeenCalledTimes(2); // add + edit
    expect(store.forget).toHaveBeenCalledTimes(2); // edit + delete
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('consolidation'));
  });

  it('wraps JSON in surrounding prose and still extracts it', async () => {
    const text = 'Here is the result:\n{"operations":[{"action":"add","text":"wrapped fact"}]}\nDone.';
    const c = new SessionMemoryConsolidator({ memoryStore: store, provider: mkProvider(text) });
    await c.afterRun(ctx(), result());
    expect(store.remember).toHaveBeenCalledWith('wrapped fact', undefined, expect.any(Object));
  });

  it('ignores operations with missing fields without logging', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const ops = {
      operations: [
        { action: 'add' }, // no text
        { action: 'edit', query: 'q' }, // no text
        { action: 'delete' }, // no query
      ],
    };
    const c = new SessionMemoryConsolidator({ memoryStore: store, provider: mkProvider(JSON.stringify(ops)) });
    await c.afterRun(ctx(), result());
    expect(store.remember).not.toHaveBeenCalled();
    expect(stderr).not.toHaveBeenCalled();
  });

  it('returns when the model produces no text', async () => {
    const c = new SessionMemoryConsolidator({ memoryStore: store, provider: mkProvider('   ') });
    await c.afterRun(ctx(), result());
    expect(store.remember).not.toHaveBeenCalled();
  });

  it('returns when there is no JSON object in the response', async () => {
    const c = new SessionMemoryConsolidator({ memoryStore: store, provider: mkProvider('no json here') });
    await c.afterRun(ctx(), result());
    expect(store.remember).not.toHaveBeenCalled();
  });

  it('returns when operations is empty or not an array', async () => {
    const c1 = new SessionMemoryConsolidator({ memoryStore: store, provider: mkProvider('{"operations":[]}') });
    await c1.afterRun(ctx(), result());
    const c2 = new SessionMemoryConsolidator({ memoryStore: store, provider: mkProvider('{"operations":"nope"}') });
    await c2.afterRun(ctx(), result());
    expect(store.remember).not.toHaveBeenCalled();
  });

  it('swallows a malformed-JSON parse error', async () => {
    const c = new SessionMemoryConsolidator({ memoryStore: store, provider: mkProvider('{ not valid json }') });
    await expect(c.afterRun(ctx(), result())).resolves.toBeUndefined();
    expect(store.remember).not.toHaveBeenCalled();
  });

  it('swallows a provider failure', async () => {
    const provider = { complete: vi.fn(async () => { throw new Error('llm down'); }) } as never as Provider;
    const c = new SessionMemoryConsolidator({ memoryStore: store, provider });
    await expect(c.afterRun(ctx(), result())).resolves.toBeUndefined();
  });
});
