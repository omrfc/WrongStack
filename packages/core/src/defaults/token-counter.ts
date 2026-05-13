import type { CacheStats, TokenCounter } from '../types/token-counter.js';
import type { Usage } from '../types/provider.js';
import type { ModelsRegistry, ResolvedModel } from '../types/models-registry.js';
import type { EventBus } from '../kernel/events.js';

interface PriceEntry {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
}

/**
 * Token counter that derives pricing from the ModelsRegistry instead of a
 * hardcoded table. If a model is unknown to the registry (or the registry is
 * unavailable) the counter still tracks token totals but reports zero cost.
 */
export class DefaultTokenCounter implements TokenCounter {
  private input = 0;
  private output = 0;
  private cacheRead = 0;
  private cacheWrite = 0;
  private costInput = 0;
  private costOutput = 0;
  private readonly registry?: ModelsRegistry;
  private readonly providerId?: string;
  private readonly events?: EventBus;
  private priceCache = new Map<string, PriceEntry>();

  constructor(opts: { registry?: ModelsRegistry; providerId?: string; events?: EventBus } = {}) {
    this.registry = opts.registry;
    this.providerId = opts.providerId;
    this.events = opts.events;
  }

  account(usage: Usage, model?: string): void {
    this.input += usage.input;
    this.output += usage.output;
    this.cacheRead += usage.cacheRead ?? 0;
    this.cacheWrite += usage.cacheWrite ?? 0;

    const price = model ? this.priceCache.get(model) : undefined;
    if (price) {
      this.applyPrice(usage, price);
    } else if (this.registry && this.providerId && model) {
      // Async lookup — populate cache, but don't block this call.
      void this.registry
        .getModel(this.providerId, model)
        .then((m) => {
          if (m) {
            const p = priceFromModel(m);
            this.priceCache.set(model, p);
            this.applyPrice(usage, p);
          }
        })
        .catch(() => {
          // Emit so observability tooling can detect unknown models.
          this.events?.emit('token.cost_estimate_unavailable', { model: model ?? '<unknown>' });
          return undefined;
        });
    }
  }

  /** Synchronous variant for code paths that have already resolved the model. */
  accountWithModel(usage: Usage, resolved: ResolvedModel): void {
    this.input += usage.input;
    this.output += usage.output;
    this.cacheRead += usage.cacheRead ?? 0;
    this.cacheWrite += usage.cacheWrite ?? 0;
    const price = priceFromModel(resolved);
    this.priceCache.set(resolved.modelId, price);
    this.applyPrice(usage, price);
  }

  total(): Usage {
    return {
      input: this.input,
      output: this.output,
      cacheRead: this.cacheRead,
      cacheWrite: this.cacheWrite,
    };
  }

  estimateCost(): { input: number; output: number; total: number; currency: 'USD' } {
    return {
      input: round4(this.costInput),
      output: round4(this.costOutput),
      total: round4(this.costInput + this.costOutput),
      currency: 'USD',
    };
  }

  cacheStats(): CacheStats {
    // Hit ratio: cacheRead / (cacheRead + input). `input` from the provider
    // is the count of fresh-token reads, so this answers "what fraction of
    // the prompt did we get for the cache price?"
    const denom = this.cacheRead + this.input;
    return {
      readTokens: this.cacheRead,
      writeTokens: this.cacheWrite,
      hitRatio: denom === 0 ? 0 : this.cacheRead / denom,
    };
  }

  /** Invalidate cached prices so the next account() call fetches fresh data. */
  invalidateCache(): void {
    this.priceCache.clear();
  }

  reset(): void {
    this.input = 0;
    this.output = 0;
    this.cacheRead = 0;
    this.cacheWrite = 0;
    this.costInput = 0;
    this.costOutput = 0;
  }

  private applyPrice(usage: Usage, price: PriceEntry): void {
    if (price.input) this.costInput += (usage.input / 1_000_000) * price.input;
    if (price.output) this.costOutput += (usage.output / 1_000_000) * price.output;
    if (usage.cacheRead && price.cacheRead) {
      this.costInput += (usage.cacheRead / 1_000_000) * price.cacheRead;
    }
    if (usage.cacheWrite && price.cacheWrite) {
      this.costInput += (usage.cacheWrite / 1_000_000) * price.cacheWrite;
    }
  }
}

function priceFromModel(m: ResolvedModel): PriceEntry {
  return {
    input: m.cost?.input,
    output: m.cost?.output,
    cacheRead: m.cost?.cache_read,
    cacheWrite: m.cost?.cache_write,
  };
}

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}
