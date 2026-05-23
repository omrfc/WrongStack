import type { EventBus } from '../kernel/events.js';
import type { MetricsSink } from '../types/observability.js';

/**
 * Subscribes a MetricsSink to the EventBus. Returns an unsubscribe function
 * that detaches all listeners. This is the single integration point between
 * the agent's event stream and the observability layer — no metric calls
 * leak into core call sites.
 */
export function wireMetricsToEvents(events: EventBus, sink: MetricsSink): () => void {
  const unsubs: Array<() => void> = [];

  unsubs.push(
    events.on('session.started', () => sink.counter('agent.sessions.started')),
    events.on('session.ended', (e) => {
      sink.counter('agent.sessions.ended');
      sink.histogram('agent.session.tokens.input', e.usage.input);
      sink.histogram('agent.session.tokens.output', e.usage.output);
    }),
    events.on('session.damaged', () => sink.counter('agent.sessions.damaged')),
    events.on('iteration.completed', () => sink.counter('agent.iterations.total')),
    events.on('iteration.limit_reached', () => sink.counter('agent.iteration_limit.hit')),
    events.on('provider.response', (e) => {
      sink.counter('provider.responses.total', 1, { stop_reason: e.stopReason });
      sink.counter('provider.tokens.input', e.usage.input);
      sink.counter('provider.tokens.output', e.usage.output);
      if (e.usage.cacheRead) sink.counter('provider.tokens.cache_read', e.usage.cacheRead);
      if (e.usage.cacheWrite) sink.counter('provider.tokens.cache_write', e.usage.cacheWrite);
    }),
    events.on('provider.retry', (e) =>
      sink.counter('provider.retries.total', 1, {
        provider: e.providerId,
        status: String(e.status),
      }),
    ),
    events.on('provider.error', (e) =>
      sink.counter('provider.errors.total', 1, {
        provider: e.providerId,
        status: String(e.status),
        retryable: String(e.retryable),
      }),
    ),
    events.on('tool.started', (e) => sink.counter('tool.starts.total', 1, { tool: e.name })),
    events.on('tool.executed', (e) => {
      sink.counter('tool.executions.total', 1, { tool: e.name, ok: String(e.ok) });
      sink.histogram('tool.duration_ms', e.durationMs, { tool: e.name });
    }),
    events.on('token.threshold', (e) => sink.gauge('agent.tokens.used', e.used)),
    events.on('compaction.fired', (e) => {
      sink.counter('compaction.fired.total');
      sink.histogram('compaction.reduction_tokens', e.report.before - e.report.after);
    }),
    events.on('mcp.server.connected', (e) =>
      sink.counter('mcp.connects.total', 1, { server: e.name }),
    ),
    events.on('mcp.server.reconnected', (e) =>
      sink.counter('mcp.reconnects.total', 1, { server: e.name }),
    ),
    events.on('mcp.server.disconnected', (e) =>
      sink.counter('mcp.disconnects.total', 1, { server: e.name }),
    ),
    events.on('error', (e) => sink.counter('agent.errors.total', 1, { phase: e.phase })),
  );

  return () => {
    for (const u of unsubs) u();
  };
}
