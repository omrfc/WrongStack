import type { SubagentBudget } from '../coordination/subagent-budget.js';
import type { AgentBridge, BridgeMessage } from './agent-bridge.js';

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

  // --- Director orchestration extensions ---

  /**
   * Provider registry id (e.g. `'anthropic'`, `'openai'`, `'google'`).
   * Allows a director to mix providers across siblings — one subagent on
   * Sonnet, another on GPT-5, another on Haiku. Falls back to the
   * factory's default provider when omitted, which is the legacy
   * single-provider behavior.
   */
  provider?: string;

  /**
   * Per-subagent session JSONL path. When omitted the orchestrator-
   * supplied factory derives a path under `<sessionRoot>/<runId>/`.
   * Override to redirect the transcript elsewhere (long-term storage,
   * a different filesystem, etc.).
   */
  sessionPath?: string;

  /**
   * Additional text appended to the role's base system prompt. Does not
   * replace it. Useful for last-mile guidance like "you may only call
   * read tools, never write" or "respond in JSON only".
   */
  systemPromptOverride?: string;

  /**
   * Routing for streaming output. `'director'` (default) forwards
   * text/tool events to the parent's FleetBus so the director can read
   * the subagent's stream. `'silent'` keeps everything subagent-local;
   * the director only sees the final task result. `'user'` forwards
   * direct to the user-facing renderer (gate this behind an explicit
   * config flag — it can confuse the chat surface).
   */
  textStream?: 'director' | 'silent' | 'user';
  toolStream?: 'director' | 'silent' | 'user';
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
  done: { results: TaskResult[]; totalIterations: number };
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
