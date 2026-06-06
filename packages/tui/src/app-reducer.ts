// Reducer + State/Action types extracted from app.tsx.
// This file has NO React or Ink dependencies — pure state transformation.
import type { AutonomyStage, ContentBlock } from '@wrongstack/core';
import type { AutonomyOption } from './components/autonomy-picker.js';
import type { HistoryEntry } from './components/history.js';
import type { ProviderOption } from './components/model-picker.js';
import type {
  AuditLevel,
  CompactorStrategy,
  LogLevel,
  SettingsMode,
} from './components/settings-picker.js';
import {
  AUDIT_LEVELS,
  COMPACTOR_STRATEGIES,
  DELAY_PRESETS_MS,
  LOG_LEVELS,
  MAX_ITERATIONS_PRESETS,
  SETTINGS_FIELD_COUNT,
  SETTINGS_MODES,
} from './components/settings-picker.js';
import type { WorktreeRow } from './components/worktree-panel.js';

export interface QueueItem {
  id: number;
  displayText: string;
  blocks: ContentBlock[];
}

/** Per-subagent state tracked live from the FleetBus. */
export interface FleetEntry {
  id: string;
  name: string;
  provider?: string;
  model?: string;
  status: 'idle' | 'running' | 'success' | 'failed' | 'timeout' | 'stopped';
  streamingText: string;
  iterations: number;
  toolCalls: number;
  recentTools: Array<{
    name: string;
    ok?: boolean;
    durationMs?: number;
    outputBytes?: number;
    outputLines?: number;
    at: number;
  }>;
  recentMessages: Array<{ text: string; at: number }>;
  cost: number;
  startedAt: number;
  lastEventAt: number;
  /**
   * Tool the subagent is currently inside, set on `tool.started` and
   * cleared on `tool.executed`. Lets the FleetPanel render "running →
   * bash" instead of an opaque "running". Undefined when no tool is
   * mid-flight (between iterations, before the first tool, or after
   * the last tool of a run).
   */
  currentTool?: { name: string; startedAt: number };
  /**
   * Absolute path to the per-subagent JSONL transcript on disk, when
   * one was created. Surfaced so the FleetPanel can render `path:`
   * dim under the entry — users grep / tail the file for full
   * visibility into the subagent's run.
   */
  transcriptPath?: string;
  /**
   * Most recent budget warning: subagent hit a soft limit and the
   * coordinator is auto-extending. Rendered in FleetPanel as:
   * "⚡ hitting tool_calls limit (350/400) — extending"
   * Cleared on the next fleetDone or fleetStart.
   */
  budgetWarning?: { kind: string; used: number; limit: number; at: number };
  /**
   * Cumulative auto-extension grants for this subagent. Surfaced as a
   * persistent "⚡×N" badge in the monitor and 4th status line so the user
   * can see how often never-die kept the agent alive. Survives across tasks
   * within the same subagent entry (unlike `budgetWarning`, which clears).
   */
  extensions?: number;
  /**
   * Latest context window fill percentage (0–1, can exceed 1 when over budget).
   * Emitted on every `iteration.completed` via `ctx.pct` event.
   * Rendered as a colored progress bar in the AgentsMonitor.
   */
  ctxPct?: number;
  /** Estimated total tokens in the context window (from ctx.pct event). */
  ctxTokens?: number;
  /** Provider's max context window in tokens (from ctx.pct event). */
  ctxMaxTokens?: number;
  /**
   * Human-readable reason for terminal failure, when known.
   * E.g. "provider_auth", "rate_limit", "timeout", "budget_iterations".
   * Shown in the Fleet timeline and the per-agent card in the agents monitor.
   */
  failureReason?: string;
}

/** A registered slash command matched against the user's current / query. */
export interface SlashCommandMatch {
  name: string;
  description: string;
  argsHint?: string;
  isBuiltin: boolean;
  category: 'Run' | 'Session' | 'Inspect' | 'Agent' | 'Config' | 'App';
}

type DraftEntry = HistoryEntry extends infer T
  ? T extends { id: number }
    ? Omit<T, 'id'>
    : never
  : never;

type GoalSummary = {
  goal: string;
  goalState: 'active' | 'paused' | 'completed' | 'abandoned';
  iterations: number;
  lastTask?: string;
  lastStatus?: string;
} | null;

export type State = {
  entries: HistoryEntry[];
  buffer: string;
  cursor: number;
  streamingText: string;
  /**
   * Live tail of the currently streaming tool's stdout/progress text. Mirrors
   * the assistant `streamingText` pattern but is keyed by tool_use id so the
   * tail is cleared automatically when that tool finishes. Only one tool's
   * stream is shown at a time — multi-tool streaming is rare and stacking
   * tails fights for the same screen space.
   */
  toolStream: { toolUseId: string; name: string; text: string; startedAt: number } | null;
  status: 'idle' | 'running' | 'streaming' | 'aborting';
  interrupts: number;
  /**
   * Set when the user pressed Esc mid-iteration to interrupt the agent.
   * The NEXT submitted user message gets a STEERING prefix block prepended
   * so the model sees "I interrupted you on purpose — focus on this
   * instead of resuming the prior task". Cleared once that message
   * lands. Distinct from `interrupts` (which is the Ctrl+C exit ladder).
   */
  steeringPending: boolean;
  /**
   * Context snapshot captured at Esc time, replayed into the STEERING
   * preamble so the model sees exactly what it was mid-doing when the
   * user pulled the cord. Cleared together with `steeringPending`.
   * Without this the model has to guess from chat scrollback which
   * tools were live — and it can't see subagent state at all.
   */
  steerSnapshot: {
    runningTools: string[];
    subagents: Array<{ label: string; status: string; tool?: string }>;
    subagentsTerminated: number;
    partialAssistantText: string;
  } | null;
  hint: string;
  brain: {
    state: 'idle' | 'deciding' | 'answered' | 'ask_human' | 'denied';
    source?: string;
    risk?: 'low' | 'medium' | 'high' | 'critical';
    summary?: string;
    updatedAt?: number;
  };
  brainPrompt: {
    requestId: string;
    source: string;
    risk: 'low' | 'medium' | 'high' | 'critical';
    question: string;
    context?: string;
    options?: Array<{
      id: string;
      label: string;
      risk?: string;
      consequence?: string;
      recommended?: boolean;
    }>;
  } | null;
  nextId: number;
  picker: { open: boolean; query: string; matches: string[]; selected: number };
  /** Slash command picker — open while typing a / command. */
  slashPicker: { open: boolean; query: string; matches: SlashCommandMatch[]; selected: number };
  /** Tool calls currently in-flight, by tool_use id. Surface in the status bar. */
  runningTools: Map<string, { name: string; startedAt: number }>;
  /** FIFO of user messages typed while the agent was running. Drained when idle. */
  queue: QueueItem[];
  nextQueueId: number;
  /** Previous input strings for up/down navigation. */
  inputHistory: string[];
  /** 0 = current buffer (not in history), 1 = most recent, n = nth most recent. */
  historyIndex: number;
  /** Two-step model picker (provider → model) — opened by `/model`. */
  modelPicker: {
    open: boolean;
    step: 'provider' | 'model';
    providerOptions: ProviderOption[];
    modelOptions: string[];
    /** Filtered list shown in step 2 (same as modelOptions when searchQuery is empty). */
    filteredOptions: string[];
    selected: number;
    pickedProviderId?: string;
    hint?: string;
    /** Live search filter in step 2. */
    searchQuery: string;
  };
  /** Single-step autonomy mode picker — opened by `/autonomy`. */
  autonomyPicker: {
    open: boolean;
    options: AutonomyOption[];
    selected: number;
    hint?: string;
  };
  /** Settings editor — opened by `/settings` or Ctrl+S. */
  settingsPicker: {
    open: boolean;
    /** Focused row index. */
    field: number;
    // Autonomy
    mode: SettingsMode;
    delayMs: number;
    // UX
    titleAnimation: boolean;
    yolo: boolean;
    streamFleet: boolean;
    chime: boolean;
    confirmExit: boolean;
    nextPrediction: boolean;
    // Features
    featureMcp: boolean;
    featurePlugins: boolean;
    featureMemory: boolean;
    featureSkills: boolean;
    featureModelsRegistry: boolean;
    // Context
    contextAutoCompact: boolean;
    contextStrategy: CompactorStrategy;
    // Logging
    logLevel: LogLevel;
    // Session
    auditLevel: AuditLevel;
    // Indexing
    indexOnStart: boolean;
    // Tools
    maxIterations: number;
    hint?: string;
  };
  /** Pending tool confirmations — queue to handle multiple tools requesting confirmation. */
  confirmQueue: {
    toolUseId: string;
    toolName: string;
    input: unknown;
    suggestedPattern: string;
    resolve: (decision: 'yes' | 'no' | 'always' | 'deny') => void;
  }[];
  /**
   * Active prompt-refinement ("did you mean this?") panel. Set while the
   * EnhancePanel is shown after the refiner rewrites a user message; the
   * panel resolves to one of refined/original/edit and `submit()` continues.
   * Null when no refinement is pending.
   */
  enhance: {
    original: string;
    refined: string;
    resolve: (decision: 'refined' | 'original' | 'edit') => void;
  } | null;
  /** When true, free-text submits are run through the prompt refiner first. Toggled by `/enhance`. */
  enhanceEnabled: boolean;
  /** True while the refiner LLM call is in flight (before the panel appears). Drives a "refining…" indicator. */
  enhanceBusy: boolean;
  /** Incremented on /clear so the context chip re-reads from agent.ctx tokens. */
  contextChipVersion: number;
  /** Live fleet state: per-subagent entries from FleetBus events. Keyed by subagentId. */
  fleet: Record<string, FleetEntry>;
  /**
   * Leader-loop activity, synthesized for the AgentsMonitor overlay so the
   * user can see leader iteration / tool counts alongside subagent rows.
   * Driven by EventBus `iteration.started`/`iteration.completed`/`tool.started`/`tool.executed`.
   * Always present; renders as AGENT#0 LEADER in the monitor regardless of
   * whether any subagents exist.
   */
  leader: {
    iterations: number;
    toolCalls: number;
    recentTools: Array<{ name: string; ok?: boolean; durationMs?: number; at: number }>;
    currentTool?: { name: string; startedAt: number };
    startedAt: number;
    lastEventAt: number;
    /** True while inside an iteration (between iteration.started and iteration.completed). */
    iterating: boolean;
    /** Latest context window fill fraction (from ctx.pct event). */
    ctxPct?: number;
    /** Estimated total tokens in context window. */
    ctxTokens?: number;
    /** Provider max context in tokens. */
    ctxMaxTokens?: number;
  };
  /** Fleet-wide accumulated cost. */
  fleetCost: number;
  /** Fleet-wide token totals from the usage aggregator, for the monitor gauge. */
  fleetTokens: { input: number; output: number };
  /** Live concurrency ceiling — updated by /fleet concurrency and concurrency.changed event. */
  fleetConcurrency: number;
  /**
   * When true, subagent text activity is
   * streamed into the main history with an `AGENT#N` prefix. Toggled
   * with `/fleet stream on|off`. Tool calls stay in the live fleet
   * surfaces so chat history remains readable during multi-agent runs.
   */
  streamFleet: boolean;
  /** When true, the full graphical fleet monitor overlay is shown (Ctrl+F). */
  monitorOpen: boolean;
  /** When true, the agents monitor overlay is shown (Ctrl+G). */
  agentsMonitorOpen: boolean;
  /** When true, the keys-&-commands help overlay is shown (`?` on an empty prompt). */
  helpOpen: boolean;
  /** When true, the todos monitor overlay is shown (F6). */
  todosMonitorOpen: boolean;
  /** When true, the queue panel is shown (F7). */
  queuePanelOpen: boolean;
  /**
   * Active or completed collaborative debugging session state.
   * Null when no collab session has run. Tracks counts + the event timeline
   * so FleetMonitor can render a live "COLLAB SESSION" banner and per-event
   * entries (bug.found / refactor.plan / critic.evaluation) as they arrive.
   */
  collabSession: {
    /** Null until the first collab subagent spawns; set on first bug.found. */
    sessionId: string | null;
    bugCount: number;
    planCount: number;
    evalCount: number;
    /** Most recent overall verdict when the session completes. */
    overallVerdict: 'approve' | 'needs_revision' | 'reject' | null;
    /** Timeline of collab events for the FleetMonitor overlay. */
    timeline: Array<{ at: number; icon: string; color: string; text: string }>;
    startedAt: number | null;
  } | null;
  /** Session checkpoints recorded by SessionWriter.writeCheckpoint() events. */
  checkpoints: Array<{
    promptIndex: number;
    promptPreview: string;
    ts: string;
    fileCount: number;
  }>;
  /** Checkpoint timeline overlay — null when closed. */
  rewindOverlay: {
    checkpoints: Array<{
      promptIndex: number;
      promptPreview: string;
      ts: string;
      fileCount: number;
    }>;
    selected: number;
  } | null;
  /** Live iteration-stage of the active autonomy engine. */
  eternalStage: AutonomyStage | null;
  /** Loaded from .wrongstack/goal.json on mount for startup banner. */
  goalSummary: GoalSummary;
  /** AutoPhase orchestrator state — rendered by PhaseMonitor. */
  autoPhase: {
    /** AutoPhase graph title. */
    title: string;
    /** Per-phase task summary, keyed by phaseId. */
    phases: Record<
      string,
      {
        name: string;
        status: string;
        completedTasks: number;
        totalTasks: number;
        startedAt?: number;
      }
    >;
    /** Active phase IDs (running phases). */
    runningPhaseIds: string[];
    /** Elapsed ms since graph start — drives the elapsed counter. */
    elapsedMs: number;
    /** True while the monitor overlay is open (Ctrl+P). */
    monitorOpen: boolean;
  } | null;
  /** Git-worktree isolation state — rendered by WorktreePanel/WorktreeMonitor. */
  worktrees: Record<string, WorktreeRow & { baseBranch?: string }>;
  /** Base branch worktrees fork from (for the monitor header). */
  worktreeBase?: string;
  /** True while the worktree monitor overlay is open (Ctrl+T). */
  worktreeMonitorOpen: boolean;
  /**
   * In-app chat scroll state for the scrollable viewport.
   * In the default `<Static>` path these are inert.
   *   scrollOffset    — rows scrolled up from the bottom; 0 = pinned to newest.
   *   totalLines      — last measured content height (rows), from onMeasure.
   *   viewportRows    — last computed viewport height (rows).
   *   pendingNewLines — rows added while scrolled up; drives the "↓ N new" hint.
   */
  scrollOffset: number;
  totalLines: number;
  viewportRows: number;
  pendingNewLines: number;
};

export type Action =
  | { type: 'addEntry'; entry: DraftEntry }
  | { type: 'setBuffer'; buffer: string; cursor: number }
  | { type: 'clearInput' }
  | { type: 'clearHistory' }
  | { type: 'streamDelta'; delta: string }
  | { type: 'streamReset' }
  | { type: 'status'; status: State['status'] }
  | { type: 'interrupt' }
  | { type: 'resetInterrupts' }
  /**
   * User pressed Esc mid-iteration — flag the next message for steering
   * AND stash a context snapshot so the preamble can tell the model
   * exactly what it was doing.
   */
  | { type: 'steerStart'; snapshot: State['steerSnapshot'] }
  /** Submit handler consumed the steering flag; reset. */
  | { type: 'steerConsume' }
  | { type: 'hint'; text: string }
  | {
      type: 'brainStatus';
      state: State['brain']['state'];
      source?: string;
      risk?: State['brain']['risk'];
      summary?: string;
    }
  | { type: 'brainPromptSet'; prompt: NonNullable<State['brainPrompt']> }
  | { type: 'brainPromptClear' }
  | { type: 'pickerOpen'; query: string }
  | { type: 'pickerClose' }
  | { type: 'pickerSetMatches'; query: string; matches: string[] }
  | { type: 'pickerMove'; delta: number }
  | { type: 'toolStarted'; id: string; name: string }
  | { type: 'toolEnded'; id?: string; name?: string }
  | { type: 'toolStreamAppend'; toolUseId: string; name: string; text: string; startedAt: number }
  | { type: 'toolStreamClear'; toolUseId?: string; name?: string }
  | { type: 'enqueue'; item: Omit<QueueItem, 'id'> }
  | { type: 'dequeueFirst' }
  | { type: 'queueClear' }
  | { type: 'queueDelete'; positions: number[] }
  | { type: 'slashPickerOpen'; query: string; matches: SlashCommandMatch[] }
  | { type: 'slashPickerClose' }
  | { type: 'slashPickerMove'; delta: number }
  | { type: 'modelPickerOpen'; providers: ProviderOption[] }
  | { type: 'modelPickerClose' }
  | { type: 'modelPickerMove'; delta: number }
  | { type: 'modelPickerPickProvider'; providerId: string; models: string[] }
  | { type: 'modelPickerBack' }
  | { type: 'modelPickerHint'; text?: string }
  /** Update the search filter in step 2. */
  | { type: 'modelPickerSearch'; query: string }
  | { type: 'autonomyPickerOpen'; options: AutonomyOption[] }
  | { type: 'autonomyPickerClose' }
  | { type: 'autonomyPickerMove'; delta: number }
  | { type: 'autonomyPickerHint'; text?: string }
  | {
      type: 'settingsOpen';
      mode: SettingsMode;
      delayMs: number;
      titleAnimation: boolean;
      yolo: boolean;
      streamFleet: boolean;
      chime: boolean;
      confirmExit: boolean;
      nextPrediction: boolean;
      featureMcp: boolean;
      featurePlugins: boolean;
      featureMemory: boolean;
      featureSkills: boolean;
      featureModelsRegistry: boolean;
      contextAutoCompact: boolean;
      contextStrategy: CompactorStrategy;
      logLevel: LogLevel;
      auditLevel: AuditLevel;
      indexOnStart: boolean;
      maxIterations: number;
    }
  | { type: 'settingsClose' }
  | { type: 'settingsFieldMove'; delta: number }
  | { type: 'settingsFieldSet'; field: number }
  | { type: 'settingsValueChange'; delta: number }
  | { type: 'settingsHint'; text?: string }
  | { type: 'historyPush'; text: string }
  | { type: 'historyUp' }
  | { type: 'historyDown' }
  | { type: 'confirmOpen'; info: State['confirmQueue'][0] }
  | { type: 'confirmClose' }
  | { type: 'enhanceOpen'; info: NonNullable<State['enhance']> }
  | { type: 'enhanceClose' }
  | { type: 'enhanceSet'; enabled: boolean }
  | { type: 'enhanceBusy'; on: boolean }
  | { type: 'resetContextChip' }
  // Fleet actions
  | { type: 'fleetSeed'; entries: FleetEntry[]; cost: number }
  | {
      type: 'fleetSpawn';
      id: string;
      name?: string;
      provider?: string;
      model?: string;
      transcriptPath?: string;
    }
  | { type: 'fleetStart'; id: string; taskId?: string }
  | { type: 'fleetDelta'; id: string; text: string }
  | { type: 'fleetMessage'; id: string; text: string }
  | {
      type: 'fleetTool';
      id: string;
      name?: string;
      ok?: boolean;
      durationMs?: number;
      outputBytes?: number;
      outputLines?: number;
    }
  /** tool.started: pin the current tool name for status display. */
  | { type: 'fleetToolStart'; id: string; name: string }
  /** tool.executed: clear the current tool (paired with fleetTool). */
  | { type: 'fleetToolEnd'; id: string }
  | {
      type: 'fleetUsage';
      id: string;
      input: number;
      output: number;
      cacheRead: number;
      cacheWrite: number;
    }
  | {
      type: 'fleetDone';
      id: string;
      status: FleetEntry['status'];
      iterations: number;
      toolCalls: number;
      /** Human-readable failure reason, e.g. "provider_auth", "rate_limit", "timeout". */
      failureReason?: string;
    }
  | {
      type: 'fleetBudgetWarning';
      id: string;
      kind: string;
      used: number;
      limit: number;
    }
  | {
      type: 'fleetBudgetExtended';
      id: string;
      totalExtensions: number;
    }
  | {
      type: 'fleetCtxPct';
      id: string;
      load: number;
      tokens: number;
      maxContext: number;
    }
  | {
      type: 'fleetCost';
      cost: number;
      input?: number;
      output?: number;
      /** Per-subagent usage keyed by subagent id (from the director snapshot). */
      perAgent?: Record<string, { cost: number }>;
    }
  /** Runtime concurrency ceiling change from CLI /fleet concurrency <n>. */
  | { type: 'fleetConcurrency'; n: number }
  | { type: 'leaderIterStart' }
  | { type: 'leaderIterEnd' }
  | { type: 'leaderToolStart'; name: string }
  | { type: 'leaderToolEnd'; name: string; ok?: boolean; durationMs?: number }
  | { type: 'leaderCtxPct'; load: number; tokens: number; maxContext: number }
  | { type: 'setStreamFleet'; enabled: boolean }
  | { type: 'toggleMonitor' }
  | { type: 'toggleAgentsMonitor' }
  | { type: 'toggleHelp' }
  | { type: 'toggleTodosMonitor' }
  | { type: 'toggleQueuePanel' }
  | { type: 'checkpointReceived'; cp: State['checkpoints'][0] }
  | { type: 'rewindOverlayOpen' }
  | { type: 'rewindOverlayClose' }
  | { type: 'rewindOverlayMove'; delta: number }
  | { type: 'sessionRewound'; toPromptIndex: number }
  | {
      type: 'eternalStage';
      stage: AutonomyStage;
    }
  | { type: 'goalSummary'; summary: GoalSummary }
  | { type: 'autoPhaseInit'; title: string }
  | {
      type: 'autoPhasePhaseUpdate';
      phaseId: string;
      name: string;
      status: string;
      completedTasks: number;
      totalTasks: number;
      startedAt?: number;
    }
  | { type: 'autoPhaseRunningPhases'; phaseIds: string[] }
  | { type: 'autoPhaseElapsed'; ms: number }
  | { type: 'autoPhaseMonitorToggle' }
  | { type: 'autoPhaseReset' }
  | {
      type: 'worktreeUpsert';
      handleId: string;
      row: Partial<WorktreeRow & { baseBranch?: string }>;
      baseBranch?: string;
    }
  | { type: 'worktreeRemove'; handleId: string }
  | { type: 'worktreeMonitorToggle' }
  // --- In-app chat scroll ---
  /** Scroll by `delta` rows: +up (older), -down (newer). Clamped. */
  | { type: 'scrollBy'; delta: number }
  | { type: 'scrollTo'; offset: number }
  /** Scroll by a viewport page in `dir`. */
  | { type: 'scrollPage'; dir: 'up' | 'down' }
  /** Jump to the newest output (pinned). */
  | { type: 'scrollToBottom' }
  /** Jump to the oldest output. */
  | { type: 'scrollToTop' }
  /** Report the measured content height; re-clamps offset + tracks new lines. */
  | { type: 'setMeasuredLines'; totalLines: number }
  /** Report the computed viewport height; re-clamps offset. */
  | { type: 'setViewportRows'; rows: number }
  /**
   * Fold a batch of fleet/display actions through the reducer in ONE pass so
   * a 150ms burst of subagent events produces a single React render instead
   * of one per event. Order-preserving; only high-frequency display events
   * are batched (correctness-sensitive events stay immediate).
   */
  | { type: 'fleetBatch'; actions: Action[] }
  /** BugHunter emitted a bug.found event on the FleetBus. */
  | {
      type: 'collabBugFound';
      sessionId: string;
      bugId: string;
      severity: string;
      description: string;
    }
  /** RefactorPlanner emitted a refactor.plan event on the FleetBus. */
  | {
      type: 'collabPlanEmitted';
      sessionId: string;
      planId: string;
      riskScore: string;
      phaseCount: number;
    }
  /** Critic emitted a critic.evaluation event on the FleetBus. */
  | {
      type: 'collabEvalComplete';
      sessionId: string;
      evalId: string;
      verdict: string;
      score: number;
    }
  /** Collab session completed — overall verdict is available. */
  | {
      type: 'collabSessionDone';
      sessionId: string;
      verdict: 'approve' | 'needs_revision' | 'reject';
    }
  /** A collab subagent (bug-hunter / refactor-planner / critic) was spawned. */
  | { type: 'collabSubagentSpawned'; subagentId: string; role: string };

export function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'addEntry': {
      // Append-only. We render finalized entries via Ink's <Static>,
      // which forbids removals or reordering — old items live on in the
      // terminal's native scrollback. Memory growth is bounded by the
      // terminal's own scrollback limits in practice.
      const appended = [...state.entries, { ...action.entry, id: state.nextId } as HistoryEntry];
      return { ...state, entries: appended, nextId: state.nextId + 1 };
    }
    case 'setBuffer':
      return { ...state, buffer: action.buffer, cursor: action.cursor };
    case 'clearInput':
      return {
        ...state,
        buffer: '',
        cursor: 0,
        historyIndex: 0,
        picker: { open: false, query: '', matches: [], selected: 0 },
        slashPicker: { open: false, query: '', matches: [], selected: 0 },
      };
    case 'clearHistory': {
      // Keep only the banner entry (always first, id=0). Any other entries
      // (user messages, assistant responses, slash results) are discarded so
      // the TUI starts fresh after /clear.
      const banner = state.entries.find((e) => e.kind === 'banner');
      return {
        ...state,
        entries: banner ? [banner] : state.entries,
        queue: [],
        nextQueueId: 1,
        scrollOffset: 0,
        pendingNewLines: 0,
        // Reset fleet state on /clear so old subagent entries don't
        // cause the LiveActivityStrip to render stale spacers, and
        // the fleet cost/tokens chips show zero.
        fleet: {},
        fleetCost: 0,
        fleetTokens: { input: 0, output: 0 },
        leader: {
          iterations: 0,
          toolCalls: 0,
          recentTools: [],
          currentTool: undefined,
          startedAt: Date.now(),
          lastEventAt: Date.now(),
          iterating: false,
        },
      };
    }
    case 'streamDelta':
      return { ...state, streamingText: state.streamingText + action.delta };
    case 'streamReset':
      return { ...state, streamingText: '' };
    case 'status':
      return { ...state, status: action.status };
    case 'interrupt':
      return { ...state, interrupts: state.interrupts + 1 };
    case 'steerStart':
      return { ...state, steeringPending: true, steerSnapshot: action.snapshot };
    case 'steerConsume':
      return { ...state, steeringPending: false, steerSnapshot: null, interrupts: 0 };
    case 'resetInterrupts':
      return { ...state, interrupts: 0 };
    case 'hint':
      return { ...state, hint: action.text };
    case 'brainStatus':
      return {
        ...state,
        brain: {
          state: action.state,
          source: action.source,
          risk: action.risk,
          summary: action.summary,
          updatedAt: Date.now(),
        },
      };
    case 'brainPromptSet':
      return { ...state, brainPrompt: action.prompt };
    case 'brainPromptClear':
      return { ...state, brainPrompt: null };
    case 'pickerOpen':
      return {
        ...state,
        picker: { open: true, query: action.query, matches: state.picker.matches, selected: 0 },
      };
    case 'pickerClose':
      return {
        ...state,
        picker: { open: false, query: '', matches: [], selected: 0 },
      };
    case 'pickerSetMatches':
      // Guard against stale async results — only apply if query still matches.
      if (!state.picker.open || state.picker.query !== action.query) return state;
      return {
        ...state,
        picker: {
          ...state.picker,
          matches: action.matches,
          selected: Math.min(state.picker.selected, Math.max(0, action.matches.length - 1)),
        },
      };
    case 'pickerMove': {
      const n = state.picker.matches.length;
      if (n === 0) return state;
      const next = (state.picker.selected + action.delta + n) % n;
      return { ...state, picker: { ...state.picker, selected: next } };
    }
    case 'toolStarted': {
      const next = new Map(state.runningTools);
      next.set(action.id, { name: action.name, startedAt: Date.now() });
      return { ...state, runningTools: next };
    }
    case 'toolEnded': {
      const next = new Map(state.runningTools);
      if (action.id !== undefined && next.has(action.id)) {
        next.delete(action.id);
        return { ...state, runningTools: next };
      }
      if (action.name !== undefined) {
        // Fall back to clearing the oldest running entry with this name —
        // `tool.executed` doesn't carry the tool_use id, so we approximate.
        for (const [id, info] of next) {
          if (info.name === action.name) {
            next.delete(id);
            return { ...state, runningTools: next };
          }
        }
      }
      return state;
    }
    case 'toolStreamAppend': {
      // Only one tool's stream is shown at a time. If a different tool is
      // currently streaming, switch — last writer wins. Streams from
      // not-yet-acknowledged tools take over as soon as data arrives, which
      // matches user intuition (whatever just produced output is what's
      // visible).
      const cur = state.toolStream;
      if (cur && cur.toolUseId === action.toolUseId) {
        return {
          ...state,
          toolStream: { ...cur, text: cur.text + action.text },
        };
      }
      return {
        ...state,
        toolStream: {
          toolUseId: action.toolUseId,
          name: action.name,
          text: action.text,
          startedAt: action.startedAt,
        },
      };
    }
    case 'toolStreamClear': {
      if (state.toolStream === null) return state;
      // Clear only when the finishing tool matches the streaming one. A
      // stale `tool.executed` for a different tool must not blank the
      // currently-visible stream.
      const t = state.toolStream;
      if (action.toolUseId !== undefined && action.toolUseId !== t.toolUseId) return state;
      if (action.name !== undefined && action.toolUseId === undefined && action.name !== t.name)
        return state;
      return { ...state, toolStream: null };
    }
    case 'enqueue': {
      const item: QueueItem = { ...action.item, id: state.nextQueueId };
      return {
        ...state,
        queue: [...state.queue, item],
        nextQueueId: state.nextQueueId + 1,
      };
    }
    case 'dequeueFirst': {
      if (state.queue.length === 0) return state;
      return { ...state, queue: state.queue.slice(1) };
    }
    case 'queueClear': {
      if (state.queue.length === 0) return state;
      return { ...state, queue: [] };
    }
    case 'queueDelete': {
      if (state.queue.length === 0 || action.positions.length === 0) return state;
      // Positions are 1-based; convert to 0-based set for fast filtering.
      const drop = new Set(action.positions.map((p) => p - 1).filter((i) => i >= 0));
      const filtered = state.queue.filter((_, i) => !drop.has(i));
      if (filtered.length === state.queue.length) return state;
      return { ...state, queue: filtered };
    }
    case 'slashPickerOpen':
      return {
        ...state,
        slashPicker: { open: true, query: action.query, matches: action.matches, selected: 0 },
      };
    case 'slashPickerClose':
      return {
        ...state,
        slashPicker: { open: false, query: '', matches: [], selected: 0 },
      };
    case 'slashPickerMove': {
      const n = state.slashPicker.matches.length;
      if (n === 0) return state;
      const next = (state.slashPicker.selected + action.delta + n) % n;
      return { ...state, slashPicker: { ...state.slashPicker, selected: next } };
    }
    case 'historyPush': {
      if (action.text === '' || action.text === state.inputHistory[0]) return state;
      return { ...state, inputHistory: [action.text, ...state.inputHistory].slice(0, 100) };
    }
    case 'historyUp': {
      if (state.inputHistory.length === 0) return state;
      const next = Math.min(state.historyIndex + 1, state.inputHistory.length);
      const entry = state.inputHistory[next - 1] ?? '';
      return { ...state, historyIndex: next, buffer: entry, cursor: entry.length };
    }
    case 'historyDown': {
      if (state.historyIndex === 0) return state;
      const next = state.historyIndex - 1;
      const entry = next === 0 ? '' : (state.inputHistory[next - 1] ?? '');
      return { ...state, historyIndex: next, buffer: entry, cursor: entry.length };
    }
    case 'modelPickerOpen':
      return {
        ...state,
        modelPicker: {
          open: true,
          step: 'provider',
          providerOptions: action.providers,
          modelOptions: [],
          filteredOptions: [],
          selected: 0,
          hint: undefined,
          searchQuery: '',
        },
      };
    case 'modelPickerClose':
      return {
        ...state,
        modelPicker: {
          open: false,
          step: 'provider',
          providerOptions: [],
          modelOptions: [],
          filteredOptions: [],
          selected: 0,
          searchQuery: '',
        },
      };
    case 'modelPickerMove': {
      if (!state.modelPicker.open) return state;
      const list =
        state.modelPicker.step === 'provider'
          ? state.modelPicker.providerOptions
          : state.modelPicker.filteredOptions;
      const len = list.length;
      if (len === 0) return state;
      const next = (state.modelPicker.selected + action.delta + len) % len;
      return {
        ...state,
        modelPicker: { ...state.modelPicker, selected: next },
      };
    }
    case 'modelPickerPickProvider':
      return {
        ...state,
        modelPicker: {
          ...state.modelPicker,
          step: 'model',
          modelOptions: action.models,
          filteredOptions: action.models,
          selected: 0,
          pickedProviderId: action.providerId,
          hint: undefined,
          searchQuery: '',
        },
      };
    case 'modelPickerBack':
      return {
        ...state,
        modelPicker: {
          ...state.modelPicker,
          step: 'provider',
          modelOptions: [],
          filteredOptions: [],
          selected: 0,
          pickedProviderId: undefined,
          hint: undefined,
          searchQuery: '',
        },
      };
    case 'modelPickerSearch': {
      if (!state.modelPicker.open || state.modelPicker.step !== 'model') return state;
      const q = action.query.toLowerCase();
      const filtered = q
        ? state.modelPicker.modelOptions.filter((id) => id.toLowerCase().includes(q))
        : state.modelPicker.modelOptions;
      const selected =
        filtered.length > 0 ? Math.min(state.modelPicker.selected, filtered.length - 1) : 0;
      return {
        ...state,
        modelPicker: {
          ...state.modelPicker,
          filteredOptions: filtered,
          selected,
          searchQuery: action.query,
          hint: undefined,
        },
      };
    }
    case 'modelPickerHint':
      return {
        ...state,
        modelPicker: { ...state.modelPicker, hint: action.text },
      };
    case 'autonomyPickerOpen':
      return {
        ...state,
        autonomyPicker: { open: true, options: action.options, selected: 0, hint: undefined },
      };
    case 'autonomyPickerClose':
      return {
        ...state,
        autonomyPicker: { open: false, options: [], selected: 0 },
      };
    case 'autonomyPickerMove': {
      const n = state.autonomyPicker.options.length;
      if (n === 0) return state;
      const next = (state.autonomyPicker.selected + action.delta + n) % n;
      return {
        ...state,
        autonomyPicker: { ...state.autonomyPicker, selected: next },
      };
    }
    case 'autonomyPickerHint':
      return {
        ...state,
        autonomyPicker: { ...state.autonomyPicker, hint: action.text },
      };
    case 'settingsOpen':
      return {
        ...state,
        settingsPicker: {
          open: true,
          field: 0,
          mode: action.mode,
          delayMs: action.delayMs,
          titleAnimation: action.titleAnimation,
          yolo: action.yolo,
          streamFleet: action.streamFleet,
          chime: action.chime,
          confirmExit: action.confirmExit,
          nextPrediction: action.nextPrediction,
          featureMcp: action.featureMcp,
          featurePlugins: action.featurePlugins,
          featureMemory: action.featureMemory,
          featureSkills: action.featureSkills,
          featureModelsRegistry: action.featureModelsRegistry,
          contextAutoCompact: action.contextAutoCompact,
          contextStrategy: action.contextStrategy,
          logLevel: action.logLevel,
          auditLevel: action.auditLevel,
          indexOnStart: action.indexOnStart,
          maxIterations: action.maxIterations,
          hint: undefined,
        },
      };
    case 'settingsClose':
      return {
        ...state,
        settingsPicker: { ...state.settingsPicker, open: false, hint: undefined },
      };
    case 'settingsFieldMove': {
      const next = (state.settingsPicker.field + action.delta + SETTINGS_FIELD_COUNT) % SETTINGS_FIELD_COUNT;
      return {
        ...state,
        settingsPicker: { ...state.settingsPicker, field: next, hint: undefined },
      };
    }
    case 'settingsFieldSet': {
      const field =
        action.field >= 0 && action.field < SETTINGS_FIELD_COUNT ? action.field : 0;
      return { ...state, settingsPicker: { ...state.settingsPicker, field, hint: undefined } };
    }
    case 'settingsValueChange': {
      const sp = state.settingsPicker;
      const f = sp.field;
      // Field 0: autonomy mode (cycle SETTINGS_MODES)
      if (f === 0) {
        const i = SETTINGS_MODES.indexOf(sp.mode);
        const base = i < 0 ? 0 : i;
        const next = (base + action.delta + SETTINGS_MODES.length) % SETTINGS_MODES.length;
        return { ...state, settingsPicker: { ...sp, mode: SETTINGS_MODES[next]!, hint: undefined } };
      }
      // Field 1: delay presets
      if (f === 1) {
        const j = DELAY_PRESETS_MS.indexOf(sp.delayMs);
        const base = j < 0 ? 0 : j;
        const next = (base + action.delta + DELAY_PRESETS_MS.length) % DELAY_PRESETS_MS.length;
        return { ...state, settingsPicker: { ...sp, delayMs: DELAY_PRESETS_MS[next]!, hint: undefined } };
      }
      // Field 2–7: UX boolean toggles
      if (f === 2) return { ...state, settingsPicker: { ...sp, titleAnimation: !sp.titleAnimation, hint: undefined } };
      if (f === 3) return { ...state, settingsPicker: { ...sp, yolo: !sp.yolo, hint: undefined } };
      if (f === 4) return { ...state, settingsPicker: { ...sp, streamFleet: !sp.streamFleet, hint: undefined } };
      if (f === 5) return { ...state, settingsPicker: { ...sp, chime: !sp.chime, hint: undefined } };
      if (f === 6) return { ...state, settingsPicker: { ...sp, confirmExit: !sp.confirmExit, hint: undefined } };
      if (f === 7) return { ...state, settingsPicker: { ...sp, nextPrediction: !sp.nextPrediction, hint: undefined } };
      // Field 8–12: Features boolean toggles
      if (f === 8) return { ...state, settingsPicker: { ...sp, featureMcp: !sp.featureMcp, hint: undefined } };
      if (f === 9) return { ...state, settingsPicker: { ...sp, featurePlugins: !sp.featurePlugins, hint: undefined } };
      if (f === 10) return { ...state, settingsPicker: { ...sp, featureMemory: !sp.featureMemory, hint: undefined } };
      if (f === 11) return { ...state, settingsPicker: { ...sp, featureSkills: !sp.featureSkills, hint: undefined } };
      if (f === 12) return { ...state, settingsPicker: { ...sp, featureModelsRegistry: !sp.featureModelsRegistry, hint: undefined } };
      // Field 13: context auto-compact (boolean)
      if (f === 13) return { ...state, settingsPicker: { ...sp, contextAutoCompact: !sp.contextAutoCompact, hint: undefined } };
      // Field 14: compactor strategy (cycle)
      if (f === 14) {
        const i = COMPACTOR_STRATEGIES.indexOf(sp.contextStrategy);
        const base = i < 0 ? 0 : i;
        const next = (base + action.delta + COMPACTOR_STRATEGIES.length) % COMPACTOR_STRATEGIES.length;
        return { ...state, settingsPicker: { ...sp, contextStrategy: COMPACTOR_STRATEGIES[next]!, hint: undefined } };
      }
      // Field 15: log level (cycle)
      if (f === 15) {
        const i = LOG_LEVELS.indexOf(sp.logLevel);
        const base = i < 0 ? 0 : i;
        const next = (base + action.delta + LOG_LEVELS.length) % LOG_LEVELS.length;
        return { ...state, settingsPicker: { ...sp, logLevel: LOG_LEVELS[next]!, hint: undefined } };
      }
      // Field 16: audit level (cycle)
      if (f === 16) {
        const i = AUDIT_LEVELS.indexOf(sp.auditLevel);
        const base = i < 0 ? 0 : i;
        const next = (base + action.delta + AUDIT_LEVELS.length) % AUDIT_LEVELS.length;
        return { ...state, settingsPicker: { ...sp, auditLevel: AUDIT_LEVELS[next]!, hint: undefined } };
      }
      // Field 17: index on start (boolean)
      if (f === 17) return { ...state, settingsPicker: { ...sp, indexOnStart: !sp.indexOnStart, hint: undefined } };
      // Field 18: max iterations (cycle presets)
      {
        const j = MAX_ITERATIONS_PRESETS.indexOf(sp.maxIterations);
        const base = j < 0 ? 0 : j;
        const next = (base + action.delta + MAX_ITERATIONS_PRESETS.length) % MAX_ITERATIONS_PRESETS.length;
        return { ...state, settingsPicker: { ...sp, maxIterations: MAX_ITERATIONS_PRESETS[next]!, hint: undefined } };
      }
    }
    case 'settingsHint':
      return { ...state, settingsPicker: { ...state.settingsPicker, hint: action.text } };
    case 'confirmOpen':
      return { ...state, confirmQueue: [...state.confirmQueue, action.info] };
    case 'confirmClose':
      return { ...state, confirmQueue: state.confirmQueue.slice(1) };
    case 'enhanceOpen':
      return { ...state, enhance: action.info };
    case 'enhanceClose':
      return { ...state, enhance: null };
    case 'enhanceSet':
      return { ...state, enhanceEnabled: action.enabled };
    case 'enhanceBusy':
      return { ...state, enhanceBusy: action.on };
    case 'resetContextChip':
      return { ...state, contextChipVersion: state.contextChipVersion + 1 };
    // --- Fleet ---
    case 'fleetSeed': {
      const seeded: Record<string, FleetEntry> = {};
      for (const e of action.entries) {
        seeded[e.id] = {
          ...e,
          recentTools: e.recentTools ?? [],
          recentMessages: e.recentMessages ?? [],
        };
      }
      return { ...state, fleet: seeded, fleetCost: action.cost };
    }
    case 'fleetSpawn': {
      const existing = state.fleet[action.id];
      const incomingName = action.name ?? action.id.slice(0, 8);
      // Placeholder names that should be overwritten when a better name arrives.
      // "adhoc" is what MultiAgentHost.spawn() seeds before Director.spawn()
      // assigns the real nickname. id-prefix fallbacks also count as placeholders.
      const isPlaceholderName = (name: string) =>
        name === 'adhoc' ||
        name === 'subagent' ||
        name === 'generic' ||
        name.startsWith('slot-') ||
        name === action.id.slice(0, 8);

      if (existing) {
        // If we already have an entry but it has a placeholder name and the
        // incoming name is a real improvement, update the name. This handles
        // the race between EventBus's "subagent.spawned" (which fires before
        // Director.spawn() assigns the nickname) and FleetBus's
        // "subagent.assigned" (which fires after the manifest is updated).
        if (
          isPlaceholderName(existing.name) &&
          !isPlaceholderName(incomingName) &&
          incomingName !== existing.name
        ) {
          return {
            ...state,
            fleet: {
              ...state.fleet,
              [action.id]: { ...existing, name: incomingName },
            },
          };
        }
        return state;
      }
      const entry: FleetEntry = {
        id: action.id,
        name: incomingName,
        provider: action.provider,
        model: action.model,
        status: 'idle',
        streamingText: '',
        iterations: 0,
        toolCalls: 0,
        recentTools: [],
        recentMessages: [],
        cost: 0,
        startedAt: Date.now(),
        lastEventAt: Date.now(),
        transcriptPath: action.transcriptPath,
      };
      return { ...state, fleet: { ...state.fleet, [action.id]: entry } };
    }
    case 'fleetToolStart': {
      const cur = state.fleet[action.id];
      if (!cur) return state;
      return {
        ...state,
        fleet: {
          ...state.fleet,
          [action.id]: {
            ...cur,
            currentTool: { name: action.name, startedAt: Date.now() },
            lastEventAt: Date.now(),
          },
        },
      };
    }
    case 'fleetToolEnd': {
      const cur = state.fleet[action.id];
      if (!cur) return state;
      return {
        ...state,
        fleet: {
          ...state.fleet,
          [action.id]: { ...cur, currentTool: undefined, lastEventAt: Date.now() },
        },
      };
    }
    case 'fleetStart': {
      const cur = state.fleet[action.id];
      if (!cur) return state;
      return {
        ...state,
        fleet: {
          ...state.fleet,
          [action.id]: {
            ...cur,
            status: 'running' as const,
            streamingText: '',
            budgetWarning: undefined, // clear on restart
            startedAt: Date.now(),
          },
        },
      };
    }
    case 'fleetDelta': {
      const cur = state.fleet[action.id];
      if (!cur) return state;
      // Keep last 500 chars of streaming text for display (refactor plans are verbose)
      const appended = (cur.streamingText + action.text).slice(-500);
      return {
        ...state,
        fleet: {
          ...state.fleet,
          [action.id]: { ...cur, streamingText: appended, lastEventAt: Date.now() },
        },
      };
    }
    case 'fleetMessage': {
      const cur = state.fleet[action.id];
      const text = action.text.trim().replace(/\s+/g, ' ');
      if (!cur || !text) return state;
      const now = Date.now();
      const recentMessages = [...(cur.recentMessages ?? []), { text, at: now }].slice(-2);
      return {
        ...state,
        fleet: {
          ...state.fleet,
          [action.id]: { ...cur, recentMessages, lastEventAt: now },
        },
      };
    }
    case 'fleetTool': {
      const cur = state.fleet[action.id];
      if (!cur) return state;
      const now = Date.now();
      const recentTools =
        action.name !== undefined
          ? [
              ...(cur.recentTools ?? []),
              {
                name: action.name,
                ok: action.ok,
                durationMs: action.durationMs,
                outputBytes: action.outputBytes,
                outputLines: action.outputLines,
                at: now,
              },
            ].slice(-2)
          : (cur.recentTools ?? []);
      return {
        ...state,
        fleet: {
          ...state.fleet,
          [action.id]: {
            ...cur,
            toolCalls: cur.toolCalls + 1,
            recentTools,
            lastEventAt: now,
          },
        },
      };
    }
    case 'fleetUsage': {
      const cur = state.fleet[action.id];
      if (!cur) return state;
      return {
        ...state,
        fleet: { ...state.fleet, [action.id]: { ...cur, lastEventAt: Date.now() } },
      };
    }
    case 'fleetDone': {
      const cur = state.fleet[action.id];
      if (!cur) return state;
      return {
        ...state,
        fleet: {
          ...state.fleet,
          [action.id]: {
            ...cur,
            status: action.status,
            iterations: action.iterations,
            toolCalls: action.toolCalls,
            streamingText: '',
            currentTool: undefined,
            budgetWarning: undefined, // clear on done/restart
            lastEventAt: Date.now(),
            failureReason: action.failureReason,
          },
        },
      };
    }
    case 'fleetBudgetWarning': {
      const cur = state.fleet[action.id];
      if (!cur) return state;
      return {
        ...state,
        fleet: {
          ...state.fleet,
          [action.id]: {
            ...cur,
            budgetWarning: {
              kind: action.kind,
              used: action.used,
              limit: action.limit,
              at: Date.now(),
            },
            lastEventAt: Date.now(),
          },
        },
      };
    }
    case 'fleetBudgetExtended': {
      const cur = state.fleet[action.id];
      if (!cur) return state;
      return {
        ...state,
        fleet: {
          ...state.fleet,
          [action.id]: {
            ...cur,
            // The director sends the authoritative cumulative count; trust it
            // over a local increment so a dropped event can't desync the badge.
            extensions: action.totalExtensions,
            lastEventAt: Date.now(),
          },
        },
      };
    }
    case 'fleetCtxPct': {
      const cur = state.fleet[action.id];
      if (!cur) return state;
      return {
        ...state,
        fleet: {
          ...state.fleet,
          [action.id]: {
            ...cur,
            ctxPct: action.load,
            ctxTokens: action.tokens,
            ctxMaxTokens: action.maxContext,
            lastEventAt: Date.now(),
          },
        },
      };
    }
    case 'fleetCost': {
      // Fold per-subagent cost into each live fleet entry so the AgentsMonitor
      // can show a per-agent `$` chip. Only touches entries we already track.
      let fleet = state.fleet;
      if (action.perAgent) {
        let changed = false;
        const next: Record<string, FleetEntry> = {};
        for (const [id, entry] of Object.entries(state.fleet)) {
          const cost = action.perAgent[id]?.cost;
          if (cost !== undefined && cost !== entry.cost) {
            next[id] = { ...entry, cost };
            changed = true;
          } else {
            next[id] = entry;
          }
        }
        if (changed) fleet = next;
      }
      return {
        ...state,
        fleet,
        fleetCost: action.cost,
        fleetTokens:
          action.input !== undefined || action.output !== undefined
            ? {
                input: action.input ?? state.fleetTokens.input,
                output: action.output ?? state.fleetTokens.output,
              }
            : state.fleetTokens,
      };
    }
    case 'fleetConcurrency': {
      return { ...state, fleetConcurrency: action.n };
    }
    case 'leaderIterStart': {
      return {
        ...state,
        leader: {
          ...state.leader,
          iterations: state.leader.iterations + 1,
          iterating: true,
          lastEventAt: Date.now(),
        },
      };
    }
    case 'leaderIterEnd': {
      return {
        ...state,
        leader: { ...state.leader, iterating: false, lastEventAt: Date.now() },
      };
    }
    case 'leaderToolStart': {
      return {
        ...state,
        leader: {
          ...state.leader,
          currentTool: { name: action.name, startedAt: Date.now() },
          lastEventAt: Date.now(),
        },
      };
    }
    case 'leaderToolEnd': {
      const now = Date.now();
      const recentTools = [
        ...state.leader.recentTools,
        { name: action.name, ok: action.ok, durationMs: action.durationMs, at: now },
      ].slice(-8);
      return {
        ...state,
        leader: {
          ...state.leader,
          toolCalls: state.leader.toolCalls + 1,
          currentTool: undefined,
          recentTools,
          lastEventAt: now,
        },
      };
    }
    case 'leaderCtxPct': {
      return {
        ...state,
        leader: {
          ...state.leader,
          ctxPct: action.load,
          ctxTokens: action.tokens,
          ctxMaxTokens: action.maxContext,
          lastEventAt: Date.now(),
        },
      };
    }
    case 'setStreamFleet': {
      return { ...state, streamFleet: action.enabled };
    }
    case 'toggleMonitor': {
      return { ...state, monitorOpen: !state.monitorOpen };
    }
    case 'toggleAgentsMonitor': {
      return { ...state, agentsMonitorOpen: !state.agentsMonitorOpen };
    }
    case 'toggleHelp': {
      return { ...state, helpOpen: !state.helpOpen };
    }
    case 'toggleTodosMonitor': {
      return { ...state, todosMonitorOpen: !state.todosMonitorOpen };
    }
    case 'toggleQueuePanel': {
      return { ...state, queuePanelOpen: !state.queuePanelOpen };
    }
    case 'checkpointReceived': {
      const existing = state.checkpoints.find((c) => c.promptIndex === action.cp.promptIndex);
      if (existing) return state;
      return { ...state, checkpoints: [...state.checkpoints, action.cp] };
    }
    case 'rewindOverlayOpen': {
      return {
        ...state,
        rewindOverlay: { checkpoints: state.checkpoints, selected: state.checkpoints.length - 1 },
      };
    }
    case 'rewindOverlayClose': {
      return { ...state, rewindOverlay: null };
    }
    case 'rewindOverlayMove': {
      if (!state.rewindOverlay) return state;
      const len = state.rewindOverlay.checkpoints.length;
      if (len === 0) return { ...state, rewindOverlay: null };
      const selected = Math.max(0, Math.min(len - 1, state.rewindOverlay.selected + action.delta));
      return { ...state, rewindOverlay: { ...state.rewindOverlay, selected } };
    }
    case 'sessionRewound': {
      return {
        ...state,
        checkpoints: state.checkpoints.filter((c) => c.promptIndex <= action.toPromptIndex),
        rewindOverlay: null,
      };
    }
    case 'eternalStage': {
      return { ...state, eternalStage: action.stage };
    }
    case 'goalSummary': {
      return { ...state, goalSummary: action.summary };
    }
    case 'autoPhaseInit': {
      return {
        ...state,
        autoPhase: {
          title: action.title,
          phases: {},
          runningPhaseIds: [],
          elapsedMs: 0,
          monitorOpen: false,
        },
      };
    }
    case 'autoPhasePhaseUpdate': {
      // Lazily initialize autoPhase state on first phase event — the title
      // is not shown in the PhaseMonitor so a placeholder is fine here.
      const existing = state.autoPhase ?? {
        title: 'AutoPhase',
        phases: {},
        runningPhaseIds: [],
        elapsedMs: 0,
        monitorOpen: false,
      };
      return {
        ...state,
        autoPhase: {
          ...existing,
          phases: {
            ...existing.phases,
            [action.phaseId]: {
              name: action.name,
              status: action.status,
              completedTasks: action.completedTasks,
              totalTasks: action.totalTasks,
              startedAt: action.startedAt,
            },
          },
        },
      };
    }
    case 'autoPhaseRunningPhases': {
      if (!state.autoPhase) return state;
      return {
        ...state,
        autoPhase: { ...state.autoPhase, runningPhaseIds: action.phaseIds },
      };
    }
    case 'autoPhaseElapsed': {
      if (!state.autoPhase) return state;
      return { ...state, autoPhase: { ...state.autoPhase, elapsedMs: action.ms } };
    }
    case 'autoPhaseMonitorToggle': {
      if (!state.autoPhase) return state;
      return {
        ...state,
        autoPhase: { ...state.autoPhase, monitorOpen: !state.autoPhase.monitorOpen },
      };
    }
    case 'autoPhaseReset': {
      return { ...state, autoPhase: null };
    }
    case 'worktreeUpsert': {
      const prev = state.worktrees[action.handleId];
      const merged: WorktreeRow & { baseBranch?: string } = {
        branch: '',
        ownerLabel: '',
        status: 'active',
        insertions: 0,
        deletions: 0,
        files: 0,
        allocatedAt: Date.now(),
        ...prev,
        ...action.row,
      };
      return {
        ...state,
        worktrees: { ...state.worktrees, [action.handleId]: merged },
        worktreeBase: action.baseBranch ?? state.worktreeBase,
      };
    }
    case 'worktreeRemove': {
      if (!state.worktrees[action.handleId]) return state;
      const next = { ...state.worktrees };
      delete next[action.handleId];
      return { ...state, worktrees: next };
    }
    case 'worktreeMonitorToggle': {
      return { ...state, worktreeMonitorOpen: !state.worktreeMonitorOpen };
    }
    // --- In-app chat scroll ---
    case 'scrollBy': {
      const maxOffset = Math.max(0, state.totalLines - state.viewportRows);
      const next = Math.max(0, Math.min(maxOffset, state.scrollOffset + action.delta));
      return {
        ...state,
        scrollOffset: next,
        pendingNewLines: next === 0 ? 0 : state.pendingNewLines,
      };
    }
    case 'scrollPage': {
      const page = Math.max(1, state.viewportRows - 1);
      const delta = action.dir === 'up' ? page : -page;
      const maxOffset = Math.max(0, state.totalLines - state.viewportRows);
      const next = Math.max(0, Math.min(maxOffset, state.scrollOffset + delta));
      return {
        ...state,
        scrollOffset: next,
        pendingNewLines: next === 0 ? 0 : state.pendingNewLines,
      };
    }
    case 'scrollTo': {
      const maxOffset = Math.max(0, state.totalLines - state.viewportRows);
      const next = Math.max(0, Math.min(maxOffset, action.offset));
      return {
        ...state,
        scrollOffset: next,
        pendingNewLines: next === 0 ? 0 : state.pendingNewLines,
      };
    }
    case 'scrollToBottom':
      return { ...state, scrollOffset: 0, pendingNewLines: 0 };
    case 'scrollToTop': {
      const maxOffset = Math.max(0, state.totalLines - state.viewportRows);
      return { ...state, scrollOffset: maxOffset };
    }
    case 'setMeasuredLines': {
      const newTotal = action.totalLines;
      const oldTotal = state.totalLines;
      const maxOffset = Math.max(0, newTotal - state.viewportRows);
      // Content grew while the user is scrolled up → keep the visible window
      // anchored on the same older rows by pushing the offset along with the
      // growth, and surface the new-line count for the "jump to bottom" hint.
      if (state.scrollOffset > 0 && newTotal > oldTotal) {
        const grew = newTotal - oldTotal;
        return {
          ...state,
          totalLines: newTotal,
          scrollOffset: Math.min(maxOffset, state.scrollOffset + grew),
          pendingNewLines: state.pendingNewLines + grew,
        };
      }
      // Pinned, or content shrank (e.g. /clear): re-clamp and keep following.
      return {
        ...state,
        totalLines: newTotal,
        scrollOffset: Math.min(state.scrollOffset, maxOffset),
      };
    }
    case 'setViewportRows': {
      const maxOffset = Math.max(0, state.totalLines - action.rows);
      return {
        ...state,
        viewportRows: action.rows,
        scrollOffset: Math.min(state.scrollOffset, maxOffset),
      };
    }
    case 'fleetBatch':
      // Fold each batched action through the reducer; one new state, one render.
      return action.actions.reduce((s, a) => reducer(s, a), state);
    // --- Collab session ---
    case 'collabSubagentSpawned': {
      // Lazily initialize collab state on the first subagent spawn.
      if (state.collabSession) return state;
      return {
        ...state,
        collabSession: {
          sessionId: null,
          bugCount: 0,
          planCount: 0,
          evalCount: 0,
          overallVerdict: null,
          timeline: [{ at: Date.now(), icon: '⚡', color: 'cyan', text: `${action.role} spawned` }],
          startedAt: Date.now(),
        },
      };
    }
    case 'collabBugFound': {
      const cs = state.collabSession;
      if (!cs) {
        // Lazily bootstrap collab state on first event.
        return {
          ...state,
          collabSession: {
            sessionId: action.sessionId,
            bugCount: 1,
            planCount: 0,
            evalCount: 0,
            overallVerdict: null,
            timeline: [
              {
                at: Date.now(),
                icon: '🐛',
                color: 'red',
                text: `bug: ${action.description.slice(0, 60)}…`,
              },
            ],
            startedAt: Date.now(),
          },
        };
      }
      const entry = {
        at: Date.now(),
        icon: '🐛',
        color: 'red',
        text: `bug [${action.severity}]: ${action.description.slice(0, 55)}…`,
      };
      return {
        ...state,
        collabSession: {
          ...cs,
          sessionId: action.sessionId,
          bugCount: cs.bugCount + 1,
          timeline: [entry, ...cs.timeline].slice(0, 30),
        },
      };
    }
    case 'collabPlanEmitted': {
      const cs = state.collabSession;
      if (!cs) return state;
      const entry = {
        at: Date.now(),
        icon: '📐',
        color: 'yellow',
        text: `plan [${action.riskScore}]: ${action.phaseCount} phases`,
      };
      return {
        ...state,
        collabSession: {
          ...cs,
          sessionId: action.sessionId,
          planCount: cs.planCount + 1,
          timeline: [entry, ...cs.timeline].slice(0, 30),
        },
      };
    }
    case 'collabEvalComplete': {
      const cs = state.collabSession;
      if (!cs) return state;
      const entry = {
        at: Date.now(),
        icon: '⚖️',
        color:
          action.verdict === 'approve' ? 'green' : action.verdict === 'reject' ? 'red' : 'yellow',
        text: `eval ${action.score}/10 → ${action.verdict}`,
      };
      return {
        ...state,
        collabSession: {
          ...cs,
          sessionId: action.sessionId,
          evalCount: cs.evalCount + 1,
          timeline: [entry, ...cs.timeline].slice(0, 30),
        },
      };
    }
    case 'collabSessionDone': {
      const cs = state.collabSession;
      if (!cs) return state;
      const entry = {
        at: Date.now(),
        icon: '🏁',
        color: 'green',
        text: `session done — ${action.verdict}`,
      };
      return {
        ...state,
        collabSession: {
          ...cs,
          overallVerdict: action.verdict,
          timeline: [entry, ...cs.timeline].slice(0, 30),
        },
      };
    }
  }
}
