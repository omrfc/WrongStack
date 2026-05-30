import { color } from '../utils/color.js';
import type { Plugin } from '../types/plugin.js';
import type { SlashCommand } from '../index.js';
import type { HealthRegistry, MetricsSink } from '../types/observability.js';

interface ObservabilityPluginOptions {
  metricsSink?: MetricsSink;
  healthRegistry?: HealthRegistry;
}

/**
 * ObservabilityPlugin — runtime metrics + health checks.
 *
 * Registers `/metrics` and `/health`. First-party ("official") plugin, so the
 * commands keep their bare names. Both require the host to have started the
 * metrics subsystem (`--metrics`); without it they report that and no-op.
 */
export function createObservabilityPlugin(opts?: ObservabilityPluginOptions): Plugin {
  return {
    name: 'wstack-observability',
    version: '1.0.0',
    description: 'Runtime metrics and health checks: /metrics, /health',
    apiVersion: '^0.1',
    capabilities: { slashCommands: true },
    defaultConfig: {},

    setup(api) {
      const rawConfig = api.config as unknown as Record<string, unknown>;
      const metricsSink = opts?.metricsSink ?? (rawConfig.metricsSink as MetricsSink | undefined);
      const healthRegistry =
        opts?.healthRegistry ?? (rawConfig.healthRegistry as HealthRegistry | undefined);

      api.slashCommands.register(buildMetricsCommand(metricsSink));
      api.slashCommands.register(buildHealthCommand(healthRegistry));
      api.log.info('[observability] loaded — /metrics, /health available');
    },

    teardown(api) {
      api.slashCommands.unregister('metrics');
      api.slashCommands.unregister('health');
      api.log.info('[observability] unloaded');
    },

    async health() {
      return { ok: true, message: 'observability ready' };
    },
  };
}

function statusIcon(status: string): string {
  if (status === 'healthy') return color.green('●');
  if (status === 'degraded') return color.yellow('●');
  return color.red('●');
}

export function buildMetricsCommand(metricsSink?: MetricsSink): SlashCommand {
  return {
    name: 'metrics',
    description: 'Show metrics snapshot (requires --metrics flag).',
    async run() {
      if (!metricsSink) {
        return { message: 'Metrics not enabled. Restart with --metrics to collect.' };
      }
      const snap = metricsSink.snapshot();
      if (snap.series.length === 0) return { message: 'No metrics recorded yet.' };

      const lines: string[] = [];
      const byName = new Map<string, typeof snap.series>();
      for (const s of snap.series) {
        const bucket = byName.get(s.name) ?? [];
        bucket.push(s);
        byName.set(s.name, bucket);
      }
      for (const [name, series] of [...byName.entries()].sort()) {
        lines.push(color.dim(`# ${name}`));
        for (const s of series) {
          const labels = Object.entries(s.labels)
            .map(([k, v]) => `${k}=${v}`)
            .join(' ');
          const labelStr = labels ? color.dim(` {${labels}}`) : '';
          if (s.type === 'histogram') {
            lines.push(
              `  count=${s.values.count} sum=${s.values.sum} min=${s.values.min} max=${s.values.max} p50=${s.values.p50} p95=${s.values.p95} p99=${s.values.p99}${labelStr}`,
            );
          } else {
            lines.push(`  ${s.values.value}${labelStr}`);
          }
        }
      }
      return { message: lines.join('\n') };
    },
  };
}

export function buildHealthCommand(healthRegistry?: HealthRegistry): SlashCommand {
  return {
    name: 'health',
    description: 'Run health checks (requires --metrics flag).',
    async run() {
      if (!healthRegistry) {
        return { message: 'Health checks not enabled. Restart with --metrics.' };
      }
      const result = await healthRegistry.run();
      const lines = [
        `${statusIcon(result.status)} overall: ${result.status}`,
        ...result.checks.map((c) => {
          const detail = c.detail ? color.dim(` — ${c.detail}`) : '';
          return `  ${statusIcon(c.status)} ${c.name}: ${c.status}${detail}`;
        }),
      ];
      return { message: lines.join('\n') };
    },
  };
}
