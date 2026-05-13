import type {
  Capabilities,
  Provider,
  Request,
  Response,
  StreamEvent,
} from '@wrongstack/core';
import { ProviderError } from '@wrongstack/core';
import { parseProviderHttpError } from './error-parse.js';

type Response2 = {
  ok: boolean;
  status: number;
  text(): Promise<string>;
  body: ReadableStream<Uint8Array> | NodeJS.ReadableStream | null;
};

async function safeText(res: Response2): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '';
  }
}

/**
 * Shared HTTP mechanics for streaming providers.
 * Providers extend this to get:
 *   - canonical error handling (ProviderError with retryable flag)
 *   - SSE body parsing via parseSSE()
 *   - abort signal wiring
 *
 * Subclasses implement the abstract members to provide their specific wire format.
 */
export abstract class WireAdapter implements Provider {
  abstract readonly id: string;
  abstract readonly capabilities: Capabilities;

  constructor(
    protected readonly apiKey: string,
    protected readonly baseUrl: string,
    public readonly fetchImpl: typeof fetch = fetch,
  ) {
    if (!apiKey) throw new Error(`${this.constructor.name}: apiKey required`);
  }

  async complete(req: Request, opts: { signal: AbortSignal }): Promise<Response> {
    const { aggregateStream } = await import('./aggregate.js');
    return aggregateStream(this.stream(req, opts));
  }

  async *stream(req: Request, opts: { signal: AbortSignal }): AsyncIterable<StreamEvent> {
    const url = this.buildUrl(req);
    const headers = this.buildHeaders(req);
    const body = this.buildBody(req);

    let httpRes: Response2;
    try {
      httpRes = (await this.fetchImpl(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: opts.signal,
      })) as unknown as Response2;
    } catch (err) {
      if (opts.signal.aborted) throw err;
      throw new ProviderError(
        err instanceof Error ? err.message : String(err),
        0,
        true,
        this.id,
        { cause: err, body: { message: err instanceof Error ? err.message : String(err) } },
      );
    }

    if (!httpRes.ok) {
      const text = await safeText(httpRes);
      throw this.translateError(httpRes.status, text);
    }

    yield* this.parseStream(httpRes.body, req.model);
  }

  // ─── Abstract / overridable ───────────────────────────────────────────────

  /** HTTP endpoint for this provider's chat completions / messages API. */
  protected abstract buildUrl(req: Request): string;

  /** Per-request headers. `apiKey` is already in scope — call `super.buildHeaders` first. */
  protected buildHeaders(_req: Request): Record<string, string> {
    return {
      'content-type': 'application/json',
      accept: 'text/event-stream',
    };
  }

  /** Map Request fields to the wire request body. */
  protected abstract buildBody(req: Request): Record<string, unknown>;

  /** Translate wire SSE events into canonical StreamEvent[]. */
  protected abstract parseStream(
    body: ReadableStream<Uint8Array> | NodeJS.ReadableStream | null,
    fallbackModel: string,
  ): AsyncIterable<StreamEvent>;

  /** Build a ProviderError from an HTTP failure response. */
  protected translateError(status: number, body: string): ProviderError {
    return parseProviderHttpError(this.id, status, body);
  }
}