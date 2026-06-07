/**
 * AutoPhase - types for autonomous phase-based workflows.
 *
 * A project is split into phases; each phase contains tasks.
 * Phases are dependency-aware: the next phase cannot start until all tasks
 * in the current phase complete. Parallel phases are optionally supported.
 */

import type { BrainArbiter } from '../coordination/brain.js';
import type { TaskGraph, TaskNode } from '../types/task-graph.js';

// ─── Phase Status ───────────────────────────────────────────────────────────

export type PhaseStatus =
  | 'pending' // Not started yet; waiting for a previous phase
  | 'ready' // Ready to start because previous phases completed
  | 'running' // Actively running
  | 'paused' // Paused by the user
  | 'completed' // All tasks finished
  | 'failed' // At least one task failed and retries are exhausted
  | 'skipped'; // Skipped

// ─── Phase Node ─────────────────────────────────────────────────────────────

export interface PhaseNode {
  id: string;
  /** Phase name, e.g. "Discovery", "Design", "Implementation", "Testing". */
  name: string;
  description: string;
  status: PhaseStatus;
  /** Task graph for this phase. */
  taskGraph: TaskGraph;
  /** Previous phase IDs; this phase cannot start until they complete. */
  dependsOn: string[];
  /** Next phase IDs. */
  nextPhases: string[];
  /** Whether this phase can run in parallel before the previous phase finishes. */
  parallelizable: boolean;
  /** Phase priority. */
  priority: 'critical' | 'high' | 'medium' | 'low';
  /** Estimated duration in hours. */
  estimateHours: number;
  /** Actual duration in milliseconds. */
  actualDurationMs?: number | undefined;
  /** Start time. */
  startedAt?: number | undefined;
  /** Completion time. */
  completedAt?: number | undefined;
  /** Agents assigned to this phase. */
  assignedAgents: string[];
  /** Phase metadata. */
  metadata?: Record<string, unknown> | undefined;
  createdAt: number;
  updatedAt: number;
}

// ─── Phase Graph ────────────────────────────────────────────────────────────

export interface PhaseGraph {
  id: string;
  /** Project title. */
  title: string;
  description: string;
  phases: Map<string, PhaseNode>;
  /** Starting phase IDs. */
  rootPhaseIds: string[];
  /** Active phase IDs with running status. */
  activePhaseIds: string[];
  /** Completed phase IDs. */
  completedPhaseIds: string[];
  /** Failed phase IDs. */
  failedPhaseIds: string[];
  /** Whether autonomous mode is active. */
  autonomous: boolean;
  /** Stop when all phases complete. */
  stopOnComplete: boolean;
  createdAt: number;
  updatedAt: number;
  startedAt?: number | undefined;
  completedAt?: number | undefined;
}

// ─── Phase Progress ─────────────────────────────────────────────────────────

export interface PhaseProgress {
  totalPhases: number;
  pending: number;
  ready: number;
  running: number;
  paused: number;
  completed: number;
  failed: number;
  skipped: number;
  percentComplete: number;
  totalTasks: number;
  completedTasks: number;
  failedTasks: number;
  estimatedHours: number;
  actualHours: number;
}

// ─── Phase Event Map ────────────────────────────────────────────────────────

export interface PhaseEventMap {
  'phase.statusChange': { phaseId: string; from: PhaseStatus; to: PhaseStatus };
  'phase.started': { phaseId: string; name: string };
  'phase.completed': { phaseId: string; name: string; durationMs: number };
  'phase.failed': { phaseId: string; name: string; error?: string | undefined };
  'phase.taskCompleted': { phaseId: string; taskId: string; taskTitle: string };
  'phase.taskFailed': { phaseId: string; taskId: string; taskTitle: string; error: string };
  'phase.taskRetrying': {
    phaseId: string;
    taskId: string;
    taskTitle: string;
    attempt: number;
    maxRetries: number;
  };
  'phase.allTasksDone': { phaseId: string; completed: number; failed: number };
  'phase.verifying': { phaseId: string; name: string; attempt: number };
  'phase.verifyFailed': { phaseId: string; name: string; attempt: number; error?: string | undefined };
  'phase.repairing': { phaseId: string; name: string; attempt: number };
  'phase.conflictResolving': { phaseId: string; name: string; files: string[] };
  'phase.conflictResolved': { phaseId: string; name: string };
  'graph.completed': { graphId: string; durationMs: number };
  'graph.failed': { graphId: string; failedPhaseId: string; error: string };
  'autonomous.tick': { activePhases: string[]; queuedPhases: string[] };
  'agent.assigned': { phaseId: string; agentId: string };
  'agent.released': { phaseId: string; agentId: string };
}

export type PhaseEventName = keyof PhaseEventMap;

// ─── Phase Execution Context ────────────────────────────────────────────────

export interface PhaseExecutionContext {
  /**
   * Execute a task through an AI agent. `env` points to the phase git
   * worktree when available, so the agent runs in an isolated working directory.
   */
  executeTask: (
    task: TaskNode,
    phaseId: string,
    env?: { cwd?: string | undefined; branch?: string | undefined },
  ) => Promise<unknown>;
  /**
   * Optional verification gate. Called after all tasks in a phase finish,
   * but before the phase is marked "completed" and its worktree is merged
   * back to the base branch. `env` points to the phase worktree when available;
   * verification should run in that isolated directory, such as typecheck/test.
   * If `ok:false` is returned, merge is blocked and `repairPhase` is attempted when available.
   *
   * If undefined, the gate is skipped for backward compatibility.
   */
  verifyPhase?: (
    phase: PhaseNode,
    env?: { cwd?: string | undefined; branch?: string | undefined },
  ) => Promise<{ ok: boolean; output?: string | undefined }>;
  /**
   * Optional repair pass. When `verifyPhase` fails, it is called with the
   * captured error output. It should try to fix the code in the worktree
   * for example, through a repair subagent. Its return value is ignored;
   * the orchestrator reruns `verifyPhase` afterward. It is never called when `verifyPhase` is undefined.
   */
  repairPhase?: (
    phase: PhaseNode,
    failure: string,
    attempt: number,
    env?: { cwd?: string | undefined; branch?: string | undefined },
  ) => Promise<void>;
  /**
   * Optional merge-conflict resolver. Called when a phase worktree conflicts
   * during squash-merge into the base branch. `info.cwd` points to the base
   * working tree where conflict markers exist; the resolver should clean those
   * markers and return `true`. On success the merge is committed; otherwise
   * the merge is aborted and the worktree is kept in `needs-review`.
   * If undefined, conflicts keep the old parked-for-review behavior.
   */
  resolveConflict?: (
    phase: PhaseNode,
    info: { conflictFiles: string[]; cwd: string },
  ) => Promise<boolean>;
  /** Optional global Brain arbiter for the policy, decision, and escalation layer. */
  brain?: BrainArbiter | undefined;
  /** Called when a phase completes. */
  onPhaseComplete?: ((phase: PhaseNode) => void) | undefined;
  /** Called when a phase fails. */
  onPhaseFail?: (phase: PhaseNode, error: Error) => void;
  /** Called on every tick in autonomous mode. */
  onTick?: (ctx: { activePhases: PhaseNode[]; readyPhases: PhaseNode[] }) => void;
}

// ─── AutoPhase Options ──────────────────────────────────────────────────────

export interface AutoPhaseOptions {
  /** Maximum number of parallel phases. */
  maxConcurrentPhases?: number | undefined;
  /** Maximum number of parallel tasks within a phase. */
  maxConcurrentTasks?: number | undefined;
  /** Retry count for failed tasks. */
  maxRetries?: number | undefined;
  /**
   * Maximum number of repair attempts after the verification gate fails.
   * Total verification runs = maxVerifyAttempts + 1: the first run plus one
   * rerun after each repair. Defaults to 2. Has no effect without `verifyPhase`.
   */
  maxVerifyAttempts?: number | undefined;
  /** Autonomous mode: automatically advance as phases complete. */
  autonomous?: boolean | undefined;
  /** Delay between phases in milliseconds. */
  phaseDelayMs?: number | undefined;
  /** Stop when a phase fails. */
  stopOnFailure?: boolean | undefined;
  /** Event bus */
  events?: import('../kernel/events.js').EventBus | undefined;
  /**
   * Optional git-worktree manager. When provided, each phase runs in its own
   * isolated worktree and branch, then is squash-merged back into the base
   * branch in order. Without it, behavior is unchanged and uses the shared working tree.
   */
  worktrees?: import('../worktree/worktree-manager.js').WorktreeManager | undefined;
}

// ─── Phase Filter / Sort ────────────────────────────────────────────────────

export interface PhaseFilter {
  status?: PhaseStatus[] | undefined;
  priority?: PhaseNode['priority'][] | undefined;
}

export interface PhaseSort {
  field: 'priority' | 'createdAt' | 'startedAt' | 'completedAt';
  direction: 'asc' | 'desc';
}

// ─── Phase Template ─────────────────────────────────────────────────────────

export interface PhaseTemplate {
  name: string;
  description: string;
  priority: PhaseNode['priority'];
  estimateHours: number;
  parallelizable: boolean;
  /** Task templates to create automatically. */
  taskTemplates?: Array<{
    title: string;
    description: string;
    type: import('../types/task-graph.js').TaskType;
    priority: import('../types/task-graph.js').TaskPriority;
    estimateHours: number;
    tags?: string[] | undefined;
  }>;
}
