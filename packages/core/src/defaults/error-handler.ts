import { ProviderError } from '../types/provider.js';
import type { ErrorHandler } from '../types/error-handler.js';
import type { Response } from '../types/provider.js';
import type { Context } from '../core/context.js';

/**
 * Tiered error recovery strategies.
 * Each strategy is attempted in order until one succeeds.
 */
export interface RecoveryStrategy {
  /** Human-readable label for logs. */
  label: string;
  /** Returns a substitute Response, or null to fall through to the next strategy. */
  attempt: (err: unknown, ctx: Context) => Promise<Response | null>;
}

/**
 * Builds the ordered list of recovery strategies used by DefaultErrorHandler.
 * Exported so callers can customise or extend the strategy chain.
 */
export function buildRecoveryStrategies(): RecoveryStrategy[] {
  return [
    {
      label: 'context_overflow_reduce',
      async attempt(err, _ctx) {
        // Only ProviderError with 413 or context-too-long message qualifies.
        if (err instanceof ProviderError && (err.status === 413 || /context|too long|tokens/i.test(err.message))) {
          // Placeholder: signal the compactor to aggressively compact and retry.
          // The agent loop checks this flag on the next iteration.
          return null;
        }
        return null;
      },
    },
    {
      label: 'rate_limit_backoff',
      async attempt(err, _ctx) {
        if (err instanceof ProviderError && err.status === 429) {
          // Placeholder: implement rate-limit-specific backoff — e.g. wait for
          // Retry-After header value before returning a Response that allows
          // the run to continue. Without provider support for Retry-After this
          // returns null so the run fails cleanly.
          return null;
        }
        return null;
      },
    },
    {
      label: 'downgrade_model',
      async attempt(_err, _ctx) {
        // Placeholder: check if the current model has a cheaper fallback registered
        // in ModelsRegistry and substitute it. Requires ModelsRegistry access on ctx.
        return null;
      },
    },
  ];
}

export const DEFAULT_RECOVERY_STRATEGIES = buildRecoveryStrategies();

export class DefaultErrorHandler implements ErrorHandler {
  private readonly strategies: RecoveryStrategy[];

  constructor(strategies: RecoveryStrategy[] = DEFAULT_RECOVERY_STRATEGIES) {
    this.strategies = strategies;
  }

  classify(err: unknown): {
    kind:
      | 'rate_limit'
      | 'overloaded'
      | 'server'
      | 'client'
      | 'network'
      | 'abort'
      | 'context_overflow'
      | 'unknown';
    retryable: boolean;
  } {
    if (err instanceof DOMException && err.name === 'AbortError') {
      return { kind: 'abort', retryable: false };
    }
    if (err instanceof Error && err.name === 'AbortError') {
      return { kind: 'abort', retryable: false };
    }
    if (err instanceof ProviderError) {
      if (err.status === 429) return { kind: 'rate_limit', retryable: true };
      if (err.status === 529) return { kind: 'overloaded', retryable: true };
      if (err.status >= 500) return { kind: 'server', retryable: true };
      if (err.status === 413 || /context|too long|tokens/i.test(err.message)) {
        return { kind: 'context_overflow', retryable: false };
      }
      if (err.status >= 400) return { kind: 'client', retryable: false };
    }
    if (err instanceof Error && /ECONN|ETIMEDOUT|ETIME|ENOTFOUND|EAI_AGAIN|fetch failed/i.test(err.message)) {
      return { kind: 'network', retryable: true };
    }
    return { kind: 'unknown', retryable: false };
  }

  async recover(err: unknown, ctx: Context): Promise<Response | null> {
    for (const strategy of this.strategies) {
      const result = await strategy.attempt(err, ctx);
      if (result !== null) return result;
    }
    return null;
  }
}
