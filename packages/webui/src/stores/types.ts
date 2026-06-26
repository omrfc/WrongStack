import type { Usage } from '@wrongstack/core';
import type { ContentBlock } from '@wrongstack/core';

// ============================================
// Shared Types
// ============================================

export interface MessageContent {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string | ContentBlock[];
}

export interface ToolExecution {
  id: string;
  name: string;
  input?: unknown | undefined;
  output?: string | undefined;
  durationMs?: number | undefined;
  ok: boolean;
  startedAt: number;
  completedAt?: number | undefined;
}

export interface ChatMessage {
  id: string;
  content: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  toolName?: string | undefined;
  toolInput?: unknown | undefined;
  toolResult?: string | undefined;
  /** Wall-clock ms reported by the backend in tool.executed; rendered next
   *  to the tool name so the user can spot slow tools at a glance. */
  toolDurationMs?: number | undefined;
  /** Backend's tool_use id (e.g. "toolu_..." from Anthropic). Used to map
   *  tool.executed events back to the right bubble when the model fires
   *  multiple tools in parallel — currentToolId alone only points at the
   *  most recent start and would leave earlier ones stuck on "Running...". */
  toolUseId?: string | undefined;
  isError?: boolean | undefined;
  timestamp: number;
  usage?: Usage | undefined;
  streaming?: boolean | undefined;
  parentId?: string | undefined;
  /** Live progress lines for an in-flight tool, populated from
   *  tool.progress WS events. Each line is shown in chronological order
   *  inside the tool bubble while it's still running, and cleared once the
   *  final tool.executed lands (toolResult takes over). Capped to the last
   *  ~30 lines so a chatty bash command can't grow this unbounded. */
  progressLines?: string[] | undefined;
  /** End-of-run summary attached to the last assistant message of a turn
   *  after run.result lands. Populated by the run.result handler in
   *  useWebSocket — gives the user a single-line readout of what just
   *  happened (iterations, tool calls, elapsed time, cost). */
  runSummary?: {
    iterations: number;
    tools: number;
    durationMs: number;
    costDelta: number;
  };
  /** Archived extended-thinking text captured during one agent iteration.
   *  The live thinking bubble is transient; this metadata keeps the final
   *  process log in chat history once the iteration completes. */
  thinkingLog?: {
    iteration: number;
    text: string;
    startedAt: number;
    durationMs: number;
    replayed?: boolean | undefined;
  } | undefined;
}

export interface SessionInfo {
  id: string;
  startedAt: number;
  provider: string;
  model: string;
  title?: string | undefined;
}

/** A row in the sidebar's History tab. Mirrors core's SessionSummary +
 *  isCurrent so the active session can be highlighted. Timestamps are
 *  ISO-8601 strings as stored on disk; the UI parses them lazily. */
export interface SessionHistoryEntry {
  id: string;
  title: string;
  startedAt: string;
  model: string;
  provider: string;
  tokenTotal: number;
  isCurrent: boolean;
}

/** One live (or just-finished) subagent in the fleet roster. */
export interface SubagentView {
  id: string;
  /** Session this agent belongs to — ties the agent to a specific project/session.
   *  Used to filter/cleanup agents on project switch. */
  sessionId?: string | undefined;
  /** Display name — the leader-assigned nickname (may be multi-word, e.g.
   *  "Von Neumann"). Falls back to the raw id until `spawned` names it. */
  name: string;
  status: 'running' | 'completed' | 'failed' | 'timeout' | 'stopped';
  provider?: string | undefined;
  model?: string | undefined;
  description?: string | undefined;
  taskId?: string | undefined;
  /** Latest iteration index from iteration_summary. */
  iteration: number;
  /** Cumulative tool calls (authoritative from iteration_summary, live-bumped
   *  by tool_executed between summaries). */
  toolCalls: number;
  costUsd: number;
  /** Tool the agent says it's running right now (iteration_summary). */
  currentTool?: string | undefined;
  /** Most-recent completed tool name (tool_executed). */
  lastTool?: string | undefined;
  /** Context-window load 0–100. */
  ctxPct: number;
  ctxTokens: number;
  maxContext: number;
  /** How many times this agent self-extended its budget. */
  extensions: number;
  error?: { kind: string | undefined; message: string };
  startedAt: number;
  completedAt?: number | undefined;
  /** Accumulated partial text from periodic iteration_summary snapshots.
   *  Last ~200 chars of the subagent's streaming output — gives live
   *  visibility into what the subagent is writing. */
  partialText?: string | undefined;
  /** Final output text from task_completed — the subagent's complete response. */
  finalText?: string | undefined;
  /** Running log of tool executions: name, ok/fail, duration. Most recent
   *  first, capped at ~50 entries to avoid memory bloat on long runs. */
  toolLog: Array<{ name: string; ok: boolean; durationMs: number; at: number }>;
  /** 12-bin activity sparkline (0–12, one per 2-second bucket). Each value
   *  is the count of events in that bucket, normalized to 0–12 for display.
   *  Updated on tool_executed and iteration_summary events. */
  sparklineBins: number[];
  /** Budget warning: subagent hit a soft limit and coordinator is auto-extending.
   *  Rendered as "⚡ hitting {kind} limit ({used}/{limit}) — extending". */
  budgetWarning?: { kind: string; used: number; limit: number } | undefined;
  /** Human-readable reason for terminal failure when status is failed/timeout.
   *  E.g. "provider_auth", "rate_limit", "timeout", "budget_iterations". */
  failureReason?: string | undefined;
  /** True when this is the leader agent (vs. a spawned subagent). */
  isLeader?: boolean | undefined;
  /** Per-agent token usage (from ctx_pct event). ctxPct is display-capped at 100. */
  tokensIn?: number | undefined;
  tokensOut?: number | undefined;
}

/** Discriminated payload mirroring the subagent.* events the backend forwards. */
export interface SubagentEvent {
  kind:
    | 'spawned'
    | 'task_started'
    | 'tool_executed'
    | 'iteration_summary'
    | 'budget_warning'
    | 'budget_extended'
    | 'ctx_pct'
    | 'task_completed'
    | 'session_stopped'
    | 'leader_updated';
  subagentId?: string | undefined;
  /** Session this agent belongs to — forwarded from the server on every subagent event. */
  sessionId?: string | undefined;
  name?: string | undefined;
  provider?: string | undefined;
  model?: string | undefined;
  description?: string | undefined;
  taskId?: string | undefined;
  toolName?: string | undefined;
  iteration?: number | undefined;
  toolCalls?: number | undefined;
  costUsd?: number | undefined;
  currentTool?: string | undefined;
  load?: number | undefined;
  rawLoad?: number | undefined;
  tokens?: number | undefined;
  maxContext?: number | undefined;
  totalExtensions?: number | undefined;
  /** Budget warning details from subagent.budget_warning. */
  budgetKind?: string | undefined;
  used?: number | undefined;
  limit?: number | undefined;
  status?: 'success' | 'failed' | 'timeout' | 'stopped' | undefined;
  iterations?: number | undefined;
  error?: { kind: string | undefined; message: string };
  /** Tool execution result (tool_executed event). */
  ok?: boolean | undefined;
  /** Tool execution duration in ms (tool_executed event). */
  durationMs?: number | undefined;
  /** Accumulated partial text (iteration_summary event). */
  partialText?: string | undefined;
  /** Final output text (task_completed event). */
  finalText?: string | undefined;
  /** Failure reason for task_completed with failed/timeout status. */
  failureReason?: string | undefined;
  /** True when this event marks the agent as the leader. */
  isLeader?: boolean | undefined;
  /** Tokens in/out for fleet-wide aggregation (from ctx_pct event). */
  tokensIn?: number | undefined;
  tokensOut?: number | undefined;
}

/** A single entry in the Fleet Monitor event timeline. */
export interface FleetTimelineEvent {
  id: string;
  kind:
    | 'spawned'
    | 'task_started'
    | 'tool_executed'
    | 'iteration_summary'
    | 'budget_warning'
    | 'budget_extended'
    | 'task_completed'
    | 'ctx_pct'
    | 'leader_updated';
  agentId: string;
  agentName: string;
  timestamp: number;
  message: string;
  /** Numeric value for sorting/display (e.g. duration, cost delta). */
  value?: number | undefined;
}
