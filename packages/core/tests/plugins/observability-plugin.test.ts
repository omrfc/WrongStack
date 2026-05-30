import { describe, expect, it, vi } from 'vitest';
import {
  buildMetricsCommand,
  buildHealthCommand,
} from '../../src/plugins/observability-plugin.js';

// ── /metrics ────────────────────────────────────────────────────────────────

describe('buildMetricsCommand', () => {
  it('reports "metrics not enabled" when no sink', async () => {
    const cmd = buildMetricsCommand(undefined);
    const res = await cmd.run('', {} as never);
    expect(res.message).toContain('Metrics not enabled');
  });

  it('reports "no metrics recorded" when series is empty', async () => {
    const sink = { snapshot: () => ({ series: [] }) };
    const cmd = buildMetricsCommand(sink as never);
    const res = await cmd.run('', {} as never);
    expect(res.message).toContain('No metrics recorded');
  });

  it('renders counter and histogram series with labels', async () => {
    const sink = {
      snapshot: () => ({
        series: [
          {
            name: 'tokens_used',
            type: 'counter',
            labels: { provider: 'anthropic' },
            values: { value: 12345 },
          },
          {
            name: 'latency_ms',
            type: 'histogram',
            labels: { model: 'opus' },
            values: { count: 10, sum: 500, min: 30, max: 80, p50: 50, p95: 75, p99: 79 },
          },
          {
            name: 'no_labels',
            type: 'counter',
            labels: {},
            values: { value: 1 },
          },
        ],
      }),
    };
    const cmd = buildMetricsCommand(sink as never);
    const res = await cmd.run('', {} as never);
    const out = res.message ?? '';
    expect(out).toContain('# latency_ms');
    expect(out).toContain('count=10');
    expect(out).toContain('p95=75');
    expect(out).toContain('model=opus');
    expect(out).toContain('# tokens_used');
    expect(out).toContain('12345');
    expect(out).toContain('provider=anthropic');
    expect(out).toContain('# no_labels');
    // Series sorted alphabetically — latency comes before tokens
    expect(out.indexOf('latency_ms')).toBeLessThan(out.indexOf('tokens_used'));
  });
});

// ── /health ─────────────────────────────────────────────────────────────────

describe('buildHealthCommand', () => {
  it('reports "health checks not enabled" without registry', async () => {
    const cmd = buildHealthCommand(undefined);
    const res = await cmd.run('', {} as never);
    expect(res.message).toContain('Health checks not enabled');
  });

  it('runs the registry and renders each check status with details', async () => {
    const registry = {
      run: vi.fn().mockResolvedValue({
        status: 'unhealthy',
        timestamp: 0,
        checks: [
          { name: 'session-store', status: 'healthy' },
          { name: 'provider', status: 'unhealthy', detail: 'rate limited' },
          { name: 'cache', status: 'degraded', detail: 'stale' },
        ],
      }),
    };
    const cmd = buildHealthCommand(registry as never);
    const res = await cmd.run('', {} as never);
    const out = res.message ?? '';
    expect(out).toContain('overall: unhealthy');
    expect(out).toContain('session-store: healthy');
    expect(out).toContain('provider: unhealthy');
    expect(out).toContain('rate limited');
    expect(out).toContain('cache: degraded');
  });
});
