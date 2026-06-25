import type { SddBoardSnapshot } from './board-types.js';
import type { SddSubtaskSpec } from './sdd-parallel-run.js';

/**
 * Control surface over a live SDD run, exposed to every steering surface
 * (TUI, CLI-hosted webui in-process; standalone webui via a control file the
 * run drains). The run itself stays CLI-owned — this is the only sanctioned
 * way to pause / retry / reassign from outside the run loop.
 */
export interface SddRunControl {
  runId: string;
  specId?: string | undefined;
  pause(): void;
  resume(): void;
  stop(): void;
  retryTask(taskId: string): boolean;
  /** Requeue every failed task to pending (board "Retry all failed"). Returns the count. */
  retryAllFailed(): number;
  reassignTask(taskId: string, agentName: string): boolean;
  /** Set/override a task's worker model (+ optional provider). Next dispatch. */
  setTaskModel(taskId: string, model: string | undefined, provider?: string | undefined): boolean;
  /** Set/override a task's fallback model chain. Next dispatch. */
  setTaskFallbacks(taskId: string, fallbackModels: string[] | undefined): boolean;
  /** Set/override a task's completion-gate verification command. Next dispatch. */
  setTaskVerification(taskId: string, verificationCommand: string | undefined): boolean;
  /** Cancel a task — abort it if running, else mark it cancelled. */
  cancelTask(taskId: string): Promise<boolean> | boolean;
  /** Delete a not-started task from the graph (refused while running). */
  deleteTask(taskId: string): boolean;
  /** Split a task into sub-tasks (refused while running). Returns the new leaf ids. */
  splitTask(taskId: string, subtasks: SddSubtaskSpec[]): string[];
  /** Latest board snapshot (built on demand). */
  snapshot(): SddBoardSnapshot;
  isRunning(): boolean;
}

/**
 * In-process registry of the active SDD run. One run is active at a time (a
 * single fleet drives it); a new run replaces the previous. Lives in the CLI
 * process where the fleet runs.
 */
export class SddRunRegistry {
  private current: SddRunControl | null = null;

  register(control: SddRunControl): void {
    this.current = control;
  }

  clear(runId: string): void {
    if (this.current?.runId === runId) this.current = null;
  }

  getActive(): SddRunControl | null {
    return this.current;
  }
}
