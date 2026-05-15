import type { Context } from '../core/context.js';
import type { Response } from './provider.js';

export type RecoveryDecision =
  | {
      /**
       * Recovery mutated state or waited for capacity and the agent should
       * rebuild the provider request and try the turn again.
       */
      action: 'retry';
      reason: string;
      model?: string;
    }
  | {
      /**
       * Recovery produced a substitute provider response that should be
       * processed exactly like a normal model response.
       */
      action: 'continue';
      response: Response;
      reason?: string;
    }
  | {
      /** Recovery inspected the error and decided the agent must fail. */
      action: 'fail';
      reason: string;
      error?: unknown;
    };

export interface ErrorHandler {
  /**
   * Attempt to recover from an unretried provider/tool boundary error.
   *
   * `null` means "no strategy matched". Non-null decisions are explicit:
   * retry the current turn, continue with a substitute response, or fail
   * deliberately. Callers should not infer control flow from truthiness.
   */
  recover(err: unknown, ctx: Context): Promise<RecoveryDecision | null>;
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
  };
}
