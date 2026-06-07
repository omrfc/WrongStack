import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type {
  Agent,
  AttachmentStore,
  ContentBlock,
  Director,
  EventBus,
  Message,
  QueueStore,
  SlashCommandRegistry,
  TokenCounter,
} from '@wrongstack/core';
import { type AutonomyStage, DefaultSessionRewinder } from '@wrongstack/core';
import { InputBuilder, buildGoalPreamble, formatTodosList, writeOut } from '@wrongstack/core';
import { enhanceUserPrompt, normalizedEqual, recentTextTurns, shouldEnhance } from '@wrongstack/core';
import { type VisionAdapters, routeImagesForModel } from '@wrongstack/runtime/vision';
import { getProcessRegistry, getIndexState, onIndexStateChange } from '@wrongstack/tools';
import { Box, Text, useApp } from 'ink';
import React, { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { readClipboardImage } from './clipboard.js';
import { AgentsMonitor } from './components/agents-monitor.js';
import { AUTONOMY_OPTIONS, AutonomyPicker } from './components/autonomy-picker.js';
import { BrainDecisionPrompt } from './components/brain-decision-prompt.js';
import { CheckpointTimeline } from './components/checkpoint-timeline.js';
import { type ConfirmDecision, ConfirmPrompt } from './components/confirm-prompt.js';
import { EnhancePanel } from './components/enhance-panel.js';
import { EscConfirmPrompt } from './components/esc-confirm-prompt.js';
import { FilePicker } from './components/file-picker.js';
import { FleetMonitor } from './components/fleet-monitor.js';
import { FleetPanel } from './components/fleet-panel.js';
import { HelpOverlay } from './components/help-overlay.js';
import { History } from './components/history.js';
import { Input, type KeyEvent } from './components/input.js';
import { LiveActivityStrip } from './components/live-activity-strip.js';
import { ModelPicker, type ProviderOption } from './components/model-picker.js';
import { PhaseMonitor } from './components/phase-monitor.js';
import { PhasePanel } from './components/phase-panel.js';
import { QueuePanel } from './components/queue-panel.js';
import { ProcessListMonitor } from './components/process-list.js';
import { SettingsPicker } from './components/settings-picker.js';
import { SlashMenu } from './components/slash-menu.js';
import { StatusBar } from './components/status-bar.js';
import { TodosMonitor } from './components/todos-monitor.js';
import { WorktreeMonitor } from './components/worktree-monitor.js';
import { WorktreePanel } from './components/worktree-panel.js';
import { searchFiles } from './file-search.js';
import { type GitInfo, readGitInfo } from './git-info.js';
import { useDirectorFleetBridge } from './hooks/use-director-fleet-bridge.js';
import { useTuiControllers } from './hooks/use-tui-controllers.js';
import { useTuiEventBridge } from './hooks/use-tui-event-bridge.js';
import { INLINE_TOKEN_SRC, deleteTokenBackward, tokenLengthForward } from './input-tokens.js';
import { createKillSlashCommand } from './kill-slash.js';
import { feedPaste } from './paste-accumulator.js';
import { createPsSlashCommand } from './ps-slash.js';
import { createQueueSlashCommand } from './queue-slash.js';
import { buildSteeringPreamble } from './steering-preamble.js';

// Types imported from app-reducer.ts (single source of truth for reducer + State types)
import {
  type FleetEntry,
  type SlashCommandMatch,
  type State,
  reducer,
} from './app-reducer.js';


function expectDefined<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) {
    throw new Error('Expected value to be defined');
  }
  return value;
}

export {
  reducer,
  type Action,
  type FleetEntry,
  type QueueItem,
  type SlashCommandMatch,
  type State,
} from './app-reducer.js';

/** Input prompt — mirrors the <Input> default so click-to-position-cursor maps
 *  columns the same way the input renders them. */
const INPUT_PROMPT = '› ';

export interface Settings {
  mode: 'off' | 'suggest' | 'auto';
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
  contextStrategy: 'hybrid' | 'intelligent' | 'selective';
  logLevel: 'error' | 'warn' | 'info' | 'debug' | 'trace';
  auditLevel: 'minimal' | 'standard' | 'full';
  indexOnStart: boolean;
  maxIterations: number;
}

export function selectedSlashCommandLine(picker: {
  open: boolean;
  matches: SlashCommandMatch[];
  selected: number;
}): string | null {
  if (!picker.open || picker.matches.length === 0) return null;
  const picked = picker.matches[picker.selected];
  return picked ? `/${picked.name}` : null;
}

/**
 * Convert restored session messages into TUI history entries so a resumed
 * session renders its prior conversation visually, not just in the LLM context.
 *
 * - system messages are skipped (not displayed)
 * - user messages become `kind: 'user'` entries
 * - assistant messages become `kind: 'assistant'` entries (tool_use blocks
 *   are stripped; full tool rendering needs the execution events which are
 *   not available at resume time)
 */
export function rehydrateHistory(
  messages: Message[],
  startId: number,
): import('./components/history/types.js').HistoryEntry[] {
  const entries: import('./components/history/types.js').HistoryEntry[] = [];
  let nextId = startId;
  for (const msg of messages) {
    if (msg.role === 'system') continue;
    // Inline asText: extract string content from text blocks.
    const text =
      typeof msg.content === 'string'
        ? msg.content
        : msg.content
            .filter((b) => b.type === 'text')
            .map((b) => (b as { text: string }).text)
            .join('');
    const trimmed = text.trim();
    if (!trimmed) continue;
    if (msg.role === 'user') {
      entries.push({ id: nextId++, kind: 'user', text: trimmed });
    } else if (msg.role === 'assistant') {
      entries.push({ id: nextId++, kind: 'assistant', text: trimmed });
    }
  }
  return entries;
}

export interface AppProps {
  agent: Agent;
  slashRegistry: SlashCommandRegistry;
  attachments: AttachmentStore;
  events: EventBus;
  tokenCounter?: TokenCounter | undefined;
  visionAdapters?: VisionAdapters | undefined;
  /** Resolve current model vision support. Falls back to provider capability when omitted. */
  supportsVision?: (() => boolean | Promise<boolean>) | undefined;
  model: string;
  banner?: boolean | undefined;
  /** Persists the queue across crashes; rehydrated on mount, written on every mutation. */
  queueStore?: QueueStore | undefined;
  /** Reflects the policy's --yolo flag for the status bar's "⚠ YOLO" chip. */
  yolo?: boolean | undefined;
  /** Play terminal bell when an agent run completes. */
  chime?: boolean | undefined;
  /** When true, the first Ctrl+C aborts work and shows "confirm exit" rather than "exit". */
  confirmExit?: boolean | undefined;
  /**
   * When true, free-text prompts are run through the prompt refiner
   * ("did you mean this?") before reaching the main agent. Default on;
   * toggled live via the `/enhance` slash command + `enhanceController`.
   */
  enhanceEnabled?: boolean | undefined;
  /**
   * Shared controller for the `/enhance on|off` toggle. The TUI rebinds
   * `setEnabled` on mount to a dispatch-backed setter so the slash command
   * (handled in the CLI) flips the reducer flag. Mirrors `fleetStreamController`.
   */
  enhanceController?: {
    enabled: boolean;
    setEnabled: (enabled: boolean) => void;
  } | undefined;
  /** Auto-send countdown (ms) for the refinement preview panel. Default 4000. */
  enhanceDelayMs?: number | undefined;
  /**
   * Query the live YOLO state from the permission policy. Called after
   * every slash-command dispatch so `/yolo off` (which mutates the
   * policy inside the CLI) is immediately reflected in the status bar.
   * Mirrors the `agent.ctx.model` → `setLiveModel` pattern used for
   * provider/model sync.
   */
  getYolo?: (() => boolean) | undefined;
  /** Query the live autonomy mode. */
  getAutonomy?: (() => 'off' | 'suggest' | 'auto' | 'eternal' | 'eternal-parallel') | undefined;
  /** Query the live agent mode label for the status bar (e.g. "teach"). */
  getModeLabel?: (() => string) | undefined;
  /**
   * Access the eternal-autonomy engine. When autonomy mode goes to
   * 'eternal' the TUI drives `runOneIteration()` from a post-slash hook
   * so the engine and TUI never race for the shared Context.
   */
  getEternalEngine?: (() => import('@wrongstack/core').EternalAutonomyEngine | null) | undefined;
  /**
   * Access the parallel-eternal engine. When autonomy mode goes to
   * 'eternal-parallel' the TUI drives `runOneIteration()` from a post-slash
   * hook so the engine and TUI never race for the shared Context.
   */
  getParallelEngine?: (() => import('@wrongstack/core').ParallelEternalEngine | null) | undefined;
  /**
   * Subscribe to live per-iteration events from the eternal engine. The
   * TUI installs this on mount to render each iteration as a timeline
   * entry the moment it lands — strictly more responsive than reading
   * goal.json after the fact.
   */
  subscribeEternalIteration?: ((
    fn: (entry: import('@wrongstack/core').JournalEntry) => void,
  ) => () => void) | undefined;
  /**
   * Subscribe to per-iteration stage transitions from the autonomy engines.
   * Drives `state.eternalStage` used by the status bar to show the
   * engine's current location.
   */
  subscribeEternalStage?: ((fn: (stage: AutonomyStage) => void) => () => void) | undefined;
  /**
   * Subscribe to AutoPhase phase/task events from the PhaseOrchestrator.
   * Drives `state.autoPhase` used by the PhaseMonitor component.
   * Handlers receive the event name and payload from PhaseEventMap.
   */
  subscribeAutoPhase?: ((handler: (event: string, payload: unknown) => void) => () => void) | undefined;
  /**
   * Read the persisted autonomy settings (defaultMode, autoProceedDelayMs).
   * Used by the SettingsPicker in the TUI on mount and after Ctrl+S toggle.
   */
  /** Settings shape — shared between getSettings and saveSettings. */
  getSettings?: (() => Settings) | undefined;
  /**
   * Persist settings changes. Returns null on success, or an
   * error string on failure (so the TUI can display it as a hint).
   */
  saveSettings?: ((s: Settings) => string | null | Promise<string | null>) | undefined;
  /**
   * Predict likely next steps after a completed turn (/next). The CLI owns the
   * gating (toggle + autonomy off) and returns [] when disabled, so the App can
   * call it unconditionally on a done turn. Display-only — never executed.
   */
  predictNext?: ((input: {
    userRequest: string;
    assistantSummary: string;
  }) => Promise<string[]>) | undefined;
  /**
   * SDD session context getter. When an SDD session is active, returns
   * the AI prompt context to inject into user messages so the model
   * knows it's in a spec-building conversation.
   */
  getSDDContext?: (() => string | null) | undefined;
  /**
   * Process AI output for SDD auto-detection (spec, tasks, plan).
   * Called after every agent.run() completes. Returns displayable
   * status messages (e.g. "✓ Spec detected and saved!").
   */
  onSDDOutput?: ((output: string) => Promise<string[]>) | undefined;
  /** Surfaced in the startup banner. Falls back to "dev" when omitted. */
  appVersion?: string | undefined;
  /** Provider id shown in the banner ("openai", "anthropic", …). Defaults to "agent". */
  provider?: string | undefined;
  /** Wire family for the configured provider — rendered under provider in the banner. */
  family?: string | undefined;
  /** Last 3 chars of the active API key, shown in the banner for "did I pick the right key?" verification. */
  keyTail?: string | undefined;
  /**
   * Snapshot the keyed providers (and their model lists) for the
   * `/model` picker. Called every time the picker opens, so the result
   * stays in sync with config edits / new aliases. Async because the
   * host may need to load the models.dev catalog.
   */
  getPickableProviders?: (() => Promise<ProviderOption[]>) | undefined;
  /**
   * Apply a (provider, model) pair after the picker confirms. Returns
   * an error message on failure; null on success. The host owns the
   * actual Provider construction + Context mutation.
   */
  switchProviderAndModel?: ((providerId: string, modelId: string) => string | null) | undefined;
  /**
   * Apply an autonomy mode after the picker confirms. Returns
   * an error string on failure; null on success.
   */
  switchAutonomy?: ((
    mode: 'off' | 'suggest' | 'auto' | 'eternal' | 'eternal-parallel',
  ) => string | null) | undefined;
  /**
   * Real max-context token budget for the *active model*, resolved by the
   * CLI via the ModelsRegistry. The provider object only knows its family
   * default (e.g. anthropic = 200k) which is wrong for variants like the
   * 1M-context Opus model. The status bar's context chip uses this when
   * provided and falls back to the provider baseline otherwise.
   */
  effectiveMaxContext?: number | undefined;
  /** Absolute project root for goal.json loading. */
  projectRoot?: string | undefined;
  onExit: (code: number) => void;
  /** Called when /clear is dispatched — the TUI should wipe its history entries (but keep the banner). */
  onClearHistory?: ((
    dispatch: React.Dispatch<{ type: 'clearHistory' } | { type: 'resetContextChip' }>,
  ) => void) | undefined;

  /**
   * Goal text passed from `--goal "..."` on the command line. When set,
   * the App mounts, renders the banner, then automatically dispatches
   * a synthetic `/goal <text>` so the user lands in goal mode without
   * having to type the slash command. Mutually advisory with `initialSteer`
   * — `initialGoal` wins if both are present.
   */
  initialGoal?: string | undefined;
  /**
   * Initial user message passed from `--ask "..."` on the command line.
   * Submitted verbatim as the first turn (no preamble) so users can
   * launch the TUI and pre-populate one turn from a shell alias / script.
   */
  initialAsk?: string | undefined;
  /** Directory for session JSONL files. Passed to App for /rewind. */
  sessionsDir?: string | undefined;

  // --- Fleet ---
  /** Live director for fleet panel rendering. Null when director mode is off. */
  director: Director | null;
  /** Optional roster for human-readable subagent names. */
  fleetRoster?: Record<string, { name: string }> | undefined;
  /**
   * Shared controller for the `/fleet stream on|off` slash command. The
   * App installs a dispatch-backed setter on mount so the slash command
   * can flip the reducer's `streamFleet` flag from the CLI surface.
   */
  fleetStreamController?: {
    enabled: boolean;
    setEnabled: (enabled: boolean) => void;
  } | undefined;
  /**
   * Controller for status bar hidden items. App installs a dispatch-backed
   * setter on mount so the /statusline slash command can update the TUI's
   * visible bar without a round-trip. The initial value is loaded from
   * the config file before App mounts.
   */
  statuslineHiddenItems: Array<'todos' | 'plan' | 'fleet' | 'git' | 'elapsed' | 'context' | 'cost'>;
  setStatuslineHiddenItems: (
    items: Array<'todos' | 'plan' | 'fleet' | 'git' | 'elapsed' | 'context' | 'cost'>,
  ) => void;
  /**
   * Controller for the agents monitor overlay. App installs a dispatch-backed
   * setter on mount so the `/agents on|off` slash command can toggle the
   * overlay without a round-trip.
   */
  agentsMonitorController?: {
    visible: boolean;
    setVisible: (visible: boolean) => void;
  };
  /** Active agent mode label shown in the status bar (e.g. "teach", "brief"). */
  modeLabel?: string | undefined;
}

const PASTE_THRESHOLD_CHARS = 200;

// Re-exported for backward compatibility with tests importing from '../src/app.js'.
// Actual implementation lives in ./steering-preamble.ts.
export { buildSteeringPreamble } from './steering-preamble.js';

// `buildGoalPreamble` was relocated to @wrongstack/core so headless and
// WebUI callers (which depend on @wrongstack/cli but not @wrongstack/tui)
// can issue `/goal set` without dragging the TUI package in. Re-exported
// from this module for backward compatibility with consumers still
// importing from @wrongstack/tui; also used locally within this file
// where `/goal …` is wired into the chat-input handler.
export { buildGoalPreamble } from '@wrongstack/core';

export function App({
  agent,
  slashRegistry,
  attachments,
  events,
  tokenCounter,
  visionAdapters = [],
  supportsVision,
  model,
  banner = true,
  queueStore,
  yolo = false,
  chime = false,
  confirmExit = true,
  enhanceEnabled = true,
  enhanceController,
  enhanceDelayMs = 15_000,
  getYolo,
  getAutonomy,
  getEternalEngine,
  getParallelEngine,
  subscribeEternalIteration,
  subscribeEternalStage,
  subscribeAutoPhase,
  getSDDContext,
  onSDDOutput,
  appVersion,
  provider,
  family,
  keyTail,
  getPickableProviders,
  switchProviderAndModel,
  getSettings,
  saveSettings,
  predictNext,
  switchAutonomy,
  effectiveMaxContext,
  onExit,
  director,
  fleetRoster,
  onClearHistory,
  fleetStreamController,
  statuslineHiddenItems,
  setStatuslineHiddenItems,
  agentsMonitorController,
  initialGoal,
  initialAsk,
  sessionsDir,
  modeLabel,
  getModeLabel,
}: AppProps): React.ReactElement {
  const { exit } = useApp();
  // Reactive mirrors of agent.ctx.{model,provider.id} so the status bar
  // re-renders when /model or /use mutate them. The banner is `Static`
  // and never re-renders — the user gets the textual confirmation from
  // the slash command's message in history instead.
  const [liveModel, setLiveModel] = useState<string>(model);
  const [liveProvider, setLiveProvider] = useState<string>(provider ?? 'agent');
  // CLI resolves the startup model's catalog limit, but /model can switch to a
  // different model without remounting App. Keep the denominator mutable so the
  // status bar follows the active model instead of a stale launch-time prop.
  const [activeMaxContext, setActiveMaxContext] = useState<number | undefined>(effectiveMaxContext);
  const [yoloLive, setYoloLive] = useState<boolean>(yolo);
  const [autonomyLive, setAutonomyLive] = useState<
    'off' | 'suggest' | 'auto' | 'eternal' | 'eternal-parallel'
  >(getAutonomy?.() ?? 'off');
  // Reactive mirror of the active agent mode so the status bar chip
  // updates after /mode <id> without remounting the App.
  const [liveModeLabel, setLiveModeLabel] = useState<string>(modeLabel ?? '');
  const [hiddenItems, setHiddenItems] = useState(statuslineHiddenItems);

  // Codebase indexing state — synced from the process-wide indexer
  // so the status bar shows "⚙ indexing 42/500" while the index builds.
  const [indexState, setIndexState] = useState(() => getIndexState());
  useEffect(() => {
    setIndexState(getIndexState());
    return onIndexStateChange((next) => setIndexState(next));
  }, []);

  // Sync when parent re-loads from config file (e.g., after /statusline reset)
  useEffect(() => {
    setHiddenItems(statuslineHiddenItems);
  }, [statuslineHiddenItems]);

  // Push local changes back to the parent controller so /statusline sees them
  useEffect(() => {
    setStatuslineHiddenItems(hiddenItems);
  }, [setStatuslineHiddenItems, hiddenItems]);

  const projectRoot = agent.ctx.projectRoot;

  // Load goal.json on mount to show startup banner with goal state
  useEffect(() => {
    if (!projectRoot) return;
    const goalPath = path.join(projectRoot, '.wrongstack', 'goal.json');
    fs.readFile(goalPath, 'utf8')
      .then((raw) => {
        const goal = JSON.parse(raw);
        if (goal?.goal && typeof goal.iterations === 'number') {
          const lastEntry = goal.journal?.[goal.journal.length - 1];
          dispatch({
            type: 'goalSummary',
            summary: {
              goal: goal.goal,
              goalState: goal.goalState ?? 'active',
              iterations: goal.iterations,
              lastTask: lastEntry?.task,
              lastStatus: lastEntry?.status,
            },
          });
        }
      })
      .catch(() => {
        // No goal file yet — that's fine
      });
  }, [projectRoot]);

  // Rehydrate TUI chat history from restored messages (session resume).
  // agent.ctx.messages is populated by setupSession → context.state.replaceMessages()
  // when wstack resume <id> is used. These messages only exist in the LLM context
  // by default; we convert them to visible history entries here.
  const restoredEntries = (() => {
    const msgs = agent.ctx.messages;
    if (!msgs || msgs.length === 0) return [];
    // Filter out system prompt messages (role === 'system') — the banner
    // already shows the provider/model, and system prompts are not user-visible.
    const visible = msgs.filter((m) => m.role !== 'system');
    if (visible.length === 0) return [];
    return rehydrateHistory(visible, /* startId */ 1);
  })();
  const initialNextId = 1 + restoredEntries.length;

  const [state, dispatch] = useReducer(reducer, {
    entries: [
      ...(banner
        ? [
            {
              id: 0,
              kind: 'banner' as const,
              version: appVersion ?? 'dev',
              provider: provider ?? 'agent',
              model,
              cwd: agent.ctx.cwd,
              family,
              keyTail,
            },
          ]
        : []),
      ...restoredEntries,
    ],
    buffer: '',
    cursor: 0,
    streamingText: '',
    toolStream: null,
    status: 'idle' as const,
    interrupts: 0,
    steeringPending: false,
    steerSnapshot: null,
    hint: '',
    brain: { state: 'idle' as const },
    brainPrompt: null,
    nextId: initialNextId,
    picker: { open: false, query: '', matches: [], selected: 0 },
    slashPicker: { open: false, query: '', matches: [], selected: 0 },
    runningTools: new Map(),
    queue: [],
    nextQueueId: 1,
    inputHistory: [],
    historyIndex: 0,
    modelPicker: {
      open: false,
      step: 'provider' as const,
      providerOptions: [],
      modelOptions: [],
      filteredOptions: [],
      selected: 0,
      searchQuery: '',
    },
    autonomyPicker: { open: false, options: [], selected: 0 },
    settingsPicker: { open: false, field: 0, mode: 'off', delayMs: 0, titleAnimation: true, yolo: false, streamFleet: true, chime: false, confirmExit: true, nextPrediction: false, featureMcp: true, featurePlugins: true, featureMemory: true, featureSkills: true, featureModelsRegistry: true, contextAutoCompact: true, contextStrategy: 'hybrid', logLevel: 'info', auditLevel: 'standard', indexOnStart: true, maxIterations: 500 },
    confirmQueue: [],
    enhance: null,
    enhanceEnabled,
    enhanceBusy: false,
    escConfirm: null,
    contextChipVersion: 0,
    fleet: {},
    leader: {
      iterations: 0,
      toolCalls: 0,
      recentTools: [],
      currentTool: undefined,
      startedAt: Date.now(),
      lastEventAt: Date.now(),
      iterating: false,
    },
    fleetCost: 0,
    fleetTokens: { input: 0, output: 0 },
    fleetConcurrency: 4,
    streamFleet: true,
    monitorOpen: false,
    agentsMonitorOpen: false,
    helpOpen: false,
    todosMonitorOpen: false,
    queuePanelOpen: false,
    processListOpen: false,
    collabSession: null,
    checkpoints: [],
    rewindOverlay: null,
    eternalStage: null,
    goalSummary: null,
    autoPhase: null,
    worktrees: {},
    worktreeMonitorOpen: false,
    scrollOffset: 0,
    totalLines: 0,
    viewportRows: 0,
    pendingNewLines: 0,
  });

  const builderRef = useRef<InputBuilder | null>(null);
  if (builderRef.current === null) {
    builderRef.current = new InputBuilder({ store: attachments });
  }

  // Bracketed-paste accumulator. A single paste can be delivered across
  // several stdin/keypress events: only the first carries the \x1b[200~
  // begin marker and only the last carries \x1b[201~. We buffer every
  // fragment here between those markers and finalize once, so a paste never
  // fragments into multiple placeholders or leaks newlines into the buffer.
  // `null` means "not currently inside a paste".
  const pasteAccumRef = useRef<string | null>(null);
  // Safety net: if the closing \x1b[201~ marker never arrives (a terminal
  // dropped it, or Ink split the escape across chunks), flush the buffered
  // payload after a short idle period so accumulation can't swallow input
  // indefinitely. Real pastes deliver all fragments back-to-back, well
  // inside this window.
  const pasteFlushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const activeCtrlRef = useRef<AbortController | null>(null);
  // Set once we've asked Ink to unmount on a Ctrl+C exit. A synchronous ref
  // (not React state) because consecutive SIGINTs can fire faster than a
  // re-render — without it, `stateRef.current.interrupts` reads stale and a
  // wedged unmount could never escalate to a hard exit.
  const exitRequestedRef = useRef(false);
  // Prevent re-entrant handleKey: some terminals emit \r\n as two separate
  // stdin events for Enter. While the first event is being processed (submit
  // or picker accept), the second arrives with stale state and would trigger
  // a duplicate action. The gate blocks the stale-second event entirely.
  const inputGateRef = useRef(false);
  // Separate guard JUST for the submit path. The full `inputGateRef`
  // is held across `await foo()` blocks (picker accept, model picker
  // commit) — that's fine because those resolve in milliseconds. But
  // `await submit()` resolves only when `agent.run()` finishes, which
  // can be minutes for a delegated subagent task. Using the same gate
  // would lock ALL keystrokes (typing, backspace, slash menu) for the
  // entire agent run. This timestamp-based guard fires for the few
  // milliseconds needed to debounce a terminal-side `\r\n` double-event
  // and then auto-releases — leaving the input live for the user.
  const lastEnterAtRef = useRef(0);
  // Maps an inline attachment token (e.g. `[pasted #1, 123 lines]`) to a short
  // preview of its content, so the chat-history entry can show the collapsed
  // text below the message. Append-only for the lifetime of the session; the
  // token strings are unique per attachment seq, so stale entries are inert.
  const tokenPreviewsRef = useRef<Map<string, string>>(new Map());
  // The status-bar chip surfaces the basename so multiple WrongStack
  // windows running against different repos are immediately distinguishable.
  // Empty / root fallback to undefined so the chip just hides itself.
  const projectName = React.useMemo(() => {
    const base = path.basename(projectRoot);
    return base && base !== path.sep ? base : undefined;
  }, [projectRoot]);

  const chimeRef = useRef(chime);
  chimeRef.current = chime;
  const confirmExitRef = useRef(confirmExit);
  confirmExitRef.current = confirmExit;

  // Source of truth for the streamed assistant text — kept here, not in
  // React state, because we need to read it synchronously when `agent.run`
  // returns. The React `streamingText` shown in the live tail is throttled
  // (~10fps) for redraw cost, so it can lag the actual stream by up to
  // FLUSH_MS. Reading from this ref instead removes the race where the
  // final chunk lands in pending after run() returns and ends up flashing
  // into the next frame's tail (leaking into scrollback).
  const streamingTextRef = useRef('');
  const pendingDeltaRef = useRef('');
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Latest state snapshot — async callbacks (the queue drainer, slash command
  // closures) read this instead of capturing `state` to avoid stale closures.
  const stateRef = useRef<State>(state);
  stateRef.current = state;
  const draftRef = useRef({ buffer: state.buffer, cursor: state.cursor });
  draftRef.current = { buffer: state.buffer, cursor: state.cursor };

  // Latest handleKey, so the keyboard event pipeline can be accessed from
  // effects and callbacks defined above handleKey in the component body.
  const handleKeyRef = useRef<((input: string, key: KeyEvent) => void) | null>(null);

  // handleRewindTo must be declared before the /rewind useEffect (line 1803)
  // so the closure can capture it. It is intentionally NOT in useCallback
  // — each call needs a fresh rewinder referencing the current sessionsDir.
  const handleRewindTo = React.useCallback(
    async (checkpointIndex: number) => {
      const sessionId = agent.ctx.session.id;
      if (!sessionId) return;
      const rewinder = new DefaultSessionRewinder(sessionsDir ?? '', projectRoot ?? agent.ctx.cwd);
      // Revert file system changes first (read-only, safe to do eagerly).
      await rewinder.rewindToCheckpoint(sessionId, checkpointIndex);
      // Then truncate the conversation history — this fires session.rewound
      // on the EventBus, which the useEffect at line 2212 listens to and
      // dispatches sessionRewound + clearHistory.
      await agent.ctx.session.truncateToCheckpoint(checkpointIndex);
    },
    [agent.ctx.session, sessionsDir, projectRoot, agent.ctx.cwd],
  );

  const setDraft = (buffer: string, cursor: number): void => {
    draftRef.current = { buffer, cursor };
    dispatch({ type: 'setBuffer', buffer, cursor });
  };

  const clearDraft = (): void => {
    draftRef.current = { buffer: '', cursor: 0 };
    dispatch({ type: 'clearInput' });
  };

  // Global clock tick. Deliberately slow (10s). The StatusBar tracks its own 1s
  // elapsed-time display internally; this tick only feeds monitor overlays and
  // the todos poll (which have their own faster intervals when open).
  const startedAtRef = useRef<number>(Date.now());
  const [nowTick, setNowTick] = React.useState<number>(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNowTick(Date.now()), 10000);
    return () => clearInterval(t);
  }, []);

  // Animated dot indicator for the refine-in-progress bar. Cycles 0..3
  // while `enhanceBusy` is true so the user sees a live "still working" cue.
  const [enhanceDots, setEnhanceDots] = useState(0);
  useEffect(() => {
    if (!state.enhanceBusy) return;
    const t = setInterval(() => setEnhanceDots((n) => (n + 1) % 4), 400);
    return () => clearInterval(t);
  }, [state.enhanceBusy]);

  // Todos polling — separate 2s interval so the status-bar chip stays fresh
  // without relying on the 10s global tick. Compares with a ref to skip
  // dispatching when nothing changed.
  const todosRef = useRef(JSON.stringify([]));
  useEffect(() => {
    const poll = () => {
      const snap = JSON.stringify(agent.ctx.todos.map((t) => ({ s: t.status })));
      if (snap !== todosRef.current) {
        todosRef.current = snap;
        setNowTick(Date.now()); // trigger a re-render so useMemo re-evaluates
      }
    };
    const t = setInterval(poll, 2000);
    return () => clearInterval(t);
  }, [agent.ctx.todos]);

  // Git branch + change counts. Polled every 5s (cheap, two short-lived
  // `git` subprocesses). Skipped silently when the cwd isn't a repo or
  // git isn't installed — the chip just doesn't render.
  const [gitInfo, setGitInfo] = React.useState<GitInfo | null>(null);
  useEffect(() => {
    let cancelled = false;
    const refresh = () => {
      readGitInfo(agent.ctx.cwd)
        .then((info) => {
          if (!cancelled) setGitInfo(info);
        })
        .catch(() => undefined);
    };
    refresh();
    const t = setInterval(refresh, 5000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [agent.ctx.cwd]);

  // Latest provider request's input-token count. Tracked separately
  // from `tokenCounter` (which is cumulative) because for the context
  // fullness bar we want the live size of the conversation as it sat
  // on the wire — that's what determines how close we are to the
  // model's max context window.
  //
  // We sum input + cacheRead + cacheWrite so the chip reflects the TRUE
  // total context the model loaded (Usage is disjoint by design — see the
  // doc on Usage). Without this, prompt-cached turns would show only the
  // fresh-token delta and the chip would read 0% even when the context
  // was near the limit.
  // Cumulative "effective context" from tokenCounter: fresh input tokens
  // PLUS cached tokens that were sent as part of this prompt. All three
  // contribute to context-window pressure — cache tokens are still tokens
  // the model must process. (usage.input is disjoint from cacheRead/
  // cacheWrite, so simple sum is correct.)

  // Per-model maxContext. CLI passes the startup value, then model-switch and
  // ctx.pct events keep activeMaxContext in sync with the live agent context.
  const maxContext = activeMaxContext ?? agent.ctx.provider.capabilities.maxContext;

  // Per-request context pressure: current prompt tokens (input + cacheRead).
  // Unlike the cumulative tokenCounter.total() which grows across all turns,
  // this tracks the live request's context weight — what actually determines
  // how close we are to the maxContext ceiling.
  // Cached tokens (cacheWrite) are excluded because they are an accounting
  // artifact of THIS request (provider charges for them separately); they
  // are already counted in usage.input as part of the prompt the model sees.
  const currentContextTokens =
    (tokenCounter?.currentRequestTokens()?.input ?? 0) +
    (tokenCounter?.currentRequestTokens()?.cacheRead ?? 0);

  const contextWindow = useMemo(() => {
    void state.contextChipVersion;
    return currentContextTokens > 0 && maxContext > 0
      ? { used: currentContextTokens, max: maxContext }
      : undefined;
  }, [currentContextTokens, maxContext, state.contextChipVersion]);

  // Todo counts come from the agent's context, which is mutated by
  // the `todo` tool. Re-read on each render — array access is O(N) on
  // a list that's typically < 20 items.
  // biome-ignore lint/correctness/useExhaustiveDependencies: nowTick intentionally triggers re-render; ctx.todos is not React state
  const todos = useMemo(() => {
    const counts = { pending: 0, inProgress: 0, completed: 0 };
    for (const t of agent.ctx.todos) {
      if (t.status === 'pending') counts.pending++;
      else if (t.status === 'in_progress') counts.inProgress++;
      else if (t.status === 'completed') counts.completed++;
    }
    return counts;
    // Tick on `nowTick` so we pick up todo changes even though
    // agent.ctx.todos isn't React state — the 1s clock doubles as a
    // poll for ctx-side state.
  }, [nowTick, agent.ctx.todos]);

  // Fleet breakdown for the status-bar chip. Derived from `state.fleet`,
  // which the FleetBus event listeners already maintain — re-bucket
  // into running / idle / pending / completed because that's the slice
  // the user cares about at a glance. Recomputes on every state.fleet
  // change (cheap — fleet usually has <10 entries).
  const fleetCounts = useMemo(() => {
    const entries = Object.values(state.fleet);
    if (entries.length === 0) return undefined;
    let running = 0;
    let idle = 0;
    let completed = 0;
    for (const e of entries) {
      if (e.status === 'running') running += 1;
      else if (e.status === 'idle') idle += 1;
      else completed += 1; // success/failed/timeout/stopped all count as "done"
    }
    return { running, idle, pending: 0, completed };
  }, [state.fleet]);

  // Synthesize LEADER as AGENT#0 and prepend to the live fleet so the
  // monitor / FleetPanel are never empty even when no subagents have been
  // spawned. The 'leader' key can't collide with subagent IDs (those are
  // ULIDs). status maps from the high-level run state — streaming/running/
  // iterating → 'running', else 'idle'.
  const entriesWithLeader = useMemo<Record<string, FleetEntry>>(() => {
    const leaderEntry: FleetEntry = {
      id: 'leader',
      name: 'LEADER',
      provider,
      model,
      status:
        state.status === 'running' || state.status === 'streaming' || state.leader.iterating
          ? 'running'
          : 'idle',
      streamingText: '',
      iterations: state.leader.iterations,
      toolCalls: state.leader.toolCalls,
      recentTools: state.leader.recentTools,
      recentMessages: [],
      // Leader (main session) cost — the same number the statusline shows.
      // Kept distinct from fleet (subagent) cost so the monitor can show a
      // trustworthy grand total = leader + fleet.
      cost: tokenCounter?.estimateCost().total ?? 0,
      startedAt: state.leader.startedAt,
      lastEventAt: state.leader.lastEventAt,
      currentTool: state.leader.currentTool,
      ctxPct: state.leader.ctxPct,
      ctxTokens: state.leader.ctxTokens,
      ctxMaxTokens: state.leader.ctxMaxTokens ?? effectiveMaxContext,
    };
    return { leader: leaderEntry, ...state.fleet };
  }, [state.fleet, state.leader, state.status, provider, model, effectiveMaxContext, tokenCounter]);

  // Plan counts come from `<sessionId>.plan.json` on disk, not React
  // state. We poll lazily every few ticks so the chip stays current
  // without slamming the FS — plans change at human pace (a few times
  // per session at most), so 3s granularity is plenty.
  const [planCounts, setPlanCounts] = useState<{
    open: number;
    inProgress: number;
    done: number;
  } | null>(null);
  useEffect(() => {
    const planPath = (agent.ctx.meta as Record<string, unknown>)['plan.path'];
    if (typeof planPath !== 'string' || !planPath) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const data = await fs.readFile(planPath, 'utf8');
        const parsed = JSON.parse(data) as {
          items?: Array<{ status?: string | undefined }>;
        };
        if (cancelled) return;
        if (!Array.isArray(parsed.items)) {
          setPlanCounts(null);
          return;
        }
        let open = 0;
        let inProgress = 0;
        let done = 0;
        for (const it of parsed.items) {
          if (it?.status === 'done') done++;
          else if (it?.status === 'in_progress') inProgress++;
          else open++;
        }
        setPlanCounts(open + inProgress + done > 0 ? { open, inProgress, done } : null);
      } catch {
        // Missing or corrupt — clear the chip.
        if (!cancelled) setPlanCounts(null);
      }
    };
    void poll();
    const id = setInterval(poll, 3000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [agent.ctx.meta]);

  // Live-region shrink mitigation. Ink's log-update tracks the previous
  // render's logical line count; when content visually wraps past the
  // terminal width, the visual-row count exceeds the logical count and
  // log-update's clear-and-rewrite leaves the extra visual rows behind.
  // Those extras then slide into native scrollback as the next render
  // commits new Static items above the live region — looking to the user
  // like an extra echo of the input ("Enter ile boş input da history'e
  // sıyrılıyor").
  //
  // We can't reach log-update directly, but we can issue an erase-below-
  // cursor (\x1b[J) at the moments most likely to leak: when a picker /
  // dialog transitions from open → closed (the live region's height
  // drops sharply), when a fresh history entry was just committed, and
  // when the terminal resizes (Ink re-renders the live region but the
  // cleanup logic above doesn't fire since none of its deps changed).
  // \x1b[J only touches what's below the cursor, so committed Static
  // history above is preserved.
  const prevAnyOverlayOpen = useRef(false);
  const prevEntriesCount = useRef(0);
  // Track tool-stream text length so we can fire eraseLiveRegion when the
  // live tool-output box grows — prevents the ◆ bash ⏱ Xms header line
  // from duplicating into scrollback on every 500ms tick.
  const prevToolStreamLen = useRef(0);
  // Stable erase function — only calls process.stdout.write which is a stable global.
  const eraseLiveRegion = useCallback(() => {
    try {
      // \x1b[J = erase from cursor to end of screen. The cursor sits at the
      // top of log-update's live region, so this clears the stale live
      // region only and leaves committed Static history (in scrollback)
      // untouched. Do NOT prefix with \x1b[H: homing to (0,0) wipes the
      // visible committed output and forces the input/status bar to redraw
      // at the top of the viewport instead of staying pinned to the bottom.
      writeOut('\x1b[J');
    } catch {
      // stdout might be detached during shutdown — ignore.
    }
  }, []);
  // useLayoutEffect fires synchronously in the commit phase, BEFORE Ink
  // flushes the new tree to the terminal. This means \x1b[J cleans the old
  // live region BEFORE new Static items are written — preventing stale
  // input/statusbar content from bleeding into scrollback.
  // useEffect (async microtask) was too late: the terminal had already
  // scrolled the old content into scrollback by the time it fired.
  React.useLayoutEffect(() => {
    const anyOpenNow =
      state.picker.open ||
      state.slashPicker.open ||
      state.modelPicker.open ||
      state.autonomyPicker.open ||
      state.settingsPicker.open ||
      state.enhanceBusy ||
      state.enhance != null ||
      state.escConfirm != null ||
      state.confirmQueue.length > 0;
    const overlayClosed = prevAnyOverlayOpen.current && !anyOpenNow;
    const newEntryCommitted = state.entries.length > prevEntriesCount.current;
    const curToolStreamLen = state.toolStream?.text.length ?? 0;
    const toolStreamGrew = curToolStreamLen > 0 && curToolStreamLen > prevToolStreamLen.current;
    prevAnyOverlayOpen.current = anyOpenNow;
    prevEntriesCount.current = state.entries.length;
    prevToolStreamLen.current = curToolStreamLen;
    if (overlayClosed || newEntryCommitted || toolStreamGrew) {
      eraseLiveRegion();
    }
  }, [
    state.picker.open,
    state.slashPicker.open,
    state.modelPicker.open,
    state.autonomyPicker.open,
    state.settingsPicker.open,
    state.enhanceBusy,
    state.enhance,
    state.escConfirm,
    state.confirmQueue.length,
    state.entries.length,
    state.toolStream?.text,
    eraseLiveRegion,
  ]);

  // Erase stale live-region content on terminal resize. Without this, Ink
  // re-renders the live region at the new dimensions but leaves visual
  // artifacts from the previous size that bleed into scrollback.
  useEffect(() => {
    const handleResize = () => eraseLiveRegion();
    process.stdout.on('resize', handleResize);
    return () => {
      process.stdout.off('resize', handleResize);
    };
  }, [eraseLiveRegion]);

  // While the prompt-refinement flow is active, the EnhancePanel's countdown
  // re-renders the live region. In inline mode each redraw can bleed the
  // region's top rows into native scrollback, so the preview "clones" itself.
  // Erase the stale region before each paint (layout effect runs pre-flush)
  // so nothing accumulates. Gated on the flow being active.
  React.useLayoutEffect(() => {
    if (state.enhanceBusy || state.enhance != null) eraseLiveRegion();
  }, [state.enhanceBusy, state.enhance, eraseLiveRegion]);

  // Detect an active `@<query>` token at the cursor and drive the picker.
  // Reruns whenever buffer/cursor changes — guards against stale results.
  // biome-ignore lint/correctness/useExhaustiveDependencies: picker state reads are intentional — dispatching based on stale picker state is harmless
  useEffect(() => {
    const detected = detectAtToken(state.buffer, state.cursor);
    if (!detected) {
      if (state.picker.open) dispatch({ type: 'pickerClose' });
      return;
    }
    if (!state.picker.open || state.picker.query !== detected.query) {
      dispatch({ type: 'pickerOpen', query: detected.query });
    }
    let cancelled = false;
    searchFiles(projectRoot, detected.query, 8)
      .then((matches) => {
        if (!cancelled) {
          dispatch({ type: 'pickerSetMatches', query: detected.query, matches });
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.buffer, state.cursor, projectRoot]);

  // Detect an active `/<query>` token at the cursor and drive the slash picker.
  // biome-ignore lint/correctness/useExhaustiveDependencies: slashPicker state reads are intentional — same pattern as @ picker above
  useEffect(() => {
    const trimmed = state.buffer.trimStart();
    if (!trimmed.startsWith('/')) {
      if (state.slashPicker.open) dispatch({ type: 'slashPickerClose' });
      return;
    }
    // Once any whitespace appears after the leading '/', the user has moved
    // past the command name into argument territory (e.g. `/model glm-5.1`).
    // Keeping the picker open here is actively harmful: arrow keys would
    // still target the command menu even though the user is typing args.
    // Close it so Enter submits the full line.
    if (/\s/.test(trimmed)) {
      if (state.slashPicker.open) dispatch({ type: 'slashPickerClose' });
      return;
    }
    const query = trimmed.slice(1).toLowerCase();
    const allCommands = slashRegistry.listWithOwner();
    const CATEGORY_ORDER = ['Run', 'Session', 'Inspect', 'Agent', 'Config', 'App'] as const;
    const matches: SlashCommandMatch[] = allCommands
      .filter(({ cmd }) => {
        const name = cmd.name.toLowerCase();
        const aliases = cmd.aliases ?? [];
        return name.includes(query) || aliases.some((a) => a.toLowerCase().includes(query));
      })
      .map(({ cmd, owner }) => ({
        name: cmd.name,
        description: cmd.description,
        argsHint: cmd.argsHint,
        isBuiltin: owner === 'core',
        category: cmd.category ?? 'App',
      }))
      .sort((a, b) => {
        const catDiff = CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category);
        if (catDiff !== 0) return catDiff;
        return a.name.localeCompare(b.name);
      });

    if (!state.slashPicker.open) {
      dispatch({ type: 'slashPickerOpen', query, matches });
    } else if (state.slashPicker.query !== query) {
      dispatch({ type: 'slashPickerOpen', query, matches });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.buffer, slashRegistry]);

  const pasteClipboardImage = async (): Promise<void> => {
    const builder = builderRef.current;
    if (!builder) return;
    try {
      const img = await readClipboardImage();
      if (!img) {
        dispatch({
          type: 'addEntry',
          entry: { kind: 'info', text: 'No image on the clipboard.' },
        });
        return;
      }
      // Register-only: the token goes inline into the editable buffer (like a
      // pasted block) so it renders as a chip and expands from the buffer at
      // submit — not into a separate pill above the input.
      const token = await builder.registerImage(img.base64, img.mediaType);
      const kb = (img.bytes / 1024).toFixed(0);
      tokenPreviewsRef.current.set(token, `image, ${kb} KB`);
      const { buffer, cursor } = draftRef.current;
      const next = buffer.slice(0, cursor) + token + buffer.slice(cursor);
      setDraft(next, cursor + token.length);
    } catch (err) {
      dispatch({
        type: 'addEntry',
        entry: {
          kind: 'error',
          text: `Clipboard image error: ${err instanceof Error ? err.message : String(err)}`,
        },
      });
    }
  };

  const acceptPickerSelection = async (): Promise<void> => {
    const { open, matches, selected } = state.picker;
    if (!open || matches.length === 0) return;
    const picked = matches[selected];
    if (!picked) return;
    const builder = builderRef.current;
    if (!builder) return;

    // Find the @-token span we're replacing.
    const draft = draftRef.current;
    const tok = detectAtToken(draft.buffer, draft.cursor);
    if (!tok) {
      dispatch({ type: 'pickerClose' });
      return;
    }

    // Register the file (no builder display mutation) and put a path-keyed
    // `[file:<path>]` token inline in the visible buffer (replacing @query).
    // The buffer is the single source of truth — the token expands back to the
    // file content at submit via the store's path lookup.
    const absPath = path.isAbsolute(picked) ? picked : path.join(projectRoot, picked);
    try {
      const data = await fs.readFile(absPath, 'utf8');
      const token = await builder.registerFile({
        kind: 'file',
        data,
        meta: { filename: picked, label: picked },
      });
      const before = draft.buffer.slice(0, tok.start);
      const after = draft.buffer.slice(tok.end);
      const next = `${before}${token}${after}`;
      setDraft(next, tok.start + token.length);
      dispatch({ type: 'pickerClose' });
    } catch (err) {
      dispatch({
        type: 'addEntry',
        entry: {
          kind: 'error',
          text: `Attach failed: ${err instanceof Error ? err.message : String(err)}`,
        },
      });
      dispatch({ type: 'pickerClose' });
    }
  };

  /** Fill the buffer with the selected slash command and close the picker. */
  const acceptSlashPickerSelection = (): void => {
    const { open, matches, selected } = state.slashPicker;
    if (!open || matches.length === 0) return;
    const picked = matches[selected];
    if (!picked) return;
    const cmd = picked.argsHint !== undefined ? `/${picked.name} ` : `/${picked.name}`;
    setDraft(cmd, cmd.length);
    dispatch({ type: 'slashPickerClose' });
  };

  // Rehydrate any queue items persisted by a previous (crashed) run.
  // Fires once at mount; the persist effect below picks up afterwards.
  // We dispatch one enqueue per item so the reducer's id allocation
  // stays the single source of truth — no need to import its internals.
  useEffect(() => {
    if (!queueStore) return;
    let cancelled = false;
    queueStore
      .read()
      .then((items) => {
        if (cancelled || items.length === 0) return;
        for (const item of items) {
          dispatch({
            type: 'enqueue',
            item: { displayText: item.displayText, blocks: item.blocks },
          });
        }
        dispatch({
          type: 'addEntry',
          entry: {
            kind: 'info',
            text: `Restored ${items.length} queued message${items.length === 1 ? '' : 's'} from a previous run.`,
          },
        });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queueStore]);

  // Persist the queue snapshot on every change. Strip the in-memory id
  // before writing — it's render bookkeeping, not part of the message.
  // Errors are swallowed: the queue lives in memory regardless, so a
  // persistence failure only loses crash-recovery, not the queue itself.
  useEffect(() => {
    if (!queueStore) return;
    queueStore
      .write(state.queue.map(({ displayText, blocks }) => ({ displayText, blocks })))
      .catch(() => undefined);
  }, [state.queue, queueStore]);

  // Register the TUI-only /queue command for the lifetime of this App.
  useEffect(() => {
    const cmd = createQueueSlashCommand({
      getQueue: () => stateRef.current.queue,
      clear: () => dispatch({ type: 'queueClear' }),
      deleteAt: (positions) => dispatch({ type: 'queueDelete', positions }),
    });
    slashRegistry.register(cmd);
    return () => {
      slashRegistry.unregister('queue');
    };
  }, [slashRegistry]);

  // Register /kill (list/kill tracked bash/exec processes) and /ps (list only).
  useEffect(() => {
    slashRegistry.register(createKillSlashCommand());
    slashRegistry.register(createPsSlashCommand());
    return () => {
      slashRegistry.unregister('kill');
      slashRegistry.unregister('ps');
    };
  }, [slashRegistry]);

  // Kill all tracked bash/exec processes when the TUI unmounts.
  // This fires on natural exit, Ctrl+C, and any other unmount path,
  // ensuring no orphaned child processes survive after the session ends.
  useEffect(() => {
    return () => {
      getProcessRegistry().killAll();
    };
  }, []);

  // `/steer <message>` — slash-command equivalent of Esc-to-steer.
  // Useful when Esc is consumed by an outer terminal multiplexer, or
  // when the user wants a single-shot redirect without the typed
  // follow-up (the message is the new direction). Performs the same
  // sequence the Esc handler does: snapshot context, abort the active
  // run, terminate the fleet, drop the queue, then sets steeringPending
  // so the message — submitted as the slash command's return — picks
  // up the rich STEERING preamble in the normal submit path.
  //
  // Unlike Esc, this slash command can be invoked at any state. When
  // the agent is idle the abort and fleet-termination are no-ops; the
  // steering preamble still gets prepended, which is harmless extra
  // context ("nothing was running") for the next turn.
  useEffect(() => {
    const cmd = {
      name: 'steer',
      description: 'Interrupt the running agent (incl. fleet) and redirect: /steer <new direction>',
      help: [
        'Usage: /steer <new direction>',
        '',
        'Aborts the active iteration, terminates any running subagents,',
        'drops queued messages, and sends your text to the model with a',
        'STEERING preamble explaining what was in flight and what the',
        'model is authorised to do (pivot hard, respawn subagents, ask',
        'for clarification). Equivalent to pressing Esc then typing.',
      ].join('\n'),
      async run(args: string) {
        const text = args.trim();
        if (!text) {
          return { message: 'Usage: /steer <new direction>' };
        }
        // Capture BEFORE mutating — same as the Esc handler.
        const s = stateRef.current;
        const runningTools = Array.from(s.runningTools.values()).map((t) => t.name);
        const subagents = Object.values(s.fleet)
          .filter((e) => e.status === 'running')
          .map((e) => ({ label: e.name, status: e.status, tool: e.currentTool?.name }));
        const subagentsTerminated = subagents.length;
        const partialAssistantText = streamingTextRef.current.slice(-1500);

        activeCtrlRef.current?.abort();
        dispatch({
          type: 'steerStart',
          snapshot: { runningTools, subagents, subagentsTerminated, partialAssistantText },
        });
        const droppedCount = s.queue.length;
        if (droppedCount > 0) dispatch({ type: 'queueClear' });
        if (director && subagentsTerminated > 0) {
          const cap = new Promise<void>((resolve) => {
            const t = setTimeout(resolve, 1500);
            t.unref?.();
          });
          void Promise.race([director.terminateAll().catch(() => undefined), cap]);
        }

        // Build the full preamble + direction here, return it as the
        // slash command output's `runText` so the submit pipeline
        // sends THIS to the model instead of "/steer …".
        const preamble = buildSteeringPreamble(
          { runningTools, subagents, subagentsTerminated, partialAssistantText },
          text,
        );
        // Consume immediately — the runText below already carries the
        // preamble; the steeringPending flag would otherwise double up.
        dispatch({ type: 'steerConsume' });

        const droppedTag = droppedCount > 0 ? ` · dropped ${droppedCount} queued` : '';
        const fleetTag =
          subagentsTerminated > 0
            ? ` · stopped ${subagentsTerminated} subagent${subagentsTerminated === 1 ? '' : 's'}`
            : '';
        return {
          message: `↯ Steering${droppedTag}${fleetTag}.`,
          runText: preamble,
        };
      },
    };
    slashRegistry.register(cmd);
    return () => {
      slashRegistry.unregister('steer');
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slashRegistry, director]);

  // `/rewind` — open the checkpoint timeline overlay. If a checkpoint
  // index is provided as argument, rewinds directly to it.
  // eslint-disable-next-line react-hooks/exhaustive-deps -- handleRewindTo is stable via useCallback
  useEffect(() => {
    const cmd = {
      name: 'rewind',
      description: 'Open checkpoint timeline to rewind session: /rewind [checkpoint-index]',
      help: [
        'Usage: /rewind [checkpoint-index]',
        '',
        'Opens a checkpoint timeline. Use ↑/↓ to navigate, Enter to rewind,',
        'Esc to cancel. The session is reverted to the selected checkpoint',
        'and conversation history is truncated — LLM continues fresh.',
        '',
        'If a checkpoint index is provided the timeline is skipped and',
        'rewind happens immediately.',
      ].join('\n'),
      async run(args: string) {
        const idx = Number.parseInt(args.trim(), 10);
        if (!Number.isNaN(idx) && idx >= 0) {
          handleRewindTo(idx);
          return {};
        }
        // No arg — open the timeline overlay
        const s = stateRef.current;
        if (s.checkpoints.length === 0) {
          return { message: 'No checkpoints in this session yet.' };
        }
        dispatch({ type: 'rewindOverlayOpen' });
        return {};
      },
    };
    slashRegistry.register(cmd);
    return () => {
      slashRegistry.unregister('rewind');
    };
  }, [slashRegistry, handleRewindTo]);

  // `/agents` — bare `/agents` and `/agents monitor` toggle the overlay.
  // `/agents <id>` falls through to the CLI builtin (same-name registration
  // from the same 'core' owner is a no-op per SlashCommandRegistry semantics,
  // so we own the bare/monitor forms here and let the builtin handle IDs).
  useEffect(() => {
    const cmd = {
      name: 'agents',
      description: 'Toggle the agents monitor overlay.',
      async run(args: string) {
        const arg = args.trim().toLowerCase();
        if (!arg || arg === 'monitor') {
          dispatch({ type: 'toggleAgentsMonitor' });
          return { message: undefined };
        }
        // Any other arg falls through to the CLI builtin (same owner
        // 'core' re-registration = silently ignored). The builtin handles
        // onAgents UUID lookups and /agents on|off.
        return { message: undefined };
      },
    };
    slashRegistry.register(cmd);
    return () => {
      slashRegistry.unregister('agents');
    };
  }, [slashRegistry]);

  // `/goal` is registered as a CLI builtin (packages/cli/src/slash-commands/
  // goal.ts) which handles both the preamble lock-in (the former TUI
  // behavior) and goal.json persistence for /autonomy eternal. The TUI
  // does NOT register its own /goal here — that would collide with the
  // builtin and throw "already registered" on mount.

  // Open routines shared by their slash command AND a mouse click on the
  // matching status-bar chip. Kept in refs (below) so the empty-dep mouse
  // handler can fire the latest version without re-subscribing.
  const openModelPicker = React.useCallback(async () => {
    if (!getPickableProviders) return;
    const providers = await getPickableProviders();
    dispatch({ type: 'modelPickerOpen', providers });
  }, [getPickableProviders]);
  const openSettings = React.useCallback(() => {
    if (!getSettings) return;
    const s = getSettings();
    dispatch({
      type: 'settingsOpen',
      mode: s.mode,
      delayMs: s.delayMs,
      titleAnimation: s.titleAnimation ?? true,
      yolo: s.yolo ?? false,
      streamFleet: s.streamFleet ?? true,
      chime: s.chime ?? false,
      confirmExit: s.confirmExit ?? true,
      nextPrediction: s.nextPrediction ?? false,
      featureMcp: s.featureMcp ?? true,
      featurePlugins: s.featurePlugins ?? true,
      featureMemory: s.featureMemory ?? true,
      featureSkills: s.featureSkills ?? true,
      featureModelsRegistry: s.featureModelsRegistry ?? true,
      contextAutoCompact: s.contextAutoCompact ?? true,
      contextStrategy: s.contextStrategy ?? 'hybrid',
      logLevel: s.logLevel ?? 'info',
      auditLevel: s.auditLevel ?? 'standard',
      indexOnStart: s.indexOnStart ?? true,
      maxIterations: s.maxIterations ?? 500,
    });
  }, [getSettings]);

  // Register the TUI-only `/model` command — opens a two-step picker
  // (provider → model). All work is local state mutation; the actual
  // switch fires only after the user confirms a model in step 2.
  useEffect(() => {
    if (!getPickableProviders || !switchProviderAndModel) return;
    const cmd = {
      name: 'model',
      aliases: ['provider', 'switch'],
      description: 'Pick a provider + model interactively (two-step).',
      async run() {
        await openModelPicker();
        return { message: undefined };
      },
    };
    // Register as an official TUI plugin so it can override a CLI built-in
    // of the same name (owner='tui' + official=true → claims the bare name).
    slashRegistry.register(cmd, 'tui', { official: true });
    return () => {
      slashRegistry.unregister('model');
    };
  }, [slashRegistry, getPickableProviders, switchProviderAndModel, openModelPicker]);

  // Register the TUI-only `/settings` command — opens the interactive
  // SettingsPicker immediately, same as Ctrl+S. Gated on the settings
  // accessors being wired by the host (CLI passes them in).
  useEffect(() => {
    if (!getSettings || !saveSettings) return;
    const cmd = {
      name: 'settings',
      aliases: ['config', 'prefs'],
      description: 'Open the interactive settings editor (19 config fields across 8 sections).',
      async run() {
        openSettings();
        return { message: undefined };
      },
    };
    // Register as an official TUI plugin so it overrides the CLI's text-based
    // /settings command. Without this, only Ctrl+S could open the picker.
    slashRegistry.register(cmd, 'tui', { official: true });
    return () => {
      slashRegistry.unregister('settings');
    };
  }, [slashRegistry, getSettings, saveSettings, openSettings]);

  // Register the TUI-only `/autonomy` command — opens a single-step picker.
  // When the user types `/autonomy` with no arg, the picker appears.
  // If they type `/autonomy off` etc. with an arg, the CLI builtin handles it.
  useEffect(() => {
    if (!switchAutonomy) return;
    const cmd = {
      name: 'autonomy',
      aliases: ['auto'],
      description: 'Pick an autonomy mode interactively (picker).',
      async run() {
        dispatch({ type: 'autonomyPickerOpen', options: AUTONOMY_OPTIONS });
        return { message: undefined };
      },
    };
    // Register as an official TUI plugin so it overrides the CLI's text-based
    // /autonomy command. Opens the interactive picker instead.
    slashRegistry.register(cmd, 'tui', { official: true });
    return () => {
      slashRegistry.unregister('autonomy');
    };
  }, [slashRegistry, switchAutonomy]);

  // Subscribe to provider streaming events.
  useEffect(() => {
    // Throttle stream delta DISPATCHES to reduce flicker — we batch into
    // React state at ~10fps. The full text is also written into
    // streamingTextRef synchronously on every delta, so `runBlocks` can
    // read the complete stream when `agent.run` returns without racing
    // the throttle's last unflushed batch.
    const FLUSH_MS = 100;
    const flush = () => {
      if (pendingDeltaRef.current) {
        dispatch({ type: 'streamDelta', delta: pendingDeltaRef.current });
        pendingDeltaRef.current = '';
      }
      flushTimerRef.current = null;
    };
    const offDelta = events.on('provider.text_delta', (e) => {
      // Strip any bracketed-paste DCS sequences that some providers echo
      // into the stream. They are invisible in a real terminal but appear as
      // junk text if Ink's raw rendering catches them. The ESC byte is
      // matched optionally — a stripped/split ESC would otherwise leave a
      // bare `[200~` in the rendered text (same failure as the input path).
      // biome-ignore lint/suspicious/noControlCharactersInRegex: bracketed paste escape sequences are intentional
      const text = e.text.replace(/\x1b?\[200~|\x1b?\[201~/g, '');
      streamingTextRef.current += text;
      pendingDeltaRef.current += text;
      if (!flushTimerRef.current) flushTimerRef.current = setTimeout(flush, FLUSH_MS);
    });
    const offToolStart = events.on('tool.started', (e) => {
      dispatch({ type: 'toolStarted', id: e.id, name: e.name });
      dispatch({ type: 'leaderToolStart', name: e.name });
    });
    const offIterStart = events.on('iteration.started', () => {
      dispatch({ type: 'leaderIterStart' });
    });
    const offIterEnd = events.on('iteration.completed', () => {
      dispatch({ type: 'leaderIterEnd' });
    });
    const offToolProgress = events.on('tool.progress', (e) => {
      // Only `partial_output` becomes the live tail. Other event kinds
      // (`log`, `warning`, `metric`, `file_changed`) are deliberately not
      // rendered here — they pile up too fast and would steal screen real
      // estate from the assistant text. They still flow through EventBus
      // for observability/metrics consumers.
      if (e.event.type !== 'partial_output' || !e.event.text) return;
      dispatch({
        type: 'toolStreamAppend',
        toolUseId: e.id,
        name: e.name,
        text: e.event.text,
        startedAt: Date.now(),
      });
    });
    const offTool = events.on('tool.executed', (e) => {
      // `delegate` renders its own readable start/finish lines via the
      // delegate.started / delegate.completed events below — skip the
      // generic tool entry so history doesn't also show the big JSON blob.
      if (e.name !== 'delegate') {
        dispatch({
          type: 'addEntry',
          entry: {
            kind: 'tool',
            name: e.name,
            durationMs: e.durationMs,
            ok: e.ok,
            input: e.input,
            output: e.output,
            // Real model-visible sizes — forwarded so the size chip beside
            // the tool header can show what the model paid for instead of
            // the misleading preview-byte count we used to surface.
            outputBytes: e.outputBytes,
            outputTokens: e.outputTokens,
            outputLines: e.outputLines,
          },
        });
      }
      // `tool.executed` has no tool_use id; the reducer falls back to
      // clearing the oldest running entry that matches this name.
      dispatch({ type: 'toolEnded', name: e.name });
      // Clear the live tail for this tool — the final entry is now in
      // <Static>, no need to keep mirroring it below.
      dispatch({ type: 'toolStreamClear', name: e.name });
      // Mirror into the leader-only counter so the AgentsMonitor's LEADER
      // row stays live even when no subagents exist.
      dispatch({ type: 'leaderToolEnd', name: e.name, ok: e.ok, durationMs: e.durationMs });
      // Echo the current todo list into chat whenever the `todo` tool
      // mutates ctx.todos — same format as `/todos list`. Snapshotted from
      // agent.ctx.todos at this point (the tool executor has already
      // applied the mutation by the time tool.executed fires).
      if (e.ok && e.name === 'todo') {
        dispatch({
          type: 'addEntry',
          entry: { kind: 'info', text: formatTodosList(agent.ctx.todos) },
        });
      }
    });
    const offRetry = events.on('provider.retry', (e) => {
      const secs = (e.delayMs / 1000).toFixed(e.delayMs >= 1000 ? 1 : 2);
      dispatch({
        type: 'addEntry',
        entry: { kind: 'warn', text: `⟳ retry ${e.attempt} in ${secs}s — ${e.description}` },
      });
    });
    const offProvErr = events.on('provider.error', (e) => {
      dispatch({
        type: 'addEntry',
        entry: { kind: 'error', text: e.description },
      });
    });
    // Per-iteration text flush. Without this, the entire run buffers all text
    // deltas in the live tail box and dumps them into history as ONE assistant
    // entry only after `agent.run()` returns. Tool results, in contrast, land
    // in history immediately via `tool.executed` — so a multi-iteration turn
    // renders as "all tools, then a wall of text" instead of the natural
    // text → tool → text → tool interleaving that matches the actual stream.
    //
    // We hook `provider.response` (fires once per LLM call, both for
    // intermediate `tool_use` stops and the final `end_turn`) and commit
    // whatever has accumulated in `streamingTextRef` as an assistant history
    // entry. The next iteration's deltas start a fresh buffer. `runBlocks`
    // becomes purely the loop driver — it no longer adds the assistant entry,
    // since the per-iteration flushes have already done so.
    const offProvResp = events.on('provider.response', () => {
      const text = streamingTextRef.current;
      streamingTextRef.current = '';
      pendingDeltaRef.current = '';
      if (flushTimerRef.current) {
        clearTimeout(flushTimerRef.current);
        flushTimerRef.current = null;
      }
      dispatch({ type: 'streamReset' });
      if (text.trim()) {
        dispatch({ type: 'addEntry', entry: { kind: 'assistant', text } });
      }
    });
    const offConfirmNeeded = events.on('tool.confirm_needed', (e) => {
      // Only show the ConfirmPrompt component — no duplicate history entry needed.
      // The full ConfirmPrompt with y/n/a/d keys is rendered below;
      // the history placeholder was redundant.
      dispatch({
        type: 'confirmOpen',
        info: {
          toolUseId: e.toolUseId,
          toolName: e.tool.name,
          input: e.input,
          suggestedPattern: e.suggestedPattern,
          resolve: e.resolve,
        },
      });
    });
    const offTrustPersisted = events.on('trust.persisted', (e) => {
      const icon = e.decision === 'always' ? '✓' : '✗';
      const label = e.decision === 'always' ? 'always allowed' : 'denied';
      dispatch({
        type: 'addEntry',
        entry: {
          kind: 'info',
          text: `${icon} ${label}: ${e.tool}(${e.pattern})`,
        },
      });
    });
    // `delegate` lifecycle — render a "started" line up front (so the
    // minutes-long subagent wait doesn't look idle) and a humanized result
    // line on completion. These replace the suppressed generic tool entry.
    const offDelegateStart = events.on('delegate.started', (e) => {
      const task = e.task.length > 100 ? `${e.task.slice(0, 99)}…` : e.task;
      dispatch({
        type: 'addEntry',
        entry: {
          kind: 'subagent',
          agentLabel: e.target,
          agentColor: 'magenta',
          icon: '🤝',
          text: 'delegating',
          detail: task,
        },
      });
    });
    const offDelegateDone = events.on('delegate.completed', (e) => {
      const cost = e.costUsd && e.costUsd > 0 ? `$${e.costUsd.toFixed(4)}` : undefined;
      dispatch({
        type: 'addEntry',
        entry: {
          kind: 'subagent',
          agentLabel: e.target,
          agentColor: e.ok ? 'green' : 'red',
          icon: e.ok ? '✓' : '✗',
          text: e.summary,
          detail: cost,
        },
      });
    });
    return () => {
      offDelta();
      offToolStart();
      offIterStart();
      offIterEnd();
      offToolProgress();
      offTool();
      offRetry();
      offProvErr();
      offProvResp();
      offConfirmNeeded();
      offTrustPersisted();
      offDelegateStart();
      offDelegateDone();
      if (flushTimerRef.current) clearTimeout(flushTimerRef.current);
    };
  }, [events, agent.ctx.todos]);

  // Live mirror of the prompt-refinement toggle, read synchronously inside
  // submit() (which can't see the latest reducer state through its closure).
  const enhanceEnabledRef = useRef(state.enhanceEnabled);
  useEffect(() => {
    enhanceEnabledRef.current = state.enhanceEnabled;
  }, [state.enhanceEnabled]);
  // Abort handle for the in-flight refiner call, so Esc can cancel a slow
  // "refining..." and send the original immediately.
  const enhanceAbortRef = useRef<AbortController | null>(null);

  useTuiEventBridge({
    events,
    dispatch,
    stateRef,
    setActiveMaxContext,
    subscribeAutoPhase,
    onClearHistory,
  });

  useTuiControllers({
    dispatch,
    streamFleet: state.streamFleet,
    enhanceEnabled: state.enhanceEnabled,
    agentsMonitorOpen: state.agentsMonitorOpen,
    fleetStreamController,
    enhanceController,
    agentsMonitorController,
  });

  // Track double-Esc for input buffer clearing.
  const lastEscAtRef = useRef(0);
  const ESC_DOUBLE_PRESS_MS = 1000;

  useDirectorFleetBridge({
    director,
    dispatch,
    stateRef,
    streamFleet: state.streamFleet,
  });

  // Handle SIGINT as a three-stage escalation:
  //   1st press — stop work and stay at the prompt: cancel the foreground
  //     run + kill the fleet, OR (in autonomy / background-only mode) halt
  //     the engines + terminate the fleet. Pickers cancel instead.
  //   2nd press — exit: graceful Ink unmount (restores the terminal) with a
  //     hard-exit fallback timer in case the React tree is wedged.
  //   3rd press — immediate process.exit, so a wedged Ink loop can't trap
  //     the user.
  useEffect(() => {
    const onSigint = () => {
      const current = stateRef.current;
      // Second (or later) Ctrl+C — exit no matter what. Status may be
      // 'aborting', 'running', or 'streaming'; the user has clearly
      // decided they want out. Try Ink's graceful exit first, then
      // hard-exit on a short timer in case the React tree is wedged.
      if (current.interrupts >= 1) {
        // Second (or later) Ctrl+C — the user wants out. Force-kill tracked
        // processes regardless of state.
        getProcessRegistry().killAll({ force: true });
        // If we already asked Ink to unmount and the user pressed again, the
        // React tree is wedged — hard-exit immediately.
        if (exitRequestedRef.current) {
          process.exit(130);
        }
        exitRequestedRef.current = true;
        dispatch({ type: 'interrupt' });
        // Terminate any lingering fleet so subagents don't outlive the TUI.
        if (director) void director.terminateAll().catch(() => undefined);
        // Graceful Ink unmount first: it restores the terminal (raw mode off,
        // cursor shown) and routes the 130 exit code
        // through run-tui's settle(). A bare process.exit() here would skip
        // that and can leave the terminal in raw mode — the "exit feels
        // broken" symptom. Fall back to a hard exit if Ink never unmounts.
        onExit(130);
        exit();
        const hardExit = setTimeout(() => process.exit(130), 400);
        hardExit.unref?.();
        return;
      }
      dispatch({ type: 'interrupt' });

      // Pickers are safe to cancel outright — closing the overlay
      // restores the previous state cleanly with no side-effects.
      // Do this first so a single Ctrl+C from the model picker or
      // slash picker exits gracefully instead of doing nothing.
      if (current.modelPicker.open) {
        dispatch({ type: 'modelPickerClose' });
        dispatch({
          type: 'addEntry',
          entry: { kind: 'warn', text: 'Model picker cancelled.' },
        });
        return;
      }
      if (current.settingsPicker.open) {
        dispatch({ type: 'settingsClose' });
        dispatch({
          type: 'addEntry',
          entry: { kind: 'warn', text: 'Settings cancelled.' },
        });
        return;
      }
      if (current.slashPicker.open) {
        dispatch({ type: 'slashPickerClose' });
        dispatch({
          type: 'addEntry',
          entry: { kind: 'warn', text: 'Cancelled.' },
        });
        return;
      }

      if (activeCtrlRef.current) {
        activeCtrlRef.current.abort();
        dispatch({ type: 'status', status: 'aborting' });
        // Kill every running subagent on the first interrupt — without
        // this the parent agent.run() stays parked in `await delegate
        // → director.awaitTasks` forever and the "press again to exit"
        // hint becomes a lie.
        //
        // We `await` terminateAll AND race a 1500ms cap so a stuck
        // bridge or hung tool can't trap us in cleanup — the user
        // pressed Ctrl+C; their patience is finite. The second
        // Ctrl+C still forces exit immediately via the path above,
        // so this race only matters for the polite-shutdown window.
        if (director) {
          const cap = new Promise<void>((resolve) => {
            const t = setTimeout(resolve, 1500);
            t.unref?.();
          });
          void Promise.race([director.terminateAll().catch(() => undefined), cap]);
        }
        // Kill all tracked bash/exec processes from the process registry.
        // This ensures runaway child processes (including background bashes
        // that outlive the agent iteration) are cleaned up on Ctrl+C.
        const killed = getProcessRegistry().killAll();
        const procTag =
          killed.length > 0
            ? ` + killed ${killed.length} process${killed.length === 1 ? '' : 'es'}`
            : '';
        const droppedCount = stateRef.current.queue.length;
        if (droppedCount > 0) {
          dispatch({ type: 'queueClear' });
          dispatch({
            type: 'addEntry',
            entry: {
              kind: 'warn',
              text: `Iteration cancelled${director ? ' + fleet terminated' : ''}${procTag}. Dropped ${droppedCount} queued message${droppedCount === 1 ? '' : 's'}. ${confirmExitRef.current ? 'Press Ctrl+C again to confirm exit.' : 'Press Ctrl+C again to exit.'}`,
            },
          });
        } else {
          dispatch({
            type: 'addEntry',
            entry: {
              kind: 'warn',
              text: `Iteration cancelled${director ? ' + fleet terminated' : ''}${procTag}. ${confirmExitRef.current ? 'Press Ctrl+C again to confirm exit.' : 'Press Ctrl+C again to exit.'}`,
            },
          });
        }
      } else {
        // No foreground (runBlocks) controller. We may still have background
        // work with no AbortController of its own: an autonomy engine driving
        // iterations, or a fleet of subagents. Eternal/parallel loops never
        // set activeCtrlRef, so this branch is the ONLY place their Ctrl+C is
        // handled — the first press must actually stop that work (and return
        // to the prompt), not merely announce "press again to exit".
        const fleetRunning = Object.values(current.fleet).filter(
          (e) => e.status === 'running',
        ).length;
        const autonomyRunning =
          eternalLoopRunningRef.current ||
          parallelLoopRunningRef.current ||
          getEternalEngine?.()?.currentState === 'running' ||
          getParallelEngine?.()?.currentState === 'running';
        if (autonomyRunning || fleetRunning > 0) {
          // Halt the engines first — eternal's stop() aborts the in-flight
          // iteration; both flip their persisted state to 'stopped'. Then
          // flip autonomy off so the driver loop won't start another
          // iteration, and terminate the fleet + tracked processes.
          getEternalEngine?.()?.stop();
          getParallelEngine?.()?.stop();
          if (autonomyRunning) switchAutonomy?.('off');
          if (director) {
            const cap = new Promise<void>((resolve) => {
              const t = setTimeout(resolve, 1500);
              t.unref?.();
            });
            void Promise.race([director.terminateAll().catch(() => undefined), cap]);
          }
          const killed = getProcessRegistry().killAll();
          const bits: string[] = [];
          if (autonomyRunning) bits.push('autonomy stopped');
          if (fleetRunning > 0)
            bits.push(`${fleetRunning} agent${fleetRunning === 1 ? '' : 's'} terminated`);
          if (killed.length > 0)
            bits.push(`${killed.length} process${killed.length === 1 ? '' : 'es'} killed`);
          dispatch({
            type: 'addEntry',
            entry: {
              kind: 'warn',
              text: `${bits.join(' + ') || 'Background work stopped'}. ${confirmExitRef.current ? 'Press Ctrl+C again to confirm exit.' : 'Press Ctrl+C again to exit.'}`,
            },
          });
          return;
        }
        // Truly idle — nothing running. Kill any lingering processes and arm
        // the second-press exit.
        const killed = getProcessRegistry().killAll();
        const procTag =
          killed.length > 0
            ? ` Killed ${killed.length} process${killed.length === 1 ? '' : 'es'}.`
            : '';
        dispatch({
          type: 'addEntry',
          entry: { kind: 'warn', text: `Press Ctrl+C again to exit.${procTag}` },
        });
      }
    };
    process.on('SIGINT', onSigint);
    return () => {
      process.off('SIGINT', onSigint);
    };
  }, [director, getEternalEngine, getParallelEngine, switchAutonomy, onExit, exit]);

  /** Truncate pasted content for history preview: first `lines` lines + "..." line if truncated. */
  const truncatePastePreview = (text: string, lines: number): string => {
    const all = text.split('\n');
    if (all.length <= lines) return text;
    const head = all.slice(0, lines).join('\n');
    return `${head}\n... (${all.length - lines} more lines)`;
  };

  // Finalize a fully-assembled paste payload. A collapse-worthy paste (long
  // or many-lined) or any multi-line paste becomes an inline `[pasted #N, L
  // lines]` chip in the editable row — the content lives in the AttachmentStore
  // and is expanded from the buffer at submit. A short single-line paste is
  // inserted straight into the row as raw text so the user can see and edit it.
  const commitPaste = async (full: string): Promise<void> => {
    const builder = builderRef.current;
    if (!builder || !full) return;
    if (builder.wouldCollapse(full) || full.includes('\n')) {
      // Register-only: store the paste, get back the inline token. The token
      // goes into the buffer (single source of truth); nothing is appended to
      // the builder's own display, so there's no double-expansion at submit.
      const token = await builder.registerPaste(full);
      tokenPreviewsRef.current.set(token, truncatePastePreview(full, 6));
      const { buffer, cursor } = draftRef.current;
      const next = buffer.slice(0, cursor) + token + buffer.slice(cursor);
      setDraft(next, cursor + token.length);
      return;
    }
    const { buffer, cursor } = draftRef.current;
    const next = buffer.slice(0, cursor) + full + buffer.slice(cursor);
    setDraft(next, cursor + full.length);
  };

  const handleKey = async (input: string, key: KeyEvent) => {
    // Note: we no longer block input while the agent is running. Enter
    // routes through the queue when busy (see submit()), but typing,
    // backspace, paste, and clipboard-image all stay live.
    // Exception: when status is 'aborting', all input is blocked — except
    // Ctrl+C which the SIGINT handler processes directly (not through handleKey).
    // We check interrupts here so the second Ctrl+C can still reach the handler
    // even though status is 'aborting'.
    // Block input while aborting — unless the user is mid-steering
    // (they need to type their new direction) or already pressed Ctrl+C
    // twice (exit ladder takes priority). Ctrl+C SIGINT handler bypasses
    // handleKey entirely so it always fires regardless of this guard.
    if (state.status === 'aborting' && !state.steeringPending && state.interrupts === 0) return;
    // Block all input while confirmation prompt is shown — the ConfirmPrompt
    // component handles y/n/a/d/escape/enter itself and Input's disabled prop
    // is not reliable when multiple useInput hooks are active.
    if (state.confirmQueue.length > 0) return;
    // While the refiner call is in flight, Esc cancels it (send original now);
    // all other keys are swallowed so nothing leaks into the input.
    if (state.enhanceBusy) {
      if (key.escape) enhanceAbortRef.current?.abort();
      return;
    }
    // The EnhancePanel owns Enter/Esc/e, so the main input stays out of the way.
    if (state.enhance) return;

    // The ESC-interrupt confirmation dialog is modal — EscConfirmPrompt owns
    // y/n/Esc/Enter; all other keys are swallowed.
    if (state.escConfirm) return;

    // The help overlay is modal: Esc / `?` / `q` dismiss it; every other key is
    // swallowed so nothing leaks into the editor or chat behind it.
    if (state.helpOpen) {
      if (key.escape || input === '?' || input === 'q') dispatch({ type: 'toggleHelp' });
      return;
    }

    // ── Monitor overlays are NON-modal ───────────────────────────────
    // F2 fleet, F3 agents, F4 worktree, F6 todos, F7 queue, and the
    // autoPhase monitor render in the lower region of the layout, but the
    // chat input above them stays LIVE — typing, backspace, paste, cursor
    // movement, and Enter (submit) all flow through to the input buffer.
    // Only the F-key toggles below and Esc are reserved for the panel:
    //   • F2/F3/F4/F6/F7 toggle their respective overlay
    //   • Esc closes whichever overlay is open
    // (Overlays with their own dedicated UI — `confirmQueue`, `enhance`,
    // `modelPicker`, `autonomyPicker`, `settingsPicker`, `rewindOverlay`,
    // `helpOpen` — are still modal and keep their own guards above.)
    // Ctrl+C still aborts via the SIGINT handler, which bypasses handleKey.

    // Re-entrancy guard: block stale-second events from \r\n terminals.
    if (inputGateRef.current) return;

    // ── Double-Esc clears input buffer ────────────────────────────────
    // When the user presses Esc twice within ESC_DOUBLE_PRESS_MS ms while
    // the buffer is non-empty, clear it. This mirrors the behaviour of bash's
    // Ctrl+C double-press clearing the line, adapted for Esc (no Ctrl needed).
    if (key.escape) {
      const now = Date.now();
      if (state.buffer.length > 0 && now - lastEscAtRef.current < ESC_DOUBLE_PRESS_MS) {
        dispatch({ type: 'clearInput' });
        lastEscAtRef.current = 0;
        return;
      }
      lastEscAtRef.current = now;
    }

    // ── Bracketed-paste accumulation ──────────────────────────────────
    // Must run before the Enter/key handling below: a paste split across
    // events can land a fragment that is exactly "\n", which would
    // otherwise be read as Enter and submit mid-paste. The begin marker
    // (\x1b[200~, or a bare [200~ when Ink ate the ESC) opens accumulation;
    // we swallow every fragment until the end marker (\x1b[201~ / [201~),
    // then finalize the whole payload at once.
    if (input) {
      const paste = feedPaste(pasteAccumRef.current, input);
      if (paste) {
        pasteAccumRef.current = paste.accum;
        if (pasteFlushTimerRef.current) clearTimeout(pasteFlushTimerRef.current);
        if (paste.complete !== null) {
          pasteFlushTimerRef.current = null;
          await commitPaste(paste.complete);
          return;
        }
        pasteFlushTimerRef.current = setTimeout(() => {
          pasteFlushTimerRef.current = null;
          const full = pasteAccumRef.current;
          pasteAccumRef.current = null;
          if (full) void commitPaste(full);
        }, 250);
        return;
      }
    }

    // Some terminals emit \r\n for Enter as two separate stdin events.
    // \r arrives with key.return=true (handled below); \n may arrive as
    // a stray character with key.return=false. Normalize both to Enter
    // and prevent them from polluting the buffer as literal text.
    const isEnter = key.return || input === '\r' || input === '\n';

    // IMPORTANT: do NOT bail on `!input` here. Special keys (arrows,
    // Enter, Escape, Tab, Backspace) arrive with an empty `input`
    // string, and the slash/file pickers + cursor movement below all
    // depend on receiving those events. The late guard before text
    // insertion handles the empty-input case correctly.

    // Model picker takes absolute precedence: nothing else is meaningful
    // while the two-step overlay is open. Esc cancels (or backs out of
    // step 2 to step 1); Enter advances to the next step or confirms.
    // Step 2 additionally supports type-to-search and Backspace-to-delete.
    if (state.modelPicker.open) {
      if (key.escape) {
        if (state.modelPicker.step === 'model') {
          dispatch({ type: 'modelPickerBack' });
        } else {
          dispatch({ type: 'modelPickerClose' });
        }
        return;
      }
      if (key.upArrow) {
        dispatch({ type: 'modelPickerMove', delta: -1 });
        return;
      }
      if (key.downArrow) {
        dispatch({ type: 'modelPickerMove', delta: 1 });
        return;
      }
      // Step 2: type-to-search — printable characters append to the filter.
      if (state.modelPicker.step === 'model' && input && !key.return && !key.backspace) {
        dispatch({ type: 'modelPickerSearch', query: state.modelPicker.searchQuery + input });
        return;
      }
      // Step 2: Backspace — delete last char from filter, or go back if empty.
      if (state.modelPicker.step === 'model' && key.backspace) {
        const q = state.modelPicker.searchQuery;
        if (q.length > 0) {
          dispatch({ type: 'modelPickerSearch', query: q.slice(0, -1) });
        } else {
          dispatch({ type: 'modelPickerBack' });
        }
        return;
      }
      if (isEnter) {
        // Debounce \r\n double-event from terminals that emit Enter as two stdin reads.
        const now = Date.now();
        if (now - lastEnterAtRef.current < 50) return;
        lastEnterAtRef.current = now;
        inputGateRef.current = true;
        try {
          if (state.modelPicker.step === 'provider') {
            const opt = state.modelPicker.providerOptions[state.modelPicker.selected];
            if (!opt) return;
            dispatch({
              type: 'modelPickerPickProvider',
              providerId: opt.id,
              models: opt.models,
            });
            return;
          }
          // step === 'model' → commit the switch (use filteredOptions for selected model)
          const providerId = state.modelPicker.pickedProviderId;
          const modelId = state.modelPicker.filteredOptions[state.modelPicker.selected];
          if (!providerId || !modelId) return;
          const err = switchProviderAndModel?.(providerId, modelId);
          if (err) {
            dispatch({ type: 'modelPickerHint', text: err });
            return;
          }
          setLiveProvider(providerId);
          setLiveModel(modelId);
          setActiveMaxContext(agent.ctx.provider.capabilities.maxContext);
          dispatch({
            type: 'addEntry',
            entry: { kind: 'info', text: `Switched to ${providerId} / ${modelId}.` },
          });
          dispatch({ type: 'modelPickerClose' });
          return;
        } finally {
          inputGateRef.current = false;
        }
      }
      // Any other key while picker is open: ignore.
      return;
    }

    // Autonomy picker takes absolute precedence while open.
    if (state.autonomyPicker.open) {
      if (key.escape) {
        dispatch({ type: 'autonomyPickerClose' });
        return;
      }
      if (key.upArrow) {
        dispatch({ type: 'autonomyPickerMove', delta: -1 });
        return;
      }
      if (key.downArrow) {
        dispatch({ type: 'autonomyPickerMove', delta: 1 });
        return;
      }
      if (isEnter) {
        // Debounce \r\n double-event from terminals that emit Enter as two stdin reads.
        const now = Date.now();
        if (now - lastEnterAtRef.current < 50) return;
        lastEnterAtRef.current = now;
        const opt = state.autonomyPicker.options[state.autonomyPicker.selected];
        if (!opt) return;
        const err = switchAutonomy?.(opt.mode);
        if (err) {
          dispatch({ type: 'autonomyPickerHint', text: err });
          return;
        }
        dispatch({ type: 'autonomyPickerClose' });
        return;
      }
      return;
    }

    if (state.settingsPicker.open) {
      if (key.escape || (key.ctrl && input === 's')) {
        dispatch({ type: 'settingsClose' });
        return;
      }
      if (key.upArrow) {
        dispatch({ type: 'settingsFieldMove', delta: -1 });
        return;
      }
      if (key.downArrow) {
        dispatch({ type: 'settingsFieldMove', delta: 1 });
        return;
      }
      if (key.leftArrow) {
        dispatch({ type: 'settingsValueChange', delta: -1 });
        return;
      }
      if (key.rightArrow) {
        dispatch({ type: 'settingsValueChange', delta: 1 });
        return;
      }
      if (isEnter) {
        // Debounce \r\n double-event from terminals that emit Enter as two stdin reads.
        const now = Date.now();
        if (now - lastEnterAtRef.current < 50) return;
        lastEnterAtRef.current = now;
        const { mode, delayMs, titleAnimation, yolo, streamFleet, chime, confirmExit, nextPrediction, featureMcp, featurePlugins, featureMemory, featureSkills, featureModelsRegistry, contextAutoCompact, contextStrategy, logLevel, auditLevel, indexOnStart, maxIterations } = state.settingsPicker;
        const err = await saveSettings?.({ mode, delayMs, titleAnimation, yolo, streamFleet, chime, confirmExit, nextPrediction, featureMcp, featurePlugins, featureMemory, featureSkills, featureModelsRegistry, contextAutoCompact, contextStrategy, logLevel, auditLevel, indexOnStart, maxIterations });
        if (err) {
          dispatch({ type: 'settingsHint', text: err });
          return;
        }
        dispatch({ type: 'settingsClose' });
        return;
      }
      return;
    }

    if (state.slashPicker.open) {
      if (key.escape) {
        dispatch({ type: 'slashPickerClose' });
        return;
      }
      if (key.upArrow) {
        dispatch({ type: 'slashPickerMove', delta: -1 });
        return;
      }
      if (key.downArrow) {
        dispatch({ type: 'slashPickerMove', delta: 1 });
        return;
      }
      if (isEnter) {
        const now = Date.now();
        if (now - lastEnterAtRef.current < 50) return;
        lastEnterAtRef.current = now;
        inputGateRef.current = true;
        const line = selectedSlashCommandLine(state.slashPicker);
        if (line) {
          void submit(line);
        } else {
          acceptSlashPickerSelection();
        }
        inputGateRef.current = false;
        return;
      }
      // Tab → autocomplete with selected command
      if (key.tab && state.slashPicker.matches.length > 0) {
        const sel = state.slashPicker.matches[state.slashPicker.selected];
        if (sel) {
          setDraft(`/${sel.name} `, sel.name.length + 2);
          dispatch({ type: 'slashPickerClose' });
        }
        return;
      }
      // Any other key falls through to normal text handling.
    }

    // Picker takes precedence over normal input handling when open.
    if (state.picker.open) {
      if (key.escape) {
        dispatch({ type: 'pickerClose' });
        return;
      }
      if (key.upArrow) {
        dispatch({ type: 'pickerMove', delta: -1 });
        return;
      }
      if (key.downArrow) {
        dispatch({ type: 'pickerMove', delta: 1 });
        return;
      }
      if (isEnter) {
        // Debounce \r\n double-event from terminals that emit Enter as two stdin reads.
        const now = Date.now();
        if (now - lastEnterAtRef.current < 50) return;
        lastEnterAtRef.current = now;
        inputGateRef.current = true;
        try {
          await acceptPickerSelection();
        } finally {
          inputGateRef.current = false;
        }
        return;
      }
      // Any other key falls through to normal text handling, which will
      // either extend the @-query (e.g. typing more chars) or break it
      // (e.g. typing a space) — handled below.
    }

    // Esc when the agent is busy = "drop what you're doing, I want to
    // steer". Aborts the current iteration, terminates any running
    // subagents (otherwise they keep burning tokens on now-stale work),
    // and stashes a context snapshot so the STEERING preamble can tell
    // the model exactly what it was mid-doing. Does NOT consume the
    // Ctrl+C exit ladder (interrupts counter untouched). When no run
    // is active, Esc falls through to normal text handling.
    //
    // When `confirmExit` is enabled, Esc first shows a confirmation
    // dialog ("Are you sure?") so the user doesn't accidentally
    // interrupt a long-running task. The dialog is dismissed with
    // y/Enter to confirm or n/Esc to cancel.
    if (key.escape && state.status !== 'idle' && state.confirmQueue.length === 0) {
      // Snapshot context BEFORE we mutate anything. The submit handler
      // replays this into the model prompt so the model isn't guessing.
      const runningTools = Array.from(state.runningTools.values()).map((t) => t.name);
      const subagents = Object.values(state.fleet)
        .filter((e) => e.status === 'running')
        .map((e) => ({
          label: e.name,
          status: e.status,
          tool: e.currentTool?.name,
        }));
      const subagentsTerminated = subagents.length;
      const partialAssistantText = streamingTextRef.current.slice(-1500);
      const snapshot = {
        runningTools,
        subagents,
        subagentsTerminated,
        partialAssistantText,
      };

      // ── confirmExit gate: show confirmation dialog ──────────────────
      if (confirmExitRef.current) {
        dispatch({ type: 'escConfirmOpen', snapshot });
        dispatch({
          type: 'addEntry',
          entry: {
            kind: 'warn',
            text:
              `⏸ Interrupt? [y]es — stop and steer  ·  [n]o / Esc — keep running` +
              (subagentsTerminated > 0
                ? `  (${subagentsTerminated} subagent${subagentsTerminated === 1 ? '' : 's'})`
                : ''),
          },
        });
        return;
      }

      // ── Immediate interrupt (confirmExit is off) ────────────────────
      activeCtrlRef.current?.abort();
      dispatch({ type: 'status', status: 'aborting' });
      dispatch({ type: 'steerStart', snapshot });

      // Kill the fleet too. Without this the subagents keep running
      // on the old direction, finish minutes later, and pollute the
      // chat with task.completed events the model doesn't care about
      // anymore. Cap at 1.5s so a wedged bridge can't hang the steer.
      if (director && subagentsTerminated > 0) {
        const cap = new Promise<void>((resolve) => {
          const t = setTimeout(resolve, 1500);
          t.unref?.();
        });
        void Promise.race([director.terminateAll().catch(() => undefined), cap]);
      }

      // Drop anything queued — steering means the user is redirecting,
      // not adding to the backlog. Without this the queued items would
      // run *before* the steering message, which contradicts the UX.
      const droppedCount = state.queue.length;
      if (droppedCount > 0) dispatch({ type: 'queueClear' });
      const droppedTag = droppedCount > 0 ? ` · dropped ${droppedCount} queued` : '';
      const fleetTag =
        subagentsTerminated > 0
          ? ` · stopped ${subagentsTerminated} subagent${subagentsTerminated === 1 ? '' : 's'}`
          : '';
      dispatch({
        type: 'addEntry',
        entry: {
          kind: 'warn',
          text: `↯ Interrupted${droppedTag}${fleetTag}. Type your new direction.`,
        },
      });
      return;
    }

    // Monitor overlays. Ctrl+F/G/T are the primary chords; F2/F3/F4 are
    // terminal-safe aliases because some terminals intercept the chord before
    // it reaches the app (notably Windows Terminal eats Ctrl+F for "Find").
    // F11 is deliberately unused — most terminals reserve it for fullscreen.
    // All toggles are allowed even while aborting, so the user can check
    // subagent state mid-steer.
    const toggleFleetOverlay = () => {
      if (state.monitorOpen) {
        dispatch({ type: 'toggleMonitor' });
        return;
      }
      // Opening: close all other overlays/panels first.
      if (state.agentsMonitorOpen) dispatch({ type: 'toggleAgentsMonitor' });
      if (state.worktreeMonitorOpen) dispatch({ type: 'worktreeMonitorToggle' });
      if (state.todosMonitorOpen) dispatch({ type: 'toggleTodosMonitor' });
      if (state.autoPhase?.monitorOpen) dispatch({ type: 'autoPhaseMonitorToggle' });
      if (state.settingsPicker.open) dispatch({ type: 'settingsClose' });
      if (state.queuePanelOpen) dispatch({ type: 'toggleQueuePanel' });
      if (state.helpOpen) dispatch({ type: 'toggleHelp' });
      dispatch({ type: 'toggleMonitor' });
    };
    const toggleAgentsOverlay = () => {
      if (state.agentsMonitorOpen) {
        dispatch({ type: 'toggleAgentsMonitor' });
        return;
      }
      // Opening: close all other overlays/panels first.
      if (state.monitorOpen) dispatch({ type: 'toggleMonitor' });
      if (state.worktreeMonitorOpen) dispatch({ type: 'worktreeMonitorToggle' });
      if (state.todosMonitorOpen) dispatch({ type: 'toggleTodosMonitor' });
      if (state.autoPhase?.monitorOpen) dispatch({ type: 'autoPhaseMonitorToggle' });
      if (state.settingsPicker.open) dispatch({ type: 'settingsClose' });
      if (state.queuePanelOpen) dispatch({ type: 'toggleQueuePanel' });
      if (state.helpOpen) dispatch({ type: 'toggleHelp' });
      dispatch({ type: 'toggleAgentsMonitor' });
    };
    const toggleWorktreeOverlay = () => {
      if (state.worktreeMonitorOpen) {
        dispatch({ type: 'worktreeMonitorToggle' });
        return;
      }
      if (state.agentsMonitorOpen) dispatch({ type: 'toggleAgentsMonitor' });
      if (state.monitorOpen) dispatch({ type: 'toggleMonitor' });
      if (state.autoPhase?.monitorOpen) dispatch({ type: 'autoPhaseMonitorToggle' });
      if (state.todosMonitorOpen) dispatch({ type: 'toggleTodosMonitor' });
      if (state.settingsPicker.open) dispatch({ type: 'settingsClose' });
      if (state.queuePanelOpen) dispatch({ type: 'toggleQueuePanel' });
      if (state.helpOpen) dispatch({ type: 'toggleHelp' });
      dispatch({ type: 'worktreeMonitorToggle' });
    };
    const toggleTodosOverlay = () => {
      if (state.todosMonitorOpen) {
        dispatch({ type: 'toggleTodosMonitor' });
        return;
      }
      if (state.agentsMonitorOpen) dispatch({ type: 'toggleAgentsMonitor' });
      if (state.monitorOpen) dispatch({ type: 'toggleMonitor' });
      if (state.worktreeMonitorOpen) dispatch({ type: 'worktreeMonitorToggle' });
      if (state.autoPhase?.monitorOpen) dispatch({ type: 'autoPhaseMonitorToggle' });
      if (state.settingsPicker.open) dispatch({ type: 'settingsClose' });
      if (state.queuePanelOpen) dispatch({ type: 'toggleQueuePanel' });
      if (state.helpOpen) dispatch({ type: 'toggleHelp' });
      dispatch({ type: 'toggleTodosMonitor' });
    };
    // Ctrl+F / F2 → fleet orchestration monitor.
    if ((key.ctrl && input === 'f') || key.fn === 2) {
      toggleFleetOverlay();
      return;
    }
    // Ctrl+G / F3 → agents live monitor.
    if ((key.ctrl && input === 'g') || key.fn === 3) {
      toggleAgentsOverlay();
      return;
    }
    // Ctrl+T / F4 → worktree monitor. (Word-delete that used to live on Ctrl+T
    // is covered by Ctrl+Backspace.)
    if ((key.ctrl && input === 't') || key.fn === 4) {
      toggleWorktreeOverlay();
      return;
    }
    // F5 → open/close the autonomy settings editor. Opening closes any
    // other open overlay or panel so only one dashboard is visible.
    if (key.fn === 5) {
      if (state.settingsPicker.open) {
        dispatch({ type: 'settingsClose' });
      } else if (getSettings && saveSettings) {
        // Close all other overlays/panels first.
        if (state.agentsMonitorOpen) dispatch({ type: 'toggleAgentsMonitor' });
        if (state.monitorOpen) dispatch({ type: 'toggleMonitor' });
        if (state.worktreeMonitorOpen) dispatch({ type: 'worktreeMonitorToggle' });
        if (state.todosMonitorOpen) dispatch({ type: 'toggleTodosMonitor' });
        if (state.autoPhase?.monitorOpen) dispatch({ type: 'autoPhaseMonitorToggle' });
        if (state.queuePanelOpen) dispatch({ type: 'toggleQueuePanel' });
        if (state.helpOpen) dispatch({ type: 'toggleHelp' });
        const cfg = getSettings();
        dispatch({
          type: 'settingsOpen',
          mode: cfg.mode,
          delayMs: cfg.delayMs,
          titleAnimation: cfg.titleAnimation ?? true,
          yolo: cfg.yolo ?? false,
          streamFleet: cfg.streamFleet ?? true,
          chime: cfg.chime ?? false,
          confirmExit: cfg.confirmExit ?? true,
          nextPrediction: cfg.nextPrediction ?? false,
          featureMcp: cfg.featureMcp ?? true,
          featurePlugins: cfg.featurePlugins ?? true,
          featureMemory: cfg.featureMemory ?? true,
          featureSkills: cfg.featureSkills ?? true,
          featureModelsRegistry: cfg.featureModelsRegistry ?? true,
          contextAutoCompact: cfg.contextAutoCompact ?? true,
          contextStrategy: cfg.contextStrategy ?? 'hybrid',
          logLevel: cfg.logLevel ?? 'info',
          auditLevel: cfg.auditLevel ?? 'standard',
          indexOnStart: cfg.indexOnStart ?? true,
          maxIterations: cfg.maxIterations ?? 500,
        });
      }
      return;
    }
    // F6 → full-screen todos monitor overlay.
    if (key.fn === 6) {
      toggleTodosOverlay();
      return;
    }
    // F7 → queue panel. Opening closes any other overlay or panel.
    if (key.fn === 7) {
      if (state.queuePanelOpen) {
        dispatch({ type: 'toggleQueuePanel' });
      } else {
        // Close all other overlays/panels first.
        if (state.agentsMonitorOpen) dispatch({ type: 'toggleAgentsMonitor' });
        if (state.monitorOpen) dispatch({ type: 'toggleMonitor' });
        if (state.worktreeMonitorOpen) dispatch({ type: 'worktreeMonitorToggle' });
        if (state.todosMonitorOpen) dispatch({ type: 'toggleTodosMonitor' });
        if (state.autoPhase?.monitorOpen) dispatch({ type: 'autoPhaseMonitorToggle' });
        if (state.settingsPicker.open) dispatch({ type: 'settingsClose' });
        if (state.helpOpen) dispatch({ type: 'toggleHelp' });
        dispatch({ type: 'toggleQueuePanel' });
      }
      return;
    }
    // F8 → process list overlay. Opening closes any other overlay or panel.
    if (key.fn === 8) {
      if (state.processListOpen) {
        dispatch({ type: 'toggleProcessList' });
      } else {
        if (state.agentsMonitorOpen) dispatch({ type: 'toggleAgentsMonitor' });
        if (state.monitorOpen) dispatch({ type: 'toggleMonitor' });
        if (state.worktreeMonitorOpen) dispatch({ type: 'worktreeMonitorToggle' });
        if (state.todosMonitorOpen) dispatch({ type: 'toggleTodosMonitor' });
        if (state.autoPhase?.monitorOpen) dispatch({ type: 'autoPhaseMonitorToggle' });
        if (state.settingsPicker.open) dispatch({ type: 'settingsClose' });
        if (state.queuePanelOpen) dispatch({ type: 'toggleQueuePanel' });
        if (state.helpOpen) dispatch({ type: 'toggleHelp' });
        dispatch({ type: 'toggleProcessList' });
      }
      return;
    }
    // Ctrl+S toggles the autonomy settings editor (also openable via
    // F5 and `/settings`). Opening closes any other overlay or panel.
    if (key.ctrl && input === 's') {
      if (state.settingsPicker.open) {
        dispatch({ type: 'settingsClose' });
      } else if (getSettings && saveSettings) {
        // Close all other overlays/panels first.
        if (state.agentsMonitorOpen) dispatch({ type: 'toggleAgentsMonitor' });
        if (state.monitorOpen) dispatch({ type: 'toggleMonitor' });
        if (state.worktreeMonitorOpen) dispatch({ type: 'worktreeMonitorToggle' });
        if (state.todosMonitorOpen) dispatch({ type: 'toggleTodosMonitor' });
        if (state.autoPhase?.monitorOpen) dispatch({ type: 'autoPhaseMonitorToggle' });
        if (state.queuePanelOpen) dispatch({ type: 'toggleQueuePanel' });
        if (state.helpOpen) dispatch({ type: 'toggleHelp' });
        const cfg = getSettings();
        dispatch({
          type: 'settingsOpen',
          mode: cfg.mode,
          delayMs: cfg.delayMs,
          titleAnimation: cfg.titleAnimation ?? true,
          yolo: cfg.yolo ?? false,
          streamFleet: cfg.streamFleet ?? true,
          chime: cfg.chime ?? false,
          confirmExit: cfg.confirmExit ?? true,
          nextPrediction: cfg.nextPrediction ?? false,
          featureMcp: cfg.featureMcp ?? true,
          featurePlugins: cfg.featurePlugins ?? true,
          featureMemory: cfg.featureMemory ?? true,
          featureSkills: cfg.featureSkills ?? true,
          featureModelsRegistry: cfg.featureModelsRegistry ?? true,
          contextAutoCompact: cfg.contextAutoCompact ?? true,
          contextStrategy: cfg.contextStrategy ?? 'hybrid',
          logLevel: cfg.logLevel ?? 'info',
          auditLevel: cfg.auditLevel ?? 'standard',
          indexOnStart: cfg.indexOnStart ?? true,
          maxIterations: cfg.maxIterations ?? 500,
        });
      }
      return;
    }
    // Esc closes whichever overlay/panel is open.
    if (key.escape) {
      if (state.agentsMonitorOpen) {
        dispatch({ type: 'toggleAgentsMonitor' });
        return;
      }
      if (state.monitorOpen) {
        dispatch({ type: 'toggleMonitor' });
        return;
      }
      if (state.worktreeMonitorOpen) {
        dispatch({ type: 'worktreeMonitorToggle' });
        return;
      }
      if (state.todosMonitorOpen) {
        dispatch({ type: 'toggleTodosMonitor' });
        return;
      }
      if (state.autoPhase?.monitorOpen) {
        dispatch({ type: 'autoPhaseMonitorToggle' });
        return;
      }
      if (state.settingsPicker.open) {
        dispatch({ type: 'settingsClose' });
        return;
      }
      if (state.queuePanelOpen) {
        dispatch({ type: 'toggleQueuePanel' });
        return;
      }
      if (state.processListOpen) {
        dispatch({ type: 'toggleProcessList' });
        return;
      }
    }

    // `?` on an empty prompt opens the keys-&-commands help overlay (lazygit
    // style). With any draft text it types normally, so a literal `?` mid-
    // message is never swallowed. Guarded against every other overlay/picker so
    // it never steals their `?`.
    if (
      input === '?' &&
      !key.ctrl &&
      !key.meta &&
      draftRef.current.buffer === '' &&
      !state.slashPicker.open &&
      !state.picker.open &&
      !state.modelPicker.open &&
      !state.autonomyPicker.open &&
      !state.settingsPicker.open &&
      !state.rewindOverlay &&
      !state.monitorOpen &&
      !state.agentsMonitorOpen &&
      !state.worktreeMonitorOpen &&
      !state.todosMonitorOpen &&
      !state.autoPhase?.monitorOpen
    ) {
      dispatch({ type: 'toggleHelp' });
      return;
    }

    if (isEnter) {
      // Shift+Enter inserts a literal newline instead of submitting.
      if (key.shift) {
        const { buffer, cursor } = draftRef.current;
        const next = buffer.slice(0, cursor) + '\n' + buffer.slice(cursor);
        setDraft(next, cursor + 1);
        return;
      }

      // Re-entrancy protection for terminals that emit `\r\n` as two
      // separate stdin events: ignore Enter pressed within 50ms of the
      // last one. The 50ms window catches the double-event reliably
      // (the second `\n` arrives within microseconds of the `\r`) while
      // staying well below human double-tap speed.
      //
      // We intentionally do NOT await submit() here — it kicks off
      // agent.run() which can stay pending for minutes when a delegate
      // call is in flight. Awaiting would block this handler frame for
      // the full duration, which means every subsequent keystroke would
      // miss its dispatch (including the slash key — the user reported
      // the input feeling dead during delegated work). submit() handles
      // its own re-entrancy via state.status: when the agent is busy,
      // the message is queued instead of re-running concurrently.
      const now = Date.now();
      if (now - lastEnterAtRef.current < 50) return;
      lastEnterAtRef.current = now;
      void submit();
      return;
    }

    const { buffer, cursor } = draftRef.current;

    if (key.backspace) {
      if (key.ctrl) {
        if (cursor === 0) return;
        const beforeCursor = buffer.slice(0, cursor);
        const lastWordStart = beforeCursor.lastIndexOf(' ') + 1;
        const next = beforeCursor.slice(0, lastWordStart) + buffer.slice(cursor);
        setDraft(next, lastWordStart);
        return;
      }

      // Token-aware backspace: if the text immediately before the cursor ends
      // with a whole attachment chip (`[pasted …]` / `[file:…]` / `[image …]`),
      // delete the entire token in one keystroke — anywhere in the line, not
      // just at the end.
      const tokenDel = deleteTokenBackward(buffer, cursor);
      if (tokenDel) {
        setDraft(tokenDel.buffer, tokenDel.cursor);
        return;
      }

      if (cursor === 0) return;
      const next = buffer.slice(0, cursor - 1) + buffer.slice(cursor);
      setDraft(next, cursor - 1);
      return;
    }

    if (key.delete) {
      if (key.ctrl) {
        if (cursor >= buffer.length) return;
        const afterCursor = buffer.slice(cursor);
        const nextWordStart = afterCursor.indexOf(' ');
        const end = nextWordStart === -1 ? buffer.length : cursor + nextWordStart + 1;
        const next = buffer.slice(0, cursor) + buffer.slice(end);
        setDraft(next, cursor);
        return;
      }

      if (cursor >= buffer.length) return;
      // Token-aware forward delete: drop a whole chip if one starts at cursor.
      const span = tokenLengthForward(buffer, cursor) || 1;
      const next = buffer.slice(0, cursor) + buffer.slice(cursor + span);
      setDraft(next, cursor);
      return;
    }

    if (key.leftArrow) {
      if (key.ctrl) {
        if (cursor === 0) return;
        const beforeCursor = buffer.slice(0, cursor);
        const prevWordStart = beforeCursor.lastIndexOf(' ');
        const target = prevWordStart === -1 ? 0 : prevWordStart + 1;
        setDraft(buffer, target);
        return;
      }
      if (cursor > 0) setDraft(buffer, cursor - 1);
      return;
    }
    if (key.rightArrow) {
      if (key.ctrl) {
        if (cursor >= buffer.length) return;
        const afterCursor = buffer.slice(cursor);
        const nextWordStart = afterCursor.indexOf(' ');
        const target = nextWordStart === -1 ? buffer.length : cursor + nextWordStart + 1;
        setDraft(buffer, target);
        return;
      }
      if (cursor < buffer.length) setDraft(buffer, cursor + 1);
      return;
    }
    if (key.home) {
      setDraft(buffer, 0);
      return;
    }
    if (key.end) {
      setDraft(buffer, buffer.length);
      return;
    }

    // History scrolling is delegated to the terminal's native scrollback
    // (mouse wheel, Shift+PgUp in Windows Terminal, etc.) — Ink's <Static>
    // emits each finalized entry once and never repaints over it.
    // Skip when ANY overlay below the statusline is open — these overlays
    // use arrow keys for their own navigation (↑↓ selection, scrolling).
    // Pickers (settings/model/autonomy) are already intercepted earlier
    // and never reach this point, so they don't need listing here.
    const overlayOpen =
      state.monitorOpen ||
      state.agentsMonitorOpen ||
      state.worktreeMonitorOpen ||
      state.todosMonitorOpen ||
      state.queuePanelOpen ||
      state.processListOpen ||
      state.helpOpen ||
      (state.autoPhase?.monitorOpen ?? false) ||
      state.rewindOverlay !== null;

    if (key.upArrow) {
      if (!overlayOpen && state.inputHistory.length > 0) {
        dispatch({ type: 'historyUp' });
      }
      return;
    }
    if (key.downArrow) {
      if (!overlayOpen && state.historyIndex > 0) {
        dispatch({ type: 'historyDown' });
      }
      return;
    }
    // Ctrl+P → toggle PhaseMonitor overlay when AutoPhase is active.
    if (key.ctrl && input === 'p') {
      if (state.autoPhase) dispatch({ type: 'autoPhaseMonitorToggle' });
      else {
        // No active AutoPhase — treat as a command alias for /autophase status
        slashRegistry.dispatch('/autophase', agent.ctx).then((res) => {
          if (res?.message)
            dispatch({ type: 'addEntry', entry: { kind: 'info', text: res.message } });
        });
      }
      return;
    }
    if (key.ctrl && input === 'a') {
      setDraft(buffer, 0);
      return;
    }
    if (key.ctrl && input === 'e') {
      setDraft(buffer, buffer.length);
      return;
    }
    if (key.ctrl && input === 'u') {
      setDraft('', 0);
      return;
    }
    // Ctrl+D → delete character at cursor (forward delete).
    // Ctrl+D also doubles as "EOF" in some shells — here it's just convenient
    // forward-delete when the user isn't at the terminal's physical Delete key.
    if (key.ctrl && input === 'd') {
      if (cursor >= buffer.length) return;
      // Token-aware forward delete: drop a whole chip if one starts at cursor.
      const span = tokenLengthForward(buffer, cursor) || 1;
      const next = buffer.slice(0, cursor) + buffer.slice(cursor + span);
      setDraft(next, cursor);
      return;
    }

    // Ctrl+K → kill: delete from cursor to end of line.
    if (key.ctrl && input === 'k') {
      if (cursor >= buffer.length) return;
      const next = buffer.slice(0, cursor);
      setDraft(next, cursor);
      return;
    }

    // Alt+V → read image from clipboard and attach as [image #N].
    if (key.meta && input === 'v') {
      await pasteClipboardImage();
      return;
    }

    if (!input || key.ctrl || key.meta) return;

    // Never insert a raw escape sequence as text. An unrecognized F-key or CSI
    // sequence that Ink forwards as `input` would otherwise leak bytes into the
    // row (the F2/F3/F4 overlays are handled above via key.fn from raw stdin).
    if (input.charCodeAt(0) === 0x1b) return;

    // Non-bracketed large paste: some terminals (notably older Windows
    // consoles) don't emit \x1b[200~ markers, so a paste arrives as one big
    // text chunk. Bracketed pastes are already handled by the accumulation
    // guard near the top of handleKey; route big unmarked chunks through the
    // same finalizer so they collapse to a pill consistently.
    if (input.length > PASTE_THRESHOLD_CHARS) {
      await commitPaste(input);
      return;
    }

    // Any multi-line chunk is a paste (Enter was already handled above), even
    // a short non-bracketed one. Route it through the same finalizer so it
    // collapses to an inline `[pasted #N, L lines]` chip instead of leaking
    // newlines (or being flattened to spaces) into the row.
    if (input.includes('\n')) {
      await commitPaste(input);
      return;
    }

    const next = buffer.slice(0, cursor) + input + buffer.slice(cursor);
    setDraft(next, cursor + input.length);
  };

  /**
   * Drive a single iteration: run the agent against `blocks`, render the
   * result into history, then if any messages were typed while we were
   * busy, pull the head of the queue and recurse. Recursion terminates
   * when the queue is empty (status stays idle).
   */
  const runBlocks = async (blocks: ContentBlock[]): Promise<void> => {
    const ctrl = new AbortController();
    activeCtrlRef.current = ctrl;
    // Each run starts a fresh interrupt cycle: 1st Ctrl+C aborts, 2nd exits.
    // submit() already resets, but queue-drain / runText / autonomy paths
    // re-enter runBlocks without going through submit — without this reset a
    // stale counter from a prior abort would make the next run's first
    // Ctrl+C force-exit instead of aborting.
    dispatch({ type: 'resetInterrupts' });
    dispatch({ type: 'status', status: 'running' });

    try {
      const startedAt = Date.now();
      const before = tokenCounter?.total();
      const costBefore = tokenCounter?.estimateCost().total ?? 0;
      const routed = blocks.some((block) => block.type === 'image')
        ? await routeImagesForModel(blocks, {
            supportsVision: supportsVision
              ? await supportsVision()
              : agent.ctx.provider.capabilities.vision,
            adapters: visionAdapters,
            ctx: agent.ctx,
            signal: ctrl.signal,
            providerId: agent.ctx.provider.id,
            model: agent.ctx.model,
          })
        : { blocks, route: 'none' as const, convertedImages: 0 };
      if (routed.route === 'adapter') {
        dispatch({
          type: 'addEntry',
          entry: {
            kind: 'info',
            text: `Image input analyzed via ${routed.adapterName ?? 'vision adapter'} (${routed.convertedImages} image${routed.convertedImages === 1 ? '' : 's'}).`,
          },
        });
      }
      const result = await agent.run(routed.blocks, { signal: ctrl.signal });

      // Per-iteration assistant text was already committed by the
      // `provider.response` listener as each LLM call finished. Safety net:
      // if anything is still lingering in the synchronous ref (e.g. an
      // aborted run that never received a final provider.response), commit
      // it now so partial output is preserved rather than silently dropped.
      const lingering = streamingTextRef.current;
      if (lingering.trim()) {
        dispatch({ type: 'addEntry', entry: { kind: 'assistant', text: lingering } });
      }
      streamingTextRef.current = '';
      pendingDeltaRef.current = '';
      if (flushTimerRef.current) {
        clearTimeout(flushTimerRef.current);
        flushTimerRef.current = null;
      }
      dispatch({ type: 'streamReset' });

      if (result.status === 'aborted') {
        dispatch({ type: 'addEntry', entry: { kind: 'warn', text: 'Aborted.' } });
      } else if (result.status === 'failed') {
        const err = result.error;
        const text = err
          ? `Failed [${err.severity}${err.recoverable ? ', recoverable' : ''}]: ${err.describe()}`
          : 'Failed.';
        dispatch({
          type: 'addEntry',
          entry: { kind: 'error', text },
        });
      } else if (result.status === 'max_iterations') {
        dispatch({
          type: 'addEntry',
          entry: { kind: 'warn', text: `Hit max iterations (${result.iterations}).` },
        });
      }

      // ── SDD Auto-Detection ──────────────────────────────────────────
      // Process AI output for spec, implementation plan, and task detection.
      if (result.status === 'done' && result.finalText && onSDDOutput) {
        try {
          const sddMessages = await onSDDOutput(result.finalText);
          for (const msg of sddMessages) {
            dispatch({ type: 'addEntry', entry: { kind: 'info', text: msg } });
          }
        } catch {
          // Non-fatal — SDD detection is best-effort
        }
      }

      if (tokenCounter && before) {
        const after = tokenCounter.total();
        const costAfter = tokenCounter.estimateCost().total;
        dispatch({
          type: 'addEntry',
          entry: {
            kind: 'turn-summary',
            text: `[in: ${fmtTok(after.input - before.input)}  out: ${fmtTok(after.output - before.output)}  iters: ${result.iterations}  cost: ${(costAfter - costBefore).toFixed(4)}  ${((Date.now() - startedAt) / 1000).toFixed(1)}s]`,
          },
        });
      }

      // ── Next-task prediction (/next) ─────────────────────────────────
      // Opt-in. The CLI gates on the toggle + autonomy-off and returns []
      // when disabled, so calling unconditionally here is safe. Best-effort:
      // any failure is swallowed so prediction can never break the turn.
      if (result.status === 'done' && predictNext) {
        try {
          const userRequest = blocks
            .filter((b) => b.type === 'text')
            .map((b) => (b as { text: string }).text)
            .join(' ')
            .trim();
          const predictions = await predictNext({
            userRequest,
            assistantSummary: result.finalText ?? '',
          });
          if (predictions.length > 0) {
            const text = ['↳ likely next:', ...predictions.map((p, i) => `  ${i + 1}. ${p}`)].join(
              '\n',
            );
            dispatch({ type: 'addEntry', entry: { kind: 'turn-summary', text } });
          }
        } catch {
          // Best-effort — never let prediction break the turn.
        }
      }
    } catch (err) {
      dispatch({
        type: 'addEntry',
        entry: { kind: 'error', text: err instanceof Error ? err.message : String(err) },
      });
    } finally {
      activeCtrlRef.current = null;
      dispatch({ type: 'status', status: 'idle' });
      // Completion chime: terminal bell when agent finishes.
      if (chimeRef.current) {
        try { process.stdout.write('\x07'); } catch { /* stdout closed */ }
      }
    }

    // Drain the queue. If the run was aborted, the SIGINT handler has
    // already cleared the queue, so the head will be undefined.
    const head = stateRef.current.queue[0];
    if (head) {
      dispatch({ type: 'dequeueFirst' });
      // Echo the dequeued message as a USER entry so the user can see
      // which queued message is now being processed — the original
      // queued entry may have scrolled off screen.
      dispatch({
        type: 'addEntry',
        entry: { kind: 'user', text: head.displayText },
      });
      await runBlocks(head.blocks);
    }
  };
  const runBlocksRef = useRef(runBlocks);
  runBlocksRef.current = runBlocks;

  /**
   * Eternal-mode driver. Loops `engine.runOneIteration()` until autonomy
   * flips away from 'eternal' or the engine reports stopped state. Each
   * iteration appends an info entry summarizing what happened so the TUI
   * timeline shows the engine's activity. Runs as a single sequential
   * consumer of `agent.run` — no race with user submissions because user
   * input is gated by `state.status` (a running iteration keeps status
   * at 'running' until the agent.run inside the engine returns).
   */
  const runEternalLoop = async (): Promise<void> => {
    const engine = getEternalEngine?.();
    if (!engine) return;
    // Avoid double-driving if the loop is already running. Status will
    // bounce idle↔running per iteration; the autonomy flag is the source
    // of truth for "should we keep going".
    if (eternalLoopRunningRef.current) return;
    eternalLoopRunningRef.current = true;
    try {
      while (true) {
        // Re-check the live state every iteration — /autonomy stop, SIGINT,
        // or /goal clear could have flipped it during the prior iteration.
        const liveMode = getAutonomy?.() ?? 'off';
        if (liveMode !== 'eternal') break;
        if (engine.currentState === 'stopped') break;
        dispatch({ type: 'status', status: 'running' });
        try {
          // Per-iteration entries land via the subscribeEternalIteration
          // useEffect below — we don't need to log here. Only surface
          // *errors* the engine catches but doesn't journal.
          await engine.runOneIteration();
        } catch (err) {
          dispatch({
            type: 'addEntry',
            entry: {
              kind: 'error',
              text: `[eternal] ${err instanceof Error ? err.message : String(err)}`,
            },
          });
        }
        dispatch({ type: 'status', status: 'idle' });
        // Yield so a slash command submitted between iterations (e.g.
        // /autonomy stop) actually lands before we kick the next one.
        await new Promise((r) => setTimeout(r, 200));
      }
    } finally {
      eternalLoopRunningRef.current = false;
      // Sync the displayed autonomy state with reality. The loop only exits
      // when getAutonomy() !== 'eternal' or engine.currentState === 'stopped',
      // both of which mean the mode is effectively off/idle. Refreshing here
      // stops the status bar from oscillating between "● thinking…" and
      // "● idle" forever after the goal is done.
      if (getAutonomy) {
        const finalMode = getAutonomy();
        if (finalMode !== autonomyLive) setAutonomyLive(finalMode);
      }
    }
  };
  const eternalLoopRunningRef = useRef(false);
  const runEternalLoopRef = useRef(runEternalLoop);
  runEternalLoopRef.current = runEternalLoop;

  /** Parallel-eternal driver — fan-out loop for the ParallelEternalEngine. */
  const runParallelLoop = async (): Promise<void> => {
    const engine = getParallelEngine?.();
    if (!engine) return;
    if (parallelLoopRunningRef.current) return;
    parallelLoopRunningRef.current = true;
    try {
      while (true) {
        const liveMode = getAutonomy?.() ?? 'off';
        if (liveMode !== 'eternal-parallel') break;
        if (engine.currentState === 'stopped') break;
        dispatch({ type: 'status', status: 'running' });
        try {
          await engine.runOneIteration();
        } catch (err) {
          dispatch({
            type: 'addEntry',
            entry: {
              kind: 'error',
              text: `[parallel] ${err instanceof Error ? err.message : String(err)}`,
            },
          });
        }
        dispatch({ type: 'status', status: 'idle' });
        await new Promise((r) => setTimeout(r, 200));
      }
    } finally {
      parallelLoopRunningRef.current = false;
      if (getAutonomy) {
        const finalMode = getAutonomy();
        if (finalMode !== autonomyLive) setAutonomyLive(finalMode);
      }
    }
  };
  const parallelLoopRunningRef = useRef(false);
  const runParallelLoopRef = useRef(runParallelLoop);
  runParallelLoopRef.current = runParallelLoop;

  // Subscribe to live per-iteration events from the eternal engine. The
  // engine's loop drive (runEternalLoop above) emits "iteration completed"
  // info entries, but those are coarse — this subscription surfaces the
  // *actual* journal entry per iteration with source, status, and cost.
  // Without it the TUI timeline only shows one-line summaries; with it the
  // user sees `#42 ✓ [todo] refactor parser ($0.0034)`.
  useEffect(() => {
    if (!subscribeEternalIteration) return;
    const unsub = subscribeEternalIteration((entry) => {
      const mark =
        entry.status === 'success'
          ? '✓'
          : entry.status === 'failure'
            ? '✗'
            : entry.status === 'aborted'
              ? '⊘'
              : '·';
      const cost = typeof entry.costUsd === 'number' ? ` ($${entry.costUsd.toFixed(4)})` : '';
      const note = entry.note ? ` — ${entry.note.slice(0, 80)}` : '';
      const text = `#${entry.iteration} ${mark} [${entry.source}] ${entry.task}${cost}${note}`;
      dispatch({ type: 'addEntry', entry: { kind: 'info', text } });
    });
    return unsub;
  }, [subscribeEternalIteration]);

  // Subscribe to live stage-transition events from the eternal engine.
  // Drives `state.eternalStage` used by the status bar to show the
  // engine's current location (decide → execute → reflect → sleep/paused).
  useEffect(() => {
    if (!subscribeEternalStage) return;
    const unsub = subscribeEternalStage((stage) => {
      dispatch({ type: 'eternalStage', stage });
    });
    return unsub;
  }, [subscribeEternalStage]);

  const submit = async (overrideRaw?: string) => {
    const raw = overrideRaw ?? draftRef.current.buffer;
    const trimmed = raw.trim();
    // Attachment chips live inline in the buffer now, so a paste/file-only
    // message is already non-empty here — a single `!trimmed` guard suffices.
    if (!trimmed) return;

    dispatch({ type: 'resetInterrupts' });
    const pushSubmittedHistory = () => {
      if (trimmed) dispatch({ type: 'historyPush', text: trimmed });
    };
    if (trimmed === '/image' || trimmed === '/paste-image') {
      pushSubmittedHistory();
      clearDraft();
      await pasteClipboardImage();
      return;
    }

    // Slash commands always dispatch immediately, even mid-iteration —
    // they don't conflict with a running agent.
    if (trimmed.startsWith('/')) {
      dispatch({ type: 'addEntry', entry: { kind: 'user', text: trimmed } });
      pushSubmittedHistory();
      clearDraft();
      try {
        const res = await slashRegistry.dispatch(trimmed, agent.ctx);
        if (res?.message) {
          dispatch({ type: 'addEntry', entry: { kind: 'info', text: res.message } });
        }
        // autoPhaseInit: when /autophase start succeeds, the graph title is
        // embedded in metadata so the TUI can show the PhasePanel immediately
        // even before the first orchestrator event fires.
        if (res?.metadata?.autoPhaseInit) {
          const m = res.metadata.autoPhaseInit as { title: string };
          dispatch({ type: 'autoPhaseInit', title: m.title });
        }
        // Slash commands like /model and /use mutate agent.ctx directly.
        // Re-sync the visible status bar so the user sees the switch
        // landed; otherwise the bar keeps the startup-time values and
        // /model "feels" broken even when subsequent requests use the
        // new model.
        const ctxModel = agent.ctx.model;
        if (ctxModel && ctxModel !== liveModel) setLiveModel(ctxModel);
        const ctxProviderId = (agent.ctx.provider as { id?: string | undefined } | undefined)?.id;
        if (ctxProviderId && ctxProviderId !== liveProvider) setLiveProvider(ctxProviderId);
        const ctxMaxContext = agent.ctx.provider.capabilities.maxContext;
        if (ctxMaxContext > 0 && ctxMaxContext !== activeMaxContext) {
          setActiveMaxContext(ctxMaxContext);
        }
        if (getYolo) {
          const currentYolo = getYolo();
          if (currentYolo !== yoloLive) setYoloLive(currentYolo);
        }
        if (getAutonomy) {
          const currentAutonomy = getAutonomy();
          if (currentAutonomy !== autonomyLive) setAutonomyLive(currentAutonomy);
          // When /autonomy eternal lands, kick off the engine-driven loop.
          // Fire-and-forget — the loop runs until autonomy flips away from
          // 'eternal' or the engine's currentState goes !== 'running'.
          // Without this, the slash command would set the flag but the
          // TUI would just sit at the prompt waiting for user input.
          if (currentAutonomy === 'eternal' && getEternalEngine) {
            void runEternalLoopRef.current();
          }
          if (currentAutonomy === 'eternal-parallel' && getParallelEngine) {
            void runParallelLoopRef.current();
          }
        }
        if (getModeLabel) {
          const currentMode = getModeLabel();
          if (currentMode !== liveModeLabel) setLiveModeLabel(currentMode);
        }
        if (res?.exit) {
          exit();
          onExit(0);
        }
        // `runText` lets a slash command queue a follow-up user-role
        // message (used by `/steer <text>` to send the STEERING
        // preamble + new direction as if the user had typed it).
        // Run AFTER the message is rendered so the user sees the
        // slash result before the model's response streams.
        if (res?.runText) {
          const b = builderRef.current;
          if (b) {
            b.appendText(res.runText);
            const blocks = await b.submit();
            // Wait briefly for any in-flight abort to settle into
            // 'idle' before kicking the next iteration — otherwise
            // runBlocks would early-return on the busy guard.
            const start = Date.now();
            while (stateRef.current.status !== 'idle' && Date.now() - start < 1500) {
              await new Promise((r) => setTimeout(r, 25));
            }
            await runBlocks(blocks);
          }
        }
        // Only fire onClearHistory for `/clear` — without this gate every
        // slash command (`/model`, `/use`, `/help`, …) would wipe the
        // conversation. Match the command name segment, not just the
        // prefix, so `/clearfoo` doesn't trigger.
        const cmd = trimmed.slice(1).split(/\s+/, 1)[0];
        if (cmd === 'clear') {
          onClearHistory?.(dispatch);
          // Reset cumulative token/cost counters so the status bar
          // reflects a fresh session, not pre-clear stats.
          tokenCounter?.reset();
        }
      } catch (err) {
        dispatch({
          type: 'addEntry',
          entry: { kind: 'error', text: err instanceof Error ? err.message : String(err) },
        });
      }
      return;
    }

    const builder = builderRef.current;
    if (!builder) return;
    // Steering inject: if the user pressed Esc on the prior iteration,
    // prepend a STEERING preamble so the model sees this isn't a
    // follow-up — it's an interrupt redirecting the work. The preamble
    // carries (a) context the model would otherwise have to guess
    // (what tools were running, what subagents were live) and (b)
    // explicit authority — "drop the prior plan, respawn subagents
    // if useful, ask for clarification if needed". Plain user-role
    // text so accountability stays with the human who triggered it.
    const steering = state.steeringPending;

    // ── Prompt refinement ("did you mean this?") ───────────────────────
    // Before the main agent sees the message, run it through a separate
    // one-shot LLM call (its own system prompt, no history) that rewrites it
    // into a clearer instruction, then briefly preview it. The user can let
    // it auto-send (countdown), accept now (Enter), keep the original (Esc),
    // or edit (e). Skipped for steering interrupts, messages carrying inline
    // attachment chips (the refiner would drop the tokens), and inputs the
    // heuristic judges not worth refining. Best-effort — any failure falls
    // straight through to the original text.
    let effectiveText = trimmed;
    const hasChips = trimmed
      ? new RegExp(INLINE_TOKEN_SRC, 'g').test(trimmed)
      : false;
    if (
      enhanceEnabledRef.current &&
      state.status === 'idle' &&
      !steering &&
      !hasChips &&
      shouldEnhance(trimmed)
    ) {
      dispatch({ type: 'enhanceBusy', on: true });
      // Let the user bail out of a slow refine (reasoning models can take many
      // seconds) by pressing Esc while "refining…" shows — handleKey aborts
      // this controller, the call rejects → null → we send the original.
      const ac = new AbortController();
      enhanceAbortRef.current = ac;
      let refined: string | null = null;
      let enhanceErr: string | null = null;
      try {
        refined = await enhanceUserPrompt({
          provider: agent.ctx.provider,
          model: agent.ctx.model,
          text: trimmed,
          signal: ac.signal,
          onError: (reason) => {
            enhanceErr = reason;
          },
          // Feed recent conversation so follow-ups ("do the same", "that file")
          // resolve against context instead of being refined blind.
          history: recentTextTurns(agent.ctx.messages),
        });
      } finally {
        enhanceAbortRef.current = null;
        dispatch({ type: 'enhanceBusy', on: false });
      }
      // Surface WHY a refine fell through (provider rejected it, timed out, no
      // text) — otherwise "refining…" vanishing with no panel is confusing.
      // Skipped when the user cancelled it themselves.
      if (refined === null && !ac.signal.aborted) {
        dispatch({
          type: 'addEntry',
          entry: {
            kind: 'info',
            text: enhanceErr
              ? `✨ refinement unavailable (${enhanceErr}) — sent your message as-is`
              : '✨ refinement unavailable — sent your message as-is',
          },
        });
      }
      if (refined && !normalizedEqual(refined, trimmed)) {
        const decision = await new Promise<'refined' | 'original' | 'edit'>((resolve) => {
          dispatch({ type: 'enhanceOpen', info: { original: trimmed, refined, resolve } });
        });
        dispatch({ type: 'enhanceClose' });
        if (decision === 'edit') {
          // Load the refined text back into the input so the user can tweak
          // it and re-submit. Nothing is sent this round.
          setDraft(refined, refined.length);
          return;
        }
        effectiveText = decision === 'refined' ? refined : trimmed;
      }
    }

    // ── SDD Context Injection ──────────────────────────────────────────
    // When an SDD session is active, prepend the session context so the
    // model knows it's in a spec-building conversation.
    const sddContext = getSDDContext?.();
    if (sddContext && trimmed) {
      builder.appendText(`[SDD SESSION ACTIVE]\n${sddContext}\n\n---\nUser message:\n`);
    }

    if (trimmed) {
      const toAppend = steering
        ? buildSteeringPreamble(state.steerSnapshot, effectiveText)
        : effectiveText;
      builder.appendText(toAppend);
    }
    if (steering) dispatch({ type: 'steerConsume' });
    // The user sees their original text + a visual ↯ marker when
    // steering, not the full preamble — keeps the chat readable while
    // the model still gets the explicit instruction.
    const displayText = trimmed
      ? steering
        ? `↯ ${effectiveText}`
        : effectiveText
      : '(attachments only)';
    // Build the history preview by scanning the message for inline chip tokens
    // and pulling each one's stored preview. Each chip becomes a label line
    // followed by an indented snippet of its collapsed content.
    const pasteParts: string[] = [];
    for (const m of trimmed.matchAll(new RegExp(INLINE_TOKEN_SRC, 'g'))) {
      const token = m[0];
      const content = tokenPreviewsRef.current.get(token);
      pasteParts.push(token);
      if (content) pasteParts.push(`  ${content.split('\n').slice(0, 6).join('\n  ')}`);
    }
    const pasteContent = pasteParts.length > 0 ? pasteParts.join('\n') : undefined;
    pushSubmittedHistory();
    clearDraft();
    const blocks = await builder.submit();

    if (state.status !== 'idle') {
      // Agent is busy — queue this message for the drainer to pick up.
      dispatch({
        type: 'addEntry',
        entry: { kind: 'user', text: displayText, queued: true, pasteContent },
      });
      dispatch({ type: 'enqueue', item: { displayText, blocks } });
      return;
    }

    dispatch({ type: 'addEntry', entry: { kind: 'user', text: displayText, pasteContent } });
    await runBlocks(blocks);
  };

  // ─── --goal / --ask boot inject ─────────────────────────────────────
  // The CLI may pass `--goal "..."` or `--ask "..."` to pre-populate the
  // very first turn. `initialGoal` wraps the text in the GOAL preamble so
  // the model lands in autonomous goal mode; `initialAsk` submits the text
  // verbatim (handy for scripted shell aliases). Both fire one-shot via a
  // mount-time ref guard so a re-render can't double-submit. We wait a tick
  // for the input builder to settle, then push directly into runBlocks —
  // bypassing the slash registry / submit() path keeps the boot path
  // self-contained even if user-installed slash commands haven't mounted
  // their effects yet.
  const bootInjectedRef = useRef(false);
  useEffect(() => {
    if (bootInjectedRef.current) return;
    bootInjectedRef.current = true;
    const goal = initialGoal?.trim();
    const ask = initialAsk?.trim();
    if (!goal && !ask) return;
    void (async () => {
      // Give the banner a frame to render first so the user sees the
      // greeting before the first turn streams over the top of it.
      await new Promise((r) => setTimeout(r, 50));
      const b = builderRef.current;
      if (!b) return;
      if (goal) {
        const shortGoal = goal.length > 80 ? `${goal.slice(0, 80)}…` : goal;
        dispatch({
          type: 'addEntry',
          entry: {
            kind: 'info',
            text: `🎯 Goal locked: ${shortGoal}\n   Agent will work until verifiably complete. Esc / /steer to redirect, Ctrl+C to stop.`,
          },
        });
        b.appendText(buildGoalPreamble(goal));
      } else if (ask) {
        dispatch({ type: 'addEntry', entry: { kind: 'user', text: ask } });
        b.appendText(ask);
      }
      const blocks = await b.submit();
      await runBlocksRef.current(blocks);
    })();
  }, [initialAsk, initialGoal]);

  // Expose the latest handleKey for the keyboard event pipeline.
  handleKeyRef.current = handleKey;

  // Stable callback wrapping handleKey via ref — prevents Input from
  // re-rendering on every nowTick tick (which bleeds the prompt line into
  // native scrollback in inline mode). handleKey itself captures many
  // mutable state values in its closure and must be recreated each render,
  // but the Input only needs a stable function reference that delegates
  // to the latest closure via the ref.
  const stableOnKey = useCallback((input: string, key: KeyEvent) => {
    handleKeyRef.current?.(input, key);
  }, []);

  const inputHint = useMemo(() => {
    if (state.status !== 'idle') return '';
    if (state.buffer.startsWith('/')) return 'slash command — Enter to dispatch';
    if (state.picker.open) return '';
    return '';
  }, [state.buffer, state.status, state.picker.open]);

  // True while a prompt-refinement call is in flight or its preview panel is
  // open. Used to blank the live input row (so the un-cleared draft can't bleed
  // into scrollback) and to drive the per-tick live-region erase below.
  const enhanceActive = state.enhanceBusy || state.enhance != null;

  return (
    <Box flexDirection="column">
      <Box flexDirection="column" flexGrow={1} flexShrink={0}>
        <History
          entries={state.entries}
          streamingText={state.streamingText}
          toolStream={state.toolStream}
        />
        <Box flexDirection="column" flexShrink={0}>
          <LiveActivityStrip entries={state.fleet} nowTick={nowTick} />
          {/* While enhance is active (refining… or panel countdown), don't render
              the Input at all — even an empty-prompt render redraws every tick
              and the Ink inline-mode log-update bleeds it into native scrollback.
              The draft buffer is preserved in state for the [e]dit / Esc paths. */}
          {enhanceActive ? (
            <Box height={1} />
          ) : (
            <Input
              prompt={INPUT_PROMPT}
              value={state.buffer}
              cursor={state.cursor}
              disabled={
                (state.status === 'aborting' && !state.steeringPending) ||
                state.confirmQueue.length > 0
              }
              hint={inputHint}
              onKey={stableOnKey}
            />
          )}
          {state.picker.open ? (
            <FilePicker
              query={state.picker.query}
              matches={state.picker.matches}
              selected={state.picker.selected}
            />
          ) : null}
          {state.slashPicker.open ? (
            <SlashMenu
              query={state.slashPicker.query}
              matches={state.slashPicker.matches}
              selected={state.slashPicker.selected}
            />
          ) : null}
          {state.modelPicker.open ? (
            <ModelPicker
              step={state.modelPicker.step}
              providerOptions={state.modelPicker.providerOptions}
              modelOptions={state.modelPicker.modelOptions}
              filteredOptions={state.modelPicker.filteredOptions}
              selected={state.modelPicker.selected}
              pickedProviderId={state.modelPicker.pickedProviderId}
              searchQuery={state.modelPicker.searchQuery}
              hint={state.modelPicker.hint}
            />
          ) : null}
          {state.autonomyPicker.open ? (
            <AutonomyPicker
              options={state.autonomyPicker.options}
              selected={state.autonomyPicker.selected}
              hint={state.autonomyPicker.hint}
            />
          ) : null}
          {state.settingsPicker.open ? (
            <SettingsPicker
              field={state.settingsPicker.field}
              mode={state.settingsPicker.mode}
              delayMs={state.settingsPicker.delayMs}
              titleAnimation={state.settingsPicker.titleAnimation}
              yolo={state.settingsPicker.yolo}
              streamFleet={state.settingsPicker.streamFleet}
              chime={state.settingsPicker.chime}
              confirmExit={state.settingsPicker.confirmExit}
              nextPrediction={state.settingsPicker.nextPrediction}
              featureMcp={state.settingsPicker.featureMcp}
              featurePlugins={state.settingsPicker.featurePlugins}
              featureMemory={state.settingsPicker.featureMemory}
              featureSkills={state.settingsPicker.featureSkills}
              featureModelsRegistry={state.settingsPicker.featureModelsRegistry}
              contextAutoCompact={state.settingsPicker.contextAutoCompact}
              contextStrategy={state.settingsPicker.contextStrategy}
              logLevel={state.settingsPicker.logLevel}
              auditLevel={state.settingsPicker.auditLevel}
              indexOnStart={state.settingsPicker.indexOnStart}
              maxIterations={state.settingsPicker.maxIterations}
              hint={state.settingsPicker.hint}
            />
          ) : null}
          {state.rewindOverlay
            ? (() => {
                const overlay = state.rewindOverlay;
                return (
                  <CheckpointTimeline
                    checkpoints={overlay.checkpoints}
                    selected={overlay.selected}
                    onSelect={(i) =>
                      dispatch({ type: 'rewindOverlayMove', delta: i - overlay.selected })
                    }
                    onConfirm={(i) => {
                      const checkpoint = overlay.checkpoints[i];
                      if (checkpoint) handleRewindTo(checkpoint.promptIndex);
                    }}
                    onClose={() => dispatch({ type: 'rewindOverlayClose' })}
                  />
                );
              })()
            : null}
          {state.brainPrompt ? (
            <Box flexDirection="column" marginY={1} flexShrink={0}>
              <BrainDecisionPrompt
                {...state.brainPrompt}
                onAnswer={(answer) => {
                  events.emit('brain.human_answered', { ...answer, at: Date.now() });
                  dispatch({ type: 'brainPromptClear' });
                }}
              />
            </Box>
          ) : null}
          {state.confirmQueue.length > 0 &&
            (() => {
              const head = expectDefined(state.confirmQueue[0]);
              let resolved = false;
              const onDecision = (decision: ConfirmDecision) => {
                if (resolved) return;
                resolved = true;
                head.resolve(decision);
                dispatch({ type: 'confirmClose' });
              };
              return (
                <ConfirmPrompt
                  toolName={head.toolName}
                  input={head.input}
                  suggestedPattern={head.suggestedPattern}
                  onDecision={onDecision}
                />
              );
            })()}
          {state.escConfirm ? (
            <Box flexDirection="column" marginY={1} flexShrink={0}>
              <EscConfirmPrompt
                runningTools={state.escConfirm.snapshot.runningTools}
                subagentCount={state.escConfirm.snapshot.subagentsTerminated}
                onConfirm={() => {
                  const escConfirm = state.escConfirm;
                  if (!escConfirm) return;
                  const { snapshot } = escConfirm;
                  activeCtrlRef.current?.abort();
                  dispatch({ type: 'status', status: 'aborting' });
                  dispatch({ type: 'steerStart', snapshot });
                  if (director && snapshot.subagentsTerminated > 0) {
                    const cap = new Promise<void>((resolve) => {
                      const t = setTimeout(resolve, 1500);
                      t.unref?.();
                    });
                    void Promise.race([director.terminateAll().catch(() => undefined), cap]);
                  }
                  const droppedCount = state.queue.length;
                  if (droppedCount > 0) dispatch({ type: 'queueClear' });
                  const droppedTag = droppedCount > 0 ? ` · dropped ${droppedCount} queued` : '';
                  const fleetTag =
                    snapshot.subagentsTerminated > 0
                      ? ` · stopped ${snapshot.subagentsTerminated} subagent${snapshot.subagentsTerminated === 1 ? '' : 's'}`
                      : '';
                  dispatch({
                    type: 'addEntry',
                    entry: {
                      kind: 'warn',
                      text: `↯ Interrupted${droppedTag}${fleetTag}. Type your new direction.`,
                    },
                  });
                  dispatch({ type: 'escConfirmClose' });
                }}
                onCancel={() => {
                  dispatch({ type: 'escConfirmClose' });
                }}
              />
            </Box>
          ) : null}
          {state.enhanceBusy && !state.enhance ? (
            <Box paddingX={1} flexDirection="column">
              <Text dimColor>
                ✨ refining:{' '}
                <Text color="cyan">
                  {state.buffer.length > 100
                    ? `${state.buffer.slice(0, 97)}…`
                    : state.buffer}
                </Text>
              </Text>
              <Text color="cyan">{'.'.repeat(enhanceDots)}</Text>
            </Box>
          ) : null}
          {state.enhance
            ? (() => {
                const info = state.enhance;
                let resolved = false;
                const onDecision = (decision: 'refined' | 'original' | 'edit') => {
                  if (resolved) return;
                  resolved = true;
                  info.resolve(decision);
                };
                return (
                  <EnhancePanel
                    original={info.original}
                    refined={info.refined}
                    delayMs={enhanceDelayMs}
                    onDecision={onDecision}
                  />
                );
              })()
            : null}
          <StatusBar
            model={`${liveProvider}/${liveModel}`}
            version={appVersion}
            state={state.status}
            tokenCounter={tokenCounter}
            hint={renderRunningTools(state.runningTools) || state.hint}
            queueCount={state.queue.length}
            yolo={yoloLive}
            autonomy={autonomyLive}
            startedAt={startedAtRef.current}
            todos={todos}
            plan={planCounts ?? undefined}
            fleet={fleetCounts}
            git={gitInfo}
            context={contextWindow}
            brain={state.brain}
            projectName={projectName}
            subagentCount={Object.keys(state.fleet).length}
            processCount={getProcessRegistry().activeCount}
            hiddenItems={hiddenItems}
            eternalStage={state.eternalStage}
            goalSummary={state.goalSummary}
            indexState={indexState}
            modeLabel={liveModeLabel || undefined}
          />
          {/* Keys-&-commands help overlay (`?` on an empty prompt). Modal: while
          open, handleKey swallows everything but Esc/?/q, so it never coexists
          with a monitor. */}
          {state.helpOpen ? <HelpOverlay /> : null}
          {/* Agents monitor overlay (Ctrl+G) and fleet monitor overlay (Ctrl+F)
          take up the lower region — hide FleetPanel while any overlay is open. */}
          {state.agentsMonitorOpen ? (
            <AgentsMonitor
              entries={entriesWithLeader}
              totalCost={state.fleetCost}
              leaderCost={tokenCounter?.estimateCost().total ?? 0}
              totalTokens={state.fleetTokens}
              nowTick={nowTick}
            />
          ) : state.autoPhase?.monitorOpen ? (
            <PhaseMonitor
              phases={state.autoPhase.phases}
              runningPhaseIds={state.autoPhase.runningPhaseIds}
              elapsedMs={state.autoPhase.elapsedMs}
              nowTick={nowTick}
              onClose={() => dispatch({ type: 'autoPhaseMonitorToggle' })}
            />
          ) : state.worktreeMonitorOpen ? (
            <WorktreeMonitor
              worktrees={state.worktrees}
              baseBranch={state.worktreeBase}
              nowTick={nowTick}
              onClose={() => dispatch({ type: 'worktreeMonitorToggle' })}
            />
          ) : state.todosMonitorOpen ? (
            <TodosMonitor todos={agent.ctx.todos} />
          ) : state.monitorOpen ? (
            <FleetMonitor
              entries={state.fleet}
              totalCost={state.fleetCost}
              totalTokens={state.fleetTokens}
              maxConcurrent={state.fleetConcurrency}
              nowTick={nowTick}
              collabSession={state.collabSession}
            />
          ) : director ? (
            <FleetPanel
              entries={entriesWithLeader}
              totalCost={state.fleetCost}
              roster={fleetRoster}
              collabSession={state.collabSession}
            />
          ) : null}
          {state.autoPhase && !state.autoPhase.monitorOpen ? (
            <PhasePanel
              phases={state.autoPhase.phases}
              runningPhaseIds={state.autoPhase.runningPhaseIds}
              nowTick={nowTick}
            />
          ) : null}
          {Object.keys(state.worktrees).length > 0 &&
          !state.worktreeMonitorOpen &&
          !state.monitorOpen ? (
            <WorktreePanel worktrees={state.worktrees} nowTick={nowTick} />
          ) : null}
          {/* Queue panel — renders as full-width panel at the bottom. */}
          {state.queuePanelOpen ? <QueuePanel items={state.queue} /> : null}
          {/* Process list overlay (F8) — shows background bash/exec processes. */}
          {state.processListOpen ? <ProcessListMonitor /> : null}
        </Box>
      </Box>
    </Box>
  );
}

/**
 * Render an at-a-glance "running: …" hint for the status bar. Shows the
 * oldest in-flight tool by name; if more than one, appends "(+N)".
 */
export function renderRunningTools(
  running: ReadonlyMap<string, { name: string; startedAt: number }>,
): string {
  if (running.size === 0) return '';
  let oldest: { name: string; startedAt: number } | null = null;
  for (const info of running.values()) {
    if (!oldest || info.startedAt < oldest.startedAt) oldest = info;
  }
  if (!oldest) return '';
  const elapsedSec = ((Date.now() - oldest.startedAt) / 1000).toFixed(1);
  const more = running.size > 1 ? ` (+${running.size - 1})` : '';
  return `running: ${oldest.name} ${elapsedSec}s${more}`;
}

/**
 * Find an active `@<query>` token at the cursor. The token starts at the
 * last `@` not preceded by a non-whitespace char, and runs up to the cursor
 * (no whitespace allowed inside). Returns null if no active token.
 */
export function detectAtToken(
  buffer: string,
  cursor: number,
): { start: number; end: number; query: string } | null {
  let i = cursor - 1;
  while (i >= 0) {
    const ch = buffer.charCodeAt(i);
    if (ch === 64 /* @ */) {
      // Must be at the start of buffer or preceded by whitespace.
      if (i === 0 || /\s/.test(buffer[i - 1] ?? '')) {
        return { start: i, end: cursor, query: buffer.slice(i + 1, cursor) };
      }
      return null;
    }
    if (ch === 32 /* space */ || ch === 9 /* tab */ || ch === 10 /* nl */) return null;
    i--;
  }
  return null;
}

function fmtTok(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}
