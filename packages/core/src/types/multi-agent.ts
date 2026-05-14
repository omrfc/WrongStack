import type { BridgeMessage, AgentBridge } from './agent-bridge.js';
import type { SubagentBudget } from '../defaults/subagent-budget.js';

export interface SubagentConfig {
  id?: string;
  name: string;
  role?: string;
  prompt?: string;
  maxIterations?: number;
  maxToolCalls?: number;
  maxTokens?: number;
  maxCostUsd?: number;
  timeoutMs?: number;
  tools?: string[];
  model?: string;
  priority?: number;
}

export interface TaskResult<T = unknown> {
  subagentId: string;
  taskId: string;
  status: 'success' | 'failed' | 'timeout' | 'stopped';
  result?: T;
  error?: string;
  iterations: number;
  toolCalls: number;
  durationMs: number;
}

export interface TaskSpec {
  id: string;
  description: string;
  subagentId?: string;
  priority?: number;
  maxToolCalls?: number;
  timeoutMs?: number;
  context?: Record<string, unknown>;
}

export interface DoneCondition {
  type: 'iterations' | 'tool_calls' | 'output_match' | 'custom' | 'all_tasks_done';
  maxIterations?: number;
  maxToolCalls?: number;
  pattern?: string;
  predicate?: string;
}

export interface MultiAgentConfig {
  coordinatorId: string;
  leaderSystemPrompt?: string;
  subagents?: SubagentConfig[];
  maxConcurrent?: number;
  doneCondition: DoneCondition;
  timeoutMs?: number;
  /**
   * Optional default budget applied to every spawned subagent. Per-subagent
   * fields in `SubagentConfig` override these. Coordinator enforces them by
   * constructing a `SubagentBudget` per spawn — see `SubagentRunContext.budget`.
   */
  defaultBudget?: {
    maxIterations?: number;
    maxToolCalls?: number;
    maxTokens?: number;
    maxCostUsd?: number;
    timeoutMs?: number;
  };
}

export interface SpawnResult {
  subagentId: string;
  agentId: string;
}

export interface TaskDelegation {
  task: TaskSpec;
  subagentId: string;
}

export interface CoordinatorEvents {
  'task.assigned': { task: TaskSpec; subagentId: string };
  'task.completed': { task: TaskSpec; result: TaskResult };
  'subagent.started': { subagent: SubagentConfig };
  'subagent.stopped': { subagentId: string; reason: string };
  'done': { results: TaskResult[]; totalIterations: number };
}

export interface MultiAgentCoordinator {
  readonly coordinatorId: string;
  readonly config: MultiAgentConfig;

  spawn(subagent: SubagentConfig): Promise<SpawnResult>;
  assign(task: TaskSpec): Promise<void>;
  delegate(to: string, msg: BridgeMessage): Promise<void>;
  stop(subagentId: string): Promise<void>;
  stopAll(): Promise<void>;
  getStatus(): CoordinatorStatus;
}

/**
 * Caller-supplied runner that actually executes a task. The coordinator
 * provides isolated state (own budget, own AbortSignal, own bridge handle)
 * and enforces concurrency limits — the runner just runs the task and reports
 * the outcome. This is the injection seam that decouples the coordinator
 * from `Agent` so it can be tested with mocks and reused for non-Agent
 * subagents (workers, MCP-driven subagents, etc.).
 */
export type SubagentRunner = (
  task: TaskSpec,
  ctx: SubagentRunContext,
) => Promise<SubagentRunOutcome>;

export interface SubagentRunContext {
  subagentId: string;
  config: SubagentConfig;
  budget: SubagentBudget;
  signal: AbortSignal;
  /** Null until `setSubagentBridge` is called for this subagent. */
  bridge: AgentBridge | null;
}

export interface SubagentRunOutcome {
  result?: unknown;
  iterations: number;
  toolCalls: number;
}

export interface CoordinatorStatus {
  coordinatorId: string;
  subagents: {
    id: string;
    name: string;
    status: 'running' | 'idle' | 'stopped' | 'error';
    currentTask?: string;
  }[];
  pendingTasks: number;
  completedTasks: number;
  totalIterations: number;
  done: boolean;
}

export interface SubagentContext {
  subagentId: string;
  tasks: TaskSpec[];
  /**
   * Two-phase initialization: `spawn()` creates the subagent before the
   * bridge is wired (`setSubagentBridge()`), so `parentBridge` is nullable
   * by design. Readers must `hasParentBridge()`-guard or null-check before
   * use; the prior `null as unknown as AgentBridge` cast was a type lie
   * that hid this from the compiler.
   */
  parentBridge: AgentBridge | null;
  doneCondition: DoneCondition;
  maxConcurrent: number;
}