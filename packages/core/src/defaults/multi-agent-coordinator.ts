import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type {
  MultiAgentCoordinator,
  CoordinatorStatus,
  SubagentConfig,
  SpawnResult,
  TaskSpec,
  TaskResult,
  MultiAgentConfig,
  SubagentContext,
  SubagentRunner,
  SubagentRunContext,
} from '../types/multi-agent.js';
import type { AgentBridge, BridgeMessage } from '../types/agent-bridge.js';
import { SubagentBudget, BudgetExceededError } from './subagent-budget.js';

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

export class DefaultMultiAgentCoordinator
  extends EventEmitter
  implements MultiAgentCoordinator
{
  readonly coordinatorId: string;
  readonly config: MultiAgentConfig;
  private readonly runner?: SubagentRunner;

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
    for (const id of this.subagents.keys()) {
      await this.stop(id);
    }
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
          error: err instanceof Error ? err.message : String(err),
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
      maxToolCalls: task.maxToolCalls ?? subagent.config.maxToolCalls ?? this.config.defaultBudget?.maxToolCalls,
      maxTokens: subagent.config.maxTokens ?? this.config.defaultBudget?.maxTokens,
      maxCostUsd: subagent.config.maxCostUsd ?? this.config.defaultBudget?.maxCostUsd,
      timeoutMs: task.timeoutMs ?? subagent.config.timeoutMs ?? this.config.defaultBudget?.timeoutMs,
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
      result = {
        subagentId,
        taskId: task.id,
        status,
        error: err instanceof Error ? err.message : String(err),
        iterations: budget.usage().iterations,
        toolCalls: budget.usage().toolCalls,
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
    if (this.inFlight === 0) {
      // Suppress the warning on the no-runner pattern: runDispatched
      // intentionally never bumps inFlight when no runner is wired, so
      // hitting zero here on completion is expected for that callsite.
      // Only treat it as a caller bug when a runner IS wired (true
      // double-completion).
      if (this.runner) {
        this.emit('warning', {
          type: 'inFlight_underflow',
          taskId: result.taskId,
          subagentId: result.subagentId,
        });
      }
    } else {
      this.inFlight--;
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
