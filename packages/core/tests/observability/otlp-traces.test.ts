import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildOtlpTracesRequest,
  startOtlpTraceExporter,
} from '../../src/observability/otlp-traces.js';

/**
 * V2-B: OTLP/JSON traces exporter. The tests exercise:
 *   1. The captured span shape — names, attrs, status, timing
 *   2. The OTLP wire body shape
 *   3. POST behavior (URL, headers, dedup of /v1/traces in endpoint)
 *   4. Failure paths — fetch error and 5xx — call onError, never throw
 *   5. Buffer cap eviction
 */

describe('startOtlpTraceExporter — span capture', () => {
  it('captures span name and attributes', async () => {
    const exp = startOtlpTraceExporter({ endpoint: 'http://x', fetchImpl: vi.fn() as any });
    const s = exp.tracer.startSpan('Agent.run', { iteration: 1 });
    s.setAttribute('model', 'claude');
    s.end();

    const buf = exp.buffered();
    expect(buf).toHaveLength(1);
    expect(buf[0]!.name).toBe('Agent.run');
    expect(buf[0]!.attributes.iteration).toBe(1);
    expect(buf[0]!.attributes.model).toBe('claude');
    expect(buf[0]!.endTimeUnixNano).toBeDefined();
    await exp.stop();
  });

  it('recordError sets ERROR status and exception attrs', async () => {
    const exp = startOtlpTraceExporter({ endpoint: 'http://x', fetchImpl: vi.fn() as any });
    const s = exp.tracer.startSpan('tool.bash');
    s.recordError(new TypeError('boom'));
    s.end();
    const buf = exp.buffered();
    expect(buf[0]!.status.code).toBe(2);
    expect(buf[0]!.attributes['exception.message']).toBe('boom');
    expect(buf[0]!.attributes['exception.type']).toBe('TypeError');
    await exp.stop();
  });

  it('end() without error sets OK status', async () => {
    const exp = startOtlpTraceExporter({ endpoint: 'http://x', fetchImpl: vi.fn() as any });
    const s = exp.tracer.startSpan('tool.read');
    s.end();
    expect(exp.buffered()[0]!.status.code).toBe(1);
    await exp.stop();
  });

  it('end() is idempotent — second call does not duplicate the buffer entry', async () => {
    const exp = startOtlpTraceExporter({ endpoint: 'http://x', fetchImpl: vi.fn() as any });
    const s = exp.tracer.startSpan('x');
    s.end();
    s.end();
    expect(exp.buffered()).toHaveLength(1);
    await exp.stop();
  });

  it('respects maxBufferedSpans by dropping oldest', async () => {
    const exp = startOtlpTraceExporter({
      endpoint: 'http://x',
      maxBufferedSpans: 3,
      fetchImpl: vi.fn() as any,
    });
    for (let i = 0; i < 5; i++) exp.tracer.startSpan(`s${i}`).end();
    const names = exp.buffered().map((b) => b.name);
    expect(names).toEqual(['s2', 's3', 's4']);
    await exp.stop();
  });
});

describe('buildOtlpTracesRequest', () => {
  it('encodes spans into resourceSpans → scopeSpans → spans', () => {
    const now = BigInt(Date.now()) * 1_000_000n;
    const body = buildOtlpTracesRequest([
      {
        traceId: 'a'.repeat(32),
        spanId: 'b'.repeat(16),
        name: 'Agent.run',
        startTimeUnixNano: now,
        endTimeUnixNano: now + 1_000_000n,
        attributes: { foo: 'bar', count: 42, ok: true, pi: 3.14 },
        status: { code: 1 },
      },
    ]);

    const span = body.resourceSpans[0]!.scopeSpans[0]!.spans[0]!;
    expect(span.name).toBe('Agent.run');
    expect(span.traceId).toBe('a'.repeat(32));
    expect(span.spanId).toBe('b'.repeat(16));

    const attrs = span.attributes;
    expect(attrs.find((a) => a.key === 'foo')!.value).toEqual({ stringValue: 'bar' });
    expect(attrs.find((a) => a.key === 'count')!.value).toEqual({ intValue: '42' });
    expect(attrs.find((a) => a.key === 'ok')!.value).toEqual({ boolValue: true });
    expect(attrs.find((a) => a.key === 'pi')!.value).toEqual({ doubleValue: 3.14 });
  });

  it('attaches the default service.name resource attribute', () => {
    const body = buildOtlpTracesRequest([]);
    const attrs = body.resourceSpans[0]!.resource.attributes;
    expect(attrs.find((a) => a.key === 'service.name')!.value).toEqual({
      stringValue: 'wrongstack',
    });
  });
});

describe('startOtlpTraceExporter — push behavior', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('POSTs to /v1/traces with content-type application/json', async () => {
    const fetchImpl = vi.fn(
      async () => new Response('', { status: 200 }),
    ) as never as typeof globalThis.fetch;
    const exp = startOtlpTraceExporter({ endpoint: 'http://collector:4318', fetchImpl });

    exp.tracer.startSpan('hello').end();
    await exp.flush();

    const calls = (fetchImpl as never as { mock: { calls: unknown[][] } }).mock.calls;
    expect(calls).toHaveLength(1);
    const [url, init] = calls[0] as [string, RequestInit];
    expect(url).toBe('http://collector:4318/v1/traces');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['content-type']).toBe('application/json');
    await exp.stop();
  });

  it('does not duplicate /v1/traces when endpoint already includes it', async () => {
    const fetchImpl = vi.fn(
      async () => new Response('', { status: 200 }),
    ) as never as typeof globalThis.fetch;
    const exp = startOtlpTraceExporter({
      endpoint: 'https://otel.example.com/v1/traces',
      fetchImpl,
    });
    exp.tracer.startSpan('hi').end();
    await exp.flush();
    const [url] = (fetchImpl as never as { mock: { calls: unknown[][] } }).mock.calls[0] as [
      string,
    ];
    expect(url).toBe('https://otel.example.com/v1/traces');
    await exp.stop();
  });

  it('drains the buffer on push — second flush sends nothing', async () => {
    const fetchImpl = vi.fn(
      async () => new Response('', { status: 200 }),
    ) as never as typeof globalThis.fetch;
    const exp = startOtlpTraceExporter({ endpoint: 'http://x:4318', fetchImpl });

    exp.tracer.startSpan('a').end();
    await exp.flush();
    await exp.flush();
    const calls = (fetchImpl as never as { mock: { calls: unknown[][] } }).mock.calls;
    expect(calls).toHaveLength(1);
    await exp.stop();
  });

  it('calls onError on 5xx', async () => {
    const fetchImpl = vi.fn(
      async () => new Response('boom', { status: 500 }),
    ) as never as typeof globalThis.fetch;
    const onError = vi.fn();
    const exp = startOtlpTraceExporter({ endpoint: 'http://x:4318', fetchImpl, onError });

    exp.tracer.startSpan('s').end();
    await exp.flush();

    expect(onError).toHaveBeenCalled();
    expect((onError.mock.calls[0]![0] as Error).message).toContain('500');
    await exp.stop();
  });
});
