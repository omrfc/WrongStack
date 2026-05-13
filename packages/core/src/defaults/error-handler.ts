import { ProviderError } from '../types/provider.js';
import type { ErrorHandler } from '../types/error-handler.js';
import type { Response } from '../types/provider.js';
import type { Context } from '../core/context.js';

import type { Compactor } from '../types/compactor.js';
import type { ModelsRegistry } from '../types/models-registry.js';

/**
 * Tiered error recovery strategies.
 * Each strategy is attempted in order until one succeeds.
 */
export interface RecoveryStrategy {
  /** Human-readable label for logs. */
  label: string;
  /** Optional compactor for context_overflow recovery. */
  compactor?: Compactor;
  /** Returns a substitute Response, or null to fall through to the next strategy. */
  attempt: (err: unknown, ctx: Context) => Promise<Response | null>;
}

/**
 * Builds the ordered list of recovery strategies used by DefaultErrorHandler.
 * Exported so callers can customise or extend the strategy chain.
 */
export function buildRecoveryStrategies(opts?: {
  compactor?: Compactor;
  modelsRegistry?: ModelsRegistry;
}): RecoveryStrategy[] {
  return [
    {
      label: 'context_overflow_reduce',
      compactor: opts?.compactor,
      async attempt(err, ctx) {
        if (err instanceof ProviderError && (err.status === 413 || /context|too long|tokens/i.test(err.message))) {
          if (this.compactor) {
            try {
              const report = await this.compactor.compact(ctx, { aggressive: true });
              if (report.after < report.before) {
                return {
                  content: [{ type: 'text', text: '[context compacted automatically — please retry]' }],
                  stopReason: 'end_turn',
                  usage: { input: 0, output: 0 },
                  model: ctx.model,
                };
              }
            } catch {
              // compact failed — fall through
            }
          }
          return null;
        }
        return null;
      },
    },
    {
      label: 'rate_limit_backoff',
      async attempt(err, ctx) {
        if (err instanceof ProviderError && err.status === 429) {
          // Prefer the parsed Retry-After hint the provider extracted into
          // body.retryAfterMs; fall back to 5s when absent.
          const delayMs = err.body?.retryAfterMs ?? 5_000;
          // Clamp between 1s and 60s.
          const delay = Math.max(1_000, Math.min(delayMs, 60_000));
          await new Promise((r) => setTimeout(r, delay));
          return {
            content: [{ type: 'text', text: '[rate limit backoff applied — please retry]' }],
            stopReason: 'end_turn',
            usage: { input: 0, output: 0 },
            model: ctx.model,
          };
        }
        return null;
      },
    },
    {
      label: 'downgrade_model',
      async attempt(err, ctx) {
        if (err instanceof ProviderError && (err.status === 429 || err.status === 529 || err.status >= 500)) {
          const registry = opts?.modelsRegistry;
          if (!registry) return null;

          try {
            const provider = await registry.getProvider(ctx.provider.id);
            if (!provider) return null;

            const currentModel = await registry.getModel(ctx.provider.id, ctx.model);
            if (!currentModel) return null;

            // Find a cheaper fallback model with the same capabilities.
            // Prefer models with lower input cost, preferring the same family.
            const candidates = provider.models.filter((m) => {
              const modelCost = m.cost?.input ?? Infinity;
              const currentCost = currentModel.cost?.input ?? Infinity;
              // Must be cheaper.
              if (modelCost >= currentCost) return false;
              // Must support tools if the original did.
              if (currentModel.capabilities.tools && !m.tool_call) return false;
              // Must support vision if the original did.
              if (currentModel.capabilities.vision && !m.modalities?.input?.includes('image')) return false;
              return true;
            });

            if (candidates.length === 0) return null;

            // Pick the cheapest one.
            const fallback = candidates.reduce((prev, curr) =>
              (curr.cost?.input ?? 0) < (prev.cost?.input ?? 0) ? curr : prev,
            );

            return {
              content: [
                {
                  type: 'text',
                  text: `[model downgrade: ${ctx.model} → ${fallback.id} — please retry]`,
                },
              ],
              stopReason: 'end_turn',
              usage: { input: 0, output: 0 },
              model: fallback.id,
            };
          } catch {
            return null;
          }
        }
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
