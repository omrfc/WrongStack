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
    this.limits = Object.freeze({ ...limits });
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
    if (kind === 'timeout' || !this._onThreshold) {
      throw new BudgetExceededError(kind, limit, used);
    }
    // Handler configured → kick off async decision flow without blocking.
    void this.checkLimitAsync(kind, used, limit);
  }

  /**
   * Async threshold negotiation with the coordinator. Fire-and-forget —
   * any error thrown here becomes an unhandled rejection in the test environment
   * because the runner's catch only handles the synchronous throw from `checkLimit`.
   */
  private async checkLimitAsync(kind: BudgetKind, used: number, limit: number): Promise<void> {
    const result = this._onThreshold!({
      kind,
      used,
      limit,
      // Inject a requestDecision helper the handler can call to emit the
      // budget.threshold_reached event and wait for the coordinator's verdict.
      // The runner wires this by injecting its EventBus into ctx.budget._events.
      requestDecision: (): Promise<BudgetThresholdDecision> => {
        return new Promise<BudgetThresholdDecision>((resolve) => {
          this._events?.emit('budget.threshold_reached', {
            kind: kind as 'iterations' | 'tool_calls' | 'tokens' | 'cost',
            used,
            limit,
            timeoutMs: 30_000,
            extend: (extra: Partial<BudgetLimits>) => resolve({ extend: extra }),
            deny: () => resolve('stop'),
          });
        });
      },
    });

    if (result === 'throw') {
      throw new BudgetExceededError(kind, limit, used);
    }
    if (result === 'continue') {
      // Allow one more unit — don't bump the counter yet, next call will re-check
      return;
    }
    // Async path: coordinator decision via requestDecision()
    const decision = await result;
    if (decision === 'stop') {
      throw new BudgetExceededError(kind, limit, used);
    }
    // 'extend' — bump the limit and continue
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
   * Throws if the wall-clock budget is exhausted. Call this from the iteration
   * loop so a hung tool can't keep a subagent running past its deadline.
   */
  checkTimeout(): void {
    if (this.startTime === null || this.limits.timeoutMs === undefined) return;
    const elapsed = Date.now() - this.startTime;
    if (elapsed > this.limits.timeoutMs) {
      throw new BudgetExceededError('timeout', this.limits.timeoutMs, elapsed);
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