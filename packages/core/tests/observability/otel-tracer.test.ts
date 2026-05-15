import { describe, expect, it, vi } from 'vitest';
import { NoopTracer, OTelTracer } from '../../src/observability/index.js';

describe('OTelTracer adapter (L1-C)', () => {
  it('forwards startSpan name and attributes to upstream tracer', () => {
    const fakeSpan = {
      setAttribute: vi.fn(),
      recordException: vi.fn(),
      setStatus: vi.fn(),
      end: vi.fn(),
    };
    const upstream = {
      startSpan: vi.fn(() => fakeSpan),
    };
    const tracer = new OTelTracer(upstream);
    const span = tracer.startSpan('agent.run', { 'agent.model': 'gpt-4o' });
    span.setAttribute('agent.status', 'done');
    span.end();

    expect(upstream.startSpan).toHaveBeenCalledWith('agent.run', {
      attributes: { 'agent.model': 'gpt-4o' },
    });
    expect(fakeSpan.setAttribute).toHaveBeenCalledWith('agent.status', 'done');
    expect(fakeSpan.end).toHaveBeenCalled();
  });

  it('translates recordError into recordException + ERROR status', () => {
    const fakeSpan = {
      setAttribute: vi.fn(),
      recordException: vi.fn(),
      setStatus: vi.fn(),
      end: vi.fn(),
    };
    const upstream = { startSpan: vi.fn(() => fakeSpan) };
    const tracer = new OTelTracer(upstream);
    const span = tracer.startSpan('tool.bash');

    const err = new Error('rm: cannot remove');
    span.recordError(err);

    expect(fakeSpan.recordException).toHaveBeenCalledWith(err);
    expect(fakeSpan.setStatus).toHaveBeenCalledWith({
      code: 2, // OTel SpanStatusCode.ERROR
      message: 'rm: cannot remove',
    });
  });

  it('upstream startSpan called without attributes when none passed', () => {
    const fakeSpan = {
      setAttribute: vi.fn(),
      recordException: vi.fn(),
      end: vi.fn(),
    };
    const upstream = { startSpan: vi.fn(() => fakeSpan) };
    const tracer = new OTelTracer(upstream);
    tracer.startSpan('foo');
    expect(upstream.startSpan).toHaveBeenCalledWith('foo', undefined);
  });

  it('NoopTracer remains zero-overhead and returns a no-op span', () => {
    const tracer = new NoopTracer();
    const span = tracer.startSpan('agent.run');
    // None of these throw or have observable side effects.
    expect(() => span.setAttribute('k', 'v')).not.toThrow();
    expect(() => span.recordError(new Error('x'))).not.toThrow();
    expect(() => span.end()).not.toThrow();
  });
});
