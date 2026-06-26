import type {
  Capabilities,
  Provider,
  ProviderFactory,
  Request,
  StreamEvent,
  WireFamily,
} from '@wrongstack/core';
import type { ProviderError } from '@wrongstack/core';
import { parseProviderHttpError } from './error-parse.js';
import { type SSEMessage, parseSSE } from './sse.js';
import { WireAdapter, type WireAdapterStreamOptions } from './wire-adapter.js';

/**
 * Declarative wire-format definition. Sufficient to add a new HTTP+SSE
 * provider without subclassing `WireAdapter` — the boilerplate (HTTP errors,
 * abort wiring, SSE body parsing) is shared.
 *
 * The shape covers the variation that actually matters between providers:
 *   - URL template (path, query)
 *   - Auth headers (x-api-key, Authorization, etc.)
 *   - Request body (field names, system-prompt placement, tool format)
 *   - SSE event translation (one wire event → 0+ canonical events)
 *
 * Anything more exotic (non-SSE streams, multipart bodies, OAuth flows) still
 * needs a hand-written subclass — those cases are too varied to template.
 *
 * `S` is provider-internal state threaded across SSE events for one stream:
 * accumulating partial tool-call JSON, tracking block kinds, carrying the
 * model id forward from `message_start`, etc. Each `stream()` call gets a
 * fresh `S` via `createStreamState`.
 */
export interface WireFormatConfig<S = Record<string, unknown>> {
  /** Provider id (matches catalog id when the provider is in models.dev). */
  id: string;
  /** Wire family — used by the registry's factory list. */
  family: WireFamily;
  capabilities: Capabilities;
  /** Used when the user doesn't override via config.baseUrl. */
  defaultBaseUrl: string;
  /** Build the HTTPS endpoint. Receives the (possibly user-overridden) base URL. */
  buildUrl(baseUrl: string, req: Request): string;
  /** Per-request headers. Default `content-type`/`accept` are provided already. */
  buildHeaders(apiKey: string, req: Request): Record<string, string>;
  /** Map a canonical Request onto the provider's body shape.
   *  Receives the provider's resolved `Capabilities` so per-model fields
   *  like `capabilities.maxOutput` can substitute for an absent
   *  `req.maxTokens`. The catalog overlay in `withCatalogCapabilities`
   *  means `ctx.capabilities` reflects the active model, not just the
   *  family default. The `ctx` is required so callers always know
   *  where to look for the model's ceiling. */
  buildBody(req: Request, ctx: { capabilities: Capabilities }): Record<string, unknown>;
  /** Construct fresh per-stream state. Called once per `stream()` call. */
  createStreamState(fallbackModel: string): S;
  /**
   * Translate one SSE event into 0+ canonical events. Mutating `state` is
   * expected — providers carry per-stream accumulators (partial tool JSON,
   * current model id, usage) here.
   */
  parseStreamEvent(msg: SSEMessage, state: S): StreamEvent[];
  /**
   * Optional: yield any final events after the upstream stream closes
   * (e.g. emit a synthetic `message_stop` when the wire format ends with
   * `[DONE]` instead of an explicit terminator).
   */
  finalizeStream?(state: S): StreamEvent[];
  /** Optional override; defaults to the shared HTTP error parser. */
  normalizeError?(status: number, body: string): ProviderError;
}

/**
 * Concrete Provider built from a declarative config. Extends WireAdapter to
 * inherit the canonical HTTP + abort + error machinery.
 */
export class WireFormatProvider<S = Record<string, unknown>> extends WireAdapter {
  override readonly id: string;
  override readonly capabilities: Capabilities;
  private readonly cfg: WireFormatConfig<S>;

  constructor(
    cfg: WireFormatConfig<S>,
    opts: {
      apiKey: string;
      baseUrl?: string | undefined;
      fetchImpl?: typeof fetch | undefined;
      streamOpts?: WireAdapterStreamOptions | undefined;
    },
  ) {
    super(opts.apiKey, opts.baseUrl ?? cfg.defaultBaseUrl, opts.fetchImpl, opts.streamOpts);
    this.id = cfg.id;
    this.capabilities = cfg.capabilities;
    this.cfg = cfg;
  }

  protected override buildUrl(req: Request): string {
    return this.cfg.buildUrl(this.baseUrl, req);
  }

  protected override buildHeaders(req: Request): Record<string, string> {
    return {
      ...super.buildHeaders(req),
      ...this.cfg.buildHeaders(this.apiKey, req),
    };
  }

  protected override buildBody(
    req: Request,
    ctx: { capabilities: Capabilities },
  ): Record<string, unknown> {
    // Forward the resolved capabilities so the preset can fall back from
    // req.maxTokens to the catalog-populated ceiling.
    return this.cfg.buildBody(req, ctx);
  }

  protected override parseStream(
    body: Parameters<typeof parseSSE>[0],
    fallbackModel: string,
  ): AsyncIterable<StreamEvent> {
    return this.runStream(body, fallbackModel);
  }

  protected override translateError(status: number, body: string): ProviderError {
    return this.cfg.normalizeError
      ? this.cfg.normalizeError(status, body)
      : parseProviderHttpError(this.id, status, body);
  }

  private async *runStream(
    body: Parameters<typeof parseSSE>[0],
    fallbackModel: string,
  ): AsyncIterable<StreamEvent> {
    const state = this.cfg.createStreamState(fallbackModel);
    for await (const msg of parseSSE(body)) {
      for (const ev of this.cfg.parseStreamEvent(msg, state)) {
        yield ev;
      }
    }
    if (this.cfg.finalizeStream) {
      for (const ev of this.cfg.finalizeStream(state)) {
        yield ev;
      }
    }
  }
}

/**
 * Identity helper that gives authors type checking on the config literal.
 * Use at module level:
 *
 *   export const myProvider = defineWireFormat({
 *     id: 'mistral',
 *     family: 'openai-compatible',
 *     capabilities: { ... },
 *     ...
 *   });
 */
export function defineWireFormat<S = Record<string, unknown>>(
  cfg: WireFormatConfig<S>,
): WireFormatConfig<S> {
  return cfg;
}

export interface WireFactoryOptions {
  /**
   * Optional config-time override of the API key. When omitted, the factory
   * reads `cfg.apiKey` (passed in at create time by the registry / config
   * loader). Setting this here is useful in tests.
   */
  apiKey?: string | undefined;
  /** Override the base URL at factory build time. */
  baseUrl?: string | undefined;
}

/**
 * Build a `ProviderFactory` from a declarative wire-format. Plug into
 * `ProviderRegistry.register(...)` or use in `buildProviderFactoriesFromRegistry`
 * for catalog-driven discovery.
 */
export function createWireFormatFactory<S>(
  cfg: WireFormatConfig<S>,
  opts: WireFactoryOptions = {},
): ProviderFactory {
  return {
    type: cfg.id,
    family: cfg.family,
    create: (rawCfg: unknown): Provider => {
      const c = rawCfg as { apiKey?: string | undefined; baseUrl?: string | undefined };
      const apiKey = opts.apiKey ?? c.apiKey;
      if (!apiKey) {
        throw new Error(`Provider "${cfg.id}" requires an apiKey.`);
      }
      return new WireFormatProvider(cfg, {
        apiKey,
        baseUrl: opts.baseUrl ?? c.baseUrl,
      });
    },
  };
}
