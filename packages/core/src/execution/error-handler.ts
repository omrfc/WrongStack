import type { Context } from '../core/context.js';
import type { ErrorHandler, RecoveryDecision } from '../types/error-handler.js';
import { ProviderError } from '../types/provider.js';
import { NETWORK_ERR_RE } from './regex-patterns.js';
import type { Compactor } from '../types/compactor.js';
import type { ModelsRegistry } from '../types/models-registry.js';

/**
 * Tiered error recovery strategies.
 * Each strategy is attempted in order until one returns a decision.
 */
export interface RecoveryStrategy {
  /** Human-readable label for logs. */
  label: string;
  /** Optional compactor for context_overflow recovery. */
  compactor?: Compactor;
  /** Returns an explicit recovery decision, or null to fall through. */
  attempt: (err: unknown, ctx: Context) => Promise<RecoveryDecision | null>;
}

// Package-level compiled regex for hot paths — avoids repeated compilation.
const CONTEXT_OVERFLOW_RE = /context|too long|tokens/i;

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
        if (!(err instanceof ProviderError)) return null;
        if (err.status !== 413 && !CONTEXT_OVERFLOW_RE.test(err.message)) return null;

        if (this.compactor) {
          try {
            const report = await this.compactor.compact(ctx, { aggressive: true });
            if (report.after < report.before) {
              return { action: 'retry', reason: 'context_compacted' };
            }
          } catch {
            // compact failed; fall through
          }
        }
        return null;
      },
    },
    {
      label: 'rate_limit_backoff',
      async attempt(err) {
        if (!(err instanceof ProviderError) || err.status !== 429) return null;

        // Prefer the parsed Retry-After hint the provider extracted into
        // body.retryAfterMs; fall back to 5s when absent.
        const delayMs = err.body?.retryAfterMs ?? 5_000;
        // Clamp between 1s and 60s.
        const delay = Math.min(60_000, Math.max(1_000, delayMs));
        await new Promise((r) => setTimeout(r, delay));
        return { action: 'retry', reason: 'rate_limit_backoff' };
      },
    },
    {
      label: 'downgrade_model',
      async attempt(err, ctx) {
        if (!(err instanceof ProviderError)) return null;
        if (err.status !== 429 && err.status !== 529 && err.status < 500) return null;

        const registry = opts?.modelsRegistry;
        if (!registry) return null;

        try {
          const providerId = ctx.provider?.id;
          if (!providerId) return null;
          const provider = await registry.getProvider(providerId);
          if (!provider) return null;

          const currentModel = await registry.getModel(providerId, ctx.model);
          if (!currentModel) return null;

          // Find a cheaper fallback model with the same capabilities.
          // Prefer models with lower input cost, preferring the same family.
          const candidates = provider.models.filter((m) => {
            const modelCost = m.cost?.input ?? Number.POSITIVE_INFINITY;
            const currentCost = currentModel.cost?.input ?? Number.POSITIVE_INFINITY;
            if (modelCost >= currentCost) return false;
            if (currentModel.capabilities.tools && !m.tool_call) return false;
            if (currentModel.capabilities.vision && !m.modalities?.input?.includes('image'))
              return false;
            return true;
          });

          if (candidates.length === 0) return null;

          const fallback = candidates.reduce((prev, curr) =>
            (curr.cost?.input ?? 0) < (prev.cost?.input ?? 0) ? curr : prev,
          );

          return {
            action: 'retry',
            reason: 'model_downgrade',
            model: fallback.id,
          };
        } catch {
          return null;
        }
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
    // AbortError can be thrown in both browser (DOMException) and Node (Error).
    // Guard with typeof check so Node builds don't reference the browser-only DOMException.
    if (
      typeof DOMException !== 'undefined' &&
      err instanceof DOMException &&
      err.name === 'AbortError'
    ) {
      return { kind: 'abort', retryable: false };
    }
    if (err instanceof Error && err.name === 'AbortError') {
      return { kind: 'abort', retryable: false };
    }
    if (err instanceof ProviderError) {
      if (err.status === 429) return { kind: 'rate_limit', retryable: true };
      if (err.status === 529) return { kind: 'overloaded', retryable: true };
      if (err.status >= 500) return { kind: 'server', retryable: true };
      if (err.status === 413 || CONTEXT_OVERFLOW_RE.test(err.message)) {
        return { kind: 'context_overflow', retryable: false };
      }
      if (err.status >= 400) return { kind: 'client', retryable: false };
    }
    if (err instanceof Error && NETWORK_ERR_RE.test(err.message)) {
      return { kind: 'network', retryable: true };
    }
    return { kind: 'unknown', retryable: false };
  }

  async recover(err: unknown, ctx: Context): Promise<RecoveryDecision | null> {
    for (const strategy of this.strategies) {
      const result = await strategy.attempt(err, ctx);
      if (result !== null) return result;
    }
    return null;
  }
}
