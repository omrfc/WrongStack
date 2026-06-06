import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type {
  Agent,
  AttachmentStore,
  ContentBlock,
  Director,
  EventBus,
  FleetEvent,
  QueueStore,
  SlashCommandRegistry,
  TokenCounter,
} from '@wrongstack/core';
import { DefaultSessionRewinder, type AutonomyStage } from '@wrongstack/core';
import { InputBuilder, buildGoalPreamble, formatTodosList, writeOut } from '@wrongstack/core';
import { type VisionAdapters, routeImagesForModel } from '@wrongstack/runtime/vision';
import { getProcessRegistry } from '@wrongstack/tools';
import { Box, type DOMElement, Text, measureElement, useApp, useStdout } from 'ink';
import React, { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { readClipboardImage } from './clipboard.js';
import { AgentsMonitor } from './components/agents-monitor.js';
import {
  AUTONOMY_OPTIONS,
  AutonomyPicker,
} from './components/autonomy-picker.js';
import { BrainDecisionPrompt } from './components/brain-decision-prompt.js';
import { CheckpointTimeline } from './components/checkpoint-timeline.js';
import {
  type ConfirmDecision,
  ConfirmPrompt,
  confirmButtonSegments,
} from './components/confirm-prompt.js';
import { FilePicker } from './components/file-picker.js';
import { FleetMonitor } from './components/fleet-monitor.js';
import { FleetPanel } from './components/fleet-panel.js';
import { HelpOverlay } from './components/help-overlay.js';
import { History } from './components/history.js';
import { EMPTY_KEY, Input, type KeyEvent } from './components/input.js';
import { KeyHintBar } from './components/key-hint-bar.js';
import { LiveActivityStrip } from './components/live-activity-strip.js';
import { ModelPicker, type ProviderOption } from './components/model-picker.js';
import { PhaseMonitor } from './components/phase-monitor.js';
import { PhasePanel } from './components/phase-panel.js';
import { ScrollableHistory, scrollOffsetForTrackRow } from './components/scrollable-history.js';
import {
  SettingsPicker,
} from './components/settings-picker.js';
import { SlashMenu } from './components/slash-menu.js';
import { StatusBar, statusBarAutonomySpan, statusBarModelSpan } from './components/status-bar.js';
import { WorktreeMonitor } from './components/worktree-monitor.js';
import { WorktreePanel } from './components/worktree-panel.js';
import { searchFiles } from './file-search.js';
import { type GitInfo, readGitInfo } from './git-info.js';
import {
  INLINE_TOKEN_SRC,
  deleteTokenBackward,
  inputIndexAtRowCol,
  layoutInputRows,
  tokenLengthForward,
} from './input-tokens.js';
import { useSubagentEvents } from './hooks/use-subagent-events.js';
import { useBrainEvents } from './hooks/use-brain-events.js';
import { createKillSlashCommand } from './kill-slash.js';
import type { MouseEvent as TuiMouseEvent } from './mouse.js';
import { feedPaste } from './paste-accumulator.js';
import { createPsSlashCommand } from './ps-slash.js';
import { createQueueSlashCommand } from './queue-slash.js';
import { buildSteeringPreamble } from './steering-preamble.js';

// Types imported from app-reducer.ts (single source of truth for reducer + State types)
import { reducer, type Action, type FleetEntry, type SlashCommandMatch, type State } from './app-reducer.js';
export {
  reducer,
  type Action,
  type FleetEntry,
  type QueueItem,
  type SlashCommandMatch,
  type State,
} from './app-reducer.js';

/** Rows the chat-history viewport scrolls per wheel tick (mouse mode). */
const WHEEL_STEP = 3;
/** Floor for the scroll viewport so it never collapses to nothing when the
 *  bottom region (overlays, wrapped input) is tall. */
const MIN_VIEWPORT = 3;
/** Input prompt — mirrors the <Input> default so click-to-position-cursor maps
 *  columns the same way the input renders them. */
const INPUT_PROMPT = '› ';

export function selectedSlashCommandLine(picker: {
  open: boolean;
  matches: SlashCommandMatch[];
  selected: number;
}): string | null {
  if (!picker.open || picker.matches.length === 0) return null;
  const picked = picker.matches[picker.selected];
  return picked ? `/${picked.name}` : null;
}

export interface AppProps {
  agent: Agent;
  slashRegistry: SlashCommandRegistry;
  attachments: AttachmentStore;
  events: EventBus;
  tokenCounter?: TokenCounter;
  visionAdapters?: VisionAdapters;
  /** Resolve current model vision support. Falls back to provider capability when omitted. */
  supportsVision?: () => boolean | Promise<boolean>;
  model: string;
  banner?: boolean;
  /** Persists the queue across crashes; rehydrated on mount, written on every mutation. */
  queueStore?: QueueStore;
  /** Reflects the policy's --yolo flag for the status bar's "⚠ YOLO" chip. */
  yolo?: boolean;
  /**
   * Query the live YOLO state from the permission policy. Called after
   * every slash-command dispatch so `/yolo off` (which mutates the
   * policy inside the CLI) is immediately reflected in the status bar.
   * Mirrors the `agent.ctx.model` → `setLiveModel` pattern used for
   * provider/model sync.
   */
  getYolo?: () => boolean;
  /** Query the live autonomy mode. */
  getAutonomy?: () => 'off' | 'suggest' | 'auto' | 'eternal' | 'eternal-parallel';
  /**
   * Access the eternal-autonomy engine. When autonomy mode goes to
   * 'eternal' the TUI drives `runOneIteration()` from a post-slash hook
   * so the engine and TUI never race for the shared Context.
   */
  getEternalEngine?: () => import('@wrongstack/core').EternalAutonomyEngine | null;
  /**
   * Access the parallel-eternal engine. When autonomy mode goes to
   * 'eternal-parallel' the TUI drives `runOneIteration()` from a post-slash
   * hook so the engine and TUI never race for the shared Context.
   */
  getParallelEngine?: () => import('@wrongstack/core').ParallelEternalEngine | null;
  /**
   * Subscribe to live per-iteration events from the eternal engine. The
   * TUI installs this on mount to render each iteration as a timeline
   * entry the moment it lands — strictly more responsive than reading
   * goal.json after the fact.
   */
  subscribeEternalIteration?: (
    fn: (entry: import('@wrongstack/core').JournalEntry) => void,
  ) => () => void;
  /**
   * Subscribe to per-iteration stage transitions from the autonomy engines.
   * Drives `state.eternalStage` used by the status bar to show the
   * engine's current location.
   */
  subscribeEternalStage?: (fn: (stage: AutonomyStage) => void) => () => void;
  /**
   * Subscribe to AutoPhase phase/task events from the PhaseOrchestrator.
   * Drives `state.autoPhase` used by the PhaseMonitor component.
   * Handlers receive the event name and payload from PhaseEventMap.
   */
  subscribeAutoPhase?: (handler: (event: string, payload: unknown) => void) => () => void;
  /**
   * Read the persisted autonomy settings (defaultMode, autoProceedDelayMs).
   * Used by the SettingsPicker in the TUI on mount and after Ctrl+S toggle.
   */
  getSettings?: () => { mode: 'off' | 'suggest' | 'auto'; delayMs: number };
  /**
   * Persist autonomy settings changes. Returns null on success, or an
   * error string on failure (so the TUI can display it as a hint).
   */
  saveSettings?: (s: { mode: 'off' | 'suggest' | 'auto'; delayMs: number }) =>
    | string
    | null
    | Promise<string | null>;
  /**
   * Predict likely next steps after a completed turn (/next). The CLI owns the
   * gating (toggle + autonomy off) and returns [] when disabled, so the App can
   * call it unconditionally on a done turn. Display-only — never executed.
   */
  predictNext?: (input: {
    userRequest: string;
    assistantSummary: string;
  }) => Promise<string[]>;
  /**
   * SDD session context getter. When an SDD session is active, returns
   * the AI prompt context to inject into user messages so the model
   * knows it's in a spec-building conversation.
   */
  getSDDContext?: () => string | null;
  /**
   * Process AI output for SDD auto-detection (spec, tasks, plan).
   * Called after every agent.run() completes. Returns displayable
   * status messages (e.g. "✓ Spec detected and saved!").
   */
  onSDDOutput?: (output: string) => Promise<string[]>;
  /** Surfaced in the startup banner. Falls back to "dev" when omitted. */
  appVersion?: string;
  /** Provider id shown in the banner ("openai", "anthropic", …). Defaults to "agent". */
  provider?: string;
  /** Wire family for the configured provider — rendered under provider in the banner. */
  family?: string;
  /** Last 3 chars of the active API key, shown in the banner for "did I pick the right key?" verification. */
  keyTail?: string;
  /**
   * Snapshot the keyed providers (and their model lists) for the
   * `/model` picker. Called every time the picker opens, so the result
   * stays in sync with config edits / new aliases. Async because the
   * host may need to load the models.dev catalog.
   */
  getPickableProviders?: () => Promise<ProviderOption[]>;
  /**
   * Apply a (provider, model) pair after the picker confirms. Returns
   * an error message on failure; null on success. The host owns the
   * actual Provider construction + Context mutation.
   */
  switchProviderAndModel?: (providerId: string, modelId: string) => string | null;
  /**
   * Apply an autonomy mode after the picker confirms. Returns
   * an error string on failure; null on success.
   */
  switchAutonomy?: (
    mode: 'off' | 'suggest' | 'auto' | 'eternal' | 'eternal-parallel',
  ) => string | null;
  /**
   * Real max-context token budget for the *active model*, resolved by the
   * CLI via the ModelsRegistry. The provider object only knows its family
   * default (e.g. anthropic = 200k) which is wrong for variants like the
   * 1M-context Opus model. The status bar's context chip uses this when
   * provided and falls back to the provider baseline otherwise.
   */
  effectiveMaxContext?: number;
  /** Absolute project root for goal.json loading. */
  projectRoot?: string;
  onExit: (code: number) => void;
  /** Called when /clear is dispatched — the TUI should wipe its history entries (but keep the banner). */
  onClearHistory?: (
    dispatch: React.Dispatch<{ type: 'clearHistory' } | { type: 'resetContextChip' }>,
  ) => void;

  /**
   * Goal text passed from `--goal "..."` on the command line. When set,
   * the App mounts, renders the banner, then automatically dispatches
   * a synthetic `/goal <text>` so the user lands in goal mode without
   * having to type the slash command. Mutually advisory with `initialSteer`
   * — `initialGoal` wins if both are present.
   */
  initialGoal?: string;
  /**
   * Initial user message passed from `--ask "..."` on the command line.
   * Submitted verbatim as the first turn (no preamble) so users can
   * launch the TUI and pre-populate one turn from a shell alias / script.
   */
  initialAsk?: string;
  /** Directory for session JSONL files. Passed to App for /rewind. */
  sessionsDir?: string;
  /**
   * True when full mouse mode is active (clickable pickers + in-app wheel
   * scrolling). Implies alt-screen. Switches History to the scrollable
   * viewport and enables the mouse event handlers.
   */
  mouse?: boolean;
  /**
   * Subscribe to decoded mouse events (press/release/wheel with 1-based
   * col/row). Installed by run-tui only when mouse mode is on; the App wires
   * it on mount and tears it down on unmount. Returns an unsubscribe fn.
   */
  subscribeMouse?: (fn: (ev: import('./mouse.js').MouseEvent) => void) => () => void;
  /**
   * True when the managed full-screen viewport is the surface (alt-screen on).
   * Drives ScrollableHistory + in-app scroll + collapsibility, independent of
   * mouse. When false the app uses History + Ink <Static> (native scrollback).
   */
  managed?: boolean;

  // --- Fleet ---
  /** Live director for fleet panel rendering. Null when director mode is off. */
  director: Director | null;
  /** Optional roster for human-readable subagent names. */
  fleetRoster?: Record<string, { name: string }>;
  /**
   * Shared controller for the `/fleet stream on|off` slash command. The
   * App installs a dispatch-backed setter on mount so the slash command
   * can flip the reducer's `streamFleet` flag from the CLI surface.
   */
  fleetStreamController?: {
    enabled: boolean;
    setEnabled: (enabled: boolean) => void;
  };
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
  mouse = false,
  subscribeMouse,
  managed = false,
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
  const [hiddenItems, setHiddenItems] = useState(statuslineHiddenItems);

  // Terminal row count, tracked reactively so the mouse-mode scroll viewport
  // can size itself against the live screen height. Only consumed in mouse
  // mode; harmless to track otherwise.
  const { stdout } = useStdout();
  const [termRows, setTermRows] = useState(stdout?.rows ?? 24);
  const [termCols, setTermCols] = useState(stdout?.columns ?? 80);
  useEffect(() => {
    const onResize = () => {
      setTermRows(process.stdout.rows ?? 24);
      setTermCols(process.stdout.columns ?? 80);
    };
    process.stdout.on('resize', onResize);
    return () => {
      process.stdout.off('resize', onResize);
    };
  }, []);

  // `mouse` (prop) is the launch-time CAPABILITY: it's only true when run-tui
  // set up the stdin proxy + mouse-event subscription, which only happens with
  // --mouse. `mouseLive` is the runtime ON/OFF, toggled by `/mouse`. Tracking
  // can only be enabled when the capability exists (otherwise mouse bytes would
  // pollute Ink), so /mouse refuses to turn on without --mouse.
  const [mouseLive, setMouseLive] = useState(mouse);
  // Whether the managed viewport (ScrollableHistory + in-app scroll) is the
  // active surface. Mirrors alt-screen; toggled by /altscreen and /mouse.
  const [managedLive, setManagedLive] = useState(managed);

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

  const [state, dispatch] = useReducer(reducer, {
    entries: banner
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
      : [],
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
    nextId: 1,
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
    settingsPicker: { open: false, field: 0, mode: 'off', delayMs: 0 },
    confirmQueue: [],
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
    streamFleet: true,
    monitorOpen: false,
    agentsMonitorOpen: false,
    helpOpen: false,
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

  // ── Mouse mode: viewport geometry + event routing ─────────────────────
  // Measures the bottom region (everything below the scroll viewport) so the
  // viewport height can be derived as termRows − bottomHeight. One ref over the
  // whole region instead of per-block bookkeeping. Mouse mode only.
  const bottomRef = useRef<DOMElement | null>(null);
  // Wraps the rows ABOVE any open picker (live strip + input). Its measured
  // height tells the click handler the absolute screen row where a picker's
  // items begin, so a click can be mapped to a list index.
  const prePickerRef = useRef<DOMElement | null>(null);
  const preRowsRef = useRef(0);
  // Wraps just the LiveActivityStrip (the rows ABOVE the input). Its measured
  // height locates the input's first screen row for click-to-position-cursor.
  const liveStripRef = useRef<DOMElement | null>(null);
  const liveStripRowsRef = useRef(0);
  // useLayoutEffect (not useEffect) so the viewport is sized BEFORE paint — no
  // one-frame flash. measureElement here only READS the already-computed Yoga
  // height (cheap), and the dispatch is guarded to fire only when the height
  // actually changed, so this stays a stable measure-and-set (no churn loop,
  // and streaming tokens never trigger a setViewportRows because the bottom
  // region's height doesn't change while the chat viewport streams).
  React.useLayoutEffect(() => {
    if (!managedLive) return;
    const node = bottomRef.current;
    if (!node) return;
    const { height } = measureElement(node);
    if (prePickerRef.current) {
      preRowsRef.current = measureElement(prePickerRef.current).height;
    }
    if (liveStripRef.current) {
      liveStripRowsRef.current = measureElement(liveStripRef.current).height;
    }
    const s = stateRef.current;
    const affordance = s.scrollOffset > 0 && s.pendingNewLines > 0 ? 1 : 0;
    // Bias the viewport DOWN by one row: an extra blank chat row is invisible,
    // but a status bar pushed off-screen is not.
    const vp = Math.max(MIN_VIEWPORT, termRows - height - affordance - 1);
    if (vp !== s.viewportRows) {
      dispatch({ type: 'setViewportRows', rows: vp });
    }
    // stable deps: stateRef (ref), dispatch (stable from useReducer),
    // termRows is a prop of the effect scope.
  }, [managedLive, termRows]);

  // Latest handleKey, so click-to-activate can replay an Enter through the
  // normal input pipeline (handleKey is defined far below; the ref is filled
  // after it). handleMouse only ever runs post-mount, so the ref is populated.
  const handleKeyRef = useRef<((input: string, key: KeyEvent) => void) | null>(null);
  // Set to the row index a mouse click selected; the effect below replays Enter
  // once that row is the live selection, giving single-click confirm.
  const pendingClickConfirmRef = useRef<number | null>(null);
  // Latest open-routines + rewind handler + confirm decision, so the
  // empty-dep mouse handler can drive surfaces defined further down without
  // re-subscribing. Populated each render (see assignments below their defs).
  const openModelPickerRef = useRef<(() => void) | null>(null);
  const openAutonomyPickerRef = useRef<(() => void) | null>(null);
  const handleRewindToRef = useRef<((promptIndex: number) => void) | null>(null);
  // The bordered ConfirmPrompt's wrapper Box + the live decision callback, so
  // a click on the button row can be located (measured height) and fired.
  const confirmRef = useRef<DOMElement | null>(null);
  const confirmDecisionRef = useRef<((d: ConfirmDecision) => void) | null>(null);
  // True while the left button is held after pressing on the scrollbar, so
  // subsequent motion events scrub the chat viewport (thumb drag).
  const scrollbarDragRef = useRef(false);
  // Multi-click detection: tracks the timestamp and position of the last left
  // click to identify double/triple clicks. SGR 1006 doesn't emit native
  // multi-click events, so we track them ourselves.
  const lastLeftClickRef = useRef<{ x: number; y: number; ts: number; count: number } | null>(null);
  const DOUBLE_CLICK_MS = 500;
  const DOUBLE_CLICK_DIST = 5; // max pixels between clicks to count as multi-click
  // Live status-bar chip inputs, so the empty-dep mouse handler can hit-test
  // the model / autonomy chips against their current values (not stale ones).
  const statusChipRef = useRef<{
    version?: string;
    model: string;
    fleetRunning: number;
    yolo: boolean;
    autonomy: 'off' | 'suggest' | 'auto' | 'eternal' | 'eternal-parallel';
  }>({ version: appVersion, model, fleetRunning: 0, yolo, autonomy: 'off' });

  // Mouse routing. Wheel scrolls history (or drives an open picker's
  // selection); a left click on a picker item selects + activates it; a click
  // on the "N new lines" affordance jumps to the bottom. Registered once;
  // reads live state via stateRef + measured geometry via preRowsRef.
  const handleMouse = React.useCallback(
    (ev: TuiMouseEvent) => {
      const s = stateRef.current;
      if (ev.type === 'wheel') {
        const up = ev.button === 'wheelUp';
        const step = up ? -1 : 1;
        // An open list overlay claims the wheel for its own selection.
        if (s.slashPicker.open) return dispatch({ type: 'slashPickerMove', delta: step });
        if (s.modelPicker.open) return dispatch({ type: 'modelPickerMove', delta: step });
        if (s.autonomyPicker.open) return dispatch({ type: 'autonomyPickerMove', delta: step });
        if (s.settingsPicker.open) return dispatch({ type: 'settingsFieldMove', delta: step });
        if (s.picker.open) return dispatch({ type: 'pickerMove', delta: step });
        if (s.rewindOverlay) return dispatch({ type: 'rewindOverlayMove', delta: step });
        // Otherwise scroll the chat history viewport.
        return dispatch({ type: 'scrollBy', delta: up ? WHEEL_STEP : -WHEEL_STEP });
      }
      // Button release ends any in-progress scrollbar drag.
      if (ev.type === 'release') {
        scrollbarDragRef.current = false;
        return;
      }
      if (ev.button !== 'left') return;

      // Multi-click detection: tracks consecutive clicks within DOUBLE_CLICK_MS
      // and DOUBLE_CLICK_DIST to identify double/triple clicks. Note: terminal
      // text selection is managed by the terminal emulator, not the app, so
      // clickCount is tracked here for future use (e.g., terminal selection API).
      const now = Date.now();
      const lastClick = lastLeftClickRef.current;
      const isMultiClick =
        lastClick !== null &&
        now - lastClick.ts < DOUBLE_CLICK_MS &&
        Math.abs(ev.x - lastClick.x) <= DOUBLE_CLICK_DIST &&
        Math.abs(ev.y - lastClick.y) <= DOUBLE_CLICK_DIST;
      const clickCount = isMultiClick ? lastClick.count + 1 : 1;
      lastLeftClickRef.current = { x: ev.x, y: ev.y, ts: now, count: clickCount };
      void clickCount; // tracked for future terminal selection API use

      // Scrollbar (right edge, rows 1..viewportRows): a press on it jumps the
      // viewport to that position and arms a drag; subsequent held-motion
      // events scrub. The bar is the terminal's last column — accept it plus
      // its 1-col left margin so near-misses still grab. Motion events never
      // fall through to click handling.
      {
        const rows = s.viewportRows;
        if (ev.drag) {
          if (scrollbarDragRef.current && s.totalLines > rows) {
            dispatch({
              type: 'scrollTo',
              offset: scrollOffsetForTrackRow(rows, s.totalLines, ev.y - 1),
            });
          }
          return;
        }
        const cols = termCols || 80;
        // Accept the scrollbar column plus 1-col left margin so near-misses still grab.
        const onScrollbar = cols > 0 && ev.x >= cols - 2 && ev.y >= 1 && ev.y <= rows;
        if (onScrollbar && s.totalLines > rows) {
          scrollbarDragRef.current = true;
          dispatch({
            type: 'scrollTo',
            offset: scrollOffsetForTrackRow(rows, s.totalLines, ev.y - 1),
          });
          return;
        }
      }

      // A click in the bottom region (where they render) dismisses an open
      // informational overlay — mouse parity with Esc. These can't coexist
      // with pickers/confirm (handleKey guards that), so this never eats a
      // picker click. Clicks up in the chat viewport are left alone.
      if (ev.y > s.viewportRows) {
        if (s.helpOpen) return dispatch({ type: 'toggleHelp' });
        if (s.agentsMonitorOpen) return dispatch({ type: 'toggleAgentsMonitor' });
        if (s.monitorOpen) return dispatch({ type: 'toggleMonitor' });
        if (s.worktreeMonitorOpen) return dispatch({ type: 'worktreeMonitorToggle' });
        if (s.autoPhase?.monitorOpen) return dispatch({ type: 'autoPhaseMonitorToggle' });
      }

      const affordance = s.scrollOffset > 0 && s.pendingNewLines > 0 ? 1 : 0;
      // The affordance occupies the row just below the viewport (1-based).
      if (affordance && ev.y === s.viewportRows + 1) {
        return dispatch({ type: 'scrollToBottom' });
      }

      // Permission dialog: map a click on the button row to a decision. The
      // dialog is the only thing between the input region and the status bar
      // while a confirm is pending, so its top row is deterministic. We
      // measure its box height to find the button row (the line just above the
      // bottom border).
      if (s.confirmQueue.length > 0) {
        const node = confirmRef.current;
        const head = s.confirmQueue[0];
        if (node && head) {
          const { height } = measureElement(node);
          const top = s.viewportRows + affordance + preRowsRef.current + 1;
          const buttonsRow = top + height - 2; // -1 bottom border, -1 to land on buttons
          if (ev.y === buttonsRow) {
            // round border (1) + paddingX (1) before the first content column.
            const contentX = ev.x - 1 - 2;
            for (const seg of confirmButtonSegments(head.suggestedPattern)) {
              if (contentX >= seg.start && contentX < seg.start + seg.len) {
                confirmDecisionRef.current?.(seg.decision);
                return;
              }
            }
          }
        }
        return; // a confirm is modal — swallow other clicks
      }

      // Checkpoint timeline (/rewind): click selects; click on the already
      // selected row rewinds. Layout: outer padding(1) + header(1) +
      // marginBottom(1) = 3 rows before the first checkpoint.
      if (s.rewindOverlay) {
        const cps = s.rewindOverlay.checkpoints;
        const firstItemRow = s.viewportRows + affordance + preRowsRef.current + 3 + 1;
        const index = ev.y - firstItemRow;
        if (index < 0 || index >= cps.length) return;
        if (index === s.rewindOverlay.selected) {
          handleRewindToRef.current?.(cps[index]!.promptIndex);
        } else {
          dispatch({ type: 'rewindOverlayMove', delta: index - s.rewindOverlay.selected });
        }
        return;
      }

      // Settings editor: click focuses a field; clicking the already-focused
      // field cycles its value. Header: title(1) + hint(1) = 2 rows.
      if (s.settingsPicker.open) {
        const firstRow = s.viewportRows + affordance + preRowsRef.current + 2 + 1;
        const field = ev.y - firstRow;
        if (field < 0 || field > 1) return;
        if (field === s.settingsPicker.field) {
          dispatch({ type: 'settingsValueChange', delta: 1 });
        } else {
          dispatch({ type: 'settingsFieldSet', field });
        }
        return;
      }

      // Identify the open picker, its header height (rows before the first
      // item) and how to move/confirm it. Only the bottom-anchored list
      // pickers participate; the full-screen rewind overlay does not.
      const picker = s.modelPicker.open
        ? {
            header: 2,
            count:
              s.modelPicker.step === 'provider'
                ? s.modelPicker.providerOptions.length
                : s.modelPicker.modelOptions.length,
            selected: s.modelPicker.selected,
            move: (delta: number) => dispatch({ type: 'modelPickerMove', delta }),
          }
        : s.autonomyPicker.open
          ? {
              header: 2,
              count: s.autonomyPicker.options.length,
              selected: s.autonomyPicker.selected,
              move: (delta: number) => dispatch({ type: 'autonomyPickerMove', delta }),
            }
          : s.slashPicker.open
            ? {
                header: 1,
                count: s.slashPicker.matches.length,
                selected: s.slashPicker.selected,
                move: (delta: number) => dispatch({ type: 'slashPickerMove', delta }),
              }
            : s.picker.open
              ? {
                  header: 1,
                  count: s.picker.matches.length,
                  selected: s.picker.selected,
                  move: (delta: number) => dispatch({ type: 'pickerMove', delta }),
                }
              : null;
      if (!picker || picker.count === 0) {
        // Click inside the editable input → reposition the caret. The input
        // sits just below the live-activity strip; its first row and wrapped
        // height are deterministic from the measured strip height + the same
        // layout the component renders. Skipped while the input is disabled.
        const inputDisabled = s.status === 'aborting' && !s.steeringPending;
        if (!inputDisabled) {
          const cols = termCols || 80;
          const inputTop = s.viewportRows + affordance + liveStripRowsRef.current + 1;
          const inputRows = layoutInputRows(INPUT_PROMPT, s.buffer, s.cursor, cols).length;
          const rowIdx = ev.y - inputTop;
          if (rowIdx >= 0 && rowIdx < inputRows) {
            const next = inputIndexAtRowCol(INPUT_PROMPT, s.buffer, cols, rowIdx, ev.x - 1);
            return dispatch({ type: 'setBuffer', buffer: s.buffer, cursor: next });
          }
        }

        // No list picker open → the status bar is at a deterministic row.
        // Make its model chip (line 1) and autonomy chip (line 2) clickable.
        if (
          !s.helpOpen &&
          !s.agentsMonitorOpen &&
          !s.monitorOpen &&
          !s.worktreeMonitorOpen &&
          !s.autoPhase?.monitorOpen
        ) {
          const chip = statusChipRef.current;
          const statusTop = s.viewportRows + affordance + preRowsRef.current + 1;
          const contentX = ev.x - 1; // status bar has no left border; paddingX folded into spans
          if (ev.y === statusTop + 1) {
            const span = statusBarModelSpan({
              version: chip.version,
              state: s.status,
              fleetRunning: chip.fleetRunning,
              model: chip.model,
            });
            if (contentX >= span.start && contentX < span.start + span.len) {
              openModelPickerRef.current?.();
            }
          } else if (ev.y === statusTop + 2) {
            const span = statusBarAutonomySpan({ yolo: chip.yolo, autonomy: chip.autonomy });
            if (span && contentX >= span.start && contentX < span.start + span.len) {
              openAutonomyPickerRef.current?.();
            }
          }
        }
        return;
      }

      // Absolute (1-based) row of the picker's first item:
      //   viewport rows + affordance + (live strip + input) + header.
      const firstItemRow = s.viewportRows + affordance + preRowsRef.current + picker.header + 1;
      const index = ev.y - firstItemRow;
      if (index < 0 || index >= picker.count) return;
      // Single-click select + confirm. handleKey's Enter path confirms whatever
      // is selected at RENDER time, so we can't move + confirm in one event.
      // Instead: if the row is already selected, confirm now; otherwise move to
      // it and arm pendingClickConfirm — an effect replays Enter on the next
      // render (when handleKey closes over the updated selection). If anything
      // is off, it degrades gracefully to a second click confirming.
      if (index === picker.selected) {
        handleKeyRef.current?.('', { ...EMPTY_KEY, return: true });
      } else {
        pendingClickConfirmRef.current = index;
        picker.move(index - picker.selected);
      }
    },
    // dispatch is stable (useReducer); refs are mutable — no reactive deps.
    // termCols is stable (useState + resize effect).
    [termCols],
  );
  useEffect(() => {
    if (!subscribeMouse) return;
    return subscribeMouse(handleMouse);
  }, [subscribeMouse, handleMouse]);

  // Single-click confirm: after a click moved the selection, replay Enter once
  // the clicked row is the live selection (handleKey then closes over the
  // updated state, so it confirms the RIGHT item). Cleared if the picker closes.
  useEffect(() => {
    const target = pendingClickConfirmRef.current;
    if (target === null) return;
    const open =
      state.slashPicker.open ||
      state.modelPicker.open ||
      state.autonomyPicker.open ||
      state.picker.open;
    if (!open) {
      pendingClickConfirmRef.current = null;
      return;
    }
    const sel = state.slashPicker.open
      ? state.slashPicker.selected
      : state.modelPicker.open
        ? state.modelPicker.selected
        : state.autonomyPicker.open
          ? state.autonomyPicker.selected
          : state.picker.selected;
    if (sel === target) {
      pendingClickConfirmRef.current = null;
      handleKeyRef.current?.('', { ...EMPTY_KEY, return: true });
    }
  }, [
    state.slashPicker.open,
    state.slashPicker.selected,
    state.modelPicker.open,
    state.modelPicker.selected,
    state.autonomyPicker.open,
    state.autonomyPicker.selected,
    state.picker.open,
    state.picker.selected,
  ]);

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

  // Session-elapsed clock. Mount time is fixed; we re-render once per
  // second to refresh the "⏱ 12:34" chip. The interval is cheap — one
  // dispatch per tick into the same `tick` action — and stops cleanly
  // on unmount.
  const startedAtRef = useRef<number>(Date.now());
  const [nowTick, setNowTick] = React.useState<number>(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const elapsedMs = nowTick - startedAtRef.current;

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
      cost: 0,
      startedAt: state.leader.startedAt,
      lastEventAt: state.leader.lastEventAt,
      currentTool: state.leader.currentTool,
      ctxPct: state.leader.ctxPct,
      ctxTokens: state.leader.ctxTokens,
      ctxMaxTokens: state.leader.ctxMaxTokens ?? effectiveMaxContext,
    };
    return { leader: leaderEntry, ...state.fleet };
  }, [state.fleet, state.leader, state.status, provider, model, effectiveMaxContext]);

  // Stable per-subagent label + color assigned on first sighting.
  const STREAM_COLORS = ['cyan', 'magenta', 'yellow', 'green', 'blue'];
  const labelsRef = useRef<Map<string, { label: string; color: string }>>(new Map());
  const labelFor = (id: string, name?: string): { label: string; color: string } => {
    const m = labelsRef.current;
    const existing = m.get(id);
    if (existing) return existing;
    const n = m.size + 1;
    const v = {
      label: name && name !== id ? name : `AGENT#${n}`,
      color: STREAM_COLORS[(n - 1) % STREAM_COLORS.length]!,
    };
    m.set(id, v);
    return v;
  };

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
          items?: Array<{ status?: string }>;
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
  // history above is preserved. For users in heavy resize / picker
  // workflows the bullet-proof alternative is still `--alt-screen`.
  const prevAnyOverlayOpen = useRef(false);
  const prevEntriesCount = useRef(0);
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
  useEffect(() => {
    const anyOpenNow =
      state.picker.open ||
      state.slashPicker.open ||
      state.modelPicker.open ||
      state.autonomyPicker.open ||
      state.settingsPicker.open ||
      state.confirmQueue.length > 0;
    const overlayClosed = prevAnyOverlayOpen.current && !anyOpenNow;
    const newEntryCommitted = state.entries.length > prevEntriesCount.current;
    prevAnyOverlayOpen.current = anyOpenNow;
    prevEntriesCount.current = state.entries.length;
    if (overlayClosed || newEntryCommitted) {
      eraseLiveRegion();
    }
  }, [
    state.picker.open,
    state.slashPicker.open,
    state.modelPicker.open,
    state.autonomyPicker.open,
    state.settingsPicker.open,
    state.confirmQueue.length,
    state.entries.length,
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
    const matches: SlashCommandMatch[] = allCommands
      .filter(({ cmd }) => {
        const name = cmd.name.toLowerCase();
        const aliases = cmd.aliases ?? [];
        return name.includes(query) || aliases.some((a) => a.toLowerCase().includes(query));
      })
      .slice(0, 12)
      .map(({ cmd, owner }) => ({
        name: cmd.name,
        description: cmd.description,
        argsHint: cmd.argsHint,
        isBuiltin: owner === 'core',
      }));

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

  // Register `/altscreen on|off` — runtime escape valve for the
  // alt-screen scrollback limitation. In alt-screen mode the terminal's
  // native scrollback is disabled, so users can't review old chat
  // entries. `off` writes the alt-screen-exit escape so subsequent
  // entries land in the normal scroll region and the mouse wheel /
  // shift+pgup work again. The trade-off (lost on-screen history,
  // resize artifacts) is spelled out in the response message so the
  // user can decide whether to keep it.
  useEffect(() => {
    const ALT_OFF = '\x1b[?1049l';
    const ALT_ON = '\x1b[?1049h';
    const cmd = {
      name: 'altscreen',
      description:
        'Toggle the alt-screen buffer. Default is OFF (native scroll); /altscreen on for full-screen mode.',
      async run(args: string) {
        const arg = args.trim().toLowerCase();
        if (arg === 'off') {
          try {
            writeOut(ALT_OFF);
          } catch {
            return { message: 'Failed to exit alt-screen.' };
          }
          // Leaving alt-screen drops the managed viewport back to <Static>.
          setManagedLive(false);
          return {
            message:
              'Alt-screen disabled. New entries will land in normal scrollback (mouse wheel / Shift+PgUp work). ' +
              'On-screen history rendered before this command is no longer reachable via terminal scroll. ' +
              'Resize may now leak the live region — `/altscreen on` to re-enable.',
          };
        }
        if (arg === 'on') {
          try {
            writeOut(ALT_ON);
          } catch {
            return { message: 'Failed to re-enter alt-screen.' };
          }
          // Entering alt-screen turns on the managed viewport (in-app scroll +
          // PgUp/PgDn + collapsibility), no mouse required.
          setManagedLive(true);
          return {
            message:
              'Alt-screen re-enabled. Managed scroll (PgUp/PgDn) is now active; native scroll is off.',
          };
        }
        return { message: 'Usage: /altscreen on|off' };
      },
    };
    slashRegistry.register(cmd);
    return () => {
      slashRegistry.unregister('altscreen');
    };
  }, [slashRegistry]);

  // Register `/mouse on|off` — runtime toggle for full mouse mode (clickable
  // pickers + in-app wheel scroll). Enabling REQUIRES launching with --mouse:
  // that's when run-tui installs the stdin proxy that keeps mouse bytes out of
  // Ink's keypress parser. Without it, turning tracking on would spray
  // `<0;..M` junk into the input — so we refuse and tell the user to relaunch.
  const mouseLiveRef = useRef(mouseLive);
  mouseLiveRef.current = mouseLive;
  useEffect(() => {
    const MOUSE_ON_SEQ = '\x1b[?1000h\x1b[?1006h';
    const MOUSE_OFF_SEQ = '\x1b[?1006l\x1b[?1000l';
    const ALT_ON = '\x1b[?1049h';
    const ALT_OFF = '\x1b[?1049l';
    const cmd = {
      name: 'mouse',
      description:
        'Toggle mouse mode (clickable menus + wheel-scroll chat). Needs launch with --mouse to enable.',
      async run(args: string) {
        const arg = args.trim().toLowerCase();
        if (arg !== 'on' && arg !== 'off') {
          return {
            message: `Mouse mode is ${mouseLiveRef.current ? 'ON' : 'OFF'}. Usage: /mouse on|off`,
          };
        }
        if (arg === 'on') {
          if (!mouse) {
            return {
              message:
                'Mouse mode needs the --mouse launch flag (it rewires stdin so mouse ' +
                'bytes never reach the input). Restart with `wstack --tui --mouse`.',
            };
          }
          try {
            writeOut(ALT_ON);
            writeOut('\x1b[H');
            writeOut(MOUSE_ON_SEQ);
          } catch {
            return { message: 'Failed to enable mouse mode.' };
          }
          setMouseLive(true);
          setManagedLive(true);
          return {
            message:
              'Mouse mode ON. Click menu items, wheel-scroll the chat (PgUp/PgDn too). ' +
              'Native terminal copy/scroll are suspended until `/mouse off`.',
          };
        }
        // off
        try {
          writeOut(MOUSE_OFF_SEQ);
          writeOut(ALT_OFF);
        } catch {
          return { message: 'Failed to disable mouse mode.' };
        }
        setMouseLive(false);
        // /mouse off also exits alt-screen (above), so drop the managed
        // viewport back to native scrollback.
        setManagedLive(false);
        return {
          message:
            'Mouse mode OFF. Native terminal scroll/copy restored; chat history flows ' +
            'into native scrollback again.',
        };
      },
    };
    slashRegistry.register(cmd);
    return () => {
      slashRegistry.unregister('mouse');
    };
  }, [slashRegistry, mouse]);

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
  const openAutonomyPicker = React.useCallback(() => {
    if (!switchAutonomy) return;
    dispatch({ type: 'autonomyPickerOpen', options: AUTONOMY_OPTIONS });
  }, [switchAutonomy]);
  const openSettings = React.useCallback(() => {
    if (!getSettings) return;
    const s = getSettings();
    dispatch({ type: 'settingsOpen', mode: s.mode, delayMs: s.delayMs });
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
    slashRegistry.register(cmd);
    return () => {
      slashRegistry.unregister('model');
    };
  }, [slashRegistry, getPickableProviders, switchProviderAndModel, openModelPicker]);

  // Register the TUI-only `/settings` command — opens the autonomy settings
  // editor (default mode + auto-proceed delay). Gated on the settings
  // accessors being wired by the host (CLI passes them in).
  useEffect(() => {
    if (!getSettings || !saveSettings) return;
    const cmd = {
      name: 'settings',
      aliases: ['config', 'prefs'],
      description: 'Edit autonomy defaults (mode + auto-proceed delay).',
      async run() {
        openSettings();
        return { message: undefined };
      },
    };
    slashRegistry.register(cmd);
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
    slashRegistry.register(cmd);
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
      if (flushTimerRef.current) clearTimeout(flushTimerRef.current);
    };
  }, [events, agent.ctx.todos]);

  // Live mirror of `streamFleet` for the FleetBus listener below. The
  // listener is wired in a single mount-time effect so it doesn't tear
  // down per-state-change; a ref lets it read the current toggle value
  // on every event without re-subscribing.
  const streamFleetRef = useRef(state.streamFleet);
  useEffect(() => {
    streamFleetRef.current = state.streamFleet;
  }, [state.streamFleet]);

  // --- Subagent lifecycle events (extracted to use-subagent-events.ts) ---
  useSubagentEvents(events, dispatch, setActiveMaxContext);

  // Checkpoint and session rewind event listeners — no director required.
  // eslint-disable-next-line react-hooks/exhaustive-deps -- onClearHistory is stable
  useEffect(() => {
    const offCheckpoint = events.on('checkpoint.written', (e) => {
      dispatch({
        type: 'checkpointReceived',
        cp: {
          promptIndex: e.promptIndex,
          promptPreview: e.promptPreview,
          ts: e.ts,
          fileCount: e.fileCount,
        },
      });
    });
    const offRewound = events.on('session.rewound', (_e) => {
      dispatch({ type: 'sessionRewound', toPromptIndex: 0 });
      dispatch({ type: 'clearHistory' });
      if (onClearHistory) {
        onClearHistory(dispatch);
      }
    });
    return () => {
      offCheckpoint();
      offRewound();
    };
  }, [events, onClearHistory]);

  // --- Brain decision events (extracted to use-brain-events.ts) ---
  useBrainEvents(events, dispatch);

  // --- AutoPhase phase/task events → PhaseMonitor ---
  useEffect(() => {
    if (!subscribeAutoPhase) return;

    const handler = (event: string, payload: unknown) => {
      switch (event) {
        case 'phase.started': {
          const p = payload as { phaseId: string; name: string };
          dispatch({
            type: 'autoPhasePhaseUpdate',
            phaseId: p.phaseId,
            name: p.name,
            status: 'running',
            completedTasks: 0,
            totalTasks: 0,
            startedAt: Date.now(),
          });
          break;
        }
        case 'phase.completed': {
          const p = payload as { phaseId: string; name: string; durationMs: number };
          dispatch({
            type: 'autoPhasePhaseUpdate',
            phaseId: p.phaseId,
            name: p.name,
            status: 'completed',
            completedTasks: 0,
            totalTasks: 0,
          });
          break;
        }
        case 'phase.failed': {
          const p = payload as { phaseId: string; name: string; error?: string };
          dispatch({
            type: 'autoPhasePhaseUpdate',
            phaseId: p.phaseId,
            name: p.name,
            status: 'failed',
            completedTasks: 0,
            totalTasks: 0,
          });
          break;
        }
        case 'phase.statusChange': {
          const p = payload as { phaseId: string; name: string; from: string; to: string };
          const status = p.to === 'running' ? 'running' : p.to;
          dispatch({
            type: 'autoPhasePhaseUpdate',
            phaseId: p.phaseId,
            name: p.name,
            status,
            completedTasks: 0,
            totalTasks: 0,
          });
          break;
        }
        case 'phase.taskCompleted': {
          const p = payload as { phaseId: string; taskId: string; taskTitle: string };
          const existing = stateRef.current.autoPhase?.phases[p.phaseId];
          if (existing) {
            dispatch({
              type: 'autoPhasePhaseUpdate',
              phaseId: p.phaseId,
              name: existing.name,
              status: existing.status,
              completedTasks: existing.completedTasks + 1,
              totalTasks: existing.totalTasks,
            });
          }
          break;
        }
        case 'autonomous.tick': {
          const p = payload as {
            activePhases: Array<{ id: string }>;
            queuedPhases: Array<{ id: string }>;
          };
          dispatch({ type: 'autoPhaseRunningPhases', phaseIds: p.activePhases.map((ph) => ph.id) });
          // Update elapsed time
          const ap = stateRef.current.autoPhase;
          if (ap) {
            const firstPhase = ap.phases[Object.keys(ap.phases)[0] ?? ''];
            const elapsed =
              ap.elapsedMs > 0
                ? ap.elapsedMs + 1000
                : Date.now() - (firstPhase?.startedAt ?? Date.now());
            dispatch({ type: 'autoPhaseElapsed', ms: elapsed });
          }
          break;
        }
        case 'graph.completed': {
          dispatch({ type: 'autoPhaseReset' });
          break;
        }
        case 'graph.failed': {
          dispatch({ type: 'autoPhaseReset' });
          break;
        }
        case 'worktree.allocated': {
          const p = payload as {
            handleId: string;
            ownerLabel: string;
            branch: string;
            baseBranch: string;
          };
          dispatch({
            type: 'worktreeUpsert',
            handleId: p.handleId,
            baseBranch: p.baseBranch,
            row: {
              branch: p.branch,
              ownerLabel: p.ownerLabel,
              baseBranch: p.baseBranch,
              status: 'active',
              allocatedAt: Date.now(),
            },
          });
          break;
        }
        case 'worktree.committed': {
          const p = payload as {
            handleId: string;
            insertions: number;
            deletions: number;
            files: number;
          };
          dispatch({
            type: 'worktreeUpsert',
            handleId: p.handleId,
            row: {
              insertions: p.insertions,
              deletions: p.deletions,
              files: p.files,
              status: 'committing',
            },
          });
          break;
        }
        case 'worktree.merged': {
          const p = payload as { handleId: string };
          dispatch({ type: 'worktreeUpsert', handleId: p.handleId, row: { status: 'merged' } });
          break;
        }
        case 'worktree.conflict': {
          const p = payload as { handleId: string; conflictFiles: string[] };
          dispatch({
            type: 'worktreeUpsert',
            handleId: p.handleId,
            row: { status: 'needs-review', conflictFiles: p.conflictFiles },
          });
          break;
        }
        case 'worktree.failed': {
          const p = payload as { handleId: string };
          dispatch({ type: 'worktreeUpsert', handleId: p.handleId, row: { status: 'failed' } });
          break;
        }
        case 'worktree.released': {
          const p = payload as { handleId: string; kept: boolean };
          // Keep conflicted/failed (kept) worktrees visible; drop clean ones.
          if (!p.kept) dispatch({ type: 'worktreeRemove', handleId: p.handleId });
          break;
        }
      }
    };

    return subscribeAutoPhase(handler);
  }, [subscribeAutoPhase]);

  // --- Leader agent compaction events → chat history ---
  useEffect(() => {
    const offFired = events.on('compaction.fired', (e) => {
      const { level, tokens, load, maxContext, report } = e as {
        level: string;
        tokens: number;
        load: number;
        maxContext: number;
        report: { before: number; after: number; reductions: { phase: string; saved: number }[] };
        aggressive: boolean;
      };
      const pct = (load * 100).toFixed(0);
      const before = report.before;
      const after = report.after;
      const saved = before - after;
      // `tokens` / `load` come from the middleware's full-request estimator
      // (messages + system + tools); `report.before` is the compactor's
      // message-only count. They are different views of the same moment, so
      // label them explicitly to avoid the "98k tokens but 73% load?" confusion.
      if (saved <= 0) {
        dispatch({
          type: 'addEntry',
          entry: {
            kind: 'info',
            text: `▸ compaction skipped at ${level} — load ${pct}% (${tokens.toLocaleString()} of ${maxContext.toLocaleString()} tok). preserveK protects recent turns; nothing to elide.`,
          },
        });
        return;
      }
      const table = [
        `▸ context compacted at ${level} — load ${pct}% (${tokens.toLocaleString()} of ${maxContext.toLocaleString()} tok, full request)`,
        `  msg tokens before ${before.toLocaleString().padStart(8)}`,
        `  msg tokens after  ${after.toLocaleString().padStart(8)}`,
        `  saved            ${saved.toLocaleString().padStart(8)}  (${((saved / before) * 100).toFixed(1)}%)`,
      ];
      for (const line of table) {
        dispatch({ type: 'addEntry', entry: { kind: 'info', text: line } });
      }
    });
    const offFailed = events.on('compaction.failed', (e) => {
      const { level, load, maxContext, fatal } = e as {
        level: string;
        load: number;
        maxContext: number;
        fatal: boolean;
      };
      const pct = (load * 100).toFixed(0);
      const text = fatal
        ? `✗ compaction failed at ${level} — load ${pct}% of ${maxContext.toLocaleString()} tok — FATAL`
        : `⚠ compaction failed at ${level} — load ${pct}% of ${maxContext.toLocaleString()} tok — continuing`;
      dispatch({ type: 'addEntry', entry: { kind: fatal ? 'error' : 'warn', text } });
    });
    return () => {
      offFired();
      offFailed();
    };
  }, [events]);

  // Install a dispatch-backed setter into the shared controller so the
  // `/fleet stream on|off` slash command can flip our reducer flag.
  // Restored to a noop on unmount so a late-arriving slash callback
  // doesn't dispatch into a torn-down React tree.
  useEffect(() => {
    if (!fleetStreamController) return;
    fleetStreamController.enabled = state.streamFleet;
    fleetStreamController.setEnabled = (enabled: boolean) => {
      dispatch({ type: 'setStreamFleet', enabled });
    };
    return () => {
      fleetStreamController.setEnabled = (enabled: boolean) => {
        fleetStreamController.enabled = enabled;
      };
    };
  }, [fleetStreamController, state.streamFleet]);

  // Keep the controller's mirror of `enabled` in sync when the toggle is
  // flipped from a TUI-side path (not the slash command).
  useEffect(() => {
    if (fleetStreamController) fleetStreamController.enabled = state.streamFleet;
  }, [state.streamFleet, fleetStreamController]);

  // Install a dispatch-backed setter into the shared controller so the
  // `/agents on|off` slash command can toggle our overlay flag.
  // Restored to a noop on unmount so a late-arriving slash callback
  // doesn't dispatch into a torn-down React tree.
  useEffect(() => {
    if (!agentsMonitorController) return;
    agentsMonitorController.visible = state.agentsMonitorOpen;
    agentsMonitorController.setVisible = (visible: boolean) => {
      if (visible !== state.agentsMonitorOpen) {
        dispatch({ type: 'toggleAgentsMonitor' });
      }
    };
    return () => {
      agentsMonitorController.setVisible = (visible: boolean) => {
        agentsMonitorController.visible = visible;
      };
    };
  }, [agentsMonitorController, state.agentsMonitorOpen]);

  // Keep the controller's mirror of `visible` in sync when the toggle is
  // flipped from a TUI-side path (not the slash command).
  useEffect(() => {
    if (agentsMonitorController) agentsMonitorController.visible = state.agentsMonitorOpen;
  }, [state.agentsMonitorOpen, agentsMonitorController]);

  // Track double-Esc for input buffer clearing.
  const lastEscAtRef = useRef(0);
  const ESC_DOUBLE_PRESS_MS = 1000;

  // --- FleetBus → TUI dispatch bridge ---
  // Subscribes to every event on the director's FleetBus and dispatches
  // fleet state actions. Text deltas are throttled (FLUSH_MS) to avoid
  // flooding React re-renders; other events dispatch immediately.
  // Seeds initial fleet state from director.status() on mount so the
  // panel reflects subagents spawned before the TUI attached.
  // biome-ignore lint/correctness/useExhaustiveDependencies: labelFor is ref-stable
  useEffect(() => {
    const d = director;
    if (!d) return;
    const FLUSH_MS = 150;

    // Coalesce high-frequency subagent display events. Instead of dispatching
    // (and re-rendering) once per event, queue them and flush as ONE
    // `fleetBatch` every ~150ms. During a multi-agent run this turns hundreds
    // of renders/sec into ~6/sec. Correctness-sensitive events (task.completed
    // on offDone, and the one-time mount seed) keep the real `dispatch`.
    const batch: Action[] = [];
    let batchTimer: ReturnType<typeof setTimeout> | null = null;
    const flushBatch = () => {
      batchTimer = null;
      if (batch.length === 0) return;
      dispatch({ type: 'fleetBatch', actions: batch.splice(0, batch.length) });
    };
    const enq = (a: Action) => {
      batch.push(a);
      // Cap so a 20-agent burst can't grow an unbounded array before the timer.
      if (batch.length >= 256) {
        if (batchTimer) clearTimeout(batchTimer);
        flushBatch();
        return;
      }
      if (!batchTimer) batchTimer = setTimeout(flushBatch, FLUSH_MS);
    };

    // Per-agent buffered assistant text. Flushed as one `subagent`
    // history entry when the agent stops emitting deltas for FLUSH_MS,
    // so we don't fire a fresh history entry on every token.
    const streamBuf = new Map<string, string>();
    let streamFlushTimer: ReturnType<typeof setTimeout> | null = null;
    const flushStreamBufs = () => {
      for (const [id, text] of streamBuf) {
        const trimmed = text.trim();
        if (!trimmed) continue;
        const lbl = labelFor(id);
        enq({ type: 'fleetMessage', id, text: trimmed });
        if (streamFleetRef.current) {
          enq({
            type: 'addEntry',
            entry: {
              kind: 'subagent',
              agentLabel: lbl.label,
              agentColor: lbl.color,
              icon: '💬',
              text: trimmed,
            },
          });
        }
      }
      streamBuf.clear();
      streamFlushTimer = null;
    };

    // Seed: discover already-spawned subagents from the coordinator.
    const status = d.status();
    for (const s of status.subagents) {
      const meta = d.getSubagentMeta(s.id);
      dispatch({
        type: 'fleetSpawn',
        id: s.id,
        name: meta?.name ?? s.name,
        provider: meta?.provider,
        model: meta?.model,
      });
      // Seed a stable label so subagents spawned before TUI mount still
      // show up by name in the status bar's per-agent detail line.
      labelFor(s.id, meta?.name ?? s.name);
    }
    // Also seed cost from the usage aggregator.
    dispatch({
      type: 'fleetCost',
      cost: d.snapshot().total.cost,
      input: d.snapshot().total.input,
      output: d.snapshot().total.output,
    });

    // Discover new subagents on first FleetBus event for an unknown id.
    const seen = new Set(Object.keys(status.subagents));

    // Throttled delta accumulator per subagent.
    const pending = new Map<string, string>();
    let flushTimer: ReturnType<typeof setTimeout> | null = null;
    const doFlush = () => {
      for (const [id, text] of pending) {
        if (text) enq({ type: 'fleetDelta', id, text });
      }
      pending.clear();
      flushTimer = null;
    };

    const offFleet = d.fleet.onAny((e: FleetEvent) => {
      // All dispatches in this handler go through the 150ms batch: shadow
      // `dispatch` with `enq` for the whole callback so every switch case
      // below queues instead of rendering immediately.
      const dispatch = enq;
      // Discover new subagents.
      const fresh = !seen.has(e.subagentId);
      if (fresh) {
        seen.add(e.subagentId);
        const meta = d.getSubagentMeta(e.subagentId);
        dispatch({
          type: 'fleetSpawn',
          id: e.subagentId,
          name: meta?.name,
          provider: meta?.provider,
          model: meta?.model,
        });
        // Always assign a label on first sighting so the status bar's
        // 4th line has stable AGENT#N names even when history streaming
        // is disabled. The history `spawned` entry below is gated on
        // streamFleet; label assignment itself is unconditional.
        const lbl = labelFor(e.subagentId, meta?.name);
        if (streamFleetRef.current) {
          const where =
            meta?.provider && meta?.model ? `${meta.provider}/${meta.model}` : 'spawned';
          dispatch({
            type: 'addEntry',
            entry: {
              kind: 'subagent',
              agentLabel: lbl.label,
              agentColor: lbl.color,
              icon: '▶',
              text: where,
            },
          });
        }
      }

      switch (e.type) {
        case 'iteration.started':
          dispatch({ type: 'fleetStart', id: e.subagentId });
          break;
        case 'session.started':
          // First event a subagent emits — treat as start so the fleet
          // panel is populated even if no iteration.started fires yet.
          dispatch({ type: 'fleetStart', id: e.subagentId });
          break;
        case 'provider.text_delta': {
          const p = e.payload as { text?: string };
          if (p?.text) {
            const cur = pending.get(e.subagentId) ?? '';
            pending.set(e.subagentId, cur + p.text);
            if (!flushTimer) flushTimer = setTimeout(doFlush, FLUSH_MS);
            streamBuf.set(e.subagentId, (streamBuf.get(e.subagentId) ?? '') + p.text);
            if (streamFlushTimer) clearTimeout(streamFlushTimer);
            streamFlushTimer = setTimeout(flushStreamBufs, FLUSH_MS * 4);
          }
          break;
        }
        case 'provider.thinking_delta': {
          // Extended thinking output — same buffering as text_delta so
          // it gets flushed into recentMessages and (when streaming is
          // on) injected into leader history.
          const p = e.payload as { text?: string };
          if (p?.text) {
            streamBuf.set(e.subagentId, (streamBuf.get(e.subagentId) ?? '') + p.text);
            if (streamFlushTimer) clearTimeout(streamFlushTimer);
            streamFlushTimer = setTimeout(flushStreamBufs, FLUSH_MS * 4);
          }
          break;
        }
        case 'provider.retry': {
          const p = e.payload as { attempt?: number; delayMs?: number };
          dispatch({
            type: 'addEntry',
            entry: {
              kind: 'warn',
              text: `subagent retry ${p?.attempt ?? '?'}${p?.delayMs ? ` (${p.delayMs}ms)` : ''}`,
            },
          });
          break;
        }
        case 'provider.error': {
          const p = e.payload as { description?: string };
          dispatch({
            type: 'addEntry',
            entry: {
              kind: 'error',
              text: `subagent error${p?.description ? `: ${p.description}` : ''}`,
            },
          });
          break;
        }
        case 'tool.started': {
          const p = e.payload as { name?: string };
          if (p?.name) {
            dispatch({ type: 'fleetToolStart', id: e.subagentId, name: p.name });
          }
          break;
        }
        case 'tool.executed': {
          const p = e.payload as {
            name?: string;
            ok?: boolean;
            durationMs?: number;
            outputBytes?: number;
            outputLines?: number;
          };
          dispatch({
            type: 'fleetTool',
            id: e.subagentId,
            name: p?.name,
            ok: p?.ok,
            durationMs: p?.durationMs,
            outputBytes: p?.outputBytes,
            outputLines: p?.outputLines,
          });
          dispatch({ type: 'fleetToolEnd', id: e.subagentId });
          // Also inject into leader chat history when stream is enabled.
          if (streamFleetRef.current && p?.name) {
            const lbl = labelFor(e.subagentId);
            dispatch({
              type: 'addEntry',
              entry: {
                kind: 'subagent',
                agentLabel: lbl.label,
                agentColor: lbl.color,
                icon: '🔧',
                text: `→ ${p.name} ${p.ok === false ? '✗' : '✓'}${p.durationMs != null ? ` (${p.durationMs}ms)` : ''}`,
              },
            });
          }
          break;
        }
        case 'provider.response': {
          // Surface live cost from the aggregator (already computed with
          // per-model pricing).
          dispatch({
            type: 'fleetCost',
            cost: d.snapshot().total.cost,
            input: d.snapshot().total.input,
            output: d.snapshot().total.output,
          });
          break;
        }
        case 'session.ended':
          // Subagent finished — leave status update to task.completed.
          break;
        case 'compaction.fired':
          dispatch({
            type: 'addEntry',
            entry: { kind: 'info', text: 'subagent compaction triggered' },
          });
          break;
        case 'compaction.failed':
          dispatch({
            type: 'addEntry',
            entry: { kind: 'warn', text: 'subagent compaction failed' },
          });
          break;
        case 'token.threshold':
          dispatch({
            type: 'addEntry',
            entry: { kind: 'info', text: 'subagent token threshold reached' },
          });
          break;
        case 'budget.threshold_reached': {
          const p = e.payload as { kind?: string; used?: number; limit?: number };
          dispatch({
            type: 'fleetBudgetWarning',
            id: e.subagentId,
            kind: p?.kind ?? 'unknown',
            used: p?.used ?? 0,
            limit: p?.limit ?? 0,
          });
          break;
        }
        case 'budget.extended': {
          const p = e.payload as { totalExtensions?: number };
          if (p?.totalExtensions !== undefined) {
            dispatch({
              type: 'fleetBudgetExtended',
              id: e.subagentId,
              totalExtensions: p.totalExtensions,
            });
          }
          break;
        }
        // --- Collab session events ---
        case 'bug.found': {
          // Detect collab subagent role from subagentId: bug-hunter-<sid>,
          // refactor-planner-<sid>, critic-<sid>
          const role = e.subagentId.includes('bug-hunter')
            ? 'bug-hunter'
            : e.subagentId.includes('refactor-planner')
              ? 'refactor-planner'
              : e.subagentId.includes('critic')
                ? 'critic'
                : null;
          if (!role && !state.collabSession) {
            // Not a collab subagent — ignore.
            break;
          }
          if (!state.collabSession) {
            // First collab event we've seen — bootstrap state lazily.
            dispatch({
              type: 'collabSubagentSpawned',
              subagentId: e.subagentId,
              role: role ?? 'unknown',
            });
          }
          const bp = e.payload as {
            finding?: { id?: string; severity?: string; description?: string };
          };
          if (bp?.finding) {
            const sessionId = e.subagentId.split('-').slice(1).join('-') || e.subagentId;
            dispatch({
              type: 'collabBugFound',
              sessionId,
              bugId: bp.finding.id ?? 'unknown',
              severity: bp.finding.severity ?? 'unknown',
              description: bp.finding.description ?? '',
            });
          }
          break;
        }
        case 'refactor.plan': {
          if (!state.collabSession) break;
          const pp = e.payload as {
            plan?: { id?: string; riskScore?: string; phases?: unknown[] };
          };
          if (pp?.plan) {
            const sessionId = e.subagentId.split('-').slice(1).join('-') || e.subagentId;
            dispatch({
              type: 'collabPlanEmitted',
              sessionId,
              planId: pp.plan.id ?? 'unknown',
              riskScore: pp.plan.riskScore ?? 'unknown',
              phaseCount: pp.plan.phases?.length ?? 0,
            });
          }
          break;
        }
        case 'critic.evaluation': {
          if (!state.collabSession) break;
          const ep = e.payload as {
            evaluation?: { id?: string; verdict?: string; score?: number };
          };
          if (ep?.evaluation) {
            const sessionId = e.subagentId.split('-').slice(1).join('-') || e.subagentId;
            dispatch({
              type: 'collabEvalComplete',
              sessionId,
              evalId: ep.evaluation.id ?? 'unknown',
              verdict: ep.evaluation.verdict ?? 'unknown',
              score: ep.evaluation.score ?? 0,
            });
          }
          break;
        }
        case 'collab.session_done': {
          // Emitted by the CollabSession itself (EventEmitter 'session.done').
          if (!state.collabSession) break;
          const dp = e.payload as {
            report?: {
              sessionId?: string;
              overallVerdict?: 'approve' | 'needs_revision' | 'reject';
            };
          };
          if (dp?.report) {
            dispatch({
              type: 'collabSessionDone',
              sessionId: dp.report.sessionId ?? state.collabSession.sessionId ?? 'unknown',
              verdict: dp.report.overallVerdict ?? 'needs_revision',
            });
          }
          break;
        }
      }
    });

    // Task completions arrive on the director's bus too, but the
    // history entry is now produced by the `subagent.task_completed`
    // EventBus listener (which fires uniformly for director and
    // non-director paths). Here we only update fleet panel state +
    // running cost — the chat-side entry would otherwise duplicate.
    const offDone = d.on('task.completed', (payload) => {
      dispatch({
        type: 'fleetDone',
        id: payload.result.subagentId,
        status: payload.result.status,
        iterations: payload.result.iterations,
        toolCalls: payload.result.toolCalls,
      });
      dispatch({
        type: 'fleetCost',
        cost: d.snapshot().total.cost,
        input: d.snapshot().total.input,
        output: d.snapshot().total.output,
      });
      // Drain any pending streaming text right before the completion
      // entry is committed by the EventBus listener so the order
      // "chat → done line" stays correct. flushStreamBufs queues into the
      // batch, so flush the batch synchronously here to commit those chat
      // lines before the done entry lands.
      if (streamFlushTimer) {
        clearTimeout(streamFlushTimer);
        flushStreamBufs();
      }
      if (batchTimer) clearTimeout(batchTimer);
      flushBatch();
    });

    return () => {
      offFleet();
      offDone();
      if (flushTimer) clearTimeout(flushTimer);
      doFlush(); // queues any pending deltas
      if (streamFlushTimer) clearTimeout(streamFlushTimer);
      flushStreamBufs(); // queues any pending messages
      if (batchTimer) clearTimeout(batchTimer);
      flushBatch(); // commit the queued batch before teardown
    };
  }, [director]);

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
        // cursor shown, alt-screen dismantled) and routes the 130 exit code
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
              text: `Iteration cancelled${director ? ' + fleet terminated' : ''}${procTag}. Dropped ${droppedCount} queued message${droppedCount === 1 ? '' : 's'}. Press Ctrl+C again to exit.`,
            },
          });
        } else {
          dispatch({
            type: 'addEntry',
            entry: {
              kind: 'warn',
              text: `Iteration cancelled${director ? ' + fleet terminated' : ''}${procTag}. Press Ctrl+C again to exit.`,
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
              text: `${bits.join(' + ') || 'Background work stopped'}. Press Ctrl+C again to exit.`,
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

    // The help overlay is modal: Esc / `?` / `q` dismiss it; every other key is
    // swallowed so nothing leaks into the editor or chat behind it.
    if (state.helpOpen) {
      if (key.escape || input === '?' || input === 'q') dispatch({ type: 'toggleHelp' });
      return;
    }

    // Re-entrancy guard: block stale-second events from \r\n terminals.
    if (inputGateRef.current) return;

    // ── Managed-viewport scroll keys (PageUp/PageDown + Ctrl+Home/End) ─
    // Keyboard parity with the wheel: page the chat viewport. Active whenever
    // the managed viewport is the surface (alt-screen), mouse or not.
    // Home/End (when buffer empty) are handled separately below.
    if (managedLive) {
      if (key.pageUp) {
        dispatch({ type: 'scrollPage', dir: 'up' });
        return;
      }
      if (key.pageDown) {
        dispatch({ type: 'scrollPage', dir: 'down' });
        return;
      }
      // Ctrl+Home/End: jump to top/bottom of chat history.
      if (key.ctrl && key.home) {
        dispatch({ type: 'scrollToTop' });
        return;
      }
      if (key.ctrl && key.end) {
        dispatch({ type: 'scrollToBottom' });
        return;
      }
    }

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
        const { mode, delayMs } = state.settingsPicker;
        const err = await saveSettings?.({ mode, delayMs });
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

      activeCtrlRef.current?.abort();
      dispatch({ type: 'status', status: 'aborting' });
      dispatch({
        type: 'steerStart',
        snapshot: {
          runningTools,
          subagents,
          subagentsTerminated,
          partialAssistantText,
        },
      });

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
      if (state.agentsMonitorOpen) {
        // Switch: close AgentsMonitor, open FleetMonitor
        dispatch({ type: 'toggleAgentsMonitor' });
        dispatch({ type: 'toggleMonitor' });
      } else {
        dispatch({ type: 'toggleMonitor' });
      }
    };
    const toggleAgentsOverlay = () => {
      if (state.monitorOpen) {
        // Switch: close FleetMonitor, open AgentsMonitor
        dispatch({ type: 'toggleMonitor' });
        dispatch({ type: 'toggleAgentsMonitor' });
      } else {
        dispatch({ type: 'toggleAgentsMonitor' });
      }
    };
    const toggleWorktreeOverlay = () => {
      if (state.worktreeMonitorOpen) {
        dispatch({ type: 'worktreeMonitorToggle' });
        return;
      }
      // Opening closes any other overlay first so only one dashboard shows.
      if (state.agentsMonitorOpen) dispatch({ type: 'toggleAgentsMonitor' });
      if (state.monitorOpen) dispatch({ type: 'toggleMonitor' });
      if (state.autoPhase?.monitorOpen) dispatch({ type: 'autoPhaseMonitorToggle' });
      dispatch({ type: 'worktreeMonitorToggle' });
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
    // Ctrl+S toggles the autonomy settings editor (also openable via
    // `/settings`). Only when the host wired the settings accessors.
    if (key.ctrl && input === 's') {
      if (state.settingsPicker.open) {
        dispatch({ type: 'settingsClose' });
      } else if (getSettings && saveSettings) {
        const cfg = getSettings();
        dispatch({ type: 'settingsOpen', mode: cfg.mode, delayMs: cfg.delayMs });
      }
      return;
    }
    // Esc closes whichever monitor is open. When both are closed the busy-state
    // Esc handler above already returned when a run was active.
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
      !state.autoPhase?.monitorOpen
    ) {
      dispatch({ type: 'toggleHelp' });
      return;
    }

    if (isEnter) {
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

    if (key.backspace || key.delete) {
      if (key.ctrl) {
        if (key.backspace) {
          if (cursor === 0) return;
          const beforeCursor = buffer.slice(0, cursor);
          const lastWordStart = beforeCursor.lastIndexOf(' ') + 1;
          const next = beforeCursor.slice(0, lastWordStart) + buffer.slice(cursor);
          setDraft(next, lastWordStart);
        } else {
          if (cursor >= buffer.length) return;
          const afterCursor = buffer.slice(cursor);
          const nextWordStart = afterCursor.indexOf(' ');
          const end = nextWordStart === -1 ? buffer.length : cursor + nextWordStart + 1;
          const next = buffer.slice(0, cursor) + buffer.slice(end);
          setDraft(next, cursor);
        }
        return;
      }

      // Token-aware backspace: if the text immediately before the cursor ends
      // with a whole attachment chip (`[pasted …]` / `[file:…]` / `[image …]`),
      // delete the entire token in one keystroke — anywhere in the line, not
      // just at the end.
      if (key.backspace) {
        const tokenDel = deleteTokenBackward(buffer, cursor);
        if (tokenDel) {
          setDraft(tokenDel.buffer, tokenDel.cursor);
          return;
        }
      }

      if (cursor === 0) return;
      const next = buffer.slice(0, cursor - 1) + buffer.slice(cursor);
      setDraft(next, cursor - 1);
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
    // In managed (scroll) mode: Home/End scroll the chat viewport to top/bottom
    // when the input buffer is empty, mirroring the wheel and PgUp/PgDn.
    // When there is text in the buffer, Home/End position the cursor.
    if (key.home) {
      if (managedLive && buffer.length === 0) {
        dispatch({ type: 'scrollToTop' });
      } else {
        setDraft(buffer, 0);
      }
      return;
    }
    if (key.end) {
      if (managedLive && buffer.length === 0) {
        dispatch({ type: 'scrollToBottom' });
      } else {
        setDraft(buffer, buffer.length);
      }
      return;
    }

    // History scrolling is delegated to the terminal's native scrollback
    // (mouse wheel, Shift+PgUp in Windows Terminal, etc.) — Ink's <Static>
    // emits each finalized entry once and never repaints over it.
    if (key.upArrow) {
      if (state.inputHistory.length > 0) dispatch({ type: 'historyUp' });
      return;
    }
    if (key.downArrow) {
      if (state.historyIndex > 0) dispatch({ type: 'historyDown' });
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
    // Delete key and Ctrl+D → delete character at cursor (forward delete).
    // Ctrl+D also doubles as "EOF" in some shells — here it's just convenient
    // forward-delete when the user isn't at the terminal's physical Delete key.
    if (key.delete || (key.ctrl && input === 'd')) {
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
    }

    // Drain the queue. If the run was aborted, the SIGINT handler has
    // already cleared the queue, so the head will be undefined.
    const head = stateRef.current.queue[0];
    if (head) {
      dispatch({ type: 'dequeueFirst' });
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
        const ctxProviderId = (agent.ctx.provider as { id?: string } | undefined)?.id;
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

    // ── SDD Context Injection ──────────────────────────────────────────
    // When an SDD session is active, prepend the session context so the
    // model knows it's in a spec-building conversation.
    const sddContext = getSDDContext?.();
    if (sddContext && trimmed) {
      builder.appendText(`[SDD SESSION ACTIVE]\n${sddContext}\n\n---\nUser message:\n`);
    }

    if (trimmed) {
      const toAppend = steering ? buildSteeringPreamble(state.steerSnapshot, trimmed) : trimmed;
      builder.appendText(toAppend);
    }
    if (steering) dispatch({ type: 'steerConsume' });
    // The user sees their original text + a visual ↯ marker when
    // steering, not the full preamble — keeps the chat readable while
    // the model still gets the explicit instruction.
    const displayText = trimmed ? (steering ? `↯ ${trimmed}` : trimmed) : '(attachments only)';
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

  // Expose the latest handleKey to the mouse handler (click-to-confirm).
  handleKeyRef.current = handleKey;
  // Expose the latest open-routines / rewind handler / status chip values to
  // the empty-dep mouse handler so clicks drive the live state.
  openModelPickerRef.current = () => {
    void openModelPicker();
  };
  openAutonomyPickerRef.current = openAutonomyPicker;
  handleRewindToRef.current = (promptIndex: number) => {
    void handleRewindTo(promptIndex);
  };
  statusChipRef.current = {
    version: appVersion,
    model: `${liveProvider}/${liveModel}`,
    fleetRunning: fleetCounts?.running ?? 0,
    yolo: yoloLive,
    autonomy: autonomyLive,
  };

  const inputHint = useMemo(() => {
    if (state.status !== 'idle') return '';
    if (state.buffer.startsWith('/')) return 'slash command — Enter to dispatch';
    if (state.picker.open) return '';
    return '';
  }, [state.buffer, state.status, state.picker.open]);

  const affordanceShown = managedLive && state.scrollOffset > 0 && state.pendingNewLines > 0;
  return (
    <Box flexDirection="column" height={managedLive ? termRows : undefined}>
      {managedLive ? (
        <ScrollableHistory
          entries={state.entries}
          streamingText={state.streamingText}
          toolStream={state.toolStream}
          scrollOffset={state.scrollOffset}
          viewportRows={state.viewportRows || Math.max(MIN_VIEWPORT, termRows - 8)}
          totalLines={state.totalLines}
          onMeasure={(total) => dispatch({ type: 'setMeasuredLines', totalLines: total })}
        />
      ) : (
        <History
          entries={state.entries}
          streamingText={state.streamingText}
          toolStream={state.toolStream}
        />
      )}
      {affordanceShown ? (
        <Text dimColor>
          {`  ↓ ${state.pendingNewLines} new line${state.pendingNewLines === 1 ? '' : 's'} — PgDn or click to jump to bottom`}
        </Text>
      ) : null}
      {/* In mouse mode the whole live region below the scroll viewport is
          wrapped in one measured Box so its height feeds the viewport-size
          computation. In the default path it's a layout-neutral column. */}
      <Box ref={managedLive ? bottomRef : undefined} flexDirection="column" flexShrink={0}>
        {/* Live activity strip + input. Wrapped so its height locates where an
          open picker's items start on screen (click-to-select geometry). */}
        <Box ref={managedLive ? prePickerRef : undefined} flexDirection="column" flexShrink={0}>
          <Box ref={managedLive ? liveStripRef : undefined} flexDirection="column" flexShrink={0}>
            <LiveActivityStrip entries={state.fleet} nowTick={nowTick} />
          </Box>
          <Input
            prompt={INPUT_PROMPT}
            value={state.buffer}
            cursor={state.cursor}
            disabled={
              (state.status === 'aborting' && !state.steeringPending) ||
              state.confirmQueue.length > 0
            }
            hint={inputHint}
            onKey={handleKey}
          />
        </Box>
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
            hint={state.settingsPicker.hint}
          />
        ) : null}
        {state.rewindOverlay ? (
          <CheckpointTimeline
            checkpoints={state.rewindOverlay.checkpoints}
            selected={state.rewindOverlay.selected}
            onSelect={(i) =>
              dispatch({ type: 'rewindOverlayMove', delta: i - state.rewindOverlay!.selected })
            }
            onConfirm={(i) => handleRewindTo(state.rewindOverlay!.checkpoints[i]!.promptIndex)}
            onClose={() => dispatch({ type: 'rewindOverlayClose' })}
          />
        ) : null}
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
            const head = state.confirmQueue[0]!;
            let resolved = false;
            const onDecision = (decision: ConfirmDecision) => {
              if (resolved) return;
              resolved = true;
              head.resolve(decision);
              dispatch({ type: 'confirmClose' });
            };
            // Expose the live decision callback so a mouse click on the button
            // row can fire it (see handleMouse). The wrapper Box owns marginY
            // and carries the ref so measureElement returns the exact box
            // height the hit-test uses to locate the button row.
            confirmDecisionRef.current = onDecision;
            return (
              <Box ref={confirmRef} flexDirection="column" marginY={1} flexShrink={0}>
                <ConfirmPrompt
                  toolName={head.toolName}
                  input={head.input}
                  suggestedPattern={head.suggestedPattern}
                  onDecision={onDecision}
                />
              </Box>
            );
          })()}
        <StatusBar
          model={`${liveProvider}/${liveModel}`}
          version={appVersion}
          state={state.status}
          tokenCounter={tokenCounter}
          hint={renderRunningTools(state.runningTools) || state.hint}
          queueCount={state.queue.length}
          yolo={yoloLive}
          autonomy={autonomyLive}
          elapsedMs={elapsedMs}
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
        />
        {/* Only render the persistent hint bar in the managed (alt-screen)
          viewport. In the default inline-redraw mode it would add a row to the
          fragile live region and collide with monitor panels rendered below it
          (interleaving their counts into the hints). */}
        {managedLive ? (
          <KeyHintBar
            context={{
              confirm: state.confirmQueue.length > 0,
              picker:
                state.picker.open ||
                state.slashPicker.open ||
                state.modelPicker.open ||
                state.autonomyPicker.open ||
                state.settingsPicker.open ||
                !!state.rewindOverlay,
              monitor:
                state.agentsMonitorOpen ||
                state.monitorOpen ||
                state.worktreeMonitorOpen ||
                !!state.autoPhase?.monitorOpen,
              managed: managedLive,
              mouse: mouseLive,
            }}
          />
        ) : null}
        {/* Keys-&-commands help overlay (`?` on an empty prompt). Modal: while
          open, handleKey swallows everything but Esc/?/q, so it never coexists
          with a monitor. */}
        {state.helpOpen ? <HelpOverlay managed={managedLive} mouse={mouseLive} /> : null}
        {/* Agents monitor overlay (Ctrl+G) and fleet monitor overlay (Ctrl+F)
          take up the lower region — hide FleetPanel while any overlay is open. */}
        {state.agentsMonitorOpen ? (
          <AgentsMonitor
            entries={entriesWithLeader}
            totalCost={state.fleetCost}
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
        ) : state.monitorOpen ? (
          <FleetMonitor
            entries={state.fleet}
            totalCost={state.fleetCost}
            totalTokens={state.fleetTokens}
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
