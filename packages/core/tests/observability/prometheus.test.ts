import { describe, expect, it } from 'vitest';
import { InMemoryMetricsSink } from '../../src/observability/metrics.js';
import {
  PROMETHEUS_CONTENT_TYPE,
  renderPrometheus,
  startMetricsServer,
} from '../../src/observability/prometheus.js';

describe('Prometheus exposition (L3-C)', () => {
  it('renders counters and gauges as their Prometheus types', () => {
    const sink = new InMemoryMetricsSink();
    sink.counter('agent_runs_total', 3, { mode: 'plan' });
    sink.gauge('active_subagents', 2);

    const out = renderPrometheus(sink.snapshot());

    expect(out).toContain('# TYPE agent_runs_total counter');
    expect(out).toContain('agent_runs_total{mode="plan"} 3');
    expect(out).toContain('# TYPE active_subagents gauge');
    expect(out).toContain('active_subagents 2');
    expect(out.endsWith('\n')).toBe(true);
  });

  it('renders histograms as Prometheus summaries with quantile labels', () => {
    const sink = new InMemoryMetricsSink();
    for (let i = 1; i <= 100; i++) sink.histogram('tool_duration_ms', i, { tool: 'bash' });

    const out = renderPrometheus(sink.snapshot());
    expect(out).toContain('# TYPE tool_duration_ms summary');
    expect(out).toMatch(/tool_duration_ms\{tool="bash",quantile="0\.5"\} \d/);
    expect(out).toMatch(/tool_duration_ms\{tool="bash",quantile="0\.99"\} \d/);
    expect(out).toMatch(/tool_duration_ms_sum\{tool="bash"\} \d/);
    expect(out).toMatch(/tool_duration_ms_count\{tool="bash"\} 100/);
  });

  it('escapes label values that contain quotes, backslashes, and newlines', () => {
    const sink = new InMemoryMetricsSink();
    sink.counter('errors_total', 1, { detail: 'oops "quoted"\nand \\back' });
    const out = renderPrometheus(sink.snapshot());
    expect(out).toContain('detail="oops \\"quoted\\"\\nand \\\\back"');
  });

  it('emits empty output (just header-less newline-free) when no metrics recorded', () => {
    const sink = new InMemoryMetricsSink();
    const out = renderPrometheus(sink.snapshot());
    expect(out).toBe('\n');
  });

  it('serves /metrics over HTTP with the correct content-type', async () => {
    const sink = new InMemoryMetricsSink();
    sink.counter('hits_total', 5);

    const handle = await startMetricsServer({ port: 0, sink });
    try {
      const res = await fetch(handle.url);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe(PROMETHEUS_CONTENT_TYPE);
      const body = await res.text();
      expect(body).toContain('hits_total 5');
    } finally {
      await handle.close();
    }
  });

  it('returns 404 for paths other than /metrics', async () => {
    const handle = await startMetricsServer({ port: 0, sink: new InMemoryMetricsSink() });
    try {
      const res = await fetch(`http://127.0.0.1:${handle.port}/nope`);
      expect(res.status).toBe(404);
    } finally {
      await handle.close();
    }
  });

  it('supports a custom path option', async () => {
    const handle = await startMetricsServer({
      port: 0,
      sink: new InMemoryMetricsSink(),
      path: '/observe',
    });
    try {
      const ok = await fetch(`http://127.0.0.1:${handle.port}/observe`);
      expect(ok.status).toBe(200);
      const notFound = await fetch(`http://127.0.0.1:${handle.port}/metrics`);
      expect(notFound.status).toBe(404);
    } finally {
      await handle.close();
    }
  });
});

describe('/healthz endpoint (V2-C)', () => {
  it('serves /healthz next to /metrics when a HealthRegistry is provided', async () => {
    const { DefaultHealthRegistry } = await import('../../src/observability/health.js');
    const sink = new InMemoryMetricsSink();
    const health = new DefaultHealthRegistry();
    health.register({
      name: 'session-store',
      check: async () => ({ status: 'healthy' }),
    });

    const handle = await startMetricsServer({ port: 0, sink, healthRegistry: health });
    try {
      const m = await fetch(`http://127.0.0.1:${handle.port}/metrics`);
      expect(m.status).toBe(200);

      const h = await fetch(`http://127.0.0.1:${handle.port}/healthz`);
      expect(h.status).toBe(200);
      expect(h.headers.get('content-type')).toContain('application/json');
      const json = (await h.json()) as {
        status: string;
        checks: { name: string; status: string }[];
      };
      expect(json.status).toBe('healthy');
      expect(json.checks).toHaveLength(1);
      expect(json.checks[0]!.name).toBe('session-store');
    } finally {
      await handle.close();
    }
  });

  it('returns 503 when at least one check is unhealthy', async () => {
    const { DefaultHealthRegistry } = await import('../../src/observability/health.js');
    const sink = new InMemoryMetricsSink();
    const health = new DefaultHealthRegistry();
    health.register({
      name: 'broken',
      check: async () => ({ status: 'unhealthy', detail: 'oops' }),
    });

    const handle = await startMetricsServer({ port: 0, sink, healthRegistry: health });
    try {
      const res = await fetch(`http://127.0.0.1:${handle.port}/healthz`);
      expect(res.status).toBe(503);
      const json = (await res.json()) as { status: string };
      expect(json.status).toBe('unhealthy');
    } finally {
      await handle.close();
    }
  });

  it('returns 200 for degraded (still-serving) status', async () => {
    const { DefaultHealthRegistry } = await import('../../src/observability/health.js');
    const sink = new InMemoryMetricsSink();
    const health = new DefaultHealthRegistry();
    health.register({
      name: 'slow-dep',
      check: async () => ({ status: 'degraded', detail: 'latency high' }),
    });

    const handle = await startMetricsServer({ port: 0, sink, healthRegistry: health });
    try {
      const res = await fetch(`http://127.0.0.1:${handle.port}/healthz`);
      expect(res.status).toBe(200);
      const json = (await res.json()) as { status: string };
      expect(json.status).toBe('degraded');
    } finally {
      await handle.close();
    }
  });

  it('supports custom healthPath', async () => {
    const { DefaultHealthRegistry } = await import('../../src/observability/health.js');
    const handle = await startMetricsServer({
      port: 0,
      sink: new InMemoryMetricsSink(),
      healthRegistry: new DefaultHealthRegistry(),
      healthPath: '/livez',
    });
    try {
      const live = await fetch(`http://127.0.0.1:${handle.port}/livez`);
      expect(live.status).toBe(200);
      const wrong = await fetch(`http://127.0.0.1:${handle.port}/healthz`);
      expect(wrong.status).toBe(404);
    } finally {
      await handle.close();
    }
  });

  it('returns 404 for /healthz when no HealthRegistry was provided', async () => {
    const handle = await startMetricsServer({ port: 0, sink: new InMemoryMetricsSink() });
    try {
      const res = await fetch(`http://127.0.0.1:${handle.port}/healthz`);
      expect(res.status).toBe(404);
    } finally {
      await handle.close();
    }
  });
});
