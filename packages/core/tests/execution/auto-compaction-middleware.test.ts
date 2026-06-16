import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Context } from '../../src/core/context.js';
import { AutoCompactionMiddleware } from '../../src/execution/auto-compaction-middleware.js';
import { EventBus } from '../../src/kernel/events.js';
import type { SessionEventBridge } from '../../src/storage/session-event-bridge.js';
import type { CompactReport, Compactor } from '../../src/types/compactor.js';

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
    clearFileTracking: () => {},
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
    await mw.handler()(ctx, async (c) => {
      ran = true;
      return c;
    });

    expect(ran).toBe(true);
    expect(compactor.compactCalls).toHaveLength(0);
  });

  it('is a pass-through when disabled via setEnabled(false), even above hard threshold', async () => {
    const mw = new AutoCompactionMiddleware(compactor, 10000, simpleEstimator(9500), {
      warn: 0.5,
      soft: 0.75,
      hard: 0.9,
    });
    expect(mw.enabled).toBe(true);
    mw.setEnabled(false);
    expect(mw.enabled).toBe(false);

    const ctx = mockContext(0); // 95% load — would normally compact aggressively
    let ran = false;
    await mw.handler()(ctx, async (c) => {
      ran = true;
      return c;
    });

    expect(ran).toBe(true); // chain still advances
    expect(compactor.compactCalls).toHaveLength(0); // but no compaction fired

    // Re-enabling restores compaction on the next pass.
    mw.setEnabled(true);
    await mw.handler()(ctx, async (c) => c);
    expect(compactor.compactCalls).toHaveLength(1);
  });

  it('compacts non-aggressively at warn threshold', async () => {
    const mw = new AutoCompactionMiddleware(compactor, 10000, simpleEstimator(5500), {
      warn: 0.5,
      soft: 0.75,
      hard: 0.9,
    });

    const ctx = mockContext(0); // 55% load — between warn and soft
    let ran = false;
    await mw.handler()(ctx, async (c) => {
      ran = true;
      return c;
    });

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
    await mw.handler()(ctx, async (c) => {
      ran = true;
      return c;
    });

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
    await mw.handler()(ctx, async (c) => {
      ran = true;
      return c;
    });

    expect(compactor.compactCalls).toHaveLength(1);
    expect(compactor.compactCalls[0].aggressive).toBe(true);
  });

  it('respects aggressiveOn=hard setting', async () => {
    const mw = new AutoCompactionMiddleware(
      compactor,
      10000,
      simpleEstimator(8000), // 80% load → soft band (between soft=75% and hard=90%)
      {
        warn: 0.5,
        soft: 0.75,
        hard: 0.9,
      },
      'hard',
    );

    const ctx = mockContext(0); // 80% load: soft band, aggressiveOn=hard
    await mw.handler()(ctx, async (c) => c);

    expect(compactor.compactCalls).toHaveLength(1);
    expect(compactor.compactCalls[0].aggressive).toBe(false); // not aggressive until hard
  });

  it('throws compaction errors at hard threshold by default', async () => {
    const badCompactor: Compactor = {
      async compact() {
        throw new Error('compaction failed');
      },
    };
    const mw = new AutoCompactionMiddleware(badCompactor, 10000, simpleEstimator(9500), {
      warn: 0.5,
      soft: 0.75,
      hard: 0.9,
    });

    const ctx = mockContext(0);
    let ran = false;
    await expect(
      mw.handler()(ctx, async (c) => {
        ran = true;
        return c;
      }),
    ).rejects.toThrow(/Auto-compaction failed/);

    expect(ran).toBe(false);
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

  it('uses a runtime policy provider for thresholds and aggressiveness', async () => {
    const mw = new AutoCompactionMiddleware(
      compactor,
      10000,
      simpleEstimator(5000),
      {
        warn: 0.7,
        soft: 0.85,
        hard: 0.95,
      },
      {
        policyProvider: () => ({
          thresholds: { warn: 0.45, soft: 0.6, hard: 0.75 },
          aggressiveOn: 'warn',
        }),
      },
    );

    await mw.handler()(mockContext(0), async (c) => c);

    expect(compactor.compactCalls).toHaveLength(1);
    expect(compactor.compactCalls[0].aggressive).toBe(true);
  });

  it('emits compaction.failed when the compactor throws and an EventBus is wired', async () => {
    const badCompactor: Compactor = {
      async compact() {
        throw new Error('summarizer model unavailable');
      },
    };
    const events = new EventBus();
    const failures: Array<{
      err: Error;
      aggressive: boolean;
      level: 'warn' | 'soft' | 'hard';
      fatal: boolean;
    }> = [];
    events.on('compaction.failed', (p) => failures.push(p));

    const mw = new AutoCompactionMiddleware(
      badCompactor,
      10000,
      simpleEstimator(9500), // hard load → aggressive
      { warn: 0.5, soft: 0.75, hard: 0.9 },
      { aggressiveOn: 'soft', events },
    );

    let ran = false;
    await expect(
      mw.handler()(mockContext(0), async (c) => {
        ran = true;
        return c;
      }),
    ).rejects.toThrow(/Auto-compaction failed/);
    expect(ran).toBe(false);
    expect(failures).toHaveLength(1);
    expect(failures[0]!.err.message).toBe('summarizer model unavailable');
    expect(failures[0]!.aggressive).toBe(true);
    expect(failures[0]!.level).toBe('hard');
    expect(failures[0]!.fatal).toBe(true);
  });

  it('does not re-run compaction after a no-op attempt at the same pressure level', async () => {
    // Compactor that reports zero savings — simulates preserveK protecting
    // everything and no oversized tool_results outside the window.
    const noopCompactor: Compactor & { calls: number } = {
      calls: 0,
      async compact() {
        this.calls++;
        return { before: 1000, after: 1000, reductions: [] };
      },
    };
    const events = new EventBus();
    const fired: unknown[] = [];
    events.on('compaction.fired', (e) => fired.push(e));

    const mw = new AutoCompactionMiddleware(
      noopCompactor,
      10000,
      simpleEstimator(8000), // 80% load → soft band (above warn=50%)
      { warn: 0.5, soft: 0.75, hard: 0.9 },
      { aggressiveOn: 'soft', events, failureMode: 'continue' },
    );

    // Three back-to-back iterations at the same pressure with no change
    for (let i = 0; i < 3; i++) {
      await mw.handler()(mockContext(0), async (c) => c);
    }

    // First attempt fires; subsequent no-op-at-same-level attempts are skipped.
    expect(noopCompactor.calls).toBe(1);
    expect(fired).toHaveLength(1);
  });

  it('retries compaction after a no-op when context grows materially', async () => {
    const noopCompactor: Compactor & { calls: number } = {
      calls: 0,
      async compact() {
        this.calls++;
        return { before: 1000, after: 1000, reductions: [] };
      },
    };
    let currentRaw = 8000;
    const estimator: (ctx: Context) => number = () => currentRaw;

    const mw = new AutoCompactionMiddleware(
      noopCompactor,
      10000,
      estimator,
      { warn: 0.5, soft: 0.75, hard: 0.9 },
      { failureMode: 'continue' },
    );

    await mw.handler()(mockContext(0), async (c) => c); // initial no-op records stuck state
    expect(noopCompactor.calls).toBe(1);

    // Tiny growth — still skipped
    currentRaw = 8100;
    await mw.handler()(mockContext(0), async (c) => c);
    expect(noopCompactor.calls).toBe(1);

    // Large growth — escalates from soft (8000=80%) to hard (10000=100%) → retries
    currentRaw = 10000;
    await mw.handler()(mockContext(0), async (c) => c);
    expect(noopCompactor.calls).toBe(2);
  });

  it('retries compaction after a no-op when pressure escalates to a higher level', async () => {
    const noopCompactor: Compactor & { calls: number } = {
      calls: 0,
      async compact() {
        this.calls++;
        return { before: 1000, after: 1000, reductions: [] };
      },
    };
    let currentRaw = 7800; // 78% load → soft band (above soft=75%, below hard=90%)
    const estimator: (ctx: Context) => number = () => currentRaw;

    const mw = new AutoCompactionMiddleware(
      noopCompactor,
      10000,
      estimator,
      { warn: 0.5, soft: 0.75, hard: 0.9 },
      { failureMode: 'continue' },
    );

    await mw.handler()(mockContext(0), async (c) => c); // no-op at soft
    await mw.handler()(mockContext(0), async (c) => c); // skipped
    expect(noopCompactor.calls).toBe(1);

    currentRaw = 9200; // 92% load → escalates to hard
    await mw.handler()(mockContext(0), async (c) => c);
    expect(noopCompactor.calls).toBe(2);
  });

  it('clears the no-op record when load drops back below all thresholds', async () => {
    const noopCompactor: Compactor & { calls: number } = {
      calls: 0,
      async compact() {
        this.calls++;
        return { before: 1000, after: 1000, reductions: [] };
      },
    };
    let currentRaw = 8000;
    const estimator: (ctx: Context) => number = () => currentRaw;

    const mw = new AutoCompactionMiddleware(
      noopCompactor,
      10000,
      estimator,
      { warn: 0.5, soft: 0.75, hard: 0.9 },
      { failureMode: 'continue' },
    );

    await mw.handler()(mockContext(0), async (c) => c); // no-op
    currentRaw = 3000; // 30% load → below warn
    await mw.handler()(mockContext(0), async (c) => c);
    currentRaw = 8000; // back up — stuck state cleared, should retry
    await mw.handler()(mockContext(0), async (c) => c);
    expect(noopCompactor.calls).toBe(2);
  });

  it('can be configured to continue after compaction errors', async () => {
    const badCompactor: Compactor = {
      async compact() {
        throw new Error('boom');
      },
    };
    const mw = new AutoCompactionMiddleware(
      badCompactor,
      10000,
      simpleEstimator(9500),
      {
        warn: 0.5,
        soft: 0.75,
        hard: 0.9,
      },
      { failureMode: 'continue' },
    );
    let ran = false;
    await mw.handler()(mockContext(0), async (c) => {
      ran = true;
      return c;
    });
    expect(ran).toBe(true);
  });

  it('writes compaction event to the provided SessionEventBridge on successful compaction', async () => {
    const append = vi.fn();
    const mockBridge: SessionEventBridge = {
      append,
      level: 'standard',
      allows: () => true,
    };

    const mw = new AutoCompactionMiddleware(
      compactor,
      10000,
      simpleEstimator(9500), // hard load → will trigger compaction
      { warn: 0.5, soft: 0.75, hard: 0.9 },
      {
        aggressiveOn: 'soft',
        sessionBridge: mockBridge,
      },
    );

    const ctx = mockContext(0);
    await mw.handler()(ctx, async (c) => c);

    expect(compactor.compactCalls).toHaveLength(1);
    expect(append).toHaveBeenCalledTimes(1);

    const event = append.mock.calls[0]![0];
    expect(event.type).toBe('compaction');
    expect(event.before).toBe(1000);
    expect(event.after).toBe(800);
    expect(event.level).toBe('hard');
    expect(typeof event.ts).toBe('string');
  });

  it('calls the custom estimator on every invocation (no caching for custom estimators)', async () => {
    // Custom estimators own their own semantics — the middleware must NOT
    // cache their result. Each handler() call invokes the estimator fresh.
    let estimatorCalls = 0;
    const countingEstimator = () => {
      estimatorCalls++;
      return 3000; // 30% load — below all thresholds
    };

    const mw = new AutoCompactionMiddleware(
      compactor,
      10000,
      countingEstimator,
      { warn: 0.5, soft: 0.75, hard: 0.9 },
    );

    const ctx = mockContext(0);

    // Three back-to-back calls with identical context — estimator called every time.
    await mw.handler()(ctx, async (c) => c);
    expect(estimatorCalls).toBe(1);

    await mw.handler()(ctx, async (c) => c);
    expect(estimatorCalls).toBe(2);

    await mw.handler()(ctx, async (c) => c);
    expect(estimatorCalls).toBe(3);
  });

  it('calls the custom estimator fresh when context changes', async () => {
    let estimatorCalls = 0;
    const countingEstimator = () => {
      estimatorCalls++;
      return 3000;
    };

    const mw = new AutoCompactionMiddleware(
      compactor,
      10000,
      countingEstimator,
      { warn: 0.5, soft: 0.75, hard: 0.9 },
    );

    // First call
    const ctx1 = mockContext(0);
    await mw.handler()(ctx1, async (c) => c);
    expect(estimatorCalls).toBe(1);

    // Same context — custom estimators are never cached, called again
    await mw.handler()(ctx1, async (c) => c);
    expect(estimatorCalls).toBe(2);

    // DIFFERENT context — called again
    const ctx2 = mockContext(0);
    ctx2.messages = [{ role: 'user', content: 'new message' } as any];
    await mw.handler()(ctx2, async (c) => c);
    expect(estimatorCalls).toBe(3);

    // Same context again — still called fresh
    await mw.handler()(ctx2, async (c) => c);
    expect(estimatorCalls).toBe(4);
  });
});
