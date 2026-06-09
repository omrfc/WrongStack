
import type { Usage } from '@wrongstack/core';

// Event types for WebSocket communication
export interface WSMessage {
  type: string;
  payload: unknown;
}

export interface WSSessionStart {
  type: 'session.start';
  payload: {
    sessionId: string;
    model: string;
    provider: string;
    maxContext?: number | undefined;
    projectName?: string | undefined;
    cwd?: string | undefined;
    mode?: string | undefined;
    contextMode?: string | undefined;
    inputCost?: number | undefined;
    outputCost?: number | undefined;
    cacheReadCost?: number | undefined;
    reset?: boolean | undefined;
    replayMessages?: Array<{ role: string | undefined; content: unknown }>;
    replayUsage?: Usage | undefined;
  };
}

export interface WSSessionEnd {
  type: 'session.end';
  payload: {
    sessionId: string;
    usage: Usage;
    totalCost: number;
  };
}

export interface WSUserMessage {
  type: 'user_message';
  payload: {
    id: string;
    content: string;
    timestamp: number;
  };
}

export interface WSTextDelta {
  type: 'provider.text_delta';
  payload: {
    text: string;
    messageId: string;
  };
}

export interface WSThinkingDelta {
  type: 'provider.thinking_delta';
  payload: {
    text: string;
  };
}

export interface WSToolUseStart {
  type: 'tool.started';
  payload: {
    id: string;
    name: string;
    input?: unknown | undefined;
    messageId: string;
  };
}

export interface WSToolProgress {
  type: 'tool.progress';
  payload: {
    name: string;
    id: string;
    event: {
      type: 'log' | 'warning' | 'metric' | 'file_changed' | 'partial_output';
      text?: string | undefined;
      data?: Record<string, unknown>;
    };
  };
}

export interface WSToolExecuted {
  type: 'tool.executed';
  payload: {
    id: string;
    name: string;
    durationMs: number;
    ok: boolean;
    input?: unknown | undefined;
    output?: string | undefined;
  };
}

export interface WSIterationStarted {
  type: 'iteration.started';
  payload: {
    index: number;
    maxIterations?: number | undefined;
  };
}

export interface WSIterationCompleted {
  type: 'iteration.completed';
  payload: {
    index: number;
    totalIterations: number;
  };
}

export interface WSProviderResponse {
  type: 'provider.response';
  payload: {
    usage: Usage;
    stopReason: string;
    messageId: string;
  };
}

export interface WSRunResult {
  type: 'run.result';
  payload: {
    status: 'done' | 'failed' | 'max_iterations' | 'aborted';
    iterations: number;
    finalText?: string | undefined;
    error?: {
      code: string;
      message: string;
      recoverable: boolean;
    };
  };
}

export interface WSSessionStats {
  type: 'session.stats';
  payload: {
    messages: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cost: number;
    duration: number;
  };
}

export interface WSError {
  type: 'error';
  payload: {
    phase: string;
    message: string;
  };
}

export interface WSToolConfirmNeeded {
  type: 'tool.confirm_needed';
  payload: {
    id: string;
    toolName: string;
    input: unknown;
    suggestedPattern: string;
    resolve: (decision: 'yes' | 'no' | 'always' | 'deny') => void;
  };
}

export interface WSToolConfirmResult {
  type: 'tool.confirm_result';
  payload: {
    id: string;
    decision: 'yes' | 'no' | 'always' | 'deny';
  };
}

export interface WSModelSwitch {
  type: 'model.switch';
  payload: {
    provider: string;
    model: string;
  };
}

export type MemoryScope = 'project-agents' | 'project-memory' | 'user-memory';

export interface WSContextDebug {
  type: 'context.debug';
  payload: {
    total: number;
    mode?: string | undefined;
    policy?: unknown | undefined;
    systemPrompt: number;
    tools: {
      total: number;
      count: number;
      breakdown: Array<{ name: string; tokens: number }>;
    };
    messages: {
      total: number;
      count: number;
      breakdown: Array<{ index: number; role: string; tokens: number; preview: string }>;
    };
  };
}

export interface WSContextCompacted {
  type: 'context.compacted';
  payload: {
    before: number;
    after: number;
    saved: number;
    reductions: Array<{ phase: string; saved: number }>;
    repaired?: {
      removedToolUses: string[];
      removedToolResults: string[];
      removedMessages: number;
    };
  };
}

export interface WSContextRepaired {
  type: 'context.repaired';
  payload: {
    removedToolUses: string[];
    removedToolResults: string[];
    removedMessages: number;
    beforeMessages?: number | undefined;
    afterMessages?: number | undefined;
  };
}

export interface WSContextModesList {
  type: 'context.modes.list';
  payload: {
    activeId: string;
    modes: Array<{
      id: string;
      name: string;
      description: string;
      isActive: boolean;
      thresholds: { warn: number; soft: number; hard: number };
      preserveK: number;
      eliseThreshold: number;
    }>;
  };
}

export interface WSContextModeChanged {
  type: 'context.mode.changed';
  payload: {
    id: string;
    name: string;
    policy: unknown;
  };
}

export interface WSToolsList {
  type: 'tools.list';
  payload: {
    tools: Array<{ name: string; description: string; params: string[] }>;
  };
}

export interface WSMemoryList {
  type: 'memory.list';
  payload: {
    text: string;
    error?: string | undefined;
  };
}

export interface WSSkillsList {
  type: 'skills.list';
  payload: {
    enabled: boolean;
    error?: string | undefined;
    skills: Array<{
      name: string;
      description: string;
      version: string;
      source: string;
      path: string;
      trigger: string;
      scope: string[];
    }>;
  };
}

export interface WSDiagGet {
  type: 'diag.get';
  payload: {
    provider: string;
    model: string;
    cwd: string;
    sessionId: string;
    tools: { count: number; names: string[] };
    features: { memory: boolean; skills: boolean; modelsRegistry: boolean };
    mode: string;
    usage: { input: number; output: number; cacheRead?: number | undefined };
    messages: number;
    todos: number;
  };
}

export interface WSStatsGet {
  type: 'stats.get';
  payload: {
    sessionId: string;
    provider: string;
    model: string;
    usage: { input: number; output: number; cacheRead?: number | undefined; cacheWrite?: number | undefined };
    cache: { readTokens: number; writeTokens: number; hitRatio: number } | null;
    cost: number;
    messages: number;
    readFiles: number;
    tools: number;
    elapsedMs: number;
  };
}

export interface WSSessionsList {
  type: 'sessions.list';
  payload: {
    sessions: Array<{
      id: string;
      title: string;
      startedAt: string;
      model: string;
      provider: string;
      tokenTotal: number;
      isCurrent: boolean;
    }>;
    error?: string | undefined;
  };
}

// --- Provider/Model/Key management (mirrors TUI/CLI auth-menu experience) ---

export interface WSProviderCatalog {
  type: 'provider.catalog';
  payload: {
    providers: Array<{
      id: string;
      name: string;
      family: string;
      apiBase?: string | undefined;
      envVars: string[];
      modelCount: number;
      hasApiKey: boolean;
    }>;
  };
}

export interface WSProviderModels {
  type: 'provider.models';
  payload: {
    provider: string;
    models: Array<{
      id: string;
      name: string;
      releaseDate?: string | undefined;
      contextWindow?: number | undefined;
      inputCost?: number | undefined;
      outputCost?: number | undefined;
      capabilities: string[];
    }>;
  };
}

export interface WSSavedProviders {
  type: 'providers.saved';
  payload: {
    providers: Array<{
      id: string;
      family?: string | undefined;
      baseUrl?: string | undefined;
      apiKeys: Array<{
        label: string;
        maskedKey: string;
        isActive: boolean;
        createdAt: string;
      }>;
    }>;
  };
}

export interface WSKeyOperationResult {
  type: 'key.operation_result';
  payload: {
    success: boolean;
    message: string;
  };
}

export interface WSFilesList {
  type: 'files.list';
  payload: {
    files: string[];
  };
}

export interface WSTodosUpdated {
  type: 'todos.updated';
  payload: {
    todos: Array<{
      id: string;
      content: string;
      status: 'pending' | 'in_progress' | 'completed';
      activeForm?: string | undefined;
    }>;
  };
}

export interface WSModesList {
  type: 'modes.list';
  payload: {
    modes: Array<{
      id: string;
      name: string;
      description: string;
      isActive: boolean;
    }>;
    activeId: string;
  };
}

/** AutoPhase live state broadcast (see server/autophase-ws-handler.ts). */
export interface WSAutoPhaseState {
  type: 'autophase.state';
  payload: Record<string, unknown>;
}

/** One worktree lane in the swim-lane / DAG view. */
export interface WorktreeHandleView {
  handleId: string;
  ownerId: string;
  ownerLabel: string;
  branch: string;
  baseBranch: string;
  status:
    | 'allocating'
    | 'active'
    | 'committing'
    | 'merging'
    | 'merged'
    | 'needs-review'
    | 'failed';
  insertions: number;
  deletions: number;
  files: number;
  conflictFiles?: string[] | undefined;
  allocatedAt: number;
  lastEventAt: number;
  recentActivity: Array<{ kind: string; text: string; at: number }>;
}

/** Full worktree snapshot (broadcast on a timer, see worktree-ws-handler.ts). */
export interface WSWorktreeState {
  type: 'worktree.state';
  payload: { worktrees: WorktreeHandleView[]; baseBranch: string };
}

/** Incremental worktree lifecycle event — drives the flowing activity strip. */
export interface WSWorktreeEvent {
  type: 'worktree.event';
  payload: { kind: string; handleId: string; text: string; at: number };
}

export type WSClientMessage =
  | WSUserMessage
  | WSToolConfirmResult
  | { type: 'autophase.start'; payload: { title: string; phases?: unknown[] | undefined; autonomous?: boolean | undefined } }
  | { type: 'autophase.pause'; payload: Record<string, never> }
  | { type: 'autophase.resume'; payload: Record<string, never> }
  | { type: 'autophase.stop'; payload: Record<string, never> }
  | { type: 'autophase.toggleAutonomous'; payload: { autonomous?: boolean | undefined } }
  | { type: 'autophase.selectPhase'; payload: { phaseId: string } }
  | { type: 'autophase.taskStatus'; payload: { taskId: string; status: string } }
  | { type: 'abort'; payload: Record<string, never> }
  | { type: 'session.resume'; payload: { id: string } }
  | { type: 'session.new' }
  | { type: 'session.checkpoints' }
  | { type: 'session.rewind'; payload: { checkpointIndex: number } }
  | { type: 'context.clear' }
  | { type: 'context.compact'; payload: { aggressive: boolean } }
  | { type: 'context.repair' }
  | { type: 'context.debug' }
  | { type: 'context.modes.list' }
  | { type: 'context.mode.switch'; payload: { id: string } }
  | { type: 'context.mode.create'; payload: { id: string; name: string; description: string; thresholds: { warn: number; soft: number; hard: number }; preserveK: number; eliseThreshold: number } }
  | { type: 'context.mode.update'; payload: { id: string; name?: string | undefined; description?: string | undefined; thresholds?: { warn?: number | undefined; soft?: number | undefined; hard?: number | undefined } | undefined; preserveK?: number | undefined; eliseThreshold?: number | undefined } }
  | { type: 'context.mode.delete'; payload: { id: string } }
  | WSModelSwitch
  | { type: 'providers.list' }
  | { type: 'provider.models'; payload: { providerId: string } }
  | { type: 'providers.saved' }
  | { type: 'key.add'; payload: { providerId: string; label: string; apiKey: string } }
  | { type: 'key.update'; payload: { providerId: string; label: string; apiKey: string } }
  | { type: 'key.delete'; payload: { providerId: string; label: string } }
  | { type: 'key.set_active'; payload: { providerId: string; label: string } }
  | {
      type: 'provider.add';
      payload: { id: string; family: string; baseUrl?: string | undefined; apiKey?: string | undefined };
    }
  | { type: 'provider.remove'; payload: { providerId: string } }
  | { type: 'tools.list' }
  | { type: 'memory.list' }
  | { type: 'memory.remember'; payload: { text: string; scope?: MemoryScope | undefined } }
  | { type: 'memory.forget'; payload: { text: string; scope?: MemoryScope | undefined } }
  | { type: 'skills.list' }
  | { type: 'diag.get' }
  | { type: 'stats.get' }
  | { type: 'session.save' }
  | { type: 'sessions.list'; payload: { limit: number } }
  | { type: 'session.delete'; payload: { id: string } }
  | { type: 'modes.list' }
  | { type: 'mode.switch'; payload: { id: string } }
  | { type: 'files.list'; payload: { query?: string | undefined; limit?: number | undefined } }
  | { type: 'files.tree'; payload: Record<string, never> }
  | { type: 'files.read'; payload: { filePath: string } }
  | { type: 'files.write'; payload: { filePath: string; content: string } }
  | { type: 'todos.get' }
  | { type: 'todos.clear' }
  | { type: 'todos.remove'; payload: { id?: string | undefined; index?: number | undefined } }
  | { type: 'tasks.get' }
  | { type: 'plan.get' }
  | { type: 'ping' }
  | { type: 'process.list' }
  | { type: 'process.kill'; payload: { pid: number } }
  | { type: 'process.killAll' }
  | { type: 'goal.get' }
  | { type: 'autonomy.switch'; payload: { mode: string } }
  | { type: 'prefs.update'; payload: Record<string, unknown> }
  | { type: 'prefs.get' }
  | WSCollabJoin
  | WSCollabLeave
  | WSCollabAnnotate
  | WSCollabResolve
  | WSCollabRequestPause
  | WSCollabResume
  | WSCollabGrantControl
  | WSCollabInjectTool;

export type WSServerMessage =
  | WSSessionStart
  | WSSessionEnd
  | WSTextDelta
  | WSThinkingDelta
  | WSToolUseStart
  | WSToolProgress
  | WSToolExecuted
  | WSIterationStarted
  | WSIterationCompleted
  | WSProviderResponse
  | WSRunResult
  | WSSessionStats
  | WSError
  | WSToolConfirmNeeded
  | WSContextDebug
  | WSContextCompacted
  | WSContextRepaired
  | WSContextModesList
  | WSContextModeChanged
  | WSToolsList
  | WSMemoryList
  | WSSkillsList
  | WSDiagGet
  | WSStatsGet
  | WSSessionsList
  | WSProviderCatalog
  | WSProviderModels
  | WSSavedProviders
  | WSKeyOperationResult
  | WSFilesList
  | { type: 'files.tree'; payload: { root: string; tree: unknown[]; error?: string | undefined } }
  | { type: 'files.read'; payload: { filePath: string; content: string; error?: string | undefined } }
  | { type: 'files.written'; payload: { filePath: string; success: boolean; error?: string | undefined } }
  | WSTodosUpdated
  | WSModesList
  | WSAutoPhaseState
  | WSWorktreeState
  | WSWorktreeEvent
  | WSCollabState
  | WSCollabParticipantJoined
  | WSCollabParticipantLeft
  | WSCollabEvent
  | WSCollabAnnotationAdded
  | WSCollabAnnotationResolved
  | WSCollabPauseGranted
  | WSCollabPauseReleased
  | WSCollabInjectionGranted
  | { type: 'session.checkpoints'; payload: { checkpoints: Array<{ index: number; iteration: number; timestamp: string; label: string; messageCount: number; tokens: number }> } }
  | { type: 'goal.updated'; payload: Record<string, unknown> | null }
  | { type: 'prefs.updated'; payload: Record<string, unknown> }
  | { type: 'process.list'; payload: { processes: Array<{ pid: number; command: string; tool: string; startedAt: number; status: 'running' | 'exited' | 'killed'; protected?: boolean | undefined }> } };

// Helper to broadcast to all clients
export type BroadcastFn = (msg: WSServerMessage) => void;

/** Narrow type for CollabPanel event handlers — only collab-related messages + errors. */
export type CollabPanelMessage =
  | WSCollabState
  | WSCollabParticipantJoined
  | WSCollabParticipantLeft
  | WSCollabAnnotationAdded
  | WSCollabAnnotationResolved
  | WSCollabPauseGranted
  | WSCollabPauseReleased
  | WSCollabInjectionGranted
  | WSError;

// ── Collaboration (Phase 1 of idea #13) ────────────────────────────────────
// Passive read-only session observer: a second client can join an active
// agent run and watch a live mirror of the kernel's iteration / tool /
// subagent events. Annotation and control hand-off land in Phase 2/3.

/**
 * Roles a collaboration participant can hold. The string union is the
 * wire contract — adding new roles (e.g. `controller`) in later phases
 * is a backward-compatible widening of this type as long as the server
 * gracefully rejects roles it does not yet implement.
 */
export type CollabRole = 'observer' | 'annotator' | 'controller';

// ── Client → Server ───────────────────────────────────────────────────────

export interface WSCollabJoin {
  type: 'collab.join';
  payload: { sessionId: string; role: CollabRole };
}

export interface WSCollabLeave {
  type: 'collab.leave';
  payload: { sessionId: string };
}

/**
 * Annotate a specific event in the session log. The `atEventIndex`
 * is a stable pointer the UI can scroll to / highlight. The server
 * persists the annotation and broadcasts it to every participant
 * in the same session, including the author.
 */
export interface WSCollabAnnotate {
  type: 'collab.annotate';
  payload: { sessionId: string; atEventIndex: number; text: string };
}

/** Mark an existing annotation as resolved. */
export interface WSCollabResolve {
  type: 'collab.resolve';
  payload: { sessionId: string; annotationId: string };
}

// ── Server → Client ───────────────────────────────────────────────────────

/** Sent on connect and every 2s while at least one participant is watching. */
export interface WSCollabState {
  type: 'collab.state';
  payload: {
    sessionId: string;
    participants: Array<{
      participantId: string;
      role: CollabRole;
      joinedAt: string;
    }>;
  };
}

/** Broadcast when a new participant joins the session. */
export interface WSCollabParticipantJoined {
  type: 'collab.participant.joined';
  payload: {
    participantId: string;
    sessionId: string;
    role: CollabRole;
    joinedAt: string;
  };
}

/** Broadcast when a participant leaves (explicit leave or WS close/error). */
export interface WSCollabParticipantLeft {
  type: 'collab.participant.left';
  payload: { participantId: string; sessionId: string };
}

/** Broadcast when a new annotation is added. Sent to all participants. */
export interface WSCollabAnnotationAdded {
  type: 'collab.annotation.added';
  payload: {
    sessionId: string;
    annotation: {
      id: string;
      atEventIndex: number;
      authorId: string;
      authorRole: 'annotator';
      text: string;
      createdAt: string;
      resolved: boolean;
    };
  };
}

/** Broadcast when an annotation is resolved. Sent to all participants. */
export interface WSCollabAnnotationResolved {
  type: 'collab.annotation.resolved';
  payload: {
    sessionId: string;
    annotationId: string;
    resolvedBy: string;
    resolvedAt: string;
  };
}

// ── Controller (Phase 3) ───────────────────────────────────────────────────
// The `controller` role can request a pause on the agent loop, resume
// it, and (later) inject manual tool calls. The pause/resume state is
// process-wide (single agent run per webui); the bus carries it.

/** Client → server: controller asks the agent loop to pause before the next tool call. */
export interface WSCollabRequestPause {
  type: 'collab.request_pause';
  payload: { sessionId: string };
}

/** Client → server: controller (or owner) clears the pause. */
export interface WSCollabResume {
  type: 'collab.resume';
  payload: { sessionId: string };
}

/**
 * Client → server: owner hands the controller role to a different
 * participant. The current implementation is metadata-only — the
 * existing controller's effective permissions don't change yet;
 * the wire is reserved for a future iteration where per-participant
 * RBAC becomes dynamic.
 */
export interface WSCollabGrantControl {
  type: 'collab.grant_control';
  payload: { sessionId: string; toParticipant: string };
}

/** Server → client: the bus transitioned to paused (controller's pause took effect). */
export interface WSCollabPauseGranted {
  type: 'collab.pause.granted';
  payload: {
    sessionId: string;
    pausedBy: string;
    pausedAt: string;
    /**
     * How long until the middleware auto-resumes (in ms). Clients
     * can render a countdown. Defaults to 60_000 on the server.
     */
    autoResumeInMs: number;
  };
}

/** Server → client: the bus transitioned back to running. */
export interface WSCollabPauseReleased {
  type: 'collab.pause.released';
  payload: {
    sessionId: string;
    /** 'controller' when a participant asked; 'timeout' when the middleware fired auto-resume. */
    reason: 'controller' | 'timeout';
    at: string;
  };
}

/**
 * Generic envelope wrapping a kernel event mirrored to observers.
 * `kind` matches the original kernel event name (e.g. `tool.started`),
 * `payload` is the original event payload (best-effort serialized),
 * `at` is the broadcast timestamp.
 *
 * `replay` is true when the event was sent from the on-disk session
 * log to a late-joining observer (Phase 1.5). Live events leave it
 * undefined. Clients use the flag to render a "history" affordance
 * (e.g. dim the styling or annotate the timestamp as "[joined late]").
 */
export interface WSCollabEvent {
  type: 'collab.event';
  payload: { kind: string; payload: unknown; at: string; replay?: boolean | undefined };
}

// ── Phase 4: manual tool-call injection (controller only) ───────────────────

/**
 * Client → server: a controller injects a synthetic tool_result for
 * the given tool_use_id. The next time the agent's toolCall pipeline
 * sees that id, the real tool is skipped and the injected content
 * is used. The injection is one-shot — consumed on first match.
 */
export interface WSCollabInjectTool {
  type: 'collab.inject_tool';
  payload: {
    sessionId: string;
    toolUseId: string;
    /** String or JSON-serializable value. */
    content: unknown;
    isError: boolean;
    /** Free-form context surfaced in the broadcast and audit log. */
    reason: string;
  };
}

/**
 * Server → client: an injection was queued or consumed. Sent to
 * every participant so observers can show "the controller just
 * replaced the tool result for tool X".
 */
export interface WSCollabInjectionGranted {
  type: 'collab.injection.granted';
  payload: {
    sessionId: string;
    toolUseId: string;
    toolName: string;
    authorId: string;
    reason: string;
    isError: boolean;
    /** 'queued' or 'consumed' — the bus does both. */
    phase: 'queued' | 'consumed';
    at: string;
  };
}
