import type { MiddlewareHandler } from '../kernel/pipeline.js';
import type { Context } from '../core/context.js';
import type { Compactor } from '../types/compactor.js';

/**
 * Pipeline middleware that monitors context token load and
 * automatically triggers compaction when the warn/soft/hard
 * thresholds are crossed. Runs before the next agent iteration.
 */
export class AutoCompactionMiddleware {
  readonly name = 'AutoCompaction';

  private readonly compactor: Compactor;
  private readonly warnThreshold: number;   // fraction of maxContext (0-1)
  private readonly softThreshold: number;
  private readonly hardThreshold: number;
  private readonly maxContext: number;
  private readonly estimator: (ctx: Context) => number;
  private readonly aggressiveOn: 'hard' | 'soft' | 'warn';

  /**
   * @param compactor        Compactor to use for compaction
   * @param maxContext       Provider's max context window in tokens
   * @param estimator        Token estimation function (ctx → token count)
   * @param thresholds      Threshold fractions (0-1) of maxContext
   * @param aggressiveOn    Which threshold triggers aggressive (full LLM summarization)
   */
  constructor(
    compactor: Compactor,
    maxContext: number,
    estimator: (ctx: Context) => number,
    thresholds: { warn: number; soft: number; hard: number },
    aggressiveOn: 'hard' | 'soft' | 'warn' = 'soft',
  ) {
    this.compactor = compactor;
    this.maxContext = maxContext;
    this.estimator = estimator;
    this.warnThreshold = thresholds.warn;
    this.softThreshold = thresholds.soft;
    this.hardThreshold = thresholds.hard;
    this.aggressiveOn = aggressiveOn;
  }

  handler(): MiddlewareHandler<Context> {
    return async (ctx, next) => {
      const tokens = this.estimator(ctx);
      const load = tokens / this.maxContext;

      if (load >= this.hardThreshold) {
        await this.compact(ctx, true);
      } else if (load >= this.softThreshold) {
        await this.compact(ctx, this.aggressiveOn !== 'hard');
      } else if (load >= this.warnThreshold) {
        await this.compact(ctx, false);
      }

      return next(ctx);
    };
  }

  private async compact(ctx: Context, aggressive: boolean): Promise<void> {
    try {
      await this.compactor.compact(ctx, { aggressive });
    } catch {
      // compaction is best-effort; never crash the agent loop
    }
  }
}