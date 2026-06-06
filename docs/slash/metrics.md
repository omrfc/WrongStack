# /metrics - Metrics Snapshot

## What it does

Dumps the current metrics snapshot from the configured `MetricsSink`. The command is registered by the built-in `wstack-observability` plugin and requires startup with `--metrics`; otherwise it reports that metrics collection is not enabled.

## Output format

Metrics are grouped by name and sorted alphabetically:

```text
# provider/complete
  count=42 sum=3.8 min=0.05 max=1.2 p50=0.09 p95=0.45 p99=0.88 {model=claude-3-5-sonnet}

# tool/execute
  count=128 sum=0.0 min=0.0 max=0.0 p50=0 p95=0 p99=0 {tool=read}
```

Each series shows `count`, `sum`, `min`, `max`, `p50`/`p95`/`p99` for histograms or a single `value` for gauges. Label key-value pairs are shown after the value.

## Code reference

- `packages/core/src/plugins/observability-plugin.ts`
- `packages/core/src/observability/metrics.ts`
- `packages/core/src/observability/event-bridge.ts`
- `packages/core/tests/plugins/observability-plugin.test.ts`
