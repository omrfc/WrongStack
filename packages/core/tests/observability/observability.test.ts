import { describe, expect, it, vi } from 'vitest';
import { EventBus } from '../../src/kernel/events.js';
import {
  DefaultHealthRegistry,
  InMemoryMetricsSink,
  NoopMetricsSink,
  NoopTracer,
  wireMetricsToEvents,
} from '../../src/observability/index.js';

describe('InMemoryMetricsSink', () => {
  it('accumulates counters', () => {
    const sink = new InMemoryMetricsSink();
    sink.counter('foo');
    sink.counter('foo', 3);
    sink.counter('foo', 1, { tool: 'read' });

    const snap = sink.snapshot();
    const unlabeled = snap.series.find((s) => s.name === 'foo' && !s.labels.tool);
    const labeled = snap.series.find((s) => s.name === 'foo' && s.labels.tool === 'read');

    expect(unlabeled?.values.value).toBe(4);
    expect(labeled?.values.value).toBe(1);
  });

  it('gauges store latest value only', () => {
    const sink = new InMemoryMetricsSink();
    sink.gauge('pending', 5);
    sink.gauge('pending', 10);
    sink.gauge('pending', 7);

    const snap = sink.snapshot();
    expect(snap.series.find((s) => s.name === 'pending')?.values.value).toBe(7);
  });

  it('histogram tracks count/sum/min/max/quantiles', () => {
    const sink = new InMemoryMetricsSink();
    for (let i = 1; i <= 100; i++) sink.histogram('latency', i);

    const snap = sink.snapshot();
    const series = snap.series.find((s) => s.name === 'latency');

    expect(series?.values.count).toBe(100);
    expect(series?.values.sum).toBe(5050);
    expect(series?.values.min).toBe(1);
    expect(series?.values.max).toBe(100);
    expect(series?.values.p50).toBeGreaterThanOrEqual(40);
    expect(series?.values.p50).toBeLessThanOrEqual(60);
    expect(series?.values.p99).toBeGreaterThanOrEqual(95);
  });

  it('labels are stable across snapshots', () => {
    const sink = new InMemoryMetricsSink();
    sink.counter('hit', 1, { tool: 'read', ok: 'true' });
    sink.counter('hit', 1, { ok: 'true', tool: 'read' }); // same labels, different key order

    const snap = sink.snapshot();
    const series = snap.series.filter((s) => s.name === 'hit');
    expect(series.length).toBe(1);
    expect(series[0].values.value).toBe(2);
  });

  it('reset clears state', () => {
    const sink = new InMemoryMetricsSink();
    sink.counter('foo', 5);
    sink.reset();
    expect(sink.snapshot().series).toEqual([]);
  });
});

describe('NoopMetricsSink', () => {
  it('all methods are no-ops', () => {
    const sink = new NoopMetricsSink();
    expect(() => {
      sink.counter('x');
      sink.gauge('y', 1);
      sink.histogram('z', 2);
      sink.reset();
    }).not.toThrow();
    expect(sink.snapshot().series).toEqual([]);
  });
});

describe('NoopTracer', () => {
  it('returns spans that do nothing', () => {
    const tracer = new NoopTracer();
    const span = tracer.startSpan('op');
    expect(() => {
      span.setAttribute('k', 'v');
      span.recordError(new Error('x'));
      span.end();
    }).not.toThrow();
  });
});

describe('DefaultHealthRegistry', () => {
  it('aggregates healthy checks as healthy', async () => {
    const reg = new DefaultHealthRegistry();
    reg.register({ name: 'db', check: async () => ({ status: 'healthy' }) });
    reg.register({ name: 'mcp', check: async () => ({ status: 'healthy' }) });

    const result = await reg.run();
    expect(result.status).toBe('healthy');
    expect(result.checks).toHaveLength(2);
  });

  it('worst severity wins', async () => {
    const reg = new DefaultHealthRegistry();
    reg.register({ name: 'a', check: async () => ({ status: 'healthy' }) });
    reg.register({ name: 'b', check: async () => ({ status: 'degraded' }) });
    reg.register({ name: 'c', check: async () => ({ status: 'unhealthy', detail: 'down' }) });

    const result = await reg.run();
    expect(result.status).toBe('unhealthy');
  });

  it('thrown errors become unhealthy', async () => {
    const reg = new DefaultHealthRegistry();
    reg.register({
      name: 'broken',
      check: async () => {
        throw new Error('explosion');
      },
    });

    const result = await reg.run();
    expect(result.status).toBe('unhealthy');
    expect(result.checks[0].detail).toBe('explosion');
  });

  it('timeouts become unhealthy', async () => {
    const reg = new DefaultHealthRegistry({ timeoutMs: 50 });
    reg.register({
      name: 'slow',
      check: () =>
        new Promise(() => {
          /* never resolves */
        }),
    });

    const result = await reg.run();
    expect(result.status).toBe('unhealthy');
    expect(result.checks[0].detail).toMatch(/timeout/);
  });

  it('unregister removes a check', async () => {
    const reg = new DefaultHealthRegistry();
    reg.register({ name: 'temp', check: async () => ({ status: 'unhealthy' }) });
    reg.unregister('temp');
    const result = await reg.run();
    expect(result.status).toBe('healthy');
    expect(result.checks).toEqual([]);
  });
});

describe('wireMetricsToEvents', () => {
  it('translates EventBus events into metrics', () => {
    const bus = new EventBus();
    const sink = new InMemoryMetricsSink();
    const unwire = wireMetricsToEvents(bus, sink);

    bus.emit('iteration.completed', { ctx: {} as any, index: 0 });
    bus.emit('iteration.completed', { ctx: {} as any, index: 1 });
    bus.emit('tool.executed', { name: 'read', durationMs: 12, ok: true });
    bus.emit('tool.executed', { name: 'read', durationMs: 30, ok: true });
    bus.emit('tool.executed', { name: 'bash', durationMs: 200, ok: false });
    bus.emit('provider.response', {
      ctx: {} as any,
      usage: { input: 1000, output: 500, cacheRead: 200, cacheWrite: 0 },
      stopReason: 'end_turn',
    });
    bus.emit('compaction.fired', { before: 10000, after: 3000 });

    const snap = sink.snapshot();
    const find = (name: string, labels: Record<string, string> = {}) =>
      snap.series.find(
        (s) => s.name === name && Object.entries(labels).every(([k, v]) => s.labels[k] === v),
      );

    expect(find('agent.iterations.total')?.values.value).toBe(2);
    expect(find('tool.executions.total', { tool: 'read', ok: 'true' })?.values.value).toBe(2);
    expect(find('tool.executions.total', { tool: 'bash', ok: 'false' })?.values.value).toBe(1);
    expect(find('tool.duration_ms', { tool: 'read' })?.values.count).toBe(2);
    expect(find('tool.duration_ms', { tool: 'read' })?.values.max).toBe(30);
    expect(find('provider.tokens.input')?.values.value).toBe(1000);
    expect(find('provider.tokens.output')?.values.value).toBe(500);
    expect(find('provider.tokens.cache_read')?.values.value).toBe(200);
    expect(find('compaction.fired.total')?.values.value).toBe(1);

    unwire();
    bus.emit('iteration.completed', { ctx: {} as any, index: 2 });
    // After unwire the counter must not advance
    expect(
      sink.snapshot().series.find((s) => s.name === 'agent.iterations.total')?.values.value,
    ).toBe(2);
  });

  it('translates every wired event type into the matching metric', () => {
    const bus = new EventBus();
    const sink = new InMemoryMetricsSink();
    const unwire = wireMetricsToEvents(bus, sink);

    bus.emit('session.started', { id: 's1' });
    bus.emit('session.ended', {
      id: 's1',
      usage: { input: 100, output: 50, cacheRead: 10, cacheWrite: 5 },
    });
    bus.emit('session.damaged', { sessionId: 's1', detail: 'truncated' });
    bus.emit('iteration.limit_reached', {
      currentIterations: 10,
      currentLimit: 10,
      grant: () => {},
      deny: () => {},
    });
    bus.emit('provider.response', {
      ctx: {} as any,
      usage: { input: 100, output: 50, cacheRead: 7, cacheWrite: 3 },
      stopReason: 'end_turn',
    });
    bus.emit('provider.retry', {
      providerId: 'anthropic',
      attempt: 1,
      delayMs: 100,
      status: 503,
      description: 'retry',
    });
    bus.emit('provider.error', {
      providerId: 'anthropic',
      status: 500,
      description: 'boom',
      retryable: false,
    });
    bus.emit('tool.started', { name: 'read', id: '1' });
    bus.emit('token.threshold', { used: 1000, limit: 8000 });
    bus.emit('mcp.server.connected', { name: 'gh', toolCount: 5 });
    bus.emit('mcp.server.reconnected', { name: 'gh', toolCount: 5 });
    bus.emit('mcp.server.disconnected', { name: 'gh', reason: 'eof' });
    bus.emit('error', { err: new Error('x'), phase: 'tool' });

    const snap = sink.snapshot();
    const has = (name: string) => snap.series.some((s) => s.name === name);
    expect(has('agent.sessions.started')).toBe(true);
    expect(has('agent.sessions.ended')).toBe(true);
    expect(has('agent.session.tokens.input')).toBe(true);
    expect(has('agent.session.tokens.output')).toBe(true);
    expect(has('agent.sessions.damaged')).toBe(true);
    expect(has('agent.iteration_limit.hit')).toBe(true);
    expect(has('provider.responses.total')).toBe(true);
    expect(has('provider.tokens.cache_write')).toBe(true);
    expect(has('provider.retries.total')).toBe(true);
    expect(has('provider.errors.total')).toBe(true);
    expect(has('tool.starts.total')).toBe(true);
    expect(has('agent.tokens.used')).toBe(true);
    expect(has('mcp.connects.total')).toBe(true);
    expect(has('mcp.reconnects.total')).toBe(true);
    expect(has('mcp.disconnects.total')).toBe(true);
    expect(has('agent.errors.total')).toBe(true);

    unwire();
  });

  it('listener exception in metrics does not crash EventBus', () => {
    const bus = new EventBus();
    bus.setLogger({ error: vi.fn() });
    const sink: any = {
      counter: vi.fn(() => {
        throw new Error('sink dead');
      }),
      gauge: vi.fn(),
      histogram: vi.fn(),
      snapshot: vi.fn(),
      reset: vi.fn(),
    };
    wireMetricsToEvents(bus, sink);

    expect(() => bus.emit('iteration.completed', { ctx: {} as any, index: 0 })).not.toThrow();
  });
});
