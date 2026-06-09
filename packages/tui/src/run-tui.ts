import type {
  Agent,
  AttachmentStore,
  Director,
  EventBus,
  QueueStore,
  SlashCommandRegistry,
  TokenCounter,
} from '@wrongstack/core';
import { writeErr, type AutonomyStage } from '@wrongstack/core';
import type { VisionAdapters } from '@wrongstack/runtime/vision';
import { render } from 'ink';
import * as path from 'node:path';
import React from 'react';
import { App } from './app.js';
import { startTerminalTitle } from './terminal-title.js';

// Re-export autonomy stage types from core for backward compatibility
export type { AutonomyStage };

export interface RunTuiOptions {
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
  /** Persists the input queue across crashes; if omitted, the queue is in-memory only. */
  queueStore?: QueueStore | undefined;
  /** Surfaces the "⚠ YOLO" chip in the status bar. */
  yolo?: boolean | undefined;
  /** Query live YOLO state from the permission policy. */
  getYolo?: (() => boolean) | undefined;
  /** Query the live autonomy mode. */
  getAutonomy?: (() => 'off' | 'suggest' | 'auto' | 'eternal' | 'eternal-parallel') | undefined;
  /**
   * Access the eternal-autonomy engine. When autonomy mode flips to
   * 'eternal' the TUI drives `runOneIteration()` from the post-slash hook
   * so the engine and TUI never race for the shared Context.
   */
  getEternalEngine?: (() => import('@wrongstack/core').EternalAutonomyEngine | null) | undefined;
  /**
   * Access the parallel-eternal engine. When autonomy mode flips to
   * 'eternal-parallel' the TUI drives `runOneIteration()` from the post-slash
   * hook so the engine and TUI never race for the shared Context.
   */
  getParallelEngine?: (() => import('@wrongstack/core').ParallelEternalEngine | null) | undefined;
  /**
   * Subscribe to live per-iteration events from the eternal engine.
   * Returns an unsubscribe function. TUI uses this to render each
   * iteration as a live timeline entry as it lands.
   */
  subscribeEternalIteration?: ((
    fn: (entry: import('@wrongstack/core').JournalEntry) => void,
  ) => () => void) | undefined;
  /**
   * Subscribe to per-iteration stage transitions from the autonomy engines.
   * TUI uses this to render live status in the status bar.
   */
  subscribeEternalStage?: ((fn: (stage: AutonomyStage) => void) => () => void) | undefined;
  /** Renders in the startup banner. Read from the CLI's package.json. */
  appVersion?: string | undefined;
  /** Provider id for the startup banner ("openai", "anthropic", ...). */
  provider?: string | undefined;
  /** Wire family — shown beneath provider in the banner. */
  family?: string | undefined;
  /** Last 3 chars of the active API key — shown in the banner for visual key-pick verification. */
  keyTail?: string | undefined;
  /** Snapshot of keyed providers + their model lists for the `/model` picker. Async — the catalog fetch may need to hit disk/network. */
  getPickableProviders?: (() => Promise<import('./components/model-picker.js').ProviderOption[]>) | undefined;
  /** Apply a (provider, model) pair after the picker confirms. Returns an error string on failure. */
  switchProviderAndModel?: ((providerId: string, modelId: string) => string | null) | undefined;
  /** Apply an autonomy mode after the picker confirms. Returns an error string on failure. */
  switchAutonomy?: ((
    mode: 'off' | 'suggest' | 'auto' | 'eternal' | 'eternal-parallel',
  ) => string | null) | undefined;
  /**
   * Model-specific maxContext (tokens), resolved by the CLI via the
   * ModelsRegistry. When omitted, the TUI falls back to the provider
   * family's baseline (e.g. anthropic = 200_000), which can be wrong
   * for variants like the 1M-context Opus build. The status bar's
   * context chip uses this for its progress denominator.
   */
  effectiveMaxContext?: number | undefined;
  /** Absolute project root for goal.json loading. */
  projectRoot?: string | undefined;

  /**
   * Terminal title animation on/off. Defaults to true. When false, the
   * OSC-0 window/tab title stays static (the app name only, no spinner).
   * Controlled via /settings → Terminal title animation.
   */
  titleAnimation?: boolean | undefined;
  /** Play terminal bell (\\x07) when agent run completes. */
  chime?: boolean | undefined;
  /** Show "confirm exit" message on first Ctrl+C instead of "exit". */
  confirmExit?: boolean | undefined;
  /** Active agent mode label shown in the status bar (e.g. "teach", "brief"). */
  modeLabel?: string | undefined;
  /** Live getter for the agent mode label so the status bar updates after /mode. */
  getModeLabel?: (() => string) | undefined;
  /**
   * Called ONCE on mount by the App to install its debug-stream telemetry
   * callback. The CLI wires this to setDebugStreamCallback() from
   * @wrongstack/providers. On App unmount, the default stderr callback
   * is restored.
   */
  registerDebugStreamCallback?: ((cb: (stats: {
    chunkCount: number;
    lastChunkSize: number;
    lastDeltaMs: number;
    totalBytes: number;
    lastChunkAt: string;
  }) => void) => void) | undefined;
  /** Called on App unmount — restores the default stderr debug-stream callback. */
  restoreDebugStreamCallback?: (() => void) | undefined;
  /** Called from /clear so the TUI can wipe its history entries while agent.ctx + memory are cleared separately. */
  onClearHistory?: ((
    dispatch: React.Dispatch<{ type: 'clearHistory' } | { type: 'resetContextChip' }>,
  ) => void) | undefined;

  // --- Fleet surface (director mode) ---

  /**
   * Live director instance. When set, the TUI renders a fleet panel
   * showing every spawned subagent, its current task, streaming output,
   * and runtime cost — updated live from the FleetBus. Pass null or omit
   * when multi-agent / director mode is disabled.
   */
  director?: Director | null | undefined;
  /**
   * Optional roster reference for resolving subagent role ids to
   * human-readable names. Same value passed to director.tools().
   */
  fleetRoster?: Record<string, { name: string }> | undefined;
  /**
   * Shared controller for the `/fleet stream on|off` toggle. The slash
   * command runs in the CLI process and needs to flip TUI reducer state;
   * the App installs a dispatch-backed `setEnabled` here on mount so
   * both sides stay synchronized.
   */
  /**
   * Shared controller for the `/fleet stream on|off` toggle. The slash
   * command runs in the CLI process and needs to flip TUI reducer state;
   * the App installs a dispatch-backed `setEnabled` here on mount so
   * both sides stay synchronized.
   */
  fleetStreamController?: {
    enabled: boolean;
    setEnabled: (enabled: boolean) => void;
  } | undefined;
  /**
   * Controller for the `/enhance on|off` prompt-refinement toggle. The App
   * installs a dispatch-backed `setEnabled` here on mount so the slash command
   * (run in the CLI process) flips the TUI's reducer flag. Mirrors
   * `fleetStreamController`.
   */
  enhanceController?: {
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
  } | undefined;

  /**
   * If set, the App boots straight into goal mode — the text is wrapped
   * in the GOAL preamble and submitted as the first turn. Lets users
   * launch directly from the shell:
   *   wstack --tui --director --goal "audit packages/core for races"
   * The chat shows a one-line "🎯 Goal locked: …" hint; the actual
   * preamble is hidden from the visible history (same as `/goal`).
   */
  initialGoal?: string | undefined;
  /**
   * If set, submitted as the first turn verbatim (no preamble). Mainly
   * for scripted shell aliases — `wstack --tui --ask "summarize foo.md"`
   * — that want one turn pre-populated without the goal-mode framing.
   * Ignored when `initialGoal` is also set.
   */
  initialAsk?: string | undefined;
  /**
   * Directory containing session JSONL files. Required for rewind
   * functionality. When provided the TUI can list checkpoints and
   * trigger a rewind via `/rewind` or Ctrl+R.
   */
  sessionsDir?: string | undefined;
  /**
   * SDD session context getter. When an SDD session is active, returns
   * the AI prompt context to inject into user messages.
   */
  getSDDContext?: (() => Promise<string | null>) | undefined;
  /**
   * Process AI output for SDD auto-detection (spec, tasks, plan).
   * Returns displayable status messages.
   */
  onSDDOutput?: ((output: string) => Promise<string[]>) | undefined;
  /**
   * Subscribe to AutoPhase phase/graph events from the PhaseOrchestrator.
   * Returns an unsubscribe function. The TUI uses this to drive the
   * PhaseMonitor and PhasePanel live views via dispatch actions.
   */
  subscribeAutoPhase?: ((handler: (event: string, payload: unknown) => void) => () => void) | undefined;
  /**
   * Read the persisted autonomy settings (defaultMode, autoProceedDelayMs).
   * Used by the SettingsPicker in the TUI on mount and after Ctrl+S toggle.
   */
  getSettings?: (() => import('./app-state.js').Settings) | undefined;
  /**
   * Persist settings changes. Returns null on success, or an
   * error string on failure (so the TUI can display it as a hint).
   */
  saveSettings?: ((s: import('./app-state.js').Settings) =>
    | string
    | null
    | Promise<string | null>) | undefined;
  /**
   * Predict likely next steps after a completed turn. The CLI wires this from
   * the session provider and the `/next` toggle; it returns [] when prediction
   * is disabled or autonomy isn't 'off'. Display-only — never executed.
   */
  predictNext?: ((input: {
    userRequest: string;
    assistantSummary: string;
  }) => Promise<string[]>) | undefined;
  /**
   * Called after each agent turn with the assistant's final output text.
   * The host parses "💡 Next steps" suggestions from the text and stores
   * them in the shared suggestion store so `/next 1`, `/next 1 2 3` work.
   */
  onSuggestionsParsed?: ((finalText: string) => void) | undefined;
}

// Bracketed paste mode wraps any pasted text with these markers, letting us
// distinguish a paste from typed input even when chunks arrive identically.
const BRACKETED_PASTE_ON = '\x1b[?2004h';
const BRACKETED_PASTE_OFF = '\x1b[?2004l';

export async function runTui(opts: RunTuiOptions): Promise<number> {
  const stdout = process.stdout;
  const stdin = process.stdin;

  // Ink requires a TTY on both stdin and stdout. Without this guard the
  // render call would fail with a terse internal Ink error; bail with a
  // clear message so a piped invocation (`echo hi | wstack --tui`) tells
  // the user what to do instead.
  if (!stdout.isTTY || !stdin.isTTY) {
    writeErr(
      'wstack: --tui requires an interactive terminal on both stdin and stdout.\n' +
        '       Drop the flag (use the plain REPL) or run wstack directly without piping.\n',
    );
    return 2;
  }

  stdout.write(BRACKETED_PASTE_ON);

  // Clear the VISIBLE screen (not scrollback) before Ink's first paint. The
  // REPL boot output (provider banner, Director roster, fleet paths, recovery
  // prompts) typically fills the terminal, so without this Ink mounts with its
  // live region (input + status bar) jammed against the bottom edge. The first
  // post-mount re-render — async git/fleet/goal state landing a frame later —
  // then grows/shifts that region by a row or two, the terminal scrolls, and
  // the top of the live region (the `›` input row + status-bar border) is
  // stranded permanently in scrollback (the "two prompts on launch" bug).
  // \x1b[2J scrolls the boot output up into native scrollback (still reachable
  // with the mouse wheel / Shift+PgUp), \x1b[H homes the cursor so Ink starts
  // from a clean top-of-screen with a full screen of headroom below it.
  stdout.write('\x1b[2J\x1b[H');

  const inkStdin: NodeJS.ReadStream = stdin;

  // Animated window/tab title: a braille spinner + live status (thinking /
  // running a tool) driven by the EventBus, scrolling the app name when idle.
  // Out-of-band OSC sequence, so it never touches Ink's render. Reset on
  // cleanup(). Disabled when WRONGSTACK_NO_TITLE=1 or titleAnimation is false.
  const stopTitle =
    opts.titleAnimation !== false
      ? startTerminalTitle({
          stdout,
          events: opts.events,
          model: opts.model,
          appName: opts.projectRoot ? path.basename(opts.projectRoot) : undefined,
        })
      : (() => {});

  // Take over EVERY keystroke. Raw mode (Ink turns this on when render
  // mounts) already disables ICANON/ECHO/ISIG/IXON on Linux+macOS, so
  // Ctrl+C/Z/\\/S/Q arrive as input bytes instead of generating
  // signals or being eaten by the terminal driver. Belt-and-suspenders:
  // install no-op handlers for the suspend/quit signals just in case
  // some shell or terminal still surfaces them — without these, a
  // stray Ctrl+Z could background the TUI mid-session.
  const swallowSignals: NodeJS.Signals[] = ['SIGTSTP', 'SIGQUIT', 'SIGTTIN', 'SIGTTOU'];
  const swallow = () => {};
  for (const s of swallowSignals) {
    try {
      process.on(s, swallow);
    } catch {
      // Signal not supported on this platform (Windows ignores most of
      // these). Safe to skip — there's nothing for the terminal to
      // deliver in the first place.
    }
  }

  // Track cleanup state so signal handlers don't double-disable.
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    try {
      stopTitle();
    } catch {
      // title controller already torn down — ignore.
    }
    try {
      stdout.write(BRACKETED_PASTE_OFF);
    } catch {
      // stdout may already be closed during shutdown — ignore.
    }
  };

  // If the process is killed externally (terminal closed, SIGTERM from a
  // supervisor) waitUntilExit's .then/.catch never runs. Register signal +
  // exit listeners so the terminal isn't left in bracketed-paste mode.
  const signals: NodeJS.Signals[] = ['SIGTERM', 'SIGHUP', 'SIGINT'];
  const signalHandler = () => cleanup();
  const exitHandler = () => cleanup();
  for (const s of signals) process.on(s, signalHandler);
  process.on('exit', exitHandler);

  const detachListeners = () => {
    for (const s of signals) process.off(s, signalHandler);
    for (const s of swallowSignals) {
      try {
        process.off(s, swallow);
      } catch {
        // ignore — see install site
      }
    }
    process.off('exit', exitHandler);
  };

  return new Promise<number>((resolve) => {
    let exitCode = 0;
    const onExit = (code: number) => {
      exitCode = code;
    };
    const settle = (code: number) => {
      cleanup();
      detachListeners();
      resolve(code);
    };

    let instance: ReturnType<typeof render>;
    try {
      instance = render(
        React.createElement(App, {
          agent: opts.agent,
          slashRegistry: opts.slashRegistry,
          attachments: opts.attachments,
          events: opts.events,
          tokenCounter: opts.tokenCounter,
          visionAdapters: opts.visionAdapters,
          supportsVision: opts.supportsVision,
          model: opts.model,
          banner: opts.banner ?? true,
          queueStore: opts.queueStore,
          yolo: opts.yolo,
          getYolo: opts.getYolo,
          getAutonomy: opts.getAutonomy,
          getEternalEngine: opts.getEternalEngine,
          getParallelEngine: opts.getParallelEngine,
          subscribeEternalIteration: opts.subscribeEternalIteration,
          subscribeEternalStage: opts.subscribeEternalStage,
          subscribeAutoPhase: opts.subscribeAutoPhase,
          appVersion: opts.appVersion,
          provider: opts.provider,
          family: opts.family,
          keyTail: opts.keyTail,
          getPickableProviders: opts.getPickableProviders,
          switchProviderAndModel: opts.switchProviderAndModel,
          switchAutonomy: opts.switchAutonomy,
          effectiveMaxContext: opts.effectiveMaxContext,
          onExit,
          director: opts.director ?? null,
          fleetRoster: opts.fleetRoster,
          onClearHistory: opts.onClearHistory
            ? (dispatch) => opts.onClearHistory?.(dispatch)
            : undefined,
          fleetStreamController: opts.fleetStreamController,
          enhanceController: opts.enhanceController,
          enhanceEnabled: opts.enhanceController?.enabled ?? true,
          statuslineHiddenItems: opts.statuslineHiddenItems,
          setStatuslineHiddenItems: opts.setStatuslineHiddenItems,
          agentsMonitorController: opts.agentsMonitorController,
          initialGoal: opts.initialGoal,
          initialAsk: opts.initialAsk,
          getSDDContext: opts.getSDDContext,
          onSDDOutput: opts.onSDDOutput,
          sessionsDir: opts.sessionsDir,
          projectRoot: opts.projectRoot,
          getSettings: opts.getSettings,
          saveSettings: opts.saveSettings,
          predictNext: opts.predictNext,
          onSuggestionsParsed: opts.onSuggestionsParsed,
          chime: opts.chime,
          confirmExit: opts.confirmExit,
          modeLabel: opts.modeLabel,
          getModeLabel: opts.getModeLabel,
          registerDebugStreamCallback: opts.registerDebugStreamCallback,
          restoreDebugStreamCallback: opts.restoreDebugStreamCallback,
        }),
        { exitOnCtrlC: false, stdin: inkStdin },
      );
    } catch (err) {
      writeErr(
        `wstack: TUI failed to start: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      settle(1);
      return;
    }
    // Terminal reflows visible text on resize BEFORE Ink can react, which can
    // leave ghosts below the cursor. Erase from-cursor-to-end on every resize
    // to minimize artifacts. Ink immediately re-renders at the new width.
    let detachResize: (() => void) | null = null;
    const onResize = () => {
      try {
        // \x1b[J = erase from cursor to end of screen. Does NOT touch
        // anything above the cursor, so committed Static history in
        // scrollback is preserved. Ink's useStdout subscriber will
        // immediately re-render the live region at the new width.
        // Do NOT prefix with \x1b[H: homing to (0,0) erases the visible
        // committed output and repositions the live region (input + status
        // bar) at the top of the viewport instead of the bottom.
        stdout.write('\x1b[J');
      } catch {
        // stdout might be detached mid-shutdown — ignore.
      }
    };
    stdout.on('resize', onResize);
    detachResize = () => stdout.off('resize', onResize);

    instance
      .waitUntilExit()
      .then(() => {
        detachResize?.();
        settle(exitCode);
      })
      .catch(() => {
        detachResize?.();
        settle(1);
      });
  });
}
