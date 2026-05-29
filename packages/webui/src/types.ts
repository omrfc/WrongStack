import type { ContentBlock, TextBlock, ToolUseBlock } from '@wrongstack/core';
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
    maxContext?: number;
    projectName?: string;
    cwd?: string;
    mode?: string;
    contextMode?: string;
    inputCost?: number;
    outputCost?: number;
    cacheReadCost?: number;
    reset?: boolean;
    replayMessages?: Array<{ role: string; content: unknown }>;
    replayUsage?: Usage;
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
    input?: unknown;
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
      text?: string;
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
    input?: unknown;
    output?: string;
  };
}

export interface WSIterationStarted {
  type: 'iteration.started';
  payload: {
    index: number;
    maxIterations?: number;
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
    finalText?: string;
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
    mode?: string;
    policy?: unknown;
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
    beforeMessages?: number;
    afterMessages?: number;
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
    error?: string;
  };
}

export interface WSSkillsList {
  type: 'skills.list';
  payload: {
    enabled: boolean;
    error?: string;
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
    usage: { input: number; output: number; cacheRead?: number };
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
    usage: { input: number; output: number; cacheRead?: number; cacheWrite?: number };
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
    error?: string;
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
      apiBase?: string;
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
      releaseDate?: string;
      contextWindow?: number;
      inputCost?: number;
      outputCost?: number;
      capabilities: string[];
    }>;
  };
}

export interface WSSavedProviders {
  type: 'providers.saved';
  payload: {
    providers: Array<{
      id: string;
      family?: string;
      baseUrl?: string;
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
      activeForm?: string;
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
  conflictFiles?: string[];
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
  | { type: 'autophase.start'; payload: { title: string; phases?: unknown[]; autonomous?: boolean } }
  | { type: 'autophase.pause'; payload: Record<string, never> }
  | { type: 'autophase.resume'; payload: Record<string, never> }
  | { type: 'autophase.stop'; payload: Record<string, never> }
  | { type: 'autophase.toggleAutonomous'; payload: { autonomous?: boolean } }
  | { type: 'autophase.selectPhase'; payload: { phaseId: string } }
  | { type: 'autophase.taskStatus'; payload: { taskId: string; status: string } }
  | { type: 'abort'; payload: Record<string, never> }
  | { type: 'session.resume'; payload: { id: string } }
  | { type: 'session.new' }
  | { type: 'context.clear' }
  | { type: 'context.compact'; payload: { aggressive: boolean } }
  | { type: 'context.repair' }
  | { type: 'context.debug' }
  | { type: 'context.modes.list' }
  | { type: 'context.mode.switch'; payload: { id: string } }
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
      payload: { id: string; family: string; baseUrl?: string; apiKey?: string };
    }
  | { type: 'provider.remove'; payload: { providerId: string } }
  | { type: 'tools.list' }
  | { type: 'memory.list' }
  | { type: 'memory.remember'; payload: { text: string; scope?: MemoryScope } }
  | { type: 'memory.forget'; payload: { text: string; scope?: MemoryScope } }
  | { type: 'skills.list' }
  | { type: 'diag.get' }
  | { type: 'stats.get' }
  | { type: 'session.save' }
  | { type: 'sessions.list'; payload: { limit: number } }
  | { type: 'session.delete'; payload: { id: string } }
  | { type: 'modes.list' }
  | { type: 'mode.switch'; payload: { id: string } }
  | { type: 'files.list'; payload: { query?: string; limit?: number } }
  | { type: 'todos.get' }
  | { type: 'todos.clear' }
  | { type: 'ping' };

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
  | WSTodosUpdated
  | WSModesList
  | WSAutoPhaseState
  | WSWorktreeState
  | WSWorktreeEvent;

// Helper to broadcast to all clients
export type BroadcastFn = (msg: WSServerMessage) => void;
