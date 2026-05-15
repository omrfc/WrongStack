import type {
  MetricLabels,
  MetricSeries,
  MetricsSink,
  MetricsSnapshot,
} from '../types/observability.js';

interface CounterState {
  value: number;
}

interface GaugeState {
  value: number;
}

interface HistogramState {
  count: number;
  sum: number;
  min: number;
  max: number;
  // Reservoir sample for cheap quantile estimates. 1024 samples gives <2% error
  // on p99 for typical agent workloads — small memory footprint, no exporter
  // dependency. Swap for HdrHistogram if you need bounded-error guarantees.
  samples: number[];
}

const RESERVOIR_SIZE = 1024;

function labelKey(labels: MetricLabels | undefined): string {
  if (!labels) return '';
  const keys = Object.keys(labels).sort();
  return keys.map((k) => `${k}=${labels[k]}`).join(',');
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor(q * sorted.length));
  return sorted[idx] ?? 0;
}

/**
 * In-memory metrics sink. Suitable for embedded use, tests, and /metrics
 * scrape over HTTP. For production push-based pipelines, write an adapter
 * that implements MetricsSink and forwards to OTLP/StatsD/Prometheus.
 */
export class InMemoryMetricsSink implements MetricsSink {
  private counters = new Map<string, Map<string, CounterState>>();
  private gauges = new Map<string, Map<string, GaugeState>>();
  private histograms = new Map<string, Map<string, HistogramState>>();

  counter(name: string, value = 1, labels?: MetricLabels): void {
    const series = this.getOrCreate(this.counters, name);
    const key = labelKey(labels);
    const state = series.get(key) ?? { value: 0 };
    state.value += value;
    series.set(key, state);
  }

  gauge(name: string, value: number, labels?: MetricLabels): void {
    const series = this.getOrCreate(this.gauges, name);
    series.set(labelKey(labels), { value });
  }

  histogram(name: string, value: number, labels?: MetricLabels): void {
    const series = this.getOrCreate(this.histograms, name);
    const key = labelKey(labels);
    let state = series.get(key);
    if (!state) {
      state = { count: 0, sum: 0, min: value, max: value, samples: [] };
      series.set(key, state);
    }
    state.count++;
    state.sum += value;
    if (value < state.min) state.min = value;
    if (value > state.max) state.max = value;
    if (state.samples.length < RESERVOIR_SIZE) {
      state.samples.push(value);
    } else {
      // Vitter's Algorithm R — every new value has size/count chance of replacing.
      const r = Math.floor(Math.random() * state.count);
      if (r < RESERVOIR_SIZE) state.samples[r] = value;
    }
  }

  snapshot(): MetricsSnapshot {
    const series: MetricSeries[] = [];

    for (const [name, byLabel] of this.counters) {
      for (const [key, state] of byLabel) {
        series.push({
          name,
          type: 'counter',
          labels: parseLabelKey(key),
          values: { value: state.value },
        });
      }
    }

    for (const [name, byLabel] of this.gauges) {
      for (const [key, state] of byLabel) {
        series.push({
          name,
          type: 'gauge',
          labels: parseLabelKey(key),
          values: { value: state.value },
        });
      }
    }

    for (const [name, byLabel] of this.histograms) {
      for (const [key, state] of byLabel) {
        const sorted = [...state.samples].sort((a, b) => a - b);
        series.push({
          name,
          type: 'histogram',
          labels: parseLabelKey(key),
          values: {
            count: state.count,
            sum: state.sum,
            min: state.min,
            max: state.max,
            p50: quantile(sorted, 0.5),
            p95: quantile(sorted, 0.95),
            p99: quantile(sorted, 0.99),
          },
        });
      }
    }

    return { timestamp: Date.now(), series };
  }

  reset(): void {
    this.counters.clear();
    this.gauges.clear();
    this.histograms.clear();
  }

  private getOrCreate<V>(bag: Map<string, Map<string, V>>, name: string): Map<string, V> {
    let series = bag.get(name);
    if (!series) {
      series = new Map();
      bag.set(name, series);
    }
    return series;
  }
}

function parseLabelKey(key: string): MetricLabels {
  if (!key) return {};
  const labels: MetricLabels = {};
  for (const pair of key.split(',')) {
    const eq = pair.indexOf('=');
    if (eq > 0) labels[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  return labels;
}

/** Cheap noop sink — drop-in default when observability is not configured. */
export class NoopMetricsSink implements MetricsSink {
  counter(): void {}
  gauge(): void {}
  histogram(): void {}
  snapshot(): MetricsSnapshot {
    return { timestamp: Date.now(), series: [] };
  }
  reset(): void {}
}
