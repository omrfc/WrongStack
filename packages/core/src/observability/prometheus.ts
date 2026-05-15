import type { HealthRegistry, MetricsSink, MetricsSnapshot } from '../types/observability.js';

/**
 * L3-C: Prometheus text exposition format renderer.
 *
 * Implements v0.0.4 (the line-oriented format every scraper accepts):
 *   # HELP <name> <help>
 *   # TYPE <name> <counter|gauge|histogram|summary>
 *   <name>{label="value"} <number>
 *
 * Histograms are emitted as Prometheus *summary* type because our in-memory
 * sink already stores quantiles (p50/p95/p99) rather than open bucket lists.
 * That maps 1:1 onto Prometheus summary semantics and avoids us having to
 * carry a bucket schema we cannot infer from samples.
 */

const NUMBER_FORMAT_INFINITY = 'NaN'; // Prometheus accepts `NaN` for missing values.

function escapeLabelValue(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
}

function formatLabels(labels: Record<string, string>): string {
  const keys = Object.keys(labels);
  if (keys.length === 0) return '';
  const parts = keys.map((k) => `${k}="${escapeLabelValue(labels[k] ?? '')}"`);
  return `{${parts.join(',')}}`;
}

function formatNumber(n: number): string {
  if (!Number.isFinite(n)) return NUMBER_FORMAT_INFINITY;
  return Number.isInteger(n) ? n.toString() : n.toString();
}

function joinLabels(
  base: Record<string, string>,
  extra: Record<string, string>,
): Record<string, string> {
  return { ...base, ...extra };
}

/**
 * Render a `MetricsSnapshot` as Prometheus text-format bytes. The output
 * always ends with a trailing newline (Prometheus requires it).
 */
export function renderPrometheus(snapshot: MetricsSnapshot): string {
  // Group by name so we can emit one HELP/TYPE pair per metric.
  type Row = { labels: Record<string, string>; values: Record<string, number> };
  const groups = new Map<
    string,
    { type: MetricsSnapshot['series'][number]['type']; rows: Row[] }
  >();
  for (const s of snapshot.series) {
    let g = groups.get(s.name);
    if (!g) {
      g = { type: s.type, rows: [] };
      groups.set(s.name, g);
    }
    g.rows.push({ labels: s.labels, values: s.values });
  }

  const lines: string[] = [];
  for (const [name, g] of groups) {
    const promType = g.type === 'histogram' ? 'summary' : g.type;
    lines.push(`# HELP ${name} ${name}`);
    lines.push(`# TYPE ${name} ${promType}`);

    if (g.type === 'counter' || g.type === 'gauge') {
      for (const row of g.rows) {
        lines.push(`${name}${formatLabels(row.labels)} ${formatNumber(row.values.value ?? 0)}`);
      }
    } else {
      // histogram → summary
      for (const row of g.rows) {
        const { count = 0, sum = 0, p50 = 0, p95 = 0, p99 = 0 } = row.values;
        lines.push(
          `${name}${formatLabels(joinLabels(row.labels, { quantile: '0.5' }))} ${formatNumber(p50)}`,
        );
        lines.push(
          `${name}${formatLabels(joinLabels(row.labels, { quantile: '0.95' }))} ${formatNumber(p95)}`,
        );
        lines.push(
          `${name}${formatLabels(joinLabels(row.labels, { quantile: '0.99' }))} ${formatNumber(p99)}`,
        );
        lines.push(`${name}_sum${formatLabels(row.labels)} ${formatNumber(sum)}`);
        lines.push(`${name}_count${formatLabels(row.labels)} ${formatNumber(count)}`);
      }
    }
  }

  return lines.join('\n') + '\n';
}

/** MIME type Prometheus servers must respond with on /metrics. */
export const PROMETHEUS_CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8';

export interface MetricsServerOptions {
  port: number;
  /** Bind address. Defaults to 127.0.0.1 so we don't accidentally expose metrics publicly. */
  host?: string;
  sink: MetricsSink;
  /** Path to serve on. Defaults to /metrics. */
  path?: string;
  /**
   * V2-C: optional health registry. When provided, the server also responds
   * on `/healthz` (configurable via `healthPath`) with a JSON aggregate of
   * every registered health check. K8s probes expect a single HTTP server
   * exposing both `/metrics` and `/healthz`, so we mount them on the same
   * port rather than opening a sibling listener.
   */
  healthRegistry?: HealthRegistry;
  /** Path to serve health JSON on. Defaults to /healthz. */
  healthPath?: string;
}

export interface MetricsServerHandle {
  port: number;
  url: string;
  close(): Promise<void>;
}

/**
 * Start an HTTP server that exposes a Prometheus scrape endpoint.
 * Uses node:http directly to avoid pulling a framework into the core graph.
 *
 * Why bind to 127.0.0.1 by default: telemetry endpoints inside an agent
 * process can leak prompt content via metric labels (tool name, error
 * message, etc.). The default keeps that on the loopback interface;
 * operators who want network scraping opt in explicitly with host: '0.0.0.0'.
 */
export async function startMetricsServer(opts: MetricsServerOptions): Promise<MetricsServerHandle> {
  const { createServer } = await import('node:http');
  const host = opts.host ?? '127.0.0.1';
  const path = opts.path ?? '/metrics';
  const healthPath = opts.healthPath ?? '/healthz';
  const healthRegistry = opts.healthRegistry;

  const server = createServer((req, res) => {
    if (!req.url || req.method !== 'GET') {
      res.statusCode = req.url ? 405 : 400;
      res.end();
      return;
    }
    // Strip query string for the route match.
    const url = req.url.split('?')[0];

    if (url === path) {
      let body: string;
      try {
        body = renderPrometheus(opts.sink.snapshot());
      } catch (err) {
        res.statusCode = 500;
        res.setHeader('content-type', 'text/plain; charset=utf-8');
        res.end(`metrics render failed: ${err instanceof Error ? err.message : String(err)}`);
        return;
      }
      res.statusCode = 200;
      res.setHeader('content-type', PROMETHEUS_CONTENT_TYPE);
      res.end(body);
      return;
    }

    if (healthRegistry && url === healthPath) {
      // Health responses are async — run the checks then emit JSON.
      healthRegistry.run().then(
        (agg) => {
          // Status maps: healthy → 200, degraded → 200 (still serving), unhealthy → 503.
          res.statusCode = agg.status === 'unhealthy' ? 503 : 200;
          res.setHeader('content-type', 'application/json; charset=utf-8');
          res.end(JSON.stringify(agg, null, 2));
        },
        (err: unknown) => {
          res.statusCode = 500;
          res.setHeader('content-type', 'text/plain; charset=utf-8');
          res.end(`health run failed: ${err instanceof Error ? err.message : String(err)}`);
        },
      );
      return;
    }

    res.statusCode = 404;
    res.setHeader('content-type', 'text/plain; charset=utf-8');
    res.end('Not Found');
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error) => {
      server.off('listening', onListening);
      reject(err);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(opts.port, host);
  });

  const addr = server.address();
  const boundPort = typeof addr === 'object' && addr ? addr.port : opts.port;
  return {
    port: boundPort,
    url: `http://${host}:${boundPort}${path}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
