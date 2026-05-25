import type { Usage } from '../types/provider.js';
import type { EventBus } from '../kernel/events.js';

export type BudgetKind = 'tool_calls' | 'iterations' | 'tokens' | 'timeout' | 'cost';

export class BudgetExceededError extends Error {
  readonly kind: BudgetKind;
  readonly limit: number;
  readonly observed: number;

  constructor(kind: BudgetKind, limit: number, observed: number) {
    super(`Budget exceeded: ${kind} (limit=${limit}, observed=${observed})`);
    this.name = 'BudgetExceededError';
    this.kind = kind;
    this.limit = limit;
    this.observed = observed;
  }
}

export interface BudgetLimits {
  maxIterations?: number;
  maxToolCalls?: number;
  maxTokens?: number;
  /** Estimated USD cost ceiling. */
  maxCostUsd?: number;
  /** Wall-clock timeout from start() to checkTimeout(). */
  timeoutMs?: number;
}

export interface BudgetUsage {
  iterations: number;
  toolCalls: number;
  tokens: { input: number; output: number; total: number };
  costUsd: number;
  elapsedMs: number;
}

/**
 * Thrown by `SubagentBudget.record*` when a soft limit is hit and
 * an `onThreshold` handler is configured that wants to ask the
 * coordinator (via `budget.threshold_reached` event). The runner
 * catches this and awaits the embedded `decision` promise to get
 * the coordinator's extend/stop decision.
 *
 * Distinct from `BudgetExceededError` which is a hard stop.
 */
export class BudgetThresholdSignal extends Error {
  readonly kind: BudgetKind;
  readonly limit: number;
  readonly used: number;
  /** Resolves to 'extend' (with optional new limits) or 'stop' */
  readonly decision: Promise<BudgetThresholdDecision>;

  constructor(
    kind: BudgetKind,
    limit: number,
    used: number,
    decision: Promise<BudgetThresholdDecision>,
  ) {
    super(`Budget soft limit: ${kind} (limit=${limit}, used=${used})`);
    this.name = 'BudgetThresholdSignal';
    this.kind = kind;
    this.limit = limit;
    this.used = used;
    this.decision = decision;
  }
}

export type BudgetThresholdDecision =
  | 'stop'
  | { extend: Partial<BudgetLimits> };

/**
 * Callback invoked when a budget limit is about to be exceeded.
 * Return 'throw' for hard stop (default — throws BudgetExceededError).
 * Return 'continue' to allow one more unit and re-check next time.
 * Return a Promise to ask the coordinator via `budget.threshold_reached`
 * event (uses the same grant/deny pattern as `iteration.limit_reached`).
 */
export type BudgetThresholdHandler = (info: {
  kind: BudgetKind;
  used: number;
  limit: number;
  requestDecision: () => Promise<BudgetThresholdDecision>;
}) => 'throw' | 'continue' | Promise<BudgetThresholdDecision>;

/**
 * Per-subagent budget enforcement. Each subagent gets its own instance so a
 * runaway agent can't drain the cost ceiling of its siblings. All record/check
 * methods are O(1) and safe to call from hot paths.
 *
 * Behavior: `record*` methods check the limit and throw synchronously when
 * no `onThreshold` handler is configured. When a handler IS configured,
 * `checkLimit` delegates to it and any async work (coordinator decision)
 * is fire-and-forget via `void` — the thrown error is always synchronous
 * so event handlers in tests (which use `expect(...).toThrow`) work correctly.
 */
export class SubagentBudget {
  readonly limits: Readonly<BudgetLimits>;
  private iterations = 0;
  private toolCalls = 0;
  private tokenInput = 0;
  private tokenOutput = 0;
  private costUsd = 0;
  private startTime: number | null = null;
  private _onThreshold: BudgetThresholdHandler | undefined;
  /**
   * Tracks which budget kinds currently have an extension request
   * in flight. While a kind is here, further `checkLimit` calls for the
   * same kind are no-ops — without this dedup, every `recordIteration`
   * after the limit is reached spawns a fresh decision Promise (until
   * the first one lands and patches limits), flooding the FleetBus
   * with redundant threshold events. Cleared in `checkLimitAsync`'s
   * `finally`.
   */
  private readonly pendingExtensions: Set<BudgetKind> = new Set();
  /**
   * Hard cap on how long `checkLimitAsync` waits for the coordinator to
   * respond before defaulting to 'stop'. Without this fallback an absent
   * or hung listener (Director not built / event filter detached mid-run)
   * leaves the budget over-limit and never enforces anything, since
   * `checkLimit` returns synchronously via `void this.checkLimitAsync`.
   * Raised from 30s to 60s to give subagents more headroom before
   * the threshold negotiation times out and triggers a hard stop.
   */
  private static readonly DECISION_TIMEOUT_MS = 60_000;
  /**
   * Injected by the runner when wiring the budget to its EventBus.
   * Used by `checkLimitAsync` to emit `budget.threshold_reached` events.
   */
  _events?: EventBus;

  /**
   * Optional callback for soft-limit handling. When set, the budget will
   * call this instead of throwing when a limit is first reached. The
   * handler decides whether to throw, continue, or ask the coordinator.
   */
  get onThreshold(): BudgetThresholdHandler | undefined {
    return this._onThreshold;
  }
  set onThreshold(fn: BudgetThresholdHandler | undefined) {
    this._onThreshold = fn;
  }

  constructor(limits: BudgetLimits = {}) {
    // NOT frozen: `negotiateExtension` patches these limits in place when the
    // coordinator grants an auto-extension. Freezing made every granted
    // extension throw `TypeError: Cannot assign to read only property` in
    // strict mode, which the runner caught as a hard stop — so extensions
    // silently became kills. The `readonly limits: Readonly<BudgetLimits>`
    // typing still blocks external mutation at compile time.
    this.limits = { ...limits };
  }

  start(): void {
    this.startTime = Date.now();
  }

  /** Returns true if we're within 10% of any limit — useful for pre-flight checks. */
  isNearLimit(): boolean {
    const { maxIterations, maxToolCalls, maxTokens, maxCostUsd } = this.limits;
    if (maxIterations && this.iterations >= maxIterations * 0.9) return true;
    if (maxToolCalls && this.toolCalls >= maxToolCalls * 0.9) return true;
    if (maxTokens && this.tokenInput + this.tokenOutput >= maxTokens * 0.9) return true;
    if (maxCostUsd && this.costUsd >= maxCostUsd * 0.9) return true;
    return false;
  }

  /**
   * Synchronous budget check — always throws synchronously so callers
   * (especially test event handlers using `expect().toThrow()`) get an
   * unhandled rejection when the budget is exceeded without a handler.
   * When `onThreshold` IS configured, the actual async threshold-handling
   * is dispatched as a fire-and-forget promise.
   */
  private checkLimit(kind: BudgetKind, used: number, limit: number): void {
    // No threshold handler → hard stop, throw synchronously.
    if (!this._onThreshold) {
      throw new BudgetExceededError(kind, limit, used);
    }
    // No EventBus or no listener for the threshold event → there's no
    // coordinator to ask. Fall back to the hard-stop contract so callers
    // that only set `onThreshold` but never wire a Director (or whose
    // FleetBus relay is detached) still get budget enforcement. Without
    // this guard the BudgetThresholdSignal path would await a decision
    // that nobody resolves, the agent would race past it synchronously,
    // and the run would "succeed" past its budget.
    const bus = this._events;
    // hasListenerFor (not listenerCount) so a FleetBus `onPattern('*')`
    // forwarder counts as a listener. listenerCount ignores wildcards, which
    // made every delegated subagent hard-stop on a soft limit instead of
    // negotiating an extension — the auto-extend path was dead on the real
    // delegate/director flow.
    if (!bus || !bus.hasListenerFor('budget.threshold_reached')) {
      throw new BudgetExceededError(kind, limit, used);
    }
    // Already negotiating an extension for this kind — the first signal
    // is in flight; the runner is awaiting its decision and will either
    // patch limits (we continue) or abort the run (we unwind). Don't
    // throw a fresh signal — it would queue duplicate decisions and spam
    // the FleetBus.
    if (this.pendingExtensions.has(kind)) return;
    this.pendingExtensions.add(kind);
    // Throw `BudgetThresholdSignal` carrying the decision Promise. The
    // runner's catch handler awaits the promise: `stop` triggers an
    // abort so the run actually unwinds; `extend` leaves the (already
    // patched) limits in place and the agent continues. The previous
    // `void this.checkLimitAsync(...)` pattern silently produced an
    // unhandled rejection on stop and let the agent run past budget.
    const decision = this.negotiateExtension(kind, used, limit);
    throw new BudgetThresholdSignal(kind, limit, used, decision);
  }

  /**
   * Drive the threshold handler to a decision. Resolves with `'stop'`
   * (signal the runner to abort) or `{ extend: ... }` (limits already
   * patched in-place; the runner should not abort). Always releases the
   * `pendingExtensions` slot in `finally`.
   *
   * The 'continue' return from a sync handler is treated as
   * `{ extend: {} }` — keep going without patching, next overrun will
   * fire a fresh signal.
   */
  private async negotiateExtension(
    kind: BudgetKind,
    used: number,
    limit: number,
  ): Promise<BudgetThresholdDecision> {
    try {
      const result = this._onThreshold!({
        kind,
        used,
        limit,
        // Inject a requestDecision helper the handler can call to emit the
        // budget.threshold_reached event and wait for the coordinator's verdict.
        // A hard fallback timer guarantees the promise eventually resolves
        // even if no listener responds — without it, an absent/detached
        // Director would leave the budget permanently in "asking" state.
        requestDecision: (): Promise<BudgetThresholdDecision> => {
          // No EventBus wired OR no listener registered → there's nobody
          // to grant an extension. Fall straight through to 'stop' so the
          // runner aborts immediately. Without this short-circuit the run
          // would idle for the 30s fallback before failing — long enough
          // for a scripted agent (and our budget-enforcement tests) to
          // happily finish past its budget.
          const bus = this._events;
          if (!bus || !bus.hasListenerFor('budget.threshold_reached')) {
            return Promise.resolve('stop');
          }
          return new Promise<BudgetThresholdDecision>((resolve) => {
            let resolved = false;
            const respond = (d: BudgetThresholdDecision) => {
              if (resolved) return;
              resolved = true;
              resolve(d);
            };
            const fallback = setTimeout(
              () => respond('stop'),
              SubagentBudget.DECISION_TIMEOUT_MS,
            );
            bus.emit('budget.threshold_reached', {
              kind: kind as 'iterations' | 'tool_calls' | 'tokens' | 'cost' | 'timeout',
              used,
              limit,
              timeoutMs: SubagentBudget.DECISION_TIMEOUT_MS,
              extend: (extra: Partial<BudgetLimits>) => {
                clearTimeout(fallback);
                respond({ extend: extra });
              },
              deny: () => {
                clearTimeout(fallback);
                respond('stop');
              },
            });
          });
        },
      });

      if (result === 'throw') return 'stop';
      if (result === 'continue') return { extend: {} };

      const decision = await result;
      if (decision === 'stop') return 'stop';

      // 'extend' — patch the in-place limits BEFORE resolving so the
      // runner's continue path sees the new ceiling. The frozen-object
      // cast mirrors the original implementation.
      const ext = decision.extend;
      if (ext.maxIterations !== undefined) {
        (this.limits as Record<string, unknown>).maxIterations = ext.maxIterations;
      }
      if (ext.maxToolCalls !== undefined) {
        (this.limits as Record<string, unknown>).maxToolCalls = ext.maxToolCalls;
      }
      if (ext.maxTokens !== undefined) {
        (this.limits as Record<string, unknown>).maxTokens = ext.maxTokens;
      }
      if (ext.maxCostUsd !== undefined) {
        (this.limits as Record<string, unknown>).maxCostUsd = ext.maxCostUsd;
      }
      if (ext.timeoutMs !== undefined) {
        (this.limits as Record<string, unknown>).timeoutMs = ext.timeoutMs;
      }
      return decision;
    } finally {
      this.pendingExtensions.delete(kind);
    }
  }

  recordIteration(): void {
    this.iterations++;
    if (this.limits.maxIterations !== undefined && this.iterations > this.limits.maxIterations) {
      void this.checkLimit('iterations', this.iterations, this.limits.maxIterations);
    }
  }

  recordToolCall(): void {
    this.toolCalls++;
    if (this.limits.maxToolCalls !== undefined && this.toolCalls > this.limits.maxToolCalls) {
      void this.checkLimit('tool_calls', this.toolCalls, this.limits.maxToolCalls);
    }
  }

  recordUsage(usage: Usage, costUsd = 0): void {
    this.tokenInput += usage.input;
    this.tokenOutput += usage.output;
    this.costUsd += costUsd;

    const totalTokens = this.tokenInput + this.tokenOutput;
    if (this.limits.maxTokens !== undefined && totalTokens > this.limits.maxTokens) {
      void this.checkLimit('tokens', totalTokens, this.limits.maxTokens);
    }
    if (this.limits.maxCostUsd !== undefined && this.costUsd > this.limits.maxCostUsd) {
      void this.checkLimit('cost', this.costUsd, this.limits.maxCostUsd);
    }
  }

  /**
   * Wall-clock budget check. Unlike other limits, timeout is treated as a
   * warning-only event — it NEVER hard-stops the subagent. When the
   * elapsed time exceeds timeoutMs, emits `budget.threshold_reached` with
   * kind='timeout' so the Director can decide whether to extend or warn.
   * Call this from the iteration loop so a hung tool gets a chance to
   * negotiate more time before the coordinator's Promise.race kills it.
   */
  checkTimeout(): void {
    if (this.startTime === null || this.limits.timeoutMs === undefined) return;
    const elapsed = Date.now() - this.startTime;
    if (elapsed > this.limits.timeoutMs) {
      // Route through the same negotiation path as all other soft limits.
      // BudgetThresholdSignal → onBudgetError in the runner → coordinator
      // decision → extend or warn. Never throw a hard BudgetExceededError
      // for timeout.
      void this.checkLimit('timeout', elapsed, this.limits.timeoutMs);
    }
  }

  /** Returns true if a timeout has occurred without throwing. Useful for races. */
  isTimedOut(): boolean {
    if (this.startTime === null || this.limits.timeoutMs === undefined) return false;
    return Date.now() - this.startTime > this.limits.timeoutMs;
  }

  usage(): BudgetUsage {
    return {
      iterations: this.iterations,
      toolCalls: this.toolCalls,
      tokens: {
        input: this.tokenInput,
        output: this.tokenOutput,
        total: this.tokenInput + this.tokenOutput,
      },
      costUsd: this.costUsd,
      elapsedMs: this.startTime === null ? 0 : Date.now() - this.startTime,
    };
  }
}