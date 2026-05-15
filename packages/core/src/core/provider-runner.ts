import type { EventBus } from '../kernel/events.js';
import type { Logger } from '../types/logger.js';
import type { Tracer } from '../types/observability.js';
import type { Provider, Request, Response } from '../types/provider.js';
import { ProviderError } from '../types/provider.js';
import type { RetryPolicy } from '../types/retry-policy.js';
import type { Context } from './context.js';
import { streamProviderToResponse } from './streaming-response-builder.js';

export interface RunProviderOptions {
  provider: Provider;
  request: Request;
  signal: AbortSignal;
  ctx: Context;
  events: EventBus;
  retry: RetryPolicy;
  logger: Logger;
  tracer?: Tracer;
}

/**
 * Call a provider with the retry policy applied. Emits `provider.retry`
 * before each retry and `provider.error` once when the retries are
 * exhausted. Streaming providers route through the streaming-response
 * builder so deltas reach the renderer.
 */
export async function runProviderWithRetry(opts: RunProviderOptions): Promise<Response> {
  const { provider, request, signal, ctx, events, retry, logger, tracer } = opts;
  let attempt = 0;
  for (;;) {
    const span = tracer?.startSpan('provider.complete', {
      'provider.id': provider.id,
      'provider.model': request.model,
      'provider.streaming': provider.capabilities.streaming,
      'provider.attempt': attempt,
    });
    try {
      const res = provider.capabilities.streaming
        ? await streamProviderToResponse(provider, request, signal, ctx, events)
        : await provider.complete(request, { signal });
      span?.setAttribute('provider.stopReason', res.stopReason);
      span?.setAttribute('provider.usage_in', res.usage.input);
      span?.setAttribute('provider.usage_out', res.usage.output);
      span?.end();
      return res;
    } catch (err) {
      if (err instanceof Error) span?.recordError(err);
      span?.end();
      if (signal.aborted) throw err;
      const isProviderErr = err instanceof ProviderError;
      const errAsErr = err instanceof Error ? err : new Error(String(err));
      const canRetry = retry.shouldRetry(isProviderErr ? err : errAsErr, attempt);
      const description = isProviderErr ? (err as ProviderError).describe() : errAsErr.message;
      if (!canRetry) {
        if (isProviderErr) {
          events.emit('provider.error', {
            providerId: (err as ProviderError).providerId,
            status: (err as ProviderError).status,
            description,
            retryable: false,
          });
        }
        throw err;
      }
      const delay = Math.round(retry.delayMs(attempt));
      const attemptNum = attempt + 1;
      logger.warn(`Provider retry ${attemptNum} in ${delay}ms — ${description}`);
      if (isProviderErr) {
        events.emit('provider.retry', {
          providerId: (err as ProviderError).providerId,
          attempt: attemptNum,
          delayMs: delay,
          status: (err as ProviderError).status,
          description,
        });
      }
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const onAbort = () => {
          if (settled) return;
          settled = true;
          clearTimeout(t);
          reject(new Error('aborted'));
        };
        const t = setTimeout(() => {
          if (settled) return;
          settled = true;
          clearTimeout(t);
          signal.removeEventListener('abort', onAbort);
          resolve();
        }, delay);
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener('abort', onAbort, { once: true });
      });
      attempt++;
    }
  }
}
