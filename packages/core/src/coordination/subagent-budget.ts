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

/**
 * Controls how the budget behaves when `onThreshold` is set and a limit is hit.
 *
 * `'auto'` — emit `budget.threshold_reached` on the EventBus and wait for a
 * coordinator response (extend/stop). If no listener responds within
 * `DECISION_TIMEOUT_MS` the decision defaults to `'stop'`.
 * `'sync'` — do not emit any event; treat the threshold as a hard stop and
 * throw `BudgetExceededError` synchronously. Useful for fire-and-forget
 * subagents that have an `onThreshold` handler for logging/metrics but are
 * not wired into a coordinator.
 *
 * @default 'auto'
 */
export type BudgetNegotiationMode = 'auto' | 'sync';

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
 * Behavior without `onThreshold`: hard stops synchronously on every limit hit.
 *
 * Behavior with `onThreshold` and `_mode === 'auto'`: emits `budget.threshold_reached`
 * on the EventBus and throws `BudgetThresholdSignal`. The coordinator's verdict
 * (extend/stop) resolves the embedded promise. If no listener responds within
 * `DECISION_TIMEOUT_MS` the decision defaults to `'stop'`.
 *
 * Behavior with `onThreshold` and `_mode === 'sync'`: throws `BudgetExceededError`
 * synchronously regardless of EventBus state or listener presence. This is useful
 * for fire-and-forget subagents that have an `onThreshold` handler for logging/metrics
 * but are not wired into a coordinator — the `'sync'` mode makes the hard-stop
 * behavior explicit and means tests can use `expect().toThrow()` even without
 * a fully-wired EventBus.
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
   * Hard cap on how long `_negotiateExtension` waits for the coordinator to
   * respond before defaulting to 'stop'. Without this fallback an absent
   * or hung listener (Director not built / event filter detached mid-run)
   * leaves the budget over-limit and never enforces anything.
   */
  private static readonly DECISION_TIMEOUT_MS = 60_000;
  /**
   * Injected by the runner when wiring the budget to its EventBus.
   * Used to emit `budget.threshold_reached` events in `'auto'` mode.
   */
  _events?: EventBus;

  /**
   * Negotiation mode — controls whether a threshold hit tries to emit
   * `budget.threshold_reached` and wait for a coordinator decision, or
   * falls straight through to a synchronous hard stop.
   *
   * `'auto'` (default) — emit on the EventBus and wait; times out to 'stop'.
   * `'sync'` — throw `BudgetExceededError` immediately regardless of listeners.
   */
  private _mode: BudgetNegotiationMode;

  /**
   * Optional callback for soft-limit handling. When set, the budget will
   * invoke it rather than throw immediately. The handler decides whether to
   * throw synchronously, continue, or ask the coordinator for an extension.
   */
  get onThreshold(): BudgetThresholdHandler | undefined {
    return this._onThreshold;
  }
  set onThreshold(fn: BudgetThresholdHandler | undefined) {
    this._onThreshold = fn;
  }

  /** Returns the current negotiation mode. */
  get mode(): BudgetNegotiationMode {
    return this._mode;
  }

  constructor(limits: BudgetLimits = {}, mode: BudgetNegotiationMode = 'auto') {
    this._mode = mode;
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
   * Synchronous budget check. Always throws synchronously so callers (especially
   * test event handlers using `expect().toThrow()`) get an unhandled rejection
   * when the budget is exceeded without a handler.
   *
   * Decision table:
   * - no `onThreshold` handler         → throw `BudgetExceededError` (hard stop, always)
   * - `mode === 'sync'`               → throw `BudgetExceededError` (hard stop, always)
   * - `mode === 'auto'` + no listener  → throw `BudgetExceededError` (hard stop; no one to ask)
   * - `mode === 'auto'` + listener     → throw `BudgetThresholdSignal` with async decision promise
   */
  /**
   * Collects all exceeded budget kinds into a single NOOP-free negotiation.
   * Called by recordIteration / recordToolCall / recordUsage — each may call
   * this for its own kind. The first call starts the negotiation and stores
   * the Promise in _pendingNegotiation. Subsequent calls for DIFFERENT
   * kinds (while a negotiation is in flight) are NOOPs — they don't start
   * new conversations with the coordinator. This prevents an EventBus flood
   * when multiple budget kinds are exceeded simultaneously in one iteration.
   *
   * Returns the kinds that were found to be exceeded (for logging/debugging).
   */
  private checkLimits(): { kind: BudgetKind; used: number; limit: number }[] {
    const exceeded: { kind: BudgetKind; used: number; limit: number }[] = [];

    if (this.limits.maxIterations !== undefined && this.iterations > this.limits.maxIterations) {
      exceeded.push({ kind: 'iterations', used: this.iterations, limit: this.limits.maxIterations });
    }
    if (this.limits.maxToolCalls !== undefined && this.toolCalls > this.limits.maxToolCalls) {
      exceeded.push({ kind: 'tool_calls', used: this.toolCalls, limit: this.limits.maxToolCalls });
    }
    const totalTokens = this.tokenInput + this.tokenOutput;
    if (this.limits.maxTokens !== undefined && totalTokens > this.limits.maxTokens) {
      exceeded.push({ kind: 'tokens', used: totalTokens, limit: this.limits.maxTokens });
    }
    if (this.limits.maxCostUsd !== undefined && this.costUsd > this.limits.maxCostUsd) {
      exceeded.push({ kind: 'cost', used: this.costUsd, limit: this.limits.maxCostUsd });
    }

    if (exceeded.length === 0) return [];

    if (!this._onThreshold) {
      // Hard stop — throw on the first exceeded kind.
      const first = exceeded[0]!;
      throw new BudgetExceededError(first.kind, first.limit, first.used);
    }
    if (this._mode === 'sync') {
      // Hard stop in sync mode.
      const first = exceeded[0]!;
      throw new BudgetExceededError(first.kind, first.limit, first.used);
    }
    const bus = this._events;
    if (!bus || !bus.hasListenerFor('budget.threshold_reached')) {
      const first = exceeded[0]!;
      throw new BudgetExceededError(first.kind, first.limit, first.used);
    }

    // A negotiation is already in flight — don't start another.
    // The existing conversation with the coordinator will handle ALL exceeded
    // kinds when it resolves. Subsequent checkLimits() calls are NOOPs.
    if (this._pendingNegotiation) return [];

    // Start exactly ONE negotiation for all exceeded kinds.
    const decision = this._negotiateExtension(exceeded);
    this._pendingNegotiation = decision;
    const first = exceeded[0]!;
    throw new BudgetThresholdSignal(first.kind, first.limit, first.used, decision);
  }

  /**
   * Single in-flight negotiation Promise. Guards against concurrent
   * negotiations for different budget kinds. Cleared in `_negotiateExtension`'s
   * `finally` block.
   */
  private _pendingNegotiation: Promise<BudgetThresholdDecision> | null = null;

  /**
   * Drive the threshold handler to a decision. Resolves with `'stop'`
   * (signal the runner to abort) or `{ extend: ... }` (limits already
   * patched in-place; the runner should not abort). Clears the
   * `_pendingNegotiation` slot in `finally`.
   *
   * The 'continue' return from a sync handler is treated as
   * `{ extend: {} }` — keep going without patching; next overrun fires
   * a fresh signal.
   */
  private async _negotiateExtension(
    exceeded: { kind: BudgetKind; used: number; limit: number }[],
  ): Promise<BudgetThresholdDecision> {
    try {
      // Use the first exceeded kind for the handler call.
      const first = exceeded[0]!;
      const result = this._onThreshold!({
        kind: first.kind,
        used: first.used,
        limit: first.limit,
        requestDecision: (): Promise<BudgetThresholdDecision> => {
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
            // Emit one event per exceeded kind so the FleetBus routes them.
            for (const { kind, used, limit } of exceeded) {
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
            }
          });
        },
      });

      if (result === 'throw') return 'stop';
      if (result === 'continue') return { extend: {} };

      const decision = await result;
      if (decision === 'stop') return 'stop';

      // 'extend' — patch in-place limits BEFORE resolving so the runner's
      // continue path sees the new ceiling.
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
      this._pendingNegotiation = null;
    }
  }

  recordIteration(): void {
    this.iterations++;
    void this.checkLimits();
  }

  recordToolCall(): void {
    this.toolCalls++;
    void this.checkLimits();
  }

  recordUsage(usage: Usage, costUsd = 0): void {
    this.tokenInput += usage.input;
    this.tokenOutput += usage.output;
    this.costUsd += costUsd;
    void this.checkLimits();
  }

  /**
   * Wall-clock budget check. Unlike other limits, timeout check passes through
   * `checkLimits` and is subject to the same negotiation-mode decision table.
   * In practice, `'sync'` mode (the usual test configuration) means a timeout
   * immediately throws `BudgetExceededError`. In production with a coordinator,
   * a timeout emits `budget.threshold_reached` so the Director can decide whether
   * to extend or abort.
   */
  checkTimeout(): void {
    if (this.startTime === null || this.limits.timeoutMs === undefined) return;
    const elapsed = Date.now() - this.startTime;
    if (elapsed > this.limits.timeoutMs) {
      void this.checkLimits();
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
