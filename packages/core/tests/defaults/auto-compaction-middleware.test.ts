import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AutoCompactionMiddleware } from '../../src/defaults/auto-compaction-middleware.js';
import { EventBus } from '../../src/kernel/events.js';
import type { Context } from '../../src/core/context.js';
import type { Compactor, CompactReport } from '../../src/types/compactor.js';

function mockContext(tokenEstimate: number): Context {
  return {
    messages: [],
    todos: [],
    readFiles: new Set(),
    fileMtimes: new Map(),
    systemPrompt: [],
    provider: {} as any,
    session: {} as any,
    signal: new AbortController().signal,
    tokenCounter: {} as any,
    cwd: '/tmp',
    projectRoot: '/tmp',
    model: 'test',
    tools: [],
    meta: {},
  } as unknown as Context;
}

function mockCompactor(): Compactor & { compactCalls: { ctx: Context; aggressive: boolean }[] } {
  return {
    compactCalls: [],
    async compact(ctx, opts = {}) {
      this.compactCalls.push({ ctx, aggressive: opts.aggressive ?? false });
      return { before: 1000, after: 800, reductions: [] };
    },
  };
}

function simpleEstimator(tokens: number): (ctx: Context) => number {
  return () => tokens;
}

describe('AutoCompactionMiddleware', () => {
  let compactor: ReturnType<typeof mockCompactor>;

  beforeEach(() => {
    compactor = mockCompactor();
  });

  it('does not compact when load is below warn threshold', async () => {
    const mw = new AutoCompactionMiddleware(compactor, 10000, simpleEstimator(), {
      warn: 0.5,
      soft: 0.75,
      hard: 0.9,
    });

    const ctx = mockContext(3000); // 30% load
    let ran = false;
    await mw.handler()(ctx, async (c) => { ran = true; return c; });

    expect(ran).toBe(true);
    expect(compactor.compactCalls).toHaveLength(0);
  });

  it('compacts non-aggressively at warn threshold', async () => {
    const mw = new AutoCompactionMiddleware(compactor, 10000, simpleEstimator(5500), {
      warn: 0.5,
      soft: 0.75,
      hard: 0.9,
    });

    const ctx = mockContext(0); // 55% load — between warn and soft
    let ran = false;
    await mw.handler()(ctx, async (c) => { ran = true; return c; });

    expect(ran).toBe(true);
    expect(compactor.compactCalls).toHaveLength(1);
    expect(compactor.compactCalls[0].aggressive).toBe(false);
  });

  it('compacts aggressively at soft threshold by default', async () => {
    const mw = new AutoCompactionMiddleware(compactor, 10000, simpleEstimator(8000), {
      warn: 0.5,
      soft: 0.75,
      hard: 0.9,
    });

    const ctx = mockContext(0); // 80% load — between soft and hard
    let ran = false;
    await mw.handler()(ctx, async (c) => { ran = true; return c; });

    expect(compactor.compactCalls).toHaveLength(1);
    expect(compactor.compactCalls[0].aggressive).toBe(true); // aggressiveOn='soft' default
  });

  it('compacts aggressively at hard threshold', async () => {
    const mw = new AutoCompactionMiddleware(compactor, 10000, simpleEstimator(9500), {
      warn: 0.5,
      soft: 0.75,
      hard: 0.9,
    });

    const ctx = mockContext(0); // 95% load — above hard
    let ran = false;
    await mw.handler()(ctx, async (c) => { ran = true; return c; });

    expect(compactor.compactCalls).toHaveLength(1);
    expect(compactor.compactCalls[0].aggressive).toBe(true);
  });

  it('respects aggressiveOn=hard setting', async () => {
    const mw = new AutoCompactionMiddleware(compactor, 10000, simpleEstimator(8000), {
      warn: 0.5,
      soft: 0.75,
      hard: 0.9,
    }, 'hard');

    const ctx = mockContext(0); // 80% — between soft and hard
    await mw.handler()(ctx, async (c) => c);

    expect(compactor.compactCalls).toHaveLength(1);
    expect(compactor.compactCalls[0].aggressive).toBe(false); // not aggressive until hard
  });

  it('swallows compaction errors and still calls next', async () => {
    const badCompactor: Compactor = {
      async compact() { throw new Error('compaction failed'); },
    };
    const mw = new AutoCompactionMiddleware(badCompactor, 10000, simpleEstimator(9500), {
      warn: 0.5,
      soft: 0.75,
      hard: 0.9,
    });

    const ctx = mockContext(0);
    let ran = false;
    await mw.handler()(ctx, async (c) => { ran = true; return c; });

    expect(ran).toBe(true); // next was still called
  });

  it('uses custom estimator', async () => {
    const estimator = vi.fn(() => 9500);
    const mw = new AutoCompactionMiddleware(compactor, 10000, estimator, {
      warn: 0.5,
      soft: 0.75,
      hard: 0.9,
    });

    const ctx = mockContext(0);
    await mw.handler()(ctx, async (c) => c);

    expect(estimator).toHaveBeenCalledWith(ctx);
    expect(compactor.compactCalls).toHaveLength(1);
  });

  it('emits compaction.failed when the compactor throws and an EventBus is wired', async () => {
    const badCompactor: Compactor = {
      async compact() {
        throw new Error('summarizer model unavailable');
      },
    };
    const events = new EventBus();
    const failures: { err: Error; aggressive: boolean }[] = [];
    events.on('compaction.failed', (p) => failures.push(p));

    const mw = new AutoCompactionMiddleware(
      badCompactor,
      10000,
      simpleEstimator(9500), // hard load → aggressive
      { warn: 0.5, soft: 0.75, hard: 0.9 },
      'soft',
      events,
    );

    let ran = false;
    await mw.handler()(mockContext(0), async (c) => { ran = true; return c; });
    expect(ran).toBe(true); // failure swallowed — loop continues
    expect(failures).toHaveLength(1);
    expect(failures[0]!.err.message).toBe('summarizer model unavailable');
    expect(failures[0]!.aggressive).toBe(true);
  });

  it('still swallows compaction errors with no EventBus (backward compatible)', async () => {
    const badCompactor: Compactor = {
      async compact() { throw new Error('boom'); },
    };
    const mw = new AutoCompactionMiddleware(badCompactor, 10000, simpleEstimator(9500), {
      warn: 0.5,
      soft: 0.75,
      hard: 0.9,
    });
    // No events arg — call site looks like all the old callers.
    let ran = false;
    await mw.handler()(mockContext(0), async (c) => { ran = true; return c; });
    expect(ran).toBe(true);
  });
});