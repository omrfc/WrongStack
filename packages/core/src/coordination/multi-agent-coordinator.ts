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
import { applyRosterBudget } from './fleet.js';

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
  private fleetBus?: import('./fleet-bus.js').FleetBus;

  private readonly subagents = new Map<string, SubagentEntry>();

  private pendingTasks: TaskSpec[] = [];
  private completedResults: TaskResult[] = [];
  private totalIterations = 0;
  private inFlight = 0;
  /**
   * Subagents currently being stopped. Set on entry to `stop()`, cleared
   * once `recordCompletion` lands the terminal TaskResult. Used by
   * `runDispatched` and `findIdleSubagent` to refuse mid-flight dispatch
   * to a subagent the caller has already asked to terminate — closes the
   * assign+terminate race where a fresh task could land on a worker that
   * was about to be killed.
   */
  private readonly terminating = new Set<string>();

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

  /**
   * Wire a FleetBus for director-mode event emission. Call after the
   * FleetManager is constructed so the coordinator can emit lifecycle
   * events the TUI and monitoring tools subscribe to.
   */
  setFleetBus(fleet: import('./fleet-bus.js').FleetBus): void {
    this.fleetBus = fleet;
  }

  /**
   * Change the in-flight dispatch ceiling at runtime. Lowering does NOT
   * preempt running tasks — already-dispatched subagents finish their
   * current task; only future dispatches respect the new cap. Raising
   * immediately tries to fill the freed slots from the pending queue.
   */
  setMaxConcurrent(n: number): void {
    if (!Number.isFinite(n) || n < 1) {
      throw new Error(`maxConcurrent must be a finite integer >= 1, got ${n}`);
    }
    this.config.maxConcurrent = Math.floor(n);
    this.tryDispatchNext();
  }

  async spawn(subagent: SubagentConfig): Promise<SpawnResult> {
    const id = subagent.id || randomUUID();
    // Duplicate-id guard. Previously a second spawn({id}) with the
    // same id silently overwrote the existing entry — orphaning the
    // first subagent's AbortController, Context, and any in-flight
    // task referencing it. Two spawns with the same id are almost
    // always a bug at the caller; refuse and let them surface it.
    if (this.subagents.has(id)) {
      throw new Error(`Subagent id "${id}" already exists — refusing to overwrite`);
    }
    const context: SubagentContext = {
      subagentId: id,
      tasks: [],
      // Wired later by the caller via setSubagentBridge() once the
      // bidirectional bridge is created. Readers must null-check / use
      // hasParentBridge() — the type now reflects this.
      parentBridge: null,
      doneCondition: this.config.doneCondition,
      maxConcurrent: this.config.maxConcurrent ?? 16,
    };

    this.subagents.set(id, {
      config: { ...subagent, id },
      context,
      status: 'idle',
      abortController: new AbortController(),
    });

    this.emit('subagent.started', { subagent: { ...subagent, id } });

    this.fleetBus?.emit({
      subagentId: id,
      ts: Date.now(),
      type: 'subagent.assigned',
      payload: {
        subagentId: id,
        name: subagent.name,
        provider: subagent.provider,
        model: subagent.model,
      },
    });

    this.emitCoordinatorStats();

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

    // Mark terminating BEFORE the abort so a synchronous tryDispatchNext
    // observation in another callback path sees the intent and skips
    // this subagent. Cleared by recordCompletion once the runner's
    // catch block lands the terminal TaskResult.
    this.terminating.add(subagentId);

    // Abort any in-flight run, then sever the bridge so further messages fail
    // fast instead of silently queueing on a dead subagent.
    subagent.abortController.abort();
    subagent.status = 'stopped';
    subagent.currentTask = undefined;
    subagent.context.parentBridge = null;

    this.emit('subagent.stopped', { subagentId, reason: 'stopped by coordinator' });

    this.fleetBus?.emit({
      subagentId,
      ts: Date.now(),
      type: 'subagent.stopped',
      payload: { subagentId, reason: 'stopped by coordinator' },
    });

    this.emitCoordinatorStats();
  }

  async stopAll(): Promise<void> {
    // Clear the queue FIRST so no new tasks land on subagents while
    // we're tearing them down. Each dropped task gets a synthetic
    // `aborted_by_parent` completion so any caller awaiting it (e.g.
    // delegate tool's awaitTasks) resolves instead of hanging.
    //
    // Pending tasks never reached `inFlight`, so we cannot route them
    // through `recordCompletion` — its underflow guard would short-
    // circuit on the second pending task and emit a warning instead
    // of the completion event. The shared helper inline-emits.
    this.drainPendingAsAborted('Coordinator stopAll() drained the pending queue');
    // allSettled so one failure doesn't leave other subagents un-stopped.
    await Promise.allSettled([...this.subagents.keys()].map((id) => this.stop(id)));
  }

  async remove(subagentId: string): Promise<void> {
    await this.stop(subagentId);
    this.subagents.delete(subagentId);
  }

  /**
   * Get current coordinator stats for monitoring/debugging.
   */
  getStats(): {
    total: number;
    running: number;
    idle: number;
    stopped: number;
    inFlight: number;
    pending: number;
    completed: number;
  } {
    let running = 0;
    let idle = 0;
    let stopped = 0;
    for (const [, entry] of this.subagents) {
      if (entry.status === 'running') running++;
      else if (entry.status === 'idle') idle++;
      else stopped++;
    }
    return {
      total: this.subagents.size,
      running,
      idle,
      stopped,
      inFlight: this.inFlight,
      pending: this.pendingTasks.length,
      completed: this.completedResults.length,
    };
  }

  /** Emit a reactive coordinator.stats event on FleetBus so the TUI can subscribe. */
  private emitCoordinatorStats(): void {
    const stats = this.getStats();
    const subagentStatuses = Array.from(this.subagents.entries()).map(([id, s]) => ({
      subagentId: id,
      taskId: s.currentTask ?? '',
      status: s.status,
      assigned: s.context.parentBridge !== null,
    }));
    this.fleetBus?.emit({
      subagentId: this.coordinatorId,
      ts: Date.now(),
      type: 'coordinator.stats',
      payload: { ...stats, subagentStatuses },
    });
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
   * Wait for one or more tasks to complete and return their results.
   * If a task is already done when called, returns immediately.
   * Resolves to an array in the same order as `taskIds`.
   */
  async awaitTasks(taskIds: string[]): Promise<TaskResult[]> {
    return Promise.all(
      taskIds.map((id) => {
        const cached = this.completedResults.find((r) => r.taskId === id);
        if (cached) return cached;
        // Fallback: poll until the task completes (up to timeoutMs).
        // The coordinator fires 'task.completed' on every result, so
        // we use a promise-based waiter tied to that event.
        return new Promise<TaskResult>((resolve, reject) => {
          const timeout = setTimeout(() => {
            this.off('task.completed', handler);
            reject(new Error(`awaitTasks timed out waiting for task "${id}"`));
          }, this.config.timeoutMs ?? 300_000);
          const handler = ({ result }: { task: TaskSpec; result: TaskResult }) => {
            if (result.taskId === id) {
              clearTimeout(timeout);
              this.off('task.completed', handler);
              resolve(result);
            }
          };
          this.on('task.completed', handler);
        });
      }),
    );
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
      const dispatchable = this.takeNextDispatchableTask();
      if (!dispatchable) {
        // No idle worker right now. If every spawned subagent is
        // stopped or mid-termination, the pending queue is dead —
        // a pending task can never start, so synthetic-complete it
        // as `aborted_by_parent`. Without this, an `assign()` after
        // `stop()` would hang forever waiting for `task.completed`.
        // We DO NOT drain when subagents are busy (status='running'):
        // those will free up and accept the work normally.
        if (this.pendingTasks.length > 0 && !this.hasLiveSubagent()) {
          this.drainPendingAsAborted(
            'No live subagent available — all stopped or mid-termination',
          );
        }
        return;
      }
      const { subagentId, task } = dispatchable;
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
    const max = this.config.maxConcurrent ?? 16;
    return this.inFlight < max && this.pendingTasks.length > 0;
  }

  private takeNextDispatchableTask(): { subagentId: string; task: TaskSpec } | null {
    for (let i = 0; i < this.pendingTasks.length; i++) {
      const task = this.pendingTasks[i]!;
      const subagentId = task.subagentId
        ? this.isIdleSubagent(task.subagentId)
          ? task.subagentId
          : null
        : this.findIdleSubagent();
      if (!subagentId) continue;
      this.pendingTasks.splice(i, 1);
      return { subagentId, task };
    }
    return null;
  }

  private findIdleSubagent(): string | null {
    for (const [id, s] of this.subagents) {
      // Skip subagents that are mid-termination — `stop()` set the
      // `terminating` flag and aborted the controller, but the
      // status mutation happens synchronously after; checking both
      // is belt-and-suspenders against any race where status is
      // transiently still 'idle' while termination is in flight.
      if (s.status === 'idle' && !this.terminating.has(id)) return id;
    }
    return null;
  }

  private isIdleSubagent(id: string): boolean {
    const subagent = this.subagents.get(id);
    return !!subagent && subagent.status === 'idle' && !this.terminating.has(id);
  }

  /**
   * Returns true iff at least one spawned subagent could still
   * process a task. A "live" subagent is one that is not stopped
   * AND not mid-termination — `running` workers count because they
   * will eventually finish and become idle.
   *
   * When no subagent has ever been spawned, returns `true` so a
   * pre-spawn `assign()` simply queues (legacy behaviour). The
   * dead-end detection only fires after `stop()` has retired every
   * spawned worker.
   *
   * Used by `tryDispatchNext` to detect a dead-end pending queue.
   */
  private hasLiveSubagent(): boolean {
    if (this.subagents.size === 0) return true;
    for (const [id, s] of this.subagents) {
      if (s.status !== 'stopped' && !this.terminating.has(id)) return true;
    }
    return false;
  }

  /**
   * Drain every pending task with a synthetic `aborted_by_parent`
   * completion event. Same shape as the `stopAll()` drain — we go
   * around `recordCompletion` because pending tasks were never
   * counted in `inFlight` and routing them through would trip the
   * underflow guard on every task after the first.
   */
  private drainPendingAsAborted(message: string): void {
    const dropped = this.pendingTasks.splice(0, this.pendingTasks.length);
    for (const t of dropped) {
      const synthetic: TaskResult = {
        subagentId: t.subagentId ?? 'unassigned',
        taskId: t.id,
        status: 'stopped',
        error: {
          kind: 'aborted_by_parent',
          message,
          retryable: false,
        },
        iterations: 0,
        toolCalls: 0,
        durationMs: 0,
      };
      this.completedResults.push(synthetic);
      this.emit('task.completed', { task: t, result: synthetic });
    }
  }

  private async runDispatched(subagentId: string, task: TaskSpec): Promise<void> {
    const subagent = this.subagents.get(subagentId);
    if (!subagent) return;
    // Final race guard: if `stop(subagentId)` ran between dispatch
    // and us arriving here, refuse to start the task and surface it
    // as `aborted_by_parent` so any caller awaiting the task id
    // unblocks. Without this, the task would be marked 'running',
    // collide with the just-completed 'stopped' state, and leak
    // inFlight by 1 because no recordCompletion path covers it.
    if (this.terminating.has(subagentId) || subagent.status === 'stopped') {
      this.recordCompletion({
        subagentId,
        taskId: task.id,
        status: 'stopped',
        error: {
          kind: 'aborted_by_parent',
          message: 'Subagent was terminated before task could start',
          retryable: false,
        },
        iterations: 0,
        toolCalls: 0,
        durationMs: 0,
      });
      return;
    }

    subagent.status = 'running';
    subagent.currentTask = task.id;
    task.subagentId = subagentId;
    subagent.context.tasks.push(task);

    this.fleetBus?.emit({
      subagentId,
      taskId: task.id,
      ts: Date.now(),
      type: 'subagent.running',
      payload: { subagentId, taskId: task.id },
    });

    this.emit('task.assigned', { task, subagentId });
    this.emitCoordinatorStats();

    // Budget combines coordinator defaults with per-subagent and per-task overrides.
    // Precedence: task > subagent (raw, no roster fills) > coordinator default > roster default.
    // We intentionally call applyRosterBudget LATE — only as a final fallback after
    // the coordinator's defaultBudget has had a chance to apply. This prevents
    // GENERIC_SUBAGENT_BUDGET (5000 iter) from shadowing the coordinator's explicit default.
    const rawMaxIterations = subagent.config.maxIterations;
    const rawMaxToolCalls = subagent.config.maxToolCalls;
    const rawMaxTokens = subagent.config.maxTokens;
    const rawMaxCostUsd = subagent.config.maxCostUsd;
    const rawTimeoutMs = subagent.config.timeoutMs;
    const configWithRosterDefaults = applyRosterBudget(subagent.config);
    const budget = new SubagentBudget({
      maxIterations:
        rawMaxIterations ?? this.config.defaultBudget?.maxIterations ?? configWithRosterDefaults.maxIterations,
      maxToolCalls:
        rawMaxToolCalls ??
        this.config.defaultBudget?.maxToolCalls ??
        configWithRosterDefaults.maxToolCalls,
      maxTokens:
        rawMaxTokens ?? this.config.defaultBudget?.maxTokens ?? configWithRosterDefaults.maxTokens,
      maxCostUsd:
        rawMaxCostUsd ?? this.config.defaultBudget?.maxCostUsd ?? configWithRosterDefaults.maxCostUsd,
      timeoutMs:
        rawTimeoutMs ?? this.config.defaultBudget?.timeoutMs ?? configWithRosterDefaults.timeoutMs,
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
    const initialTimeoutMs = budget.limits.timeoutMs;
    if (initialTimeoutMs === undefined) return runner(task, ctx);

    // Re-armable watchdog. When the wall-clock fires, give the budget a
    // chance to negotiate an extension (via the same onThreshold path the
    // other limit kinds use). The Director's auto-extend listener handles
    // `kind: 'timeout'` and patches `budget.limits.timeoutMs`; we observe
    // that patch on the next tick and re-arm the timer for the remaining
    // window. If onThreshold is unset or negotiation returns 'stop',
    // reject as before with `elapsed` (not `Date.now()`) so the error
    // message reads sensibly.
    const start = Date.now();
    let timer: ReturnType<typeof setTimeout> | null = null;

    const timeoutPromise = new Promise<never>((_, reject) => {
      const armFor = (ms: number) => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(async () => {
          const elapsed = Date.now() - start;
          const limit = budget.limits.timeoutMs ?? initialTimeoutMs;
          // Without an onThreshold handler the original behaviour stands:
          // abort the signal and hard-reject. This preserves the contract
          // for direct SubagentBudget consumers that don't wire negotiation.
          if (!budget.onThreshold) {
            this.subagents.get(ctx.subagentId)?.abortController.abort();
            reject(new BudgetExceededError('timeout', limit, elapsed));
            return;
          }
          // With a handler, ask for an extension. The budget's
          // requestDecision returns 'stop' on no response (decision
          // fallback timer inside SubagentBudget), so this never hangs.
          try {
            const result = budget.onThreshold({
              kind: 'timeout',
              used: elapsed,
              limit,
              requestDecision: () =>
                new Promise((resolveDecision) => {
                  budget._events?.emit('budget.threshold_reached', {
                    kind: 'timeout',
                    used: elapsed,
                    limit,
                    timeoutMs: 60_000,
                    extend: (extra) => resolveDecision({ extend: extra }),
                    deny: () => resolveDecision('stop'),
                  });
                }),
            });
            const decision =
              typeof result === 'string' ? result : await result;
            if (decision === 'continue') {
              armFor(Math.max(1_000, limit));
              return;
            }
            if (decision === 'throw' || decision === 'stop') {
              // Timeout denied — re-arm for the same limit so we ask again
              // on the next tick. This makes timeout a pure warning event:
              // the subagent keeps running, the user sees "⚡ timeout —
              // extending" in chat history, and work continues until the
              // subagent naturally finishes or the user stops it. No task
              // is hard-killed solely because its wall-clock ran out.
              armFor(Math.max(1_000, limit));
              return;
            }
            // 'extend' — patch budget and re-arm for the new remainder.
            if (decision.extend.timeoutMs !== undefined) {
              (budget.limits as Record<string, unknown>).timeoutMs =
                decision.extend.timeoutMs;
              const newLimit = decision.extend.timeoutMs;
              const remaining = Math.max(1_000, newLimit - elapsed);
              armFor(remaining);
              return;
            }
            // No timeoutMs in extend — fall through to reject.
            this.subagents.get(ctx.subagentId)?.abortController.abort();
            reject(new BudgetExceededError('timeout', limit, elapsed));
          } catch (err) {
            this.subagents.get(ctx.subagentId)?.abortController.abort();
            reject(
              err instanceof BudgetExceededError
                ? err
                : new BudgetExceededError('timeout', limit, elapsed),
            );
          }
        }, ms);
      };
      armFor(initialTimeoutMs);
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
      // Synchronously reset the worker to idle after either a clean
      // finish or a transient failure. The previous code parked the
      // subagent in 'error' and used a `queueMicrotask` to flip it
      // back to 'idle' — that opened a window where `assign()` +
      // `tryDispatchNext` could race the microtask, leaving the
      // worker stuck in 'running' state while actually idle. By
      // resetting now, no async gap can leak the state machine.
      subagent.status = 'idle';
      void failed; // kept for future telemetry hooks
      subagent.currentTask = undefined;
      // If the run aborted (timeout or explicit stop), the subagent's
      // signal is now permanently aborted — recycling the controller lets
      // the next dispatched task start with a fresh cancellation scope.
      if (subagent.abortController.signal.aborted) {
        subagent.abortController = new AbortController();
      }

      this.fleetBus?.emit({
        subagentId: result.subagentId,
        ts: Date.now(),
        type: 'subagent.idle',
        payload: { subagentId: result.subagentId },
      });
    }
    // Clear the terminating flag now that the worker has a terminal
    // TaskResult on record. Subsequent stop() calls re-add it; new
    // assign() calls can flow normally.
    this.terminating.delete(result.subagentId);

    this.emit('task.completed', {
      task: subagent?.context.tasks.find((t) => t.id === result.taskId) ?? { id: result.taskId },
      result,
    });

    this.fleetBus?.emit({
      subagentId: result.subagentId,
      taskId: result.taskId,
      ts: Date.now(),
      type: 'subagent.completed',
      payload: {
        subagentId: result.subagentId,
        taskId: result.taskId,
        status: result.status,
        iterations: result.iterations,
        toolCalls: result.toolCalls,
        durationMs: result.durationMs,
      },
    });

    this.tryDispatchNext();

    // Emit after tryDispatchNext so the stats reflect the post-dispatch
    // state (either a new running subagent, or idle if the queue is drained).
    this.emitCoordinatorStats();

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

  if (err instanceof ProviderError) {
    const baseMessage = err.describe();
    return providerErrorToSubagentError(err, baseMessage, cause);
  }

  const baseMessage = err instanceof Error ? err.message : String(err);

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
  // The runner throws `Error('tool failed: <name>')` when an executed tool
  // returned `ok:false` and the agent ultimately ended without recovering
  // (or aborted). Surface as `tool_failed` so callers don't conflate a
  // failed tool with a thrown tool — both are useful but mean different
  // things at the LLM layer.
  if (/^tool failed: /i.test(baseMessage)) {
    return { kind: 'tool_failed', message: baseMessage, retryable: false, cause };
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
