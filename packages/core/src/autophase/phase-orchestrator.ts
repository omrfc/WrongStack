import type { EventBus } from '../kernel/events.js';
import { DefaultTaskStore } from '../sdd/task-generator.js';
import { TaskTracker } from '../sdd/task-tracker.js';
import type { TaskNode } from '../types/task-graph.js';
import type { WorktreeHandle, WorktreeManager } from '../worktree/worktree-manager.js';
import type {
  AutoPhaseOptions,
  PhaseEventMap,
  PhaseEventName,
  PhaseExecutionContext,
  PhaseGraph,
  PhaseNode,
  PhaseProgress,
  PhaseStatus,
} from './types.js';

export interface PhaseOrchestratorOptions extends AutoPhaseOptions {
  graph: PhaseGraph;
  ctx: PhaseExecutionContext;
}

/**
 * PhaseOrchestrator — Fazları dependency-aware, otonom olarak çalıştıran motor.
 *
 * Özellikler:
 * - Bir faz tamamlandıkça sonrakini otomatik başlatır (autonomous mode)
 * - Parallel faz desteği (parallelizable=true)
 * - Agent atama / serbest bırakma
 * - Event bus entegrasyonu
 * - Pause / resume desteği
 */
export class PhaseOrchestrator {
  private graph: PhaseGraph;
  private ctx: PhaseExecutionContext;
  private opts: Required<Omit<AutoPhaseOptions, 'worktrees'>>;
  private events: EventBus;
  private stopped = false;
  private paused = false;
  private runningPhases = new Set<string>();
  private tickInterval: ReturnType<typeof setInterval> | null = null;
  private trackerCache = new Map<string, TaskTracker>();
  private taskRetryCounts = new Map<string, number>();

  // ── Git-worktree isolation (optional) ──────────────────────────────────────
  private readonly worktrees?: WorktreeManager;
  /** Per-phase worktree handles, keyed by phase id. */
  private readonly phaseWorktrees = new Map<string, WorktreeHandle>();
  /** Serializes all merges back to the base branch (one at a time). */
  private mergeQueue: Promise<void> = Promise.resolve();
  /** Per-phase merge promise, so a phase merges only after its deps do. */
  private readonly phaseMergePromise = new Map<string, Promise<void>>();

  constructor(opts: PhaseOrchestratorOptions) {
    this.graph = opts.graph;
    this.ctx = opts.ctx;
    this.events = opts.events ?? this.createNoopEventBus();
    this.worktrees = opts.worktrees;
    this.opts = {
      maxConcurrentPhases: opts.maxConcurrentPhases ?? 1,
      maxConcurrentTasks: opts.maxConcurrentTasks ?? 2,
      maxRetries: opts.maxRetries ?? 2,
      maxVerifyAttempts: opts.maxVerifyAttempts ?? 2,
      autonomous: opts.autonomous ?? true,
      phaseDelayMs: opts.phaseDelayMs ?? 0,
      stopOnFailure: opts.stopOnFailure ?? true,
      events: this.events,
    };
  }

  // ─── Lifecycle ────────────────────────────────────────────────────────────

  /**
   * Tüm faz akışını başlat.
   * Autonomous mode'da: kök faz(lar)ı başlatır, bitince sonrakini otomatik başlatır.
   */
  async start(): Promise<void> {
    this.stopped = false;
    this.paused = false;
    this.graph.startedAt = Date.now();
    this.graph.updatedAt = Date.now();

    // Tüm fazları sırayla çalıştır (autonomous=false'da da sonraki fazlar başlar)
    let readyPhases = this.getReadyPhases();
    while (readyPhases.length > 0 && !this.stopped) {
      await this.waitWhilePaused();
      if (this.stopped) break;

      const batch = readyPhases.slice(0, this.opts.maxConcurrentPhases);
      await Promise.all(batch.map((p) => this.startPhase(p)));

      // Faz gecikmesi uygula
      if (this.opts.phaseDelayMs > 0) {
        await this.delay(this.opts.phaseDelayMs);
      }

      await this.waitWhilePaused();
      if (this.stopped) break;

      // Yeni ready fazları kontrol et (bir faz tamamlanınca sonrakiler ready olur)
      readyPhases = this.getReadyPhases().filter(
        (p) => !this.runningPhases.has(p.id) && p.status !== 'completed' && p.status !== 'failed',
      );
    }

    // Tüm worktree merge'lerinin (arka planda, sıralı) bitmesini bekle ki
    // graph "completed" ilan edilmeden önce değişiklikler ana branch'e inmiş olsun.
    await this.drainMerges();

    // Autonomous tick loop (gerçek zamanlı monitoring için)
    if (this.opts.autonomous) {
      this.tickInterval = setInterval(() => this.tick(), 1000);
    }
  }

  /** Bekleyen tüm faz merge'lerini (dep-sıralı + global seri) bekle. */
  private async drainMerges(): Promise<void> {
    await Promise.allSettled([...this.phaseMergePromise.values()]);
    await this.mergeQueue.catch(() => {});
  }

  /** Duraklat — aktif fazlar çalışmaya devam eder ama yeni faz başlamaz */
  pause(): void {
    this.paused = true;
  }

  /** Devam et — yeni fazlar başlayabilir */
  resume(): void {
    this.paused = false;
    this.tick().catch((err) => {
      console.error(
        '[phase-orchestrator] tick failed:',
        err instanceof Error ? err.message : String(err),
      );
    });
  }

  /** Tamamen durdur — aktif fazlar da durdurulur */
  stop(): void {
    this.stopped = true;
    if (this.tickInterval) {
      clearInterval(this.tickInterval);
      this.tickInterval = null;
    }
    for (const phaseId of this.runningPhases) {
      const phase = this.graph.phases.get(phaseId);
      if (phase) {
        this.updatePhaseStatus(phase, 'paused');
      }
    }
    // Preserve any live worktrees for inspection rather than discarding work.
    if (this.worktrees) {
      for (const handle of this.worktrees.list()) {
        void this.worktrees.release(handle, { keep: true }).catch(() => {});
      }
    }
  }

  // ─── Tick Loop (Autonomous) ───────────────────────────────────────────────

  private async tick(): Promise<void> {
    if (this.stopped || this.paused) return;

    const active = this.getActivePhases();
    const queued = this.getReadyPhases();

    this.emit('autonomous.tick', {
      activePhases: active.map((p) => p.id),
      queuedPhases: queued.map((p) => p.id),
    });

    this.ctx.onTick?.({ activePhases: active, readyPhases: queued });

    // Yeni faz başlatma slotu var mı?
    const availableSlots = this.opts.maxConcurrentPhases - active.length;
    if (availableSlots > 0 && queued.length > 0) {
      for (const phase of queued.slice(0, availableSlots)) {
        if (phase.status === 'pending') {
          await this.startPhase(phase);
        }
      }
    }

    // Tüm fazlar tamamlandı mı?
    if (this.isComplete()) {
      this.onGraphComplete();
      return;
    }

    // Bir faz failed ve stopOnFailure?
    if (this.opts.stopOnFailure && this.graph.failedPhaseIds.length > 0) {
      const failedPhase = this.graph.phases.get(this.graph.failedPhaseIds[0]!);
      if (failedPhase) {
        this.onGraphFailed(failedPhase);
      }
      return;
    }
  }

  // ─── Phase Execution ──────────────────────────────────────────────────────

  private async startPhase(phase: PhaseNode): Promise<void> {
    if (phase.status !== 'pending' && phase.status !== 'ready') return;

    this.updatePhaseStatus(phase, 'running');
    phase.startedAt = Date.now();
    this.runningPhases.add(phase.id);
    this.graph.activePhaseIds.push(phase.id);

    // Allocate an isolated git worktree for this phase, if a manager is wired.
    // Allocation failure degrades gracefully to the shared working tree.
    if (this.worktrees && !this.phaseWorktrees.has(phase.id)) {
      try {
        const handle = await this.worktrees.allocate(phase.id, {
          slugHint: phase.name,
          ownerLabel: phase.name,
        });
        if (handle.status === 'active') this.phaseWorktrees.set(phase.id, handle);
      } catch {
        // Manager already emitted worktree.failed; run on the shared tree.
      }
    }

    this.emit('phase.started', { phaseId: phase.id, name: phase.name });

    try {
      await this.executePhaseTasks(phase);

      const failedTasks = this.getFailedTaskCount(phase);
      const completedTasks = this.getCompletedTaskCount(phase);

      this.emit('phase.allTasksDone', {
        phaseId: phase.id,
        completed: completedTasks,
        failed: failedTasks,
      });

      if (failedTasks > 0 && this.opts.stopOnFailure) {
        await this.failPhaseAfterTasks(phase, `${failedTasks} task(s) failed`);
        return;
      }

      // Verification gate: all tasks succeeded, but the produced code must still
      // pass (typecheck/test/…) before we mark the phase done and merge it back.
      // Skipped entirely when no verifyPhase callback is wired (back-compat).
      const verdict = await this.runVerifyGate(phase);
      if (!verdict.ok) {
        await this.failPhaseAfterTasks(
          phase,
          `verification failed${verdict.output ? `: ${this.truncate(verdict.output)}` : ''}`,
        );
        return;
      }

      this.updatePhaseStatus(phase, 'completed');
      phase.completedAt = Date.now();
      phase.actualDurationMs = Date.now() - (phase.startedAt ?? Date.now());
      this.runningPhases.delete(phase.id);
      this.graph.activePhaseIds = this.graph.activePhaseIds.filter((id) => id !== phase.id);
      this.graph.completedPhaseIds.push(phase.id);
      this.emit('phase.completed', {
        phaseId: phase.id,
        name: phase.name,
        durationMs: phase.actualDurationMs,
      });
      this.ctx.onPhaseComplete?.(phase);
      // Commit the phase's work in its worktree and queue the merge back into
      // the base branch (dependency-ordered + globally serialized).
      await this.commitAndEnqueueMerge(phase);
    } catch (error) {
      this.updatePhaseStatus(phase, 'failed');
      phase.completedAt = Date.now();
      phase.actualDurationMs = Date.now() - (phase.startedAt ?? Date.now());
      this.runningPhases.delete(phase.id);
      this.graph.activePhaseIds = this.graph.activePhaseIds.filter((id) => id !== phase.id);
      this.graph.failedPhaseIds.push(phase.id);
      this.emit('phase.failed', {
        phaseId: phase.id,
        name: phase.name,
        error: error instanceof Error ? error.message : String(error),
      });
      this.ctx.onPhaseFail?.(phase, error instanceof Error ? error : new Error(String(error)));
      await this.keepWorktreeForReview(phase);
    }
  }

  // ─── Verification gate ──────────────────────────────────────────────────────

  /**
   * Run the verification gate for a phase whose tasks all succeeded. Verifies in
   * the phase's worktree; on failure, runs the repair pass and re-verifies, up to
   * `maxVerifyAttempts` repairs. Returns the final verdict. When no `verifyPhase`
   * callback is wired the gate is a no-op and always passes.
   */
  private async runVerifyGate(phase: PhaseNode): Promise<{ ok: boolean; output?: string }> {
    if (!this.ctx.verifyPhase) return { ok: true };
    const env = this.worktreeEnv(phase);

    for (let attempt = 0; attempt <= this.opts.maxVerifyAttempts; attempt++) {
      if (this.stopped) return { ok: false, output: 'stopped before verification completed' };

      this.emit('phase.verifying', { phaseId: phase.id, name: phase.name, attempt });
      let verdict: { ok: boolean; output?: string };
      try {
        verdict = await this.ctx.verifyPhase(phase, env);
      } catch (err) {
        verdict = { ok: false, output: err instanceof Error ? err.message : String(err) };
      }
      if (verdict.ok) return { ok: true };

      this.emit('phase.verifyFailed', {
        phaseId: phase.id,
        name: phase.name,
        attempt,
        error: verdict.output,
      });

      // Out of attempts, no repair pass available, or aborted → give up.
      if (attempt >= this.opts.maxVerifyAttempts || !this.ctx.repairPhase || this.stopped) {
        return { ok: false, output: verdict.output };
      }

      this.emit('phase.repairing', { phaseId: phase.id, name: phase.name, attempt: attempt + 1 });
      try {
        await this.ctx.repairPhase(
          phase,
          verdict.output ?? 'verification failed',
          attempt + 1,
          env,
        );
      } catch {
        // A failed repair is non-fatal: the next verifyPhase run will observe the
        // still-broken tree and the loop will exit with ok:false.
      }
    }
    return { ok: false };
  }

  /** Worktree env (cwd/branch) for a phase, or undefined if it runs on the shared tree. */
  private worktreeEnv(phase: PhaseNode): { cwd?: string; branch?: string } | undefined {
    const handle = this.phaseWorktrees.get(phase.id);
    return handle ? { cwd: handle.dir, branch: handle.branch } : undefined;
  }

  /** Shared failure bookkeeping for a phase whose tasks ran but the phase failed. */
  private async failPhaseAfterTasks(phase: PhaseNode, error: string): Promise<void> {
    this.updatePhaseStatus(phase, 'failed');
    phase.completedAt = Date.now();
    phase.actualDurationMs = Date.now() - (phase.startedAt ?? Date.now());
    this.runningPhases.delete(phase.id);
    this.graph.activePhaseIds = this.graph.activePhaseIds.filter((id) => id !== phase.id);
    this.emit('phase.failed', { phaseId: phase.id, name: phase.name, error });
    this.ctx.onPhaseFail?.(phase, new Error(error));
    await this.keepWorktreeForReview(phase);
  }

  /** Trim long verifier output so it fits cleanly in an event/error message. */
  private truncate(text: string, max = 500): string {
    const t = text.trim();
    return t.length <= max ? t : `${t.slice(0, max)}… (+${t.length - max} chars)`;
  }

  // ─── Worktree integration ───────────────────────────────────────────────────

  /**
   * Commit the phase's worktree changes, then enqueue the merge back into the
   * base branch. Merges run dependency-ordered (a phase merges only after its
   * `dependsOn` phases) and globally serialized (one at a time) to avoid
   * concurrent writes to the base tree.
   */
  private async commitAndEnqueueMerge(phase: PhaseNode): Promise<void> {
    const handle = this.phaseWorktrees.get(phase.id);
    if (!this.worktrees || !handle) return;

    try {
      await this.worktrees.commitAll(handle, `autophase(${phase.name}): ${phase.id}`);
    } catch {
      // commit failure is non-fatal; the merge step will report a clean tree.
    }

    const depPromises = phase.dependsOn
      .map((d) => this.phaseMergePromise.get(d))
      .filter((p): p is Promise<void> => Boolean(p));

    const merged = (async () => {
      await Promise.allSettled(depPromises); // dependency-ordered
      // Chain onto the global queue so only one merge touches base at a time.
      this.mergeQueue = this.mergeQueue.then(() => this.mergeOne(phase, handle));
      await this.mergeQueue;
    })();
    this.phaseMergePromise.set(phase.id, merged);
  }

  /**
   * Squash-merge one phase. When a `resolveConflict` callback is wired, a merge
   * conflict is handed to it (a resolver subagent) before giving up; only if
   * that fails does the worktree fall to needs-review and the run continues.
   */
  private async mergeOne(phase: PhaseNode, handle: WorktreeHandle): Promise<void> {
    if (!this.worktrees) return;
    try {
      const resolve = this.ctx.resolveConflict
        ? async (info: { conflictFiles: string[]; cwd: string }) => {
            const shouldResolve = await this.shouldAttemptConflictResolution(phase, info);
            if (!shouldResolve) return false;
            this.emit('phase.conflictResolving', {
              phaseId: phase.id,
              name: phase.name,
              files: info.conflictFiles,
            });
            return this.ctx.resolveConflict!(phase, info);
          }
        : undefined;
      const result = await this.worktrees.merge(handle, { squash: true, resolve });
      if (result.resolved) {
        this.emit('phase.conflictResolved', { phaseId: phase.id, name: phase.name });
      }
      this.setIntegrationMetadata(phase, result.ok ? 'merged' : 'needs_review', {
        branch: handle.branch,
        worktreeDir: handle.dir,
        conflictFiles: result.conflictFiles,
      });
      // merge() already emitted worktree.merged / worktree.conflict and set status.
      // Clean (or resolved) merge → remove the worktree; conflict → release(keep).
      await this.worktrees.release(handle, { keep: !result.ok });
    } catch (err) {
      this.setIntegrationMetadata(phase, 'merge_failed', {
        branch: handle.branch,
        worktreeDir: handle.dir,
        error: err instanceof Error ? err.message : String(err),
      });
      this.emit('phase.failed', {
        phaseId: phase.id,
        name: phase.name,
        error: `worktree merge failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  private async shouldAttemptConflictResolution(
    phase: PhaseNode,
    info: { conflictFiles: string[]; cwd: string },
  ): Promise<boolean> {
    if (!this.ctx.brain) return true;

    const decision = await this.ctx.brain.decide({
      id: `autophase-conflict-${phase.id}`,
      source: 'autophase',
      question: `Should AutoPhase try to resolve merge conflicts for phase "${phase.name}" automatically?`,
      context: [
        `Phase id: ${phase.id}`,
        `Conflicted files: ${info.conflictFiles.join(', ') || '(unknown)'}`,
        `Base working tree: ${info.cwd}`,
      ].join('\n'),
      risk: 'high',
      fallback: 'ask_human',
      options: [
        {
          id: 'resolve',
          label: 'Try the configured conflict resolver',
          consequence: 'A resolver agent may edit conflicted files in the base working tree.',
          risk: 'medium',
        },
        {
          id: 'review',
          label: 'Keep the worktree for human review',
          consequence: 'No automatic conflict resolution is attempted.',
          risk: 'low',
          recommended: true,
        },
      ],
    });

    phase.metadata = {
      ...phase.metadata,
      brainConflictDecision: decision.type,
      brainConflictDecisionAt: Date.now(),
    };

    if (decision.type !== 'answer') return false;
    return decision.optionId === 'resolve' || /\bresolve\b/i.test(decision.text);
  }

  private setIntegrationMetadata(
    phase: PhaseNode,
    status: 'merged' | 'needs_review' | 'merge_failed' | 'not_merged_failed_phase',
    details: {
      branch?: string;
      worktreeDir?: string;
      conflictFiles?: string[];
      error?: string;
    } = {},
  ): void {
    phase.metadata = {
      ...phase.metadata,
      integrationStatus: status,
      integrationBranch: details.branch,
      integrationWorktreeDir: details.worktreeDir,
      integrationConflictFiles: details.conflictFiles,
      integrationError: details.error,
      integrationUpdatedAt: Date.now(),
    };
    phase.updatedAt = Date.now();
    this.graph.updatedAt = Date.now();
  }

  /** A failed phase keeps its worktree on disk for inspection (no merge). */
  private async keepWorktreeForReview(phase: PhaseNode): Promise<void> {
    const handle = this.phaseWorktrees.get(phase.id);
    if (!this.worktrees || !handle) return;
    try {
      await this.worktrees.commitAll(handle, `autophase(${phase.name}) [failed]: ${phase.id}`);
    } catch {
      // best effort
    }
    this.setIntegrationMetadata(phase, 'not_merged_failed_phase', {
      branch: handle.branch,
      worktreeDir: handle.dir,
    });
    await this.worktrees.release(handle, { keep: true }).catch(() => {});
  }

  private async executePhaseTasks(phase: PhaseNode): Promise<void> {
    const pendingTasks = this.getExecutableTasks(phase);

    while (pendingTasks.length > 0 && !this.stopped) {
      const batch = pendingTasks.splice(0, this.opts.maxConcurrentTasks);

      const results = await Promise.allSettled(
        batch.map((task) => this.executeSingleTask(task, phase)),
      );

      for (let i = 0; i < results.length; i++) {
        const result = results[i];
        const task = batch[i];
        if (!result || !task) continue;

        if (result.status === 'fulfilled') {
          this.markTaskCompleted(phase, task);
        } else {
          this.markTaskFailed(phase, task, result.reason);
        }
      }

      const newReady = this.getExecutableTasks(phase);
      pendingTasks.length = 0;
      pendingTasks.push(...newReady);
    }
  }

  private async executeSingleTask(task: TaskNode, phase: PhaseNode): Promise<unknown> {
    const tracker = this.getTrackerForPhase(phase);
    tracker.updateNodeStatus(task.id, 'in_progress');
    const handle = this.phaseWorktrees.get(phase.id);
    return this.ctx.executeTask(task, phase.id, { cwd: handle?.dir, branch: handle?.branch });
  }

  private markTaskCompleted(phase: PhaseNode, task: TaskNode): void {
    const tracker = this.getTrackerForPhase(phase);
    tracker.updateNodeStatus(task.id, 'completed');
    this.emit('phase.taskCompleted', {
      phaseId: phase.id,
      taskId: task.id,
      taskTitle: task.title,
    });
  }

  private markTaskFailed(phase: PhaseNode, task: TaskNode, error: unknown): void {
    const tracker = this.getTrackerForPhase(phase);
    const taskKey = `${phase.id}:${task.id}`;
    const currentRetries = this.taskRetryCounts.get(taskKey) ?? 0;

    if (currentRetries < this.opts.maxRetries) {
      this.taskRetryCounts.set(taskKey, currentRetries + 1);
      tracker.updateNodeStatus(
        task.id,
        'pending',
        `Retry ${currentRetries + 1}/${this.opts.maxRetries}`,
      );
      this.emit('phase.taskRetrying', {
        phaseId: phase.id,
        taskId: task.id,
        taskTitle: task.title,
        attempt: currentRetries + 1,
        maxRetries: this.opts.maxRetries,
      });
    } else {
      tracker.updateNodeStatus(
        task.id,
        'failed',
        error instanceof Error ? error.message : String(error),
      );
      this.emit('phase.taskFailed', {
        phaseId: phase.id,
        taskId: task.id,
        taskTitle: task.title,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  private getReadyPhases(): PhaseNode[] {
    const ready: PhaseNode[] = [];

    for (const phase of this.graph.phases.values()) {
      if (phase.status !== 'pending') continue;

      const depsDone = phase.dependsOn.every((depId) => {
        const dep = this.graph.phases.get(depId);
        return dep?.status === 'completed' || dep?.status === 'skipped';
      });

      if (depsDone || phase.parallelizable) {
        ready.push(phase);
      }
    }

    const prioOrder = { critical: 0, high: 1, medium: 2, low: 3 };
    ready.sort((a, b) => (prioOrder[a.priority] ?? 4) - (prioOrder[b.priority] ?? 4));

    return ready;
  }

  private getActivePhases(): PhaseNode[] {
    return Array.from(this.graph.phases.values()).filter((p) => p.status === 'running');
  }

  private getExecutableTasks(phase: PhaseNode): TaskNode[] {
    const tracker = this.getTrackerForPhase(phase);
    return tracker
      .getAllNodes({ status: ['pending', 'blocked'] })
      .filter((n) => n.status === 'pending' && tracker.canStart(n.id))
      .sort((a, b) => {
        const priorityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
        return (priorityOrder[a.priority] ?? 4) - (priorityOrder[b.priority] ?? 4);
      });
  }

  private getTrackerForPhase(phase: PhaseNode): TaskTracker {
    if (this.trackerCache.has(phase.id)) {
      return this.trackerCache.get(phase.id)!;
    }

    const store = new DefaultTaskStore();
    const tracker = new TaskTracker({ store });
    tracker.setGraph(phase.taskGraph);
    this.trackerCache.set(phase.id, tracker);
    return tracker;
  }

  private getFailedTaskCount(phase: PhaseNode): number {
    return this.getTrackerForPhase(phase).getAllNodes({ status: ['failed'] }).length;
  }

  private getCompletedTaskCount(phase: PhaseNode): number {
    return this.getTrackerForPhase(phase).getAllNodes({ status: ['completed'] }).length;
  }

  private updatePhaseStatus(phase: PhaseNode, status: PhaseStatus): void {
    const from = phase.status;
    phase.status = status;
    phase.updatedAt = Date.now();
    this.graph.updatedAt = Date.now();
    this.emit('phase.statusChange', { phaseId: phase.id, from, to: status });
  }

  private isComplete(): boolean {
    const allPhases = Array.from(this.graph.phases.values());
    return allPhases.every(
      (p) => p.status === 'completed' || p.status === 'skipped' || p.status === 'failed',
    );
  }

  private onGraphComplete(): void {
    this.graph.completedAt = Date.now();
    const durationMs = this.graph.completedAt - (this.graph.startedAt ?? this.graph.completedAt);
    this.emit('graph.completed', { graphId: this.graph.id, durationMs });
    this.stop();
  }

  private onGraphFailed(failedPhase: PhaseNode): void {
    this.emit('graph.failed', {
      graphId: this.graph.id,
      failedPhaseId: failedPhase.id,
      error: `Phase "${failedPhase.name}" failed`,
    });
    this.stop();
  }

  // ─── Progress ─────────────────────────────────────────────────────────────

  getProgress(): PhaseProgress {
    const phases = Array.from(this.graph.phases.values());
    let pending = 0;
    let ready = 0;
    let running = 0;
    let paused = 0;
    let completed = 0;
    let failed = 0;
    let skipped = 0;
    let totalTasks = 0;
    let completedTasks = 0;
    let failedTasks = 0;
    let estimatedHours = 0;
    let actualHours = 0;

    for (const p of phases) {
      switch (p.status) {
        case 'pending':
          pending++;
          break;
        case 'ready':
          ready++;
          break;
        case 'running':
          running++;
          break;
        case 'paused':
          paused++;
          break;
        case 'completed':
          completed++;
          break;
        case 'failed':
          failed++;
          break;
        case 'skipped':
          skipped++;
          break;
      }
      estimatedHours += p.estimateHours;
      if (p.actualDurationMs) actualHours += p.actualDurationMs / 3600000;

      const tracker = this.getTrackerForPhase(p);
      const progress = tracker.getProgress();
      totalTasks += progress.total;
      completedTasks += progress.completed;
      failedTasks += progress.failed;
    }

    const totalPhases = phases.length;
    const done = completed + skipped;

    return {
      totalPhases,
      pending,
      ready,
      running,
      paused,
      completed,
      failed,
      skipped,
      percentComplete: totalPhases > 0 ? Math.round((done / totalPhases) * 100) : 0,
      totalTasks,
      completedTasks,
      failedTasks,
      estimatedHours,
      actualHours,
    };
  }

  getGraph(): PhaseGraph {
    return this.graph;
  }

  isRunning(): boolean {
    return !this.stopped && this.runningPhases.size > 0;
  }

  isPaused(): boolean {
    return this.paused;
  }

  // ─── Agent Assignment ─────────────────────────────────────────────────────

  assignAgent(phaseId: string, agentId: string): void {
    const phase = this.graph.phases.get(phaseId);
    if (!phase) return;
    if (!phase.assignedAgents.includes(agentId)) {
      phase.assignedAgents.push(agentId);
      this.emit('agent.assigned', { phaseId, agentId });
    }
  }

  releaseAgent(phaseId: string, agentId: string): void {
    const phase = this.graph.phases.get(phaseId);
    if (!phase) return;
    phase.assignedAgents = phase.assignedAgents.filter((id) => id !== agentId);
    this.emit('agent.released', { phaseId, agentId });
  }

  // ─── Events ───────────────────────────────────────────────────────────────

  private emit<K extends PhaseEventName>(event: K, payload: PhaseEventMap[K]): void {
    (this.events.emit as (event: string, payload: unknown) => void)(event, payload);
  }

  private createNoopEventBus(): EventBus {
    return {
      emit: () => {},
      on: () => {},
      off: () => {},
      once: () => {},
      listeners: new Map(),
      wildcards: new Set(),
      setLogger: () => {},
      onAny: () => {},
      offAny: () => {},
      emitAsync: async () => [],
      waitFor: async () => {},
    } as unknown as EventBus;
  }

  private async waitWhilePaused(): Promise<void> {
    while (this.paused && !this.stopped) {
      await this.delay(100);
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
