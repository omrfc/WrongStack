import { expectDefined } from '../utils/expect-defined.js';
/**
 * SddParallelRun
 *
 * Drives a TaskGraph through ParallelEternalEngine's infrastructure
 * (DefaultMultiAgentCoordinator + AgentSubagentRunner) but powered by
 * SddTaskDecomposer — producing dependency-aware waves instead of
 * goal-driven iterations.
 *
 * One-shot: completes when all tasks are done OR a deadlock is detected.
 * Does NOT loop — each run() call is a discrete execution.
 *
 * Usage:
 * ```
 * const run = new SddParallelRun({ tracker, graph, agent, projectRoot });
 * await run.run({ onWave });
 * // or with progress callback:
 * await run.run({ onProgress: (p) => console.log(renderProgress(p)) });
 * ```
 */

import { randomUUID } from 'node:crypto';
import type { Agent } from '../core/agent.js';
import type { SubagentConfig, TaskResult, TaskSpec } from '../types/multi-agent.js';
import type { AgentFactory } from '../coordination/agent-subagent-runner.js';
import { makeAgentSubagentRunner } from '../coordination/agent-subagent-runner.js';
import { DefaultMultiAgentCoordinator } from '../coordination/multi-agent-coordinator.js';
import type { MultiAgentConfig } from '../types/multi-agent.js';
import type { TaskGraph, TaskProgress } from '../types/task-graph.js';
import type { TaskTracker } from './task-tracker.js';
import { SddError, ERROR_CODES } from '../types/errors.js';
import { SddTaskDecomposer, type TaskBatch } from './sdd-task-decomposer.js';
import { computeTaskProgress } from '../types/task-graph.js';
export interface SddParallelRunOptions {
  /** Pre-constructed TaskTracker (must already hold the graph's initial state). */
  tracker: TaskTracker;
  /** The TaskGraph produced by TaskGenerator from an approved spec. */
  graph: TaskGraph;
  /** The main agent — used as the subagent factory. */
  agent: Agent;
  /** Project root (used for coordinator id). */
  projectRoot: string;
  /** Override default parallel slots (1–16). Default: 4. */
  parallelSlots?: number | undefined;
  /** Per-task timeout in ms. Default: 300_000 (5 min). */
  taskTimeoutMs?: number | undefined;
  /** Maximum retry attempts for failed tasks. Default: 2. */
  maxRetries?: number | undefined;
  /** Override the default agent factory. */
  subagentFactory?: AgentFactory | undefined;
  /** Called after each wave completes. */
  onWave?: ((wave: WaveResult) => void) | undefined;
  /** Called with progress stats every ~2s during execution. */
  onProgress?: ((progress: SddProgress) => void) | undefined;
}

export interface SddProgress {
  wave: number;
  total: number;
  completed: number;
  inProgress: number;
  failed: number;
  blocked: number;
  pending: number;
  percent: number;
  deadlocked: boolean;
}

export interface WaveResult {
  wave: number;
  batch: TaskBatch;
  results: TaskResult[];
  successCount: number;
  failCount: number;
  durationMs: number;
  stopRequested: boolean;
}

export interface RunResult {
  totalWaves: number;
  totalCompleted: number;
  totalFailed: number;
  totalDurationMs: number;
  deadlocked: boolean;
  stopRequested: boolean;
  finalProgress: TaskProgress;
}

export class SddParallelRun {
  private readonly slots: number;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private decomposer: SddTaskDecomposer;
  private coordinator: DefaultMultiAgentCoordinator | null = null;
  private stopRequested = false;
  private retryMap = new Map<string, number>();

  constructor(private readonly opts: SddParallelRunOptions) {
    this.slots = Math.min(16, Math.max(1, opts.parallelSlots ?? 4));
    this.timeoutMs = opts.taskTimeoutMs ?? 300_000;
    this.maxRetries = Math.max(0, opts.maxRetries ?? 2);
    this.decomposer = new SddTaskDecomposer(opts.tracker, opts.graph, { parallelSlots: this.slots });
  }

  // -------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------

  /** Trigger stop — causes run() to abort after the current wave. */
  stop(): void {
    this.stopRequested = true;
    this.coordinator?.stopAll();
  }

  /** Execute all waves until completion or deadlock. Returns final summary. */
  async run(): Promise<RunResult> {
    this.stopRequested = false;
    this.retryMap.clear();
    const startTime = Date.now();
    let totalCompleted = 0;
    let totalFailed = 0;
    let totalWaves = 0;

    this.buildCoordinator();

    while (!this.stopRequested && !this.decomposer.isDone()) {
      const batch = this.decomposer.nextBatch();

      if (batch.deadlocked) {
        // No runnable tasks and some are blocked — deadlock
        break;
      }

      if (batch.tasks.length === 0 && batch.allDone) {
        // Graph completed
        break;
      }

      const waveResult = await this.executeWave(batch);
      totalWaves++;
      totalCompleted += waveResult.successCount;
      totalFailed += waveResult.failCount;

      this.decomposer.acknowledgeBatch(batch.tasks.map(t => t.id));
      this.opts.onWave?.(waveResult);

      // Emit progress
      const progress = this.buildProgress();
      this.opts.onProgress?.(progress);

      if (this.stopRequested) break;
    }

    const finalProgress = this.opts.tracker.getProgress();

    return {
      totalWaves,
      totalCompleted,
      totalFailed,
      totalDurationMs: Date.now() - startTime,
      deadlocked: !this.decomposer.isDone() && this.stopRequested === false,
      stopRequested: this.stopRequested,
      finalProgress,
    };
  }

  // -------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------

  private buildCoordinator(): void {
    const config: MultiAgentConfig = {
      coordinatorId: `sdd-parallel-${randomUUID().slice(0, 8)}`,
      maxConcurrent: this.slots,
      doneCondition: { type: 'all_tasks_done' },
    };
    this.coordinator = new DefaultMultiAgentCoordinator(config);
    const runner = makeAgentSubagentRunner({ factory: this.opts.subagentFactory ?? this.defaultFactory() });
    this.coordinator.setRunner?.(runner);
  }

  private defaultFactory(): AgentFactory {
    return async (_config: SubagentConfig) => ({
      agent: this.opts.agent,
      events: this.opts.agent.events,
    });
  }

  async executeWave(batch: TaskBatch): Promise<WaveResult> {
    const wave = batch.wave;
    const tasks = batch.tasks;
    const waveStart = Date.now();

    // Mark all tasks as in_progress
    for (const task of tasks) {
      this.opts.tracker.updateNodeStatus(task.id, 'in_progress');
    }

    const progress = computeTaskProgress(this.opts.graph);

    const taskIds: string[] = tasks.map(() => randomUUID());
    const subagentIds: string[] = tasks.map((_, i) => `sdd-wave${wave}-${i}`);

    // Build directive preamble
    const directivePreamble = [
      '═══ SDD PARALLEL EXECUTION ═══',
      '',
      `Wave ${wave + 1} of ~${Math.ceil(progress.total / this.slots)}`,
      `Graph: ${this.opts.graph.title}`,
      `Parallel slots: ${tasks.length}`,
      '',
      '── EXECUTION PROTOCOL ──',
      '• Execute the assigned SDD task end-to-end using multiple tool calls.',
      '• Mark the task [done] in the tracker when complete.',
      '• Do not ask before routine in-project tool use; if a permission gate appears, wait for that flow.',
      '• Keep output concise — summarize changes, do not transcribe files.',
    ].join('\n');

    // Phase 1: spawn all subagents
    if (!this.coordinator) throw new SddError({
      message: 'SDD parallel runner requires a coordinator',
      code: ERROR_CODES.SDD_INVALID_STATE,
    });
    const coordinator = this.coordinator;
    const spawns = subagentIds.map((subagentId) =>
      coordinator.spawn({
        id: subagentId,
        name: subagentId,
        role: 'executor',
        timeoutMs: this.timeoutMs,
      }),
    );
    const spawnResults = await Promise.all(spawns);
    // All spawns succeeded or we bail entirely — no partial waves
    if (!spawnResults.every((r) => Boolean(r.subagentId))) {
      throw new SddError({
        message: 'One or more subagent spawns failed',
        code: ERROR_CODES.SDD_INVALID_STATE,
      });
    }

    // Phase 2: assign task specs to spawned subagents
    const assignPromises = tasks.map((task, i) => {
      const spec: TaskSpec = {
          id: taskIds[i] ?? task.id,
        description: [
          directivePreamble,
          '',
          `── TASK ${i + 1}/${tasks.length} ──`,
          `[${task.priority.toUpperCase()}] ${task.title}`,
          '',
          task.description,
        ].join('\n'),
          subagentId: subagentIds[i] ?? spawnResults[i]?.subagentId ?? task.id,
        timeoutMs: this.timeoutMs,
      };
      return this.coordinator?.assign(spec);
    });
    await Promise.all(assignPromises);

    // Phase 3: wait for all task results
    let results: TaskResult[];
    try {
      results = await coordinator.awaitTasks(taskIds);
    } catch (err) {
      // await threw — synthesize error results for all pending tasks
      results = taskIds.map((id) => ({
        subagentId: '',
        taskId: id,
        status: 'failed' as const,
        error: { kind: 'unknown' as const, message: String(err), retryable: false },
        iterations: 0,
        toolCalls: 0,
        durationMs: 0,
      }));
    }

    const successCount = results.filter((r) => r.status === 'success').length;
    const failCount = results.length - successCount;

    // Phase 4: update tracker status for each result, with retry support
    for (let i = 0; i < results.length; i++) {
      const result = expectDefined(results[i]);
      const taskId = expectDefined(taskIds[i]);
      if (result.status === 'success') {
        this.opts.tracker.updateNodeStatus(taskId, 'completed');
        this.retryMap.delete(taskId);
      } else {
        const errMsg = result.error?.kind
          ? `${result.error.kind}: ${result.error.message}`
          : result.error?.message ?? 'unknown error';
        // Retry: re-mark as pending if retries remain
        const currentRetries = this.retryMap.get(taskId) ?? 0;
        if (currentRetries < this.maxRetries) {
          this.retryMap.set(taskId, currentRetries + 1);
          this.opts.tracker.updateNodeStatus(
            taskId,
            'pending',
            `Retry ${currentRetries + 1}/${this.maxRetries}: ${errMsg}`,
          );
        } else {
          this.opts.tracker.updateNodeStatus(taskId, 'failed', errMsg);
        }
      }
    }

    return {
      wave,
      batch,
      results,
      successCount,
      failCount,
      durationMs: Date.now() - waveStart,
      stopRequested: this.stopRequested,
    };
  }

  private buildProgress(): SddProgress {
    const gp = this.opts.tracker.getProgress();
    const isDeadlocked = !this.decomposer.isDone() &&
      this.decomposer.nextBatch().deadlocked;
    return {
      wave: this.decomposer.getWaveCount(),
      total: gp.total,
      completed: gp.completed,
      inProgress: gp.inProgress,
      failed: gp.failed,
      blocked: gp.blocked,
      pending: gp.pending,
      percent: gp.percentComplete,
      deadlocked: isDeadlocked,
    };
  }
}
