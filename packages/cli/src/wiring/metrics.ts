import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { writeFileSync } from 'node:fs';
import {
  DefaultHealthRegistry,
  InMemoryMetricsSink,
  startMetricsServer,
  wireMetricsToEvents,
  type EventBus,
  type HealthRegistry,
  type MetricsServerHandle,
  type MetricsSink,
  type WstackPaths,
} from '@wrongstack/core';

export interface MetricsWiringDeps {
  flags: Record<string, unknown>;
  wpaths: WstackPaths;
  events: EventBus;
  logger: { info(msg: string): void; warn(msg: string): void };
  config: { provider: string; model: string };
}

export interface MetricsWiringResult {
  metricsSink: MetricsSink | undefined;
  healthRegistry: HealthRegistry | undefined;
  metricsServerHandle: MetricsServerHandle | undefined;
}

export function setupMetrics(params: MetricsWiringDeps): MetricsWiringResult {
  const { flags, wpaths, events, logger, config } = params;
  let metricsSink: MetricsSink | undefined;
  let healthRegistry: HealthRegistry | undefined;
  let metricsServerHandle: MetricsServerHandle | undefined;

  const metricsPortFlag = flags['metrics-port'];
  const metricsPort =
    typeof metricsPortFlag === 'string' && metricsPortFlag.length > 0
      ? Number.parseInt(metricsPortFlag, 10)
      : undefined;
  if (metricsPort !== undefined && !flags.metrics) flags.metrics = true;

  if (!flags.metrics) return { metricsSink, healthRegistry, metricsServerHandle };

  metricsSink = new InMemoryMetricsSink();
  wireMetricsToEvents(events, metricsSink);
  healthRegistry = new DefaultHealthRegistry();
  healthRegistry.register({
    name: 'session-store',
    check: async () => {
      try {
        await fs.access(wpaths.projectSessions);
        return { status: 'healthy' };
      } catch (e) {
        return { status: 'unhealthy', detail: e instanceof Error ? e.message : 'access denied' };
      }
    },
  });
  healthRegistry.register({
    name: 'provider',
    check: async () => ({
      status: 'healthy',
      data: { id: config.provider, model: config.model },
    }),
  });

  const dumpMetrics = () => {
    if (!metricsSink) return;
    try {
      const out = path.join(wpaths.projectSessions, 'metrics.json');
      const snap = metricsSink.snapshot();
      writeFileSync(out, JSON.stringify(snap, null, 2));
    } catch {
      // best-effort
    }
  };
  process.on('exit', dumpMetrics);
  process.on('SIGINT', () => {
    dumpMetrics();
    process.exit(130);
  });

  if (metricsPort !== undefined && Number.isFinite(metricsPort)) {
    try {
      // eslint-disable-next-line no-restricted-syntax
      metricsServerHandle = startMetricsServer({
        port: metricsPort,
        host: process.env['METRICS_HOST'] ?? '127.0.0.1',
        sink: metricsSink,
        healthRegistry,
      }) as unknown as MetricsServerHandle;
      logger.info(
        `metrics endpoint listening on ${(metricsServerHandle as unknown as { url?: string }).url} (healthz on same port)`,
      );
      process.on('exit', () => {
        void metricsServerHandle?.close().catch(() => {});
      });
    } catch (err) {
      logger.warn(
        `metrics endpoint failed to start: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return { metricsSink, healthRegistry, metricsServerHandle };
}