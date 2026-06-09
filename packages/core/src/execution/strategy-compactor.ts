import type { Context } from '../core/context.js';
import type { CompactReport, Compactor } from '../types/compactor.js';
import type { ContextWindowPolicy } from '../types/context-window.js';
import { HybridCompactor } from './compactor.js';
import { IntelligentCompactor } from './intelligent-compactor.js';
import { SelectiveCompactor } from './selective-compactor.js';

export type CompactorStrategy = 'hybrid' | 'intelligent' | 'selective';

export interface StrategyCompactorOptions {
  /** Which compactor to use. Defaults to 'hybrid' (lossless, no LLM). */
  strategy?: CompactorStrategy | string | undefined;
  /** Recent user/assistant pairs to always preserve. */
  preserveK?: number | undefined;
  /** Token threshold below which tool results are not elided. */
  eliseThreshold?: number | undefined;
  /**
   * Enable content-aware smart digest for 'hybrid' strategy. When true,
   * collapsed ancient turns use buildSmartDigest: critical content (errors,
   * corrections, decisions) stays verbatim; normal exchanges get first-sentence
   * summaries; noise (repeated failures, large tool outputs) is aggressively
   * compressed. Defaults to false (lossless digest).
   */
  smart?: boolean | undefined;
  /** Model used by the LLM-backed strategies for summarization/selection. */
  summarizerModel?: string | undefined;
  /**
   * Legacy shortcut for `strategy: 'selective'`. When `strategy` is unset (or
   * 'hybrid') and this is true, the selective (LLM-driven) compactor is used.
   * An explicit `strategy` always wins.
   */
  llmSelector?: boolean | undefined;
}

/**
 * Build the compactor named by `config.context.strategy`.
 *
 * - `hybrid` (default): lossless rule-based — no provider needed.
 * - `intelligent` / `selective`: LLM-backed. These need a `provider`, which is
 *   only known per-run, so we return a thin wrapper that resolves the concrete
 *   compactor from `ctx` at `compact()`-time. This deliberately avoids the
 *   container/provider construction-ordering problem: `TOKENS.Compactor` is
 *   resolved (and memoized) before `context.provider` exists, but `ctx.provider`
 *   is always present once a run is actually compacting. If no provider is
 *   available at compact-time the wrapper degrades to the lossless hybrid rules
 *   rather than failing.
 */
export function createStrategyCompactor(opts: StrategyCompactorOptions = {}): Compactor {
  const requested = opts.strategy ?? (opts.llmSelector ? 'selective' : 'hybrid');
  const strategy = requested as CompactorStrategy;
  if (strategy === 'intelligent' || strategy === 'selective') {
    return new ProviderBackedCompactor(strategy, opts);
  }
  return new HybridCompactor({
    preserveK: opts.preserveK,
    eliseThreshold: opts.eliseThreshold,
    smart: opts.smart,
  });
}

class ProviderBackedCompactor implements Compactor {
  constructor(
    private readonly strategy: 'intelligent' | 'selective',
    private readonly opts: StrategyCompactorOptions,
  ) {}

  async compact(
    ctx: Context,
    compactOpts: { aggressive?: boolean | undefined } = {},
  ): Promise<CompactReport> {
    return this.resolveInner(ctx).compact(ctx, compactOpts);
  }

  /**
   * Construct the concrete compactor for this run. Rebuilt per call (cheap, no
   * I/O) so a model switch — which changes `ctx.provider.capabilities.maxContext`
   * — is always reflected. Reads the active ContextWindowPolicy from `ctx.meta`
   * so the LLM compactors honor the same thresholds/preserveK as the policy.
   */
  private resolveInner(ctx: Context): Compactor {
    const provider = ctx.provider;
    if (!provider) {
      // No provider on ctx → cannot run an LLM compactor. Degrade to lossless rules.
      return new HybridCompactor({
        preserveK: this.opts.preserveK,
        eliseThreshold: this.opts.eliseThreshold,
      });
    }

    const policy = readPolicy(ctx);
    const maxContext = provider.capabilities?.maxContext || undefined;
    const thresholds = policy?.thresholds;
    const common = {
      provider,
      maxContext,
      preserveK: this.opts.preserveK ?? policy?.preserveK,
      eliseThreshold: this.opts.eliseThreshold ?? policy?.eliseThreshold,
      ...(thresholds
        ? { warnThreshold: thresholds.warn, softThreshold: thresholds.soft, hardThreshold: thresholds.hard }
        : {}),
    };

    if (this.strategy === 'selective') {
      return new SelectiveCompactor({
        ...common,
        selectorModel: this.opts.summarizerModel,
        summarizerModel: this.opts.summarizerModel,
      });
    }
    return new IntelligentCompactor({
      ...common,
      summarizerModel: this.opts.summarizerModel,
    });
  }
}

function readPolicy(ctx: Context): ContextWindowPolicy | null {
  const policy = ctx.meta?.['contextWindowPolicy'];
  if (!policy || typeof policy !== 'object') return null;
  const candidate = policy as Partial<ContextWindowPolicy>;
  if (typeof candidate.preserveK !== 'number' || !candidate.thresholds) return null;
  return candidate as ContextWindowPolicy;
}
