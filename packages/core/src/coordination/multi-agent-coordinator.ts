import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { AgentBridge, BridgeMessage } from '../types/agent-bridge.js';
import type {
  CoordinatorStatus,
  MultiAgentConfig,
  MultiAgentCoordinator,
  SpawnResult,
  SubagentConfig,
  SubagentContext,
  SubagentError,
  SubagentErrorKind,
  SubagentRunContext,
  SubagentRunner,
  TaskResult,
  TaskSpec,
} from '../types/multi-agent.js';
import { ProviderError } from '../types/provider.js';
import { BudgetExceededError, SubagentBudget } from './subagent-budget.js';

type SubagentStatus = 'running' | 'idle' | 'stopped' | 'error';

interface SubagentEntry {
  config: SubagentConfig;
  context: SubagentContext;
  status: SubagentStatus;
  currentTask?: string;
  abortController: AbortController;
  /** Lazily created on first dispatch — budget is per-task, not per-subagent. */
  activeBudget?: SubagentBudget;
}

export interface MultiAgentCoordinatorOptions {
  /**
   * Callback that executes a task on behalf of a subagent. Required for
   * `assign()` to actually run anything — without it, tasks queue forever.
   * The coordinator provides per-subagent isolation (own budget, own signal,
   * own bridge) and enforces timeout + concurrency.
   */
  runner?: SubagentRunner;
}

export class DefaultMultiAgentCoordinator extends EventEmitter implements MultiAgentCoordinator {
  readonly coordinatorId: string;
  readonly config: MultiAgentConfig;
  private runner?: SubagentRunner;

  private readonly subagents = new Map<string, SubagentEntry>();

  private pendingTasks: TaskSpec[] = [];
  private completedResults: TaskResult[] = [];
  private totalIterations = 0;
  private inFlight = 0;

  constructor(config: MultiAgentConfig, options: MultiAgentCoordinatorOptions = {}) {
    super();
    this.coordinatorId = config.coordinatorId;
    this.config = config;
    this.runner = options.runner;
  }

  /**
   * Replace the runner after construction. Used when the runner depends
   * on infrastructure (e.g. FleetBus) that isn't available until after
   * the coordinator's owning Director is built.
   */
  setRunner(runner: SubagentRunner): void {
    this.runner = runner;
  }

  async spawn(subagent: SubagentConfig): Promise<SpawnResult> {
    const id = subagent.id || randomUUID();
    const context: SubagentContext = {
      subagentId: id,
      tasks: [],
      // Wired later by the caller via setSubagentBridge() once the
      // bidirectional bridge is created. Readers must null-check / use
      // hasParentBridge() — the type now reflects this.
      parentBridge: null,
      doneCondition: this.config.doneCondition,
      maxConcurrent: this.config.maxConcurrent ?? 4,
    };

    this.subagents.set(id, {
      config: { ...subagent, id },
      context,
      status: 'idle',
      abortController: new AbortController(),
    });

    this.emit('subagent.started', { subagent: { ...subagent, id } });

    return { subagentId: id, agentId: id };
  }

  async assign(task: TaskSpec): Promise<void> {
    this.pendingTasks.push(task);
    this.tryDispatchNext();
  }

  async delegate(to: string, msg: BridgeMessage): Promise<void> {
    const subagent = this.subagents.get(to);
    if (!subagent) throw new Error(`Subagent "${to}" not found`);
    if (!subagent.context.parentBridge) {
      throw new Error(`Subagent "${to}" has no parentBridge — call setSubagentBridge() first`);
    }
    await subagent.context.parentBridge.send(msg);
  }

  /**
   * Wire up the communication bridge for a subagent. Call after spawn() once
   * the caller has created the bidirectional connection.
   */
  setSubagentBridge(subagentId: string, bridge: AgentBridge): void {
    const subagent = this.subagents.get(subagentId);
    if (!subagent) throw new Error(`Subagent "${subagentId}" not found`);
    subagent.context.parentBridge = bridge;
  }

  async stop(subagentId: string): Promise<void> {
    const subagent = this.subagents.get(subagentId);
    if (!subagent) return;

    // Abort any in-flight run, then sever the bridge so further messages fail
    // fast instead of silently queueing on a dead subagent.
    subagent.abortController.abort();
    subagent.status = 'stopped';
    subagent.currentTask = undefined;
    subagent.context.parentBridge = null;

    this.emit('subagent.stopped', { subagentId, reason: 'stopped by coordinator' });
  }

  async stopAll(): Promise<void> {
    // allSettled so one failure doesn't leave other subagents un-stopped.
    await Promise.allSettled([...this.subagents.keys()].map((id) => this.stop(id)));
  }

  getStatus(): CoordinatorStatus {
    return {
      coordinatorId: this.coordinatorId,
      subagents: Array.from(this.subagents.entries()).map(([id, s]) => ({
        id,
        name: s.config.name,
        status: s.status,
        currentTask: s.currentTask,
      })),
      pendingTasks: this.pendingTasks.length,
      completedTasks: this.completedResults.length,
      totalIterations: this.totalIterations,
      done: this.isDone(),
    };
  }

  /** Expose snapshot of completed results — useful for callers awaiting all done. */
  results(): readonly TaskResult[] {
    return this.completedResults;
  }

  /**
   * Manual completion — for callers that drive subagents without a runner
   * (e.g. external orchestrators). When a runner is configured the coordinator
   * calls this itself.
   */
  completeTask(result: TaskResult): void {
    this.recordCompletion(result);
  }

  // --- internal dispatching ---------------------------------------------

  private tryDispatchNext(): void {
    while (this.canDispatch()) {
      const subagentId = this.findIdleSubagent();
      if (!subagentId) return;
      const task = this.pendingTasks.shift();
      if (!task) return;
      // Attach a catch so a synchronous throw inside runDispatched (rare —
      // e.g. provider misconfiguration before the first await) becomes a
      // visible failed task instead of an unhandled rejection that leaves
      // `inFlight` permanently elevated.
      this.runDispatched(subagentId, task).catch((err) => {
        this.recordCompletion({
          subagentId,
          taskId: task.id,
          status: 'failed',
          error: classifySubagentError(err),
          iterations: 0,
          toolCalls: 0,
          durationMs: 0,
        });
      });
    }
  }

  private canDispatch(): boolean {
    const max = this.config.maxConcurrent ?? 4;
    return this.inFlight < max && this.pendingTasks.length > 0;
  }

  private findIdleSubagent(): string | null {
    for (const [id, s] of this.subagents) {
      if (s.status === 'idle') return id;
    }
    return null;
  }

  private async runDispatched(subagentId: string, task: TaskSpec): Promise<void> {
    const subagent = this.subagents.get(subagentId);
    if (!subagent) return;

    subagent.status = 'running';
    subagent.currentTask = task.id;
    task.subagentId = subagentId;
    subagent.context.tasks.push(task);

    this.emit('task.assigned', { task, subagentId });

    // Budget combines coordinator defaults with per-subagent and per-task overrides.
    // Precedence: task > subagent > coordinator default.
    const budget = new SubagentBudget({
      maxIterations: subagent.config.maxIterations ?? this.config.defaultBudget?.maxIterations,
      maxToolCalls:
        task.maxToolCalls ??
        subagent.config.maxToolCalls ??
        this.config.defaultBudget?.maxToolCalls,
      maxTokens: subagent.config.maxTokens ?? this.config.defaultBudget?.maxTokens,
      maxCostUsd: subagent.config.maxCostUsd ?? this.config.defaultBudget?.maxCostUsd,
      timeoutMs:
        task.timeoutMs ?? subagent.config.timeoutMs ?? this.config.defaultBudget?.timeoutMs,
    });
    subagent.activeBudget = budget;

    if (!this.runner) {
      // No runner wired — caller drives execution via completeTask(). Status
      // reverts when the caller reports. We intentionally don't bump
      // `inFlight` here: `completeTask` → `recordCompletion` would then
      // decrement an inFlight that runDispatched never incremented, masking
      // the "no runner" state. With this guard, `isDone()`'s all_tasks_done
      // check still settles correctly once the caller reports.
      return;
    }

    // Only count inFlight when we actually own the execution lifecycle.
    this.inFlight++;

    const startTime = Date.now();
    const runCtx: SubagentRunContext = {
      subagentId,
      config: subagent.config,
      budget,
      signal: subagent.abortController.signal,
      bridge: subagent.context.parentBridge || null,
    };

    let result: TaskResult;

    budget.start();
    try {
      const outcome = await this.executeWithTimeout(this.runner, task, runCtx, budget);
      result = {
        subagentId,
        taskId: task.id,
        status: 'success',
        result: outcome.result,
        iterations: outcome.iterations,
        toolCalls: outcome.toolCalls,
        durationMs: Date.now() - startTime,
      };
    } catch (err) {
      // Order matters: a timeout calls abort() to signal cooperative runners,
      // which also flips `signal.aborted=true`. Inspect the error first so we
      // surface 'timeout' rather than masking it as 'stopped'.
      const status: TaskResult['status'] =
        err instanceof BudgetExceededError && err.kind === 'timeout'
          ? 'timeout'
          : subagent.abortController.signal.aborted
            ? 'stopped'
            : 'failed';
      const usage = budget.usage();
      result = {
        subagentId,
        taskId: task.id,
        status,
        error: classifySubagentError(err, {
          parentAborted: subagent.abortController.signal.aborted,
        }),
        iterations: usage.iterations,
        toolCalls: usage.toolCalls,
        durationMs: Date.now() - startTime,
      };
    }

    this.recordCompletion(result);
  }

  private async executeWithTimeout(
    runner: SubagentRunner,
    task: TaskSpec,
    ctx: SubagentRunContext,
    budget: SubagentBudget,
  ) {
    const timeoutMs = budget.limits.timeoutMs;
    if (timeoutMs === undefined) return runner(task, ctx);

    let timer: ReturnType<typeof setTimeout> | null = null;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        // Abort the subagent's signal so cooperative runners can clean up.
        this.subagents.get(ctx.subagentId)?.abortController.abort();
        reject(new BudgetExceededError('timeout', timeoutMs, Date.now()));
      }, timeoutMs);
    });

    try {
      return await Promise.race([runner(task, ctx), timeoutPromise]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private recordCompletion(result: TaskResult): void {
    this.completedResults.push(result);
    this.totalIterations += result.iterations;
    if (this.inFlight > 0) {
      this.inFlight--;
    } else if (this.runner) {
      // Runner-driven path completed without an outstanding inFlight slot —
      // shouldn't happen unless completeTask was called externally.
      this.emit('warning', {
        type: 'inFlight_underflow',
        taskId: result.taskId,
        subagentId: result.subagentId,
      });
      return;
    }

    const subagent = this.subagents.get(result.subagentId);
    if (subagent && subagent.status !== 'stopped') {
      const failed = result.status === 'failed' || result.status === 'timeout';
      subagent.status = failed ? 'error' : 'idle';
      subagent.currentTask = undefined;
      // If the run aborted (timeout or explicit stop), the subagent's
      // signal is now permanently aborted — recycling the controller lets
      // the next dispatched task start with a fresh cancellation scope.
      if (subagent.abortController.signal.aborted) {
        subagent.abortController = new AbortController();
      }
      // Reset error state on next assignment so a transient failure doesn't
      // permanently sideline the subagent.
      if (subagent.status === 'error') {
        queueMicrotask(() => {
          if (subagent.status === 'error') subagent.status = 'idle';
          this.tryDispatchNext();
        });
      }
    }

    this.emit('task.completed', {
      task: subagent?.context.tasks.find((t) => t.id === result.taskId) ?? { id: result.taskId },
      result,
    });

    this.tryDispatchNext();

    if (this.isDone()) {
      this.emit('done', {
        results: this.completedResults,
        totalIterations: this.totalIterations,
      });
    }
  }

  private isDone(): boolean {
    if (this.config.doneCondition.type === 'all_tasks_done') {
      return this.pendingTasks.length === 0 && this.inFlight === 0;
    }
    if (
      this.config.doneCondition.maxIterations !== undefined &&
      this.totalIterations >= this.config.doneCondition.maxIterations
    ) {
      return true;
    }
    return false;
  }
}

/**
 * Map any raw exception thrown out of a subagent's runner into a
 * structured `SubagentError`. This is the single point where the
 * coordinator decides "what kind of failure was that" — so callers
 * (delegate tool output, /agents UI, retry policies) branch on
 * `kind` instead of substring-matching `error.message`.
 *
 * The classification order matters:
 *   1. Provider errors first (their `status` + `retryable` are
 *      already structured, just translate to our enum).
 *   2. Budget errors next (BudgetExceededError carries a discrete
 *      `kind` we can lift directly).
 *   3. Parent-abort if the subagent's signal was aborted and we
 *      didn't recognize the error otherwise — distinguishes user
 *      Ctrl+C from a tool throwing.
 *   4. Substring sniffing for stable error markers ("agent
 *      aborted" from agent-subagent-runner, "Bridge transport"
 *      from agent-bridge).
 *   5. Fallback to `unknown` so callers know we couldn't classify.
 *
 * The `cause` field is always populated when `err` is an Error so
 * diagnostics survive even when `kind === 'unknown'` — no info is
 * dropped, the classifier just refused to commit.
 *
 * Exported because tests and CLI surfaces want to assert on the
 * classification without instantiating a coordinator.
 */
export function classifySubagentError(
  err: unknown,
  hints: { parentAborted?: boolean } = {},
): SubagentError {
  const cause = err instanceof Error
    ? { name: err.name, message: err.message, stack: err.stack }
    : undefined;
  const baseMessage = err instanceof Error ? err.message : String(err);

  if (err instanceof ProviderError) {
    return providerErrorToSubagentError(err, baseMessage, cause);
  }

  if (err instanceof BudgetExceededError) {
    const map: Record<BudgetExceededError['kind'], SubagentErrorKind> = {
      iterations: 'budget_iterations',
      tool_calls: 'budget_tool_calls',
      tokens: 'budget_tokens',
      cost: 'budget_cost',
      timeout: 'budget_timeout',
    };
    return {
      kind: map[err.kind],
      message: baseMessage,
      // Budgets are user-configured ceilings, not transient failures —
      // retrying with the same budget will hit the same ceiling. The
      // orchestrator must raise the budget or narrow the task first.
      retryable: false,
      cause,
    };
  }

  // Distinguish parent-aborted from real failures BEFORE substring
  // sniffing — if the parent signal is aborted, the most common
  // exception is "agent aborted" thrown by agent-subagent-runner.
  if (hints.parentAborted) {
    return {
      kind: 'aborted_by_parent',
      message: baseMessage,
      retryable: false,
      cause,
    };
  }

  // Stable markers — these strings live in our own code and are
  // checked here intentionally so callers can react without
  // exception-type imports.
  const lower = baseMessage.toLowerCase();
  if (/agent aborted$/i.test(baseMessage)) {
    return {
      kind: 'aborted_by_parent',
      message: baseMessage,
      retryable: false,
      cause,
    };
  }
  if (/agent exhausted iteration limit$/i.test(baseMessage)) {
    return { kind: 'budget_iterations', message: baseMessage, retryable: false, cause };
  }
  if (/empty response$/i.test(baseMessage)) {
    return { kind: 'empty_response', message: baseMessage, retryable: false, cause };
  }
  if (lower.includes('bridge transport') || /bridge.*(closed|disconnect)/i.test(baseMessage)) {
    return { kind: 'bridge_failed', message: baseMessage, retryable: false, cause };
  }
  if (/context length|max.*tokens?.*exceeded|prompt is too long/i.test(baseMessage)) {
    return { kind: 'context_overflow', message: baseMessage, retryable: false, cause };
  }

  // Final fallback — preserve cause so diagnostics aren't lost.
  return {
    kind: 'unknown',
    message: baseMessage,
    retryable: false,
    cause,
  };
}

function providerErrorToSubagentError(
  err: ProviderError,
  message: string,
  cause: SubagentError['cause'],
): SubagentError {
  const status = err.status;
  // Read suggested retry-after from the provider body when present so
  // the orchestrator doesn't have to invent a backoff. Most providers
  // include retry-after as a header / body field which our provider
  // layer normalises into `body.message` — we cannot trust a numeric
  // field exists, so we leave backoffMs unset when unknown.
  if (status === 429 || err.body?.type === 'rate_limit_error') {
    return {
      kind: 'provider_rate_limit',
      message,
      retryable: true,
      // Conservative default: 5s. Provider-specific code can override
      // by emitting an error whose body carries an explicit hint.
      backoffMs: 5_000,
      cause,
    };
  }
  if (status === 401 || status === 403 || err.body?.type === 'authentication_error') {
    return { kind: 'provider_auth', message, retryable: false, cause };
  }
  if (status === 408 || status === 0) {
    return { kind: 'provider_timeout', message, retryable: true, cause };
  }
  if (status >= 500 && status < 600) {
    return {
      kind: 'provider_5xx',
      message,
      retryable: true,
      backoffMs: 3_000,
      cause,
    };
  }
  // Other provider errors (400 invalid request, 404 not found, etc.)
  // are not retryable as-is and don't have a dedicated kind — surface
  // as 'unknown' so the orchestrator treats them as terminal.
  return { kind: 'unknown', message, retryable: err.retryable, cause };
}
