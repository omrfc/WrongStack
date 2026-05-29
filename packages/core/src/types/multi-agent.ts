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

  /**
   * Working directory for this subagent's tools. Defaults to the factory's
   * cwd. AutoPhase sets this to a per-phase git worktree so parallel phases
   * edit isolated checkouts instead of clobbering one shared working tree.
   * `projectRoot` is intentionally left unchanged — tools resolve the
   * worktree's `.git` gitlink from `cwd` while staying bounded to the repo.
   */
  cwd?: string;

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

/**
 * Discriminator for every distinct failure mode a subagent can hit. The
 * coordinator's classifier (`classifySubagentError` in
 * coordination/multi-agent-coordinator.ts) maps raw exceptions to one of
 * these — callers (delegate tool, /agents UI, retry policies) can then
 * branch on `kind` instead of grepping `error.message`. Each kind
 * documents its retryability so an orchestrator can act on it without
 * extra knowledge.
 */
export type SubagentErrorKind =
  /** Provider returned 5xx. Transient server-side issue — safe to retry with backoff. */
  | 'provider_5xx'
  /** Provider returned 429. Rate-limited — retry with `backoffMs` delay. */
  | 'provider_rate_limit'
  /** Provider call timed out at the network layer (TCP / TLS / read). Retry safe. */
  | 'provider_timeout'
  /** Provider rejected the credentials (401/403). NOT retryable — config fix required. */
  | 'provider_auth'
  /** Model returned a "context length exceeded" error. Retrying without trimming will fail again. */
  | 'context_overflow'
  /** A tool's `execute()` returned `ok:false`. Logical task failure, not a crash. */
  | 'tool_failed'
  /** A tool's `execute()` threw an exception. Often retryable but cause-dependent. */
  | 'tool_threw'
  /** Hit the per-subagent `maxIterations` budget. Either raise budget or narrow task. */
  | 'budget_iterations'
  /** Hit the per-subagent `maxToolCalls` budget. Either raise budget or narrow task. */
  | 'budget_tool_calls'
  /** Hit the per-subagent `maxTokens` budget. */
  | 'budget_tokens'
  /** Hit the per-subagent `maxCostUsd` budget. */
  | 'budget_cost'
  /** Hit the per-subagent `timeoutMs` wall-clock budget. */
  | 'budget_timeout'
  /** Parent agent's AbortController fired (user Ctrl+C, parent unwound, sibling failure cascade). */
  | 'aborted_by_parent'
  /** LLM returned end_turn with no textual content. Often a prompt issue. */
  | 'empty_response'
  /** Parent-child bridge transport failed (rare — IPC / writer crash). */
  | 'bridge_failed'
  /** Everything else. Classifier fallback — should narrow over time as new modes appear. */
  | 'unknown';

/**
 * Structured failure envelope. Replaces the prior `error?: string` so
 * callers can switch on `kind`, respect `retryable`, and apply
 * provider-suggested `backoffMs` instead of guessing from substring
 * matches on the message.
 */
export interface SubagentError {
  /** Discriminator — see SubagentErrorKind doc strings for semantics. */
  kind: SubagentErrorKind;
  /** Human-readable summary, suitable for direct UI display. Always populated. */
  message: string;
  /** True if the operation can be retried as-is (possibly with backoff). */
  retryable: boolean;
  /** Suggested backoff before retry, in ms. Set for `provider_rate_limit` and `provider_5xx`. */
  backoffMs?: number;
  /** Original cause snapshot for diagnostics — never used for control flow. */
  cause?: { name: string; message: string; stack?: string };
}

export interface TaskResult<T = unknown> {
  subagentId: string;
  taskId: string;
  status: 'success' | 'failed' | 'timeout' | 'stopped';
  result?: T;
  /**
   * Structured failure envelope. Populated whenever `status !== 'success'`.
   * Prefer reading `error.kind` over substring-matching `error.message`.
   */
  error?: SubagentError;
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
  type: 'iterations' | 'tool_calls' | 'output_match' | 'custom' | 'all_tasks_done' | 'directive';
  maxIterations?: number;
  maxToolCalls?: number;
  pattern?: string;
  predicate?: string;
  /**
   * For `directive` type — stop when model emits [done] and keep going
   * on [continue]/[next step]/[proceed] WITHOUT returning to the outer runner.
   * When false (default), the runner behaves normally (one agent.run per loop).
   * When true, the runner passes `autonomousContinue: true` to the agent and
   * re-runs internally when the model signals continue.
   */
  autonomous?: boolean;
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
  /**
   * Stop a subagent and remove it from the coordinator. Releases all
   * associated resources. The subagent id can be reused in a future spawn.
   */
  remove(subagentId: string): Promise<void>;
  getStatus(): CoordinatorStatus;
  /**
   * Wait for one or more tasks to complete and return their results.
   * If a task is already done when called, returns immediately.
   * Resolves to an array in the same order as `taskIds`.
   */
  awaitTasks(taskIds: string[]): Promise<TaskResult[]>;
  /** Snapshot of completed task results. */
  results(): readonly TaskResult[];
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
    /** Cumulative budget auto-extensions granted to this subagent, when the
     *  status is produced by a Director that tracks them. */
    extensions?: number;
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
