import * as crypto from 'node:crypto';
import type { Span, Tracer } from '../types/observability.js';

/**
 * V2-B: OTLP/JSON trace exporter.
 *
 * The `Tracer` produced here captures every started span into an
 * in-memory buffer; an exporter timer drains the buffer and POSTs to
 * `/v1/traces` on the configured OTLP HTTP endpoint.
 *
 * Two production paths:
 *
 *   1. **This adapter** — zero deps, single-process, no parent/child
 *      relationships (every span is a root span). Suitable when you
 *      mostly want to see the agent's iteration / provider-call /
 *      tool-call timings in a vendor UI (Jaeger, Tempo, Honeycomb,
 *      Datadog APM, Grafana Cloud, Lightstep, …).
 *
 *   2. **Wrap a real OTel SDK** via the existing `OTelTracer` adapter.
 *      Use this when you need context propagation, distributed traces
 *      across processes, or vendor-specific span attributes.
 *
 * Keep `@opentelemetry/*` out of the dependency graph by design — both
 * paths above let users opt in to that dep on their own.
 */

const SPAN_STATUS_CODE_UNSET = 0;
const SPAN_STATUS_CODE_OK = 1;
const SPAN_STATUS_CODE_ERROR = 2;

type SpanAttrValue = string | number | boolean;

interface RecordedSpan {
  traceId: string;
  spanId: string;
  name: string;
  startTimeUnixNano: bigint;
  endTimeUnixNano?: bigint;
  attributes: Record<string, SpanAttrValue>;
  status: { code: number; message?: string };
}

function hex(bytes: number): string {
  return crypto.randomBytes(bytes).toString('hex');
}

function nowNs(): bigint {
  // Date.now() resolution is 1ms — fine for spans whose work takes ≥1ms.
  // Performance.now-based high-res nanoseconds would help, but reference
  // monoclock differs across processes and the OTLP receiver expects
  // wall-clock anyway.
  return BigInt(Date.now()) * 1_000_000n;
}

class CapturingSpan implements Span {
  constructor(
    private readonly state: RecordedSpan,
    private readonly onEnd: (s: RecordedSpan) => void,
  ) {}

  setAttribute(key: string, value: SpanAttrValue): void {
    this.state.attributes[key] = value;
  }

  recordError(err: Error): void {
    this.state.status = { code: SPAN_STATUS_CODE_ERROR, message: err.message };
    this.state.attributes['exception.message'] = err.message;
    if (err.name) this.state.attributes['exception.type'] = err.name;
  }

  end(): void {
    if (this.state.endTimeUnixNano !== undefined) return;
    this.state.endTimeUnixNano = nowNs();
    if (this.state.status.code === SPAN_STATUS_CODE_UNSET) {
      this.state.status.code = SPAN_STATUS_CODE_OK;
    }
    this.onEnd(this.state);
  }
}

export interface OtlpTraceExporterOptions {
  /** OTLP HTTP endpoint base URL. `/v1/traces` is appended unless already present. */
  endpoint: string;
  /** Push interval in milliseconds. Defaults to 5s (traces are bursty). */
  intervalMs?: number;
  /** Hard cap on buffered spans. When exceeded, oldest are dropped. Defaults to 2048. */
  maxBufferedSpans?: number;
  /** Authorization header. */
  authorization?: string;
  /** Extra request headers. */
  headers?: Record<string, string>;
  /** Resource attributes. Defaults to `service.name=wrongstack`. */
  resourceAttributes?: Record<string, string>;
  /** Instrumentation scope name. Default `wrongstack`. */
  scopeName?: string;
  /** Per-request timeout in ms. Default 10s. */
  timeoutMs?: number;
  /** Override fetch (for tests). */
  fetchImpl?: typeof globalThis.fetch;
  /** Called on push failure. Defaults to silent. */
  onError?: (err: unknown) => void;
}

export interface OtlpTraceExporterHandle {
  /** The Tracer to install on Agent / ToolExecutor. */
  readonly tracer: Tracer;
  /** Push buffered spans immediately. */
  flush(): Promise<void>;
  /** Stop the timer, push remaining spans, resolve. */
  stop(): Promise<void>;
  /** Test helper: snapshot of spans currently in the buffer (not yet pushed). */
  readonly buffered: () => readonly RecordedSpan[];
}

const DEFAULT_INTERVAL_MS = 5_000;
const DEFAULT_BUFFER_CAP = 2048;
const DEFAULT_TIMEOUT_MS = 10_000;

function joinEndpoint(base: string): string {
  if (/\/v1\/traces\/?$/.test(base)) return base;
  return base.replace(/\/$/, '') + '/v1/traces';
}

interface OtlpAttribute {
  key: string;
  value:
    | { stringValue: string }
    | { boolValue: boolean }
    | { doubleValue: number }
    | { intValue: string };
}

function encodeAttr(key: string, value: SpanAttrValue): OtlpAttribute {
  if (typeof value === 'boolean') return { key, value: { boolValue: value } };
  if (typeof value === 'number') {
    return Number.isInteger(value)
      ? { key, value: { intValue: String(value) } }
      : { key, value: { doubleValue: value } };
  }
  return { key, value: { stringValue: value } };
}

interface OtlpSpan {
  traceId: string;
  spanId: string;
  name: string;
  kind: 1;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: OtlpAttribute[];
  status: { code: number; message?: string };
}

interface OtlpTracesRequest {
  resourceSpans: {
    resource: { attributes: OtlpAttribute[] };
    scopeSpans: {
      scope: { name: string };
      spans: OtlpSpan[];
    }[];
  }[];
}

export function buildOtlpTracesRequest(
  spans: readonly RecordedSpan[],
  opts: { resourceAttributes?: Record<string, string>; scopeName?: string } = {},
): OtlpTracesRequest {
  const resourceAttributes = opts.resourceAttributes ?? { 'service.name': 'wrongstack' };
  const scopeName = opts.scopeName ?? 'wrongstack';

  const otlpSpans: OtlpSpan[] = spans.map((s) => ({
    traceId: s.traceId,
    spanId: s.spanId,
    name: s.name,
    kind: 1, // SPAN_KIND_INTERNAL
    startTimeUnixNano: s.startTimeUnixNano.toString(),
    endTimeUnixNano: (s.endTimeUnixNano ?? s.startTimeUnixNano).toString(),
    attributes: Object.entries(s.attributes).map(([k, v]) => encodeAttr(k, v)),
    status: s.status,
  }));

  return {
    resourceSpans: [
      {
        resource: {
          attributes: Object.entries(resourceAttributes).map(([k, v]) => encodeAttr(k, v)),
        },
        scopeSpans: [{ scope: { name: scopeName }, spans: otlpSpans }],
      },
    ],
  };
}

/**
 * Start the OTLP trace exporter. Returns a `Tracer` to install on the
 * runtime (`Agent.run` etc.) and `flush()`/`stop()` controls.
 */
export function startOtlpTraceExporter(opts: OtlpTraceExporterOptions): OtlpTraceExporterHandle {
  const url = joinEndpoint(opts.endpoint);
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  const maxBuffered = opts.maxBufferedSpans ?? DEFAULT_BUFFER_CAP;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const onError = opts.onError ?? (() => {});
  const resourceAttributes = opts.resourceAttributes ?? { 'service.name': 'wrongstack' };
  const scopeName = opts.scopeName ?? 'wrongstack';

  let stopped = false;
  const buffer: RecordedSpan[] = [];

  const headers: Record<string, string> = {
    'content-type': 'application/json',
    ...(opts.headers ?? {}),
  };
  if (opts.authorization) headers.authorization = opts.authorization;

  const tracer: Tracer = {
    startSpan(name, attrs) {
      const state: RecordedSpan = {
        traceId: hex(16),
        spanId: hex(8),
        name,
        startTimeUnixNano: nowNs(),
        attributes: { ...(attrs ?? {}) },
        status: { code: SPAN_STATUS_CODE_UNSET },
      };
      return new CapturingSpan(state, (ended) => {
        if (buffer.length >= maxBuffered) buffer.shift();
        buffer.push(ended);
      });
    },
  };

  async function pushOnce(): Promise<void> {
    if (buffer.length === 0) return;
    const batch = buffer.splice(0, buffer.length);
    const body = buildOtlpTracesRequest(batch, { resourceAttributes, scopeName });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        onError(new Error(`OTLP traces push failed: ${res.status} ${res.statusText} ${text}`));
      }
    } catch (err) {
      onError(err);
    } finally {
      clearTimeout(timer);
    }
  }

  const handle = setInterval(() => {
    if (!stopped) void pushOnce();
  }, intervalMs);
  handle.unref?.();

  return {
    tracer,
    flush: pushOnce,
    async stop() {
      stopped = true;
      clearInterval(handle);
      await pushOnce().catch(onError);
    },
    buffered: () => [...buffer],
  };
}
