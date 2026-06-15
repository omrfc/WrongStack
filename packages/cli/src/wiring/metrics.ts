import { writeFileSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { toErrorMessage } from '@wrongstack/core/utils';
import {
  DefaultHealthRegistry,
  type EventBus,
  type HealthRegistry,
  InMemoryMetricsSink,
  type MetricsServerHandle,
  type MetricsSink,
  startMetricsServer,
  type WstackPaths,
  wireMetricsToEvents,
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
  // Dump on natural exit. We deliberately do NOT register a SIGINT
  // handler that calls process.exit() — doing so would preempt the
  // REPL's "press Ctrl+C twice to exit" semantics and turn a soft
  // abort (cancel current iteration) into a hard kill of the process.
  // Other SIGINT handlers (repl.ts, execution.ts, tui/app.tsx) own
  // the exit lifecycle; when they ultimately call process.exit the
  // 'exit' event fires and dumpMetrics runs.
  process.on('exit', dumpMetrics);

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
        `metrics endpoint listening on ${(metricsServerHandle as unknown as { url?: string | undefined }).url} (healthz on same port)`,
      );
      process.on('exit', () => {
        void metricsServerHandle?.close().catch(() => {});
      });
    } catch (err) {
      logger.warn(
        `metrics endpoint failed to start: ${toErrorMessage(err)}`,
      );
    }
  }

  return { metricsSink, healthRegistry, metricsServerHandle };
}
