import type { Context } from '../core/context.js';
import type { EventBus } from '../kernel/events.js';
import type { MiddlewareHandler } from '../kernel/pipeline.js';
import type { Compactor } from '../types/compactor.js';
import type { ContextWindowAggressiveOn, ContextWindowPolicy } from '../types/context-window.js';
import { AgentError } from '../types/errors.js';

export type CompactionFailureMode = 'throw' | 'throw_on_hard' | 'continue';

export interface AutoCompactionOptions {
  aggressiveOn?: ContextWindowAggressiveOn;
  events?: EventBus;
  failureMode?: CompactionFailureMode;
  policyProvider?: (ctx: Context) => Pick<
    ContextWindowPolicy,
    'thresholds' | 'aggressiveOn'
  > | null | undefined;
}

/**
 * Pipeline middleware that monitors context token load and automatically
 * triggers compaction when the warn/soft/hard thresholds are crossed.
 * Runs before the next agent iteration.
 */
export class AutoCompactionMiddleware {
  readonly name = 'AutoCompaction';

  private readonly compactor: Compactor;
  private readonly estimator: (ctx: Context) => number;
  private readonly warnThreshold: number;
  private readonly softThreshold: number;
  private readonly hardThreshold: number;
  /** Writable so model-switch can update the denominator without re-registering the middleware. */
  private _maxContext: number;
  private readonly aggressiveOn: ContextWindowAggressiveOn;
  private readonly events?: EventBus;
  private readonly failureMode: CompactionFailureMode;
  private readonly policyProvider?: AutoCompactionOptions['policyProvider'];

  /**
   * @param compactor        Compactor to use for compaction.
   * @param maxContext       Provider's max context window in tokens.
   * @param estimator        Token estimation function.
   * @param thresholds       Threshold fractions (0-1) of maxContext.
   * @param opts             Optional behavior. By default, failures at the
   *                         hard threshold throw AGENT_CONTEXT_OVERFLOW so
   *                         the agent does not continue into a likely
   *                         provider context overflow. Warn/soft failures
   *                         still emit compaction.failed and continue.
   */
  constructor(
    compactor: Compactor,
    maxContext: number,
    estimator: (ctx: Context) => number,
    thresholds: { warn: number; soft: number; hard: number },
    optsOrAggressiveOn: AutoCompactionOptions | ContextWindowAggressiveOn = {},
    events?: EventBus,
  ) {
    const opts =
      typeof optsOrAggressiveOn === 'string'
        ? { aggressiveOn: optsOrAggressiveOn, events }
        : optsOrAggressiveOn;
    this.compactor = compactor;
    this._maxContext = maxContext;
    this.estimator = estimator;
    this.warnThreshold = thresholds.warn;
    this.softThreshold = thresholds.soft;
    this.hardThreshold = thresholds.hard;
    this.aggressiveOn = opts.aggressiveOn ?? 'soft';
    this.events = opts.events;
    this.failureMode = opts.failureMode ?? 'throw_on_hard';
    this.policyProvider = opts.policyProvider;
  }

  /** Allow callers (e.g. model-switch in WebUI) to update the context window
   *  denominator when the active model changes. */
  setMaxContext(maxContext: number): void {
    this._maxContext = maxContext;
  }

  handler(): MiddlewareHandler<Context> {
    return async (ctx, next) => {
      const tokens = this.estimator(ctx);
      const load = tokens / this._maxContext;
      const policy = this.policyProvider?.(ctx);
      const thresholds = policy?.thresholds ?? {
        warn: this.warnThreshold,
        soft: this.softThreshold,
        hard: this.hardThreshold,
      };
      const aggressiveOn = policy?.aggressiveOn ?? this.aggressiveOn;

      if (load >= thresholds.hard) {
        await this.compact(ctx, true, { level: 'hard', tokens, load });
      } else if (load >= thresholds.soft) {
        await this.compact(ctx, aggressiveOn !== 'hard', { level: 'soft', tokens, load });
      } else if (load >= thresholds.warn) {
        await this.compact(ctx, aggressiveOn === 'warn', { level: 'warn', tokens, load });
      }

      return next(ctx);
    };
  }

  private async compact(
    ctx: Context,
    aggressive: boolean,
    pressure: { level: 'warn' | 'soft' | 'hard'; tokens: number; load: number },
  ): Promise<void> {
    try {
      await this.compactor.compact(ctx, { aggressive });
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      const fatal =
        this.failureMode === 'throw' ||
        (this.failureMode === 'throw_on_hard' && pressure.level === 'hard');
      this.events?.emit('compaction.failed', {
        err: error,
        aggressive,
        level: pressure.level,
        tokens: pressure.tokens,
        maxContext: this._maxContext,
        load: pressure.load,
        fatal,
      });
      if (fatal) {
        throw new AgentError({
          message: `Auto-compaction failed at ${pressure.level} threshold`,
          code: 'AGENT_CONTEXT_OVERFLOW',
          recoverable: true,
          context: {
            level: pressure.level,
            tokens: pressure.tokens,
            maxContext: this._maxContext,
          },
          cause: err,
        });
      }
    }
  }
}
