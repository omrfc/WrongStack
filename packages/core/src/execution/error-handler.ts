import type { Context } from '../core/context.js';
import type { ErrorHandler, RecoveryDecision } from '../types/error-handler.js';
import { ProviderError } from '../types/provider.js';
import { NETWORK_ERR_RE } from './regex-patterns.js';
import type { Compactor } from '../types/compactor.js';
import type { ModelsRegistry } from '../types/models-registry.js';
import type { Config } from '../types/config.js';

/**
 * Tiered error recovery strategies.
 * Each strategy is attempted in order until one returns a decision.
 */
export interface RecoveryStrategy {
  /** Human-readable label for logs. */
  label: string;
  /** Optional compactor for context_overflow recovery. */
  compactor?: Compactor | undefined;
  /** Returns an explicit recovery decision, or null to fall through. */
  attempt: (err: unknown, ctx: Context) => Promise<RecoveryDecision | null>;
}

// Package-level compiled regex for hot paths — avoids repeated compilation.
const CONTEXT_OVERFLOW_RE = /context|too long|tokens|exceeds the context window|context window/i;

/**
 * Builds the ordered list of recovery strategies used by DefaultErrorHandler.
 * Exported so callers can customise or extend the strategy chain.
 */
export function buildRecoveryStrategies(opts?: {
  compactor?: Compactor | undefined;
  modelsRegistry?: ModelsRegistry | undefined;
  getConfig?: (() => Config) | undefined;
}): RecoveryStrategy[] {
  return [
    {
      label: 'context_overflow_reduce',
      compactor: opts?.compactor,
      async attempt(err, ctx) {
        if (!(err instanceof ProviderError)) return null;
        if (err.status !== 413 && !isContextOverflowError(err)) return null;

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
        // 429 is intentionally NOT handled here: the rate_limit_backoff
        // strategy above always returns a decision for 429, so this strategy
        // is never reached for it. Downgrade applies to overload (529) and
        // generic 5xx server errors only.
        if (err.status !== 529 && err.status < 500) return null;

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
          const visibleModels = opts?.getConfig?.().providers?.[providerId]?.models;
          const candidates = provider.models.filter((m) => {
            if (visibleModels !== undefined && !visibleModels.includes(m.id)) return false;
            const modelCost = m.cost?.input ?? Number.POSITIVE_INFINITY;
            const currentCost = currentModel.cost?.input ?? Number.POSITIVE_INFINITY;
            if (modelCost >= currentCost) return false;
            if (currentModel.capabilities.tools && !m.tool_call) return false;
            if (currentModel.capabilities.vision && !m.modalities?.input?.includes('image'))
              return false;
            return true;
          });

          if (candidates.length === 0) return null;

          // Pick the cheapest candidate. Treat a missing input cost as
          // +Infinity (most expensive) — matching the filter above, which
          // already excludes undefined-cost models — so the sentinel stays
          // consistent if the filter is ever loosened.
          const fallback = candidates.reduce((prev, curr) =>
            (curr.cost?.input ?? Number.POSITIVE_INFINITY) <
            (prev.cost?.input ?? Number.POSITIVE_INFINITY)
              ? curr
              : prev,
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

function isContextOverflowError(err: ProviderError): boolean {
  return CONTEXT_OVERFLOW_RE.test([
    err.message,
    err.body?.message,
    err.body?.type,
    err.body?.raw,
  ].filter(Boolean).join('\n'));
}

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
      if (err.status === 413 || isContextOverflowError(err)) {
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
