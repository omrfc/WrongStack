# /health - Health Check Runner

## What it does

Runs registered health checks from the injected `HealthRegistry` and reports their status. The command is registered by the built-in `wstack-observability` plugin and requires startup with `--metrics`; otherwise it reports that health checks are not enabled.

## Output format

```text
overall: healthy
  provider: healthy
  storage: healthy - /home/user/.wrongstack is writable
  session: degraded - 2 sessions open > 1h
```

## Code reference

- `packages/core/src/plugins/observability-plugin.ts`
- `packages/core/src/observability/health.ts`
- `packages/core/tests/plugins/observability-plugin.test.ts`
