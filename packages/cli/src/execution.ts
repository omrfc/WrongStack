/**
 * Execution phase — single-shot, TUI, REPL, and WebUI dispatch.
 * Extracted from index.ts so the main() function focuses on
 * boot + wiring; this file owns the three run modes and cleanup.
 */
import * as path from 'node:path';
import {
  type Agent,
  type AttachmentStore,
  type CoordinatorEvent,
  type ChimeraReviewNeededPayload,
  type Config,
  type ConfigStore,
  type Director,
  type EventBus,
  type GlobalMailbox,
  type MemoryStore,
  type ModelsRegistry,
  type ModeStore,
  type ProviderConfig,
  RecoveryLock,
  type ResolvedProvider,
  type SessionStore,
  type SessionWriter,
  type SlashCommandRegistry,
  type SubagentConfig,
  type TokenCounter,
  normalizeTokenSavingTier,
  type TokenSavingTier,
  type WstackPaths,
} from '@wrongstack/core';
import {
  type AutonomyStage,
  attachTodosCheckpoint,
  CHIMERA_REVIEW_PROMPT,
  color,
  mergeCustomModelDefs,
  setQueuedMessagesSnapshot,
} from '@wrongstack/core';
import type { MCPRegistry } from '@wrongstack/mcp';
import { capabilitiesFor } from '@wrongstack/providers';
import { createToolVisionAdapters } from '@wrongstack/runtime/vision';
import { FleetStatusLine } from './fleet-statusline.js';
import { runWebUIDispatch } from './boot/dispatch-webui.js';
import { runSingleShotDispatch } from './boot/dispatch-singleshot.js';
import { wireAutoPhase } from './boot/tui-autophase-wiring.js';
import { handleProjectSwitchSpawn } from './boot/tui-project-spawn.js';
import { setupAutonomousCoordinator } from './boot/tui-coordinator-setup.js';
import { switchProjectInPlace as switchProjectInPlaceExtracted, type ProjectSwitchContext } from './boot/tui-project-switch.js';
import { createSettingsAdapter } from './boot/tui-settings-adapter.js';
import type { TuiRuntimeState } from './boot/tui-runtime-state.js';
import type { ReadlineInputReader } from './input-reader.js';
import { type PredictLLMProvider, predictNextTasks } from './next-task-predictor.js';
import type { TerminalRenderer } from './renderer.js';
import { parseSuggestionsFromOutput, runRepl } from './repl.js';
import type { SessionStats } from './session-stats.js';
import { resolveActiveApiKey } from './provider-config-utils.js';
import { setSuggestions } from './slash-commands/suggestion-store.js';
import { CLI_VERSION } from './version.js';

/**
 * Settings payload shared by `saveSettings` (persist) and `applyLiveSettings`
 * (apply to the running session). Mirrors the fields the TUI `/settings` picker
 * cycles with ←/→.
 */
export interface LiveSettingsInput {
  mode: 'off' | 'suggest' | 'auto';
  delayMs: number;
  titleAnimation?: boolean | undefined;
  yolo?: boolean | undefined;
  streamFleet?: boolean | undefined;
  chime?: boolean | undefined;
  confirmExit?: boolean | undefined;
  nextPrediction?: boolean | undefined;
  featureMcp?: boolean | undefined;
  featurePlugins?: boolean | undefined;
  featureMemory?: boolean | undefined;
  featureSkills?: boolean | undefined;
  featureModelsRegistry?: boolean | undefined;
  featureTokenSaving?: TokenSavingTier | undefined;
  allowOutsideProjectRoot?: boolean | undefined;
  contextAutoCompact?: boolean | undefined;
  contextStrategy?: string | undefined;
  logLevel?: string | undefined;
  auditLevel?: string | undefined;
  indexOnStart?: boolean | undefined;
  maxIterations?: number | undefined;
  autoProceedMaxIterations?: number | undefined;
  /** When true, file tools are confined to the project root. Default false. */
  restrictFsToRoot?: boolean | undefined;
  debugStream?: boolean | undefined;
  configScope?: 'global' | 'project' | undefined;
  enhanceDelayMs?: number | undefined;
  enhanceEnabled?: boolean | undefined;
  enhanceLanguage?: string | undefined;
  mouseMode?: boolean | undefined;
  autonomyNextPrompt?: string | undefined;
  /** Whether the process circuit breaker gates bash/exec. Default false. */
  breakerEnabled?: boolean | undefined;
  /** Auto kill/reset delay (ms) when the breaker trips. 0 = manual recovery. */
  breakerAutoKillResetMs?: number | undefined;
  /** TUI statusline density. Defaults to detailed when unset. */
  statuslineMode?: 'minimum' | 'detailed' | undefined;
}

export interface ExecutionDeps {
  agent: Agent;
  events: EventBus;
  slashRegistry: SlashCommandRegistry;
  attachments: AttachmentStore;
  tokenCounter: TokenCounter;
  config: Config;
  /** Live config store — used to read/persist `/settings` values from the TUI. */
  configStore: ConfigStore;
  renderer: TerminalRenderer;
  reader: ReadlineInputReader;
  session: SessionWriter;
  mcpRegistry: MCPRegistry;
  recoveryLock: RecoveryLock;
  wpaths: WstackPaths;
  modelsRegistry: ModelsRegistry;
  projectRoot: string;
  flags: Record<string, string | boolean>;
  positional: string[];
  effectiveMaxContext: number;
  queueStore: import('@wrongstack/core').QueueStore;
  context: import('@wrongstack/core').Context;
  /**
   * Project-scoped mailbox (mailbox-bus) that lives across all sessions
   * for this project. The AutonomousCoordinator subscribes to it so
   * goals/tasks/knowledge are visible to every terminal in the project.
   */
  mailbox: GlobalMailbox;
  stats: SessionStats;
  detachTodosCheckpoint?: (() => void | Promise<void>) | undefined;
  savedProviderCfg: ProviderConfig | undefined;
  resolvedProvider: ResolvedProvider | undefined;
  getPickableProviders: () => Promise<Array<{ id: string; family: string; models: string[] }>>;
  switchProviderAndModel: (providerId: string, modelId: string) => string | null;
  /** Initial director snapshot for the TUI fleet panel. Null when director mode is off. */
  director: Director | null;
  /** Read the current director; unlike `director`, this sees lazy promotion after startup. */
  getDirector?: (() => Director | null) | undefined;
  /** Mutable holder for coordinator callbacks — filled by execute() when coordinator is created. */
  coordinatorController?: Record<string, unknown> | undefined;
  /** Fleet roster for human-readable subagent names. */
  fleetRoster?: Record<string, { name: string }>;
  /**
   * Shared controller object for the `/fleet stream on|off` toggle. The
   * TUI installs a dispatch-backed setter on mount; the slash command
   * reads/writes via this object so both surfaces stay synchronized.
   */
  fleetStreamController?: {
    enabled: boolean;
    setEnabled: (enabled: boolean) => void;
  };
  /** Shared controller for the `/interrupt` slash command (leader abort). The
   *  TUI rebinds `abortLeader` on mount; the REPL installs its own. */
  interruptController?: {
    abortLeader: () => boolean;
  };
  /** Shared controller for the `/enhance on|off` prompt-refinement toggle. */
  enhanceController?: {
    enabled: boolean;
    setEnabled: (enabled: boolean) => void;
  };
  /** Status bar hidden items controller (passed to TUI). */
  statuslineHiddenItems: Array<
    'todos' | 'plan' | 'tasks' | 'fleet' | 'git' | 'elapsed' | 'context' | 'cost' | 'working_dir'
  >;
  setStatuslineHiddenItems: (
    items: Array<
      'todos' | 'plan' | 'tasks' | 'fleet' | 'git' | 'elapsed' | 'context' | 'cost' | 'working_dir'
    >,
  ) => void;
  /** Atomically updates in-memory state AND persists statusline hidden items. */
  saveStatuslineHiddenItems: (
    items: Array<
      'todos' | 'plan' | 'tasks' | 'fleet' | 'git' | 'elapsed' | 'context' | 'cost' | 'working_dir'
    >,
  ) => Promise<void>;
  /** Agents monitor overlay controller (passed to TUI). */
  agentsMonitorController?: {
    visible: boolean;
    setVisible: (visible: boolean) => void;
  };
  /**
   * Mutable ref for opening TUI panels from slash commands. The slash commands
   * call `onPanelOpen.current(action)` to open panels. The TUI sets
   * `onPanelOpen.current` to its actual dispatch function on mount.
   */
  onPanelOpen?: { current: ((action: string) => boolean) | null } | undefined;
  /** Query the live YOLO state from the permission policy. */
  getYolo?: (() => boolean) | undefined;
  /** Query the live autonomy mode. */
  getAutonomy?: (() => import('./slash-commands/autonomy.js').AutonomyMode) | undefined;
  /** Set autonomy mode (used by SIGINT handler to flip back to 'off'). */
  onAutonomy?: ((mode: import('./slash-commands/autonomy.js').AutonomyMode) => void) | undefined;
  /** Whether next-task prediction is enabled (toggled via /next). */
  getNextPredict?: (() => boolean) | undefined;
  /**
   * Apply `/settings` changes to the RUNNING session (not just persist them).
   * Called by `saveSettings` after the config is written. The host (cli-main)
   * wires each field to its live runtime setter — policy.setYolo, onNextPredict,
   * enhanceController, agent.maxIterations, the logger level, the session
   * bridge's audit level, and the auto-compactor's on/off gate. Boot-only
   * settings (MCP/plugins/skills/etc.) are intentionally not applied here.
   */
  applyLiveSettings?: ((s: LiveSettingsInput) => void) | undefined;
  /** Receive suggestions parsed from the assistant turn (null clears them). */
  onSuggestionsParsed?: ((suggestions: string[] | null) => void) | undefined;
  /** Read current suggestions (for auto-proceed in 'auto' autonomy mode). */
  getSuggestions?: (() => string[]) | undefined;
  /** Read current auto suggestions (items with auto="true" attribute). Used by YOLO+auto autonomy. */
  getAutoSuggestions?: (() => string[]) | undefined;
  /** Autonomy next prompt template for YOLO+auto mode. Contains {{suggestion}} placeholder. */
  autonomyNextPrompt?: string | undefined;
  /** Delay before auto-proceeding with a suggestion in 'auto' mode (ms). */
  autoProceedDelayMs?: number | undefined;
  /** Maximum auto-proceed iterations before stopping. Default 50. 0 = unlimited. */
  autoProceedMaxIterations?: number | undefined;
  /** Host Brain arbiter (same instance bound at TOKENS.BrainArbiter). */
  brain?: import('@wrongstack/core').BrainArbiter | undefined;
  /** Host brain settings — the SAME object /brain mutates (shared ceiling). */
  brainSettings?: { maxAutoRisk: import('@wrongstack/core').BrainAutoRisk } | undefined;
  /** Read the host's rolling brain decision log (newest last, ≤20 entries). */
  getBrainLog?:
    | (() => Array<{ at: number; kind: string; question: string; outcome: string }>)
    | undefined;
  /**
   * LLM validation gate called before starting the auto-proceed countdown.
   * Receives the top suggestion and the last agent output; returns `true`
   * when auto-proceeding is safe. Forwarded verbatim to the REPL.
   */
  onValidateAutoProceed?:
    | ((suggestion: string, lastOutput: string) => Promise<boolean>)
    | undefined;
  /**
   * Access the (possibly null) eternal-autonomy engine. The REPL drives
   * `runOneIteration()` from its main loop when autonomy is 'eternal'.
   */
  getEternalEngine?: (() => import('@wrongstack/core').EternalAutonomyEngine | null) | undefined;
  /**
   * Access the (possibly null) parallel-eternal engine. The REPL drives
   * `runOneIteration()` from its main loop when autonomy is 'eternal-parallel'.
   */
  getParallelEngine?: (() => import('@wrongstack/core').ParallelEternalEngine | null) | undefined;
  /**
   * Subscribe to live per-iteration events from the eternal engine.
   * Returns an unsubscribe function. The TUI uses this to render each
   * iteration as a live event entry instead of polling goal.json after
   * the fact. REPL doesn't need it (drives iterations sequentially).
   */
  subscribeEternalIteration?: (
    fn: (entry: import('@wrongstack/core').JournalEntry) => void,
  ) => () => void;
  /**
   * Subscribe to per-iteration stage transitions from the autonomy engines.
   * Returns an unsubscribe function. TUI uses this to render live status
   * (decide/execute/reflect or decompose/fanout/aggregate) in the status bar.
   */
  subscribeEternalStage?: ((fn: (stage: AutonomyStage) => void) => () => void) | undefined;
  /**
   * Called every second during the auto-proceed countdown with the
   * remaining seconds. Return true to abort the countdown and switch
   * to manual mode.
   */
  onCountdownTick?: ((remainingSeconds: number) => boolean | void) | undefined;
  /** Skill loader for the skill generator wizard. */
  skillLoader?: import('@wrongstack/core').SkillLoader | undefined;
  /** Active agent mode id shown in the status bar (e.g. "teach", "brief"). */
  modeId?: string | undefined;
  /** Session store — used by WebUI for session.resume, session.delete, sessions.list. */
  sessionStore?: SessionStore | undefined;
  /** Memory store — used by WebUI for the MemoryPanel. */
  memoryStore?: MemoryStore | undefined;
  /** Mode store — used by WebUI for the ModePicker panel. */
  modeStore?: ModeStore | undefined;
  /**
   * Messages restored from a previous session resume. When non-empty, the
   * TUI renders the prior conversation as visible history entries.
   */
  restoredMessages?: import('@wrongstack/core').Message[] | undefined;
  /**
   * Tool execution records from a previous session (tool_call_end JSONL
   * events). Used by the TUI to render tool entries on resume.
   */
  restoredToolCalls?:
    | Array<{
        name: string;
        id: string;
        durationMs: number;
        ok: boolean;
        outputBytes?: number | undefined;
        outputTokens?: number | undefined;
        outputLines?: number | undefined;
      }>
    | undefined;
  /** When true, the WebUI shows a provider/model setup screen instead of the chat. */
  needsSetup?: boolean | undefined;
  /** Called when the REPL shuts down — use to clean up event listeners etc. */
  onDestroy?: (() => void) | undefined;
  /** Called in the execute() finally block to stop the AutonomousCoordinator cleanly. */
  onCoordinatorStop?: (() => void) | undefined;
}

export async function execute(deps: ExecutionDeps): Promise<number> {
  const {
    agent,
    events,
    slashRegistry,
    attachments,
    tokenCounter,
    config,
    configStore,
    renderer,
    reader,
    session,
    mcpRegistry,
    recoveryLock: initialRecoveryLock,
    wpaths: initialWpaths,
    modelsRegistry,
    projectRoot: initialProjectRoot,
    flags,
    positional,
    effectiveMaxContext,
    queueStore,
    context,
    mailbox,
    stats,
    detachTodosCheckpoint,
    savedProviderCfg,
    resolvedProvider,
    getPickableProviders,
    switchProviderAndModel,
    director,
    getDirector,
    coordinatorController,
    fleetRoster,
    fleetStreamController,
    interruptController,
    enhanceController,
    statuslineHiddenItems,
    setStatuslineHiddenItems,
    saveStatuslineHiddenItems,
    agentsMonitorController,
    onPanelOpen,
    getYolo,
    getAutonomy,
    onAutonomy,
    getNextPredict,
    onSuggestionsParsed,
    getSuggestions,
    getAutoSuggestions,
    autonomyNextPrompt,
    autoProceedDelayMs,
    autoProceedMaxIterations,
    brain,
    brainSettings,
    getBrainLog,
    onValidateAutoProceed,
    getEternalEngine,
    getParallelEngine,
    subscribeEternalIteration,
    subscribeEternalStage,
    skillLoader,
    modeId,
    sessionStore,
    memoryStore,
    modeStore,
    restoredMessages,
    restoredToolCalls,
    needsSetup,
  } = deps;

  let wpaths = initialWpaths;
  let projectRoot = initialProjectRoot;
  let activeSessionStore = sessionStore;
  let activeRecoveryLock = initialRecoveryLock;
  let detachActiveTodosCheckpoint: (() => void | Promise<void>) | undefined = detachTodosCheckpoint;

  // ── Storage observability: relay storage.* events to stdout as structured JSON ──
  // The root traceId from the Context is the primary correlation ID. Storage
  // events emitted by FileSessionWriter (flush, close) carry their own traceId
  // (propagated from ContextInit) which we also included; events from the
  // DefaultSessionStore level (load, summary, compact) inherit it from context.
  const rootTraceId = context.traceId;
  const storageLog = (event: string, payload: Record<string, unknown>) => {
    // Merge: prefer the storage-event-level traceId (from FileSessionWriter) over
    // the root traceId when both are present, so Fleet/spans are precisely keyed.
    const traceId = (payload.traceId as string | undefined) ?? rootTraceId;
    // eslint-disable-next-line no-console
    console.warn(JSON.stringify({
      level: 'info',
      event,
      timestamp: new Date().toISOString(),
      traceId,
      ...payload,
    }));
  };
  const onStorageRead = (...args: unknown[]) => storageLog('storage.read', args[0] as Record<string, unknown>);
  const onStorageWrite = (...args: unknown[]) => storageLog('storage.write', args[0] as Record<string, unknown>);
  const onStorageError = (...args: unknown[]) => storageLog('storage.error', args[0] as Record<string, unknown>);
  events.on('storage.read', onStorageRead);
  events.on('storage.write', onStorageWrite);
  events.on('storage.error', onStorageError);

  // Tracks the in-flight chimera subagent so finally can await it before session.close().
  // Without this, the fire-and-forget IIFE appends to a session whose handle is already closed.
  let pendingChimeraWork: Promise<void> | undefined;

  // ── Chimera post-session review: spawns subagent on chimera.review_needed ──
  events.onPattern('chimera.review_needed', (_event, payload) => {
    const p = payload as ChimeraReviewNeededPayload;
    const dir = director;
    if (!dir) {
      // Director not active — review skipped. Chimera needs --director flag.
      return;
    }
    if (p.files.length === 0) return;

    // Store the promise so the finally block can await it before session.close().
    // events.emit('session.ended') fires synchronously, so this assignment
    // happens before the finally block checks pendingChimeraWork.
    pendingChimeraWork = (async () => {
      try {
        const fileList = p.files.map((f) => `- [${f.status.toUpperCase()}] ${f.path}`).join('\n');

        const taskDesc = [
          `Review the following ${p.files.length} file(s) changed in this session at ${p.cwd}.`,
          '',
          fileList,
          '',
          '---',
          '',
          'Read each file using the read tool. Check for bugs, type issues,',
          'security problems, and produce a structured review report.',
        ].join('\n');

        const cfg: SubagentConfig = {
          name: 'chimera-review',
          provider: p.config.provider,
          model: p.config.model,
          systemPromptOverride: CHIMERA_REVIEW_PROMPT,
          maxIterations: 10,
          maxToolCalls: 60,
          timeoutMs: 300_000,
        };

        const subagentId = await dir.spawn(cfg);
        const { randomUUID } = await import('node:crypto');
        const taskId = randomUUID();
        await dir.assign({
          id: taskId,
          description: taskDesc,
          subagentId,
        });

        const results = await dir.awaitTasks([taskId]);
        const result = results[0];
        if (result?.status !== 'success') {
          try {
            await session.append({
              type: 'error',
              ts: new Date().toISOString(),
              message: `🦂 Chimera review subagent ${result?.status ?? 'unknown'}: ${result?.error?.message ?? 'no result'}`,
              phase: 'agent',
            });
          } catch (err) {
            console.error(
              JSON.stringify({
                level: 'error',
                event: 'execution.chimera_append_failed',
                message: err instanceof Error ? err.message : String(err),
                timestamp: new Date().toISOString(),
              }),
            );
          }
          return;
        }

        const reviewText =
          typeof result.result === 'string' ? result.result.trim() : JSON.stringify(result.result);

        if (reviewText) {
          await session.append({
            type: 'llm_response',
            ts: new Date().toISOString(),
            content: [{ type: 'text', text: reviewText }],
            stopReason: 'end_turn' as import('@wrongstack/core').StopReason,
            usage: { input: 0, output: 0 },
          });
        }
      } catch (err) {
        // Subagent spawn/assign failed — log and ignore
        try {
          await session.append({
            type: 'error',
            ts: new Date().toISOString(),
            message: `🦂 Chimera review failed: ${err instanceof Error ? err.message : String(err)}`,
            phase: 'agent',
          });
        } catch (appendErr) {
          console.error(
            JSON.stringify({
              level: 'error',
              event: 'execution.chimera_review_append_failed',
              message: appendErr instanceof Error ? appendErr.message : String(appendErr),
              timestamp: new Date().toISOString(),
            }),
          );
        }
      }
    })();
  });

  let code = 0;
  let fleetStatusLine: FleetStatusLine | null = null;
  try {
    const visionAdapters = () => createToolVisionAdapters(agent.tools);
    const supportsVision = async (): Promise<boolean> => {
      try {
        const providerConfig = config.providers?.[context.provider.id];
        const mergedModels = mergeCustomModelDefs(providerConfig?.customModels, config.models);
        const caps = await capabilitiesFor(
          modelsRegistry,
          context.provider.id,
          context.model,
          mergedModels,
        );
        return caps.vision;
      } catch {
        return context.provider.capabilities.vision;
      }
    };
    // --prompt flag takes precedence: treat it like a positional query
    const promptFlag = typeof flags['prompt'] === 'string' ? flags['prompt'] : undefined;
    if (promptFlag) {
      positional.unshift(promptFlag);
    }
    // --goal / --ask boot directly into the TUI in goal/ask mode. The TUI is
    // the only surface with the steering + fleet panel + Esc-redirect wiring
    // that goal mode depends on, so if the user passed a goal but forgot
    // --tui, we flip --tui on for them. Single-shot positional invocation
    // still wins: `wstack --goal X "literal prompt"` runs the positional as
    // a normal single-shot (positional is non-empty), which is consistent
    // with --prompt's existing semantics.
    const goalFlag = typeof flags['goal'] === 'string' ? flags['goal'] : undefined;
    const askFlag = typeof flags['ask'] === 'string' ? flags['ask'] : undefined;
    if ((goalFlag || askFlag) && positional.length === 0 && !promptFlag) {
      flags.tui = true;
    }
    // Live fleet status line for the plain terminal. The TUI owns its own
    // per-agent surface (and Ink owns stdout), so only run this on the
    // non-TUI paths: single-shot, plain REPL, and webui-backed REPL.
    const enteringTui =
      !(positional.length > 0 || promptFlag) && !!flags.tui && flags['no-tui'] !== true;
    if (!enteringTui) {
      fleetStatusLine = new FleetStatusLine({ events, version: CLI_VERSION });
      fleetStatusLine.start();
    }
    if (positional.length > 0 || promptFlag) {
      code = await runSingleShotDispatch({
        agent,
        query: positional.join(' '),
        flags,
        tokenCounter,
        renderer,
      });
    } else if (flags.tui && !flags['no-tui'] && !flags.webui) {
      // --webui takes precedence over the TUI: both want exclusive ownership of
      // stdout, and the webui branch (below) runs the REPL + browser server. The
      // `!flags.webui` guard ensures a stray --tui (or a default) can't shadow it.
      // Switch from inline CLI prompts to event-driven confirmation.
      // Without this, the permission prompt writes to stdout and blocks
      // on stdin — both owned by Ink — making the prompt invisible and
      // the input deadlocked. After this call, tool.confirm_needed events
      // fire instead, which the TUI's ConfirmPrompt component handles.
      agent.disableInteractiveConfirmation();
      const { runTui } = (await import('@wrongstack/tui')) as {
        runTui: (opts: import('@wrongstack/tui').RunTuiOptions) => Promise<number>;
      };
      renderer.setSilent(true);

      // Shared mutable runtime state for extracted TUI sub-modules.
      // Phase B modules (coordinator setup, project switch) mutate these
      // fields through the shared object rather than closure capture.
      const state: TuiRuntimeState = {
        projectRoot,
        wpaths,
        activeSessionStore,
        activeRecoveryLock,
        detachActiveTodosCheckpoint,
        pendingProjectSwitch: null,
        autonomousCoordinator: null,
        coordinatorRun: null,
        coordinatorEvents: new Set(),
      };

      const banneredFamily = savedProviderCfg?.family ?? resolvedProvider?.family;
      const banneredKey =
        (savedProviderCfg ? resolveActiveApiKey(savedProviderCfg) : undefined) ??
        config.apiKey ??
        (resolvedProvider?.envVars ?? savedProviderCfg?.envVars ?? [])
          .map((v) => process.env[v])
          .find((v): v is string => !!v);
      // Last 3 chars of the active API key — shown in the TUI startup banner
      // so the operator can visually confirm which key is being used (e.g. "...abc").
      // Only 3 chars are shown: meaningful for key-pick verification, meaningless
      // for an attacker without the full key. The full key is never displayed or logged.
      // This is low risk but intentionally documented here so the design is clear.
      const banneredKeyTail =
        banneredKey && banneredKey.length >= 3 ? banneredKey.slice(-3) : undefined;

      // AutoPhase event forwarding — subscribes to PhaseOrchestrator events
      // on the main EventBus and forwards them to the TUI handler so the
      // PhaseMonitor/PhasePanel stay in sync with the running graph.
      const autoPhaseWiring = wireAutoPhase(events);
      const subscribeAutoPhase = autoPhaseWiring.subscribe;

      // Special exit code for project switch — triggers a clean wstack restart
      // in the target project directory after the TUI unmounts.
      // (Imported from boot/tui-project-spawn.ts — the spawn logic lives there.)

      // Stores the pending project switch info set by onProjectSelect (F1
      // picker) or onSwitchToSession (F10 sessions panel). Checked after
      // runTui returns PROJECT_SWITCH_EXIT_CODE to spawn the new wstack
      // process. `resumeSessionId` makes the new instance resume that
      // session (`--resume <id>`) instead of starting fresh.
      // (Lives on `state.pendingProjectSwitch` — set by TUI callbacks, read by handleProjectSwitchSpawn.)

      // ── AutonomousCoordinator: project-level multi-session coordination ─────────
      // The coordinator tracks goals, tasks, knowledge, and consensus across all
      // active sessions in the same project. Initialized lazily when the Director
      // becomes available so we have access to director.fleet for cross-session events.
      const coordinatorEvents = new Set<(event: CoordinatorEvent) => void>();
      state.coordinatorEvents = coordinatorEvents;
      const coordinatorSetup = setupAutonomousCoordinator({
        state,
        events,
        context,
        wpaths,
        mailbox,
        director,
        getDirector,
        coordinatorController,
        onCoordinatorStopSetter: (fn) => { deps.onCoordinatorStop = fn ?? undefined; },
      });
      const ensureAutonomousCoordinator = coordinatorSetup.ensure;
      const offDirectorSpawned = coordinatorSetup.cleanup;

      const switchCtx: ProjectSwitchContext = {
        state,
        context,
        events,
        agent,
        config,
        tokenCounter,
        modeId,
        modeStore,
        memoryStore,
        skillLoader,
        attachTodosCheckpoint,
      };
      const switchProjectInPlace = (targetRoot: string, displayName: string) =>
        switchProjectInPlaceExtracted(switchCtx, targetRoot, displayName);

      try {
        code = await runTui({
          agent,
          events,
          slashRegistry,
          attachments,
          tokenCounter,
          visionAdapters,
          supportsVision,
          model: context.model,
          banner: !flags['no-banner'],
          queueStore,
          // Queue awareness: mirror the TUI's pending-message queue onto the
          // live Context so the agent loop can surface "messages are waiting"
          // at its next iteration boundary (see core/queued-messages.ts).
          onQueueChange: (items: string[]) => {
            setQueuedMessagesSnapshot(context, items);
          },
          // --mouse forces full mouse mode on; when absent, leave undefined so
          // run-tui can still enable it from the saved setting / WRONGSTACK_MOUSE.
          mouse: flags.mouse ? true : undefined,
          yolo: !!config.yolo,
          getYolo,
          getAutonomy,
          // Next-task prediction (/next). Host owns the gating: returns [] when
          // the toggle is off or autonomy is self-driving, so the TUI can call
          // this unconditionally after a done turn. Display-only.
          predictNext: async (input: { userRequest: string; assistantSummary: string }) => {
            if (!getNextPredict?.()) return [];
            if ((getAutonomy?.() ?? 'off') !== 'off') return [];
            return predictNextTasks(
              { ...input, todos: context.todos },
              {
                provider: context.provider as unknown as PredictLLMProvider,
                model: context.model,
              },
            );
          },
          // Parse 💡 Next steps from assistant output and store them in the
          // shared suggestion store so `/next 1`, `/next 1 2 3` work without
          // requiring `/suggest` first. Called unconditionally on every done turn.
          onSuggestionsParsed: (finalText: string) => {
            const parsed = parseSuggestionsFromOutput(finalText);
            setSuggestions(parsed ?? []);
          },
          // Retrieve current suggestions for next-steps auto-submit countdown.
          getSuggestions: () => getSuggestions?.() ?? [],
          // Store parsed next steps so the /next command and auto-submit countdown
          // can access them (entry.tsx parses from rendered messages).
          setSuggestions,
          getEternalEngine,
          subscribeEternalIteration,
          subscribeEternalStage,
          subscribeAutoPhase,
          appVersion: CLI_VERSION,
          provider: config.provider,
          family: banneredFamily,
          keyTail: banneredKeyTail,
          getPickableProviders,
          switchProviderAndModel,
          switchAutonomy: (mode: 'off' | 'suggest' | 'auto' | 'eternal' | 'eternal-parallel') => {
            onAutonomy?.(mode);
            return null;
          },
          ...createSettingsAdapter({
            configStore,
            wpaths,
            fleetStreamController,
            applyLiveSettings: deps.applyLiveSettings,
          }),
          effectiveMaxContext,
          // Terminal title animation: read from config (default on).
          titleAnimation:
            ((config.autonomy as Record<string, unknown> | undefined)?.[
              'terminalTitleAnimation'
            ] as boolean) ?? true,
          // Completion chime: terminal bell when agent finishes.
          chime:
            ((config.autonomy as Record<string, unknown> | undefined)?.['chime'] as boolean) ??
            false,
          // Normal exit.
          confirmExit:
            ((config.autonomy as Record<string, unknown> | undefined)?.[
              'confirmExit'
            ] as boolean) ?? true,
          director,
          fleetRoster,
          // ── AutonomousCoordinator: project-level multi-session coordination ─────────
          // The coordinator tracks goals, tasks, knowledge, and consensus across all
          // active sessions in the same project. It runs independently of the leader
          // agent and is accessible to any session in the project via the GlobalMailbox.
          getAutonomousCoordinator: () => ensureAutonomousCoordinator(),
          subscribeCoordinatorEvents: (fn: (event: CoordinatorEvent) => void) => {
            coordinatorEvents.add(fn);
            return () => { coordinatorEvents.delete(fn); };
          },
          onCoordinatorStart: (goal?: string) => {
            const coordinator = ensureAutonomousCoordinator();
            if (!coordinator) {
              console.error('[coordinator] not ready — no director available');
              return;
            }
            if (state.coordinatorRun) return;
            state.coordinatorRun = coordinator.run({ goal: goal ?? 'Improve the codebase', runUntilComplete: true })
              .then(() => undefined)
              .catch((err) => {
                console.error('[coordinator] run() failed:', err);
              })
              .finally(() => {
                state.coordinatorRun = null;
              });
          },
          onCoordinatorStop: () => {
            state.autonomousCoordinator?.stop();
          },
          onCoordinatorTasks: async () => {
            const coordinator = ensureAutonomousCoordinator();
            if (!coordinator) return null;
            await coordinator.graph.load();
            return coordinator.auction
              .getPendingTasks()
              .map((task) => ({
                id: task.id,
                title: task.title,
                priority: task.priority,
                tags: task.tags,
              }));
          },
          onCoordinatorClaim: async (taskId: string) => {
            const coordinator = ensureAutonomousCoordinator();
            if (!coordinator) return 'No coordinator is active.';
            await coordinator.graph.load();
            const goal = coordinator.graph.get(taskId) as
              | import('@wrongstack/core').GoalNode
              | undefined;
            if (goal?.type !== 'goal') {
              return `Task ${taskId.slice(0, 8)} not found in the coordinator graph.`;
            }
            if (goal.status !== 'pending') {
              return `Task ${taskId.slice(0, 8)} is ${goal.status}, not claimable.`;
            }
            const ok = await coordinator.auction.claim(
              taskId,
              `terminal@${context.session.id ?? 'unknown'}`,
              'Terminal worker',
            );
            if (!ok) {
              return `Task ${taskId.slice(0, 8)} could not be claimed (status changed?).`;
            }
            return { description: goal.description };
          },
          onCoordinatorComplete: async (taskId: string, result?: string) => {
            const coordinator = ensureAutonomousCoordinator();
            if (!coordinator) return 'No coordinator is active.';
            await coordinator.graph.load();
            const goal = coordinator.graph.get(taskId) as
              | import('@wrongstack/core').GoalNode
              | undefined;
            if (goal?.type !== 'goal') {
              return `Task ${taskId.slice(0, 8)} not found in the coordinator graph.`;
            }
            if (goal.status !== 'in_progress') {
              return `Task ${taskId.slice(0, 8)} is ${goal.status}, cannot complete.`;
            }
            await coordinator.reportTaskCompletion(taskId, result ?? 'Terminal worker completed the task');
            return null;
          },
          onCoordinatorFail: async (taskId: string, error: string) => {
            const coordinator = ensureAutonomousCoordinator();
            if (!coordinator) return 'No coordinator is active.';
            await coordinator.graph.load();
            const goal = coordinator.graph.get(taskId) as
              | import('@wrongstack/core').GoalNode
              | undefined;
            if (goal?.type !== 'goal') {
              return `Task ${taskId.slice(0, 8)} not found in the coordinator graph.`;
            }
            if (goal.status !== 'in_progress') {
              return `Task ${taskId.slice(0, 8)} is ${goal.status}, cannot fail.`;
            }
            await coordinator.reportTaskFailure(taskId, error);
            return null;
          },
          onCoordinatorStatus: async () => {
            const coordinator = ensureAutonomousCoordinator();
            if (!coordinator) return null;
            await coordinator.syncFromGraph();
            const stats = coordinator.getStats();
            return {
              goals: {
                total: stats.goals.total,
                done: stats.goals.done,
                pending: stats.goals.pending,
                failed: stats.goals.failed,
              },
              dag: {
                running: stats.dag.running,
                ready: stats.dag.ready,
                done: stats.dag.done,
                failed: stats.dag.failed,
              },
              auction: {
                pending: stats.auction.pending,
                inProgress: stats.auction.in_progress,
              },
            };
          },
          // /clear: signal the TUI to wipe entries and reset fleet/leader stats
          // AND bump the context chip version — so the display reflects a
          // completely fresh session after the backend has been cleared.
          onClearHistory: (
            dispatch: (
              action:
                | { type: 'clearHistory' }
                | { type: 'resetContextChip' }
                | { type: 'streamReset' }
                | { type: 'toolStreamClear' },
            ) => void,
          ) => {
            dispatch({ type: 'clearHistory' });
            dispatch({ type: 'resetContextChip' });
            dispatch({ type: 'streamReset' });
            dispatch({ type: 'toolStreamClear' });
          },
          fleetStreamController,
          interruptController,
          enhanceController,
          statuslineHiddenItems,
          setStatuslineHiddenItems,
          saveStatuslineHiddenItems,
          agentsMonitorController,
          getLiveSessions: async () => {
            const { SessionRegistry } = await import('@wrongstack/core');
            const globalRoot = path.dirname(wpaths.globalConfig);
            const registry = new SessionRegistry(globalRoot);
            const sessions = await registry.list();
            return sessions
              .filter((s) => s.status !== 'stale')
              .map((s) => ({
                sessionId: s.sessionId,
                projectName: s.projectName,
                projectSlug: s.projectSlug,
                projectRoot: s.projectRoot,
                workingDir: s.workingDir,
                gitBranch: s.gitBranch,
                status: s.status,
                pid: s.pid,
                startedAt: s.startedAt,
                agentCount: s.agentCount,
                agents: s.agents.map((a) => ({
                  id: a.id,
                  name: a.name,
                  status: a.status,
                  currentTool: a.currentTool,
                  iterations: a.iterations,
                  toolCalls: a.toolCalls,
                  lastActivityAt: a.lastActivityAt,
                })),
              }));
          },
          onSwitchToSession: (_sessionId: string, targetRoot: string, projectName: string) => {
            // Record the pending switch; the TUI follows up with
            // requestExit(PROJECT_SWITCH_EXIT_CODE) and the spawn happens
            // after runTui returns — exactly like the F1 project switch.
            //
            // Deliberately NOT `--resume <sessionId>`: the F10 panel lists
            // LIVE sessions (their owner processes are alive — 'stale' is
            // filtered out), and resuming one would put two processes on the
            // same session JSONL. We open the target project fresh instead.
            //
            // This REPLACED an in-place `spawn(..., { stdio: 'inherit' })`
            // that launched a second interactive wstack while this TUI kept
            // running: two raw-mode processes fighting over one terminal,
            // and a stray `AbortSignal.timeout(30_000)` that SIGTERM'd the
            // new instance 30 seconds in.
            state.pendingProjectSwitch = { root: targetRoot, name: projectName };
          },
          initialGoal: goalFlag,
          initialAsk: askFlag,
          projectRoot,
          appConfig: config,
          getSDDContext: async () => {
            const { getActiveSDDContext } = await import('./slash-commands/sdd.js');
            return getActiveSDDContext();
          },
          onSDDOutput: async (output: string) => {
            const {
              trySaveSpecFromAIOutput,
              trySaveImplementationPlan,
              trySaveTasksFromAIOutput,
              autoDetectTaskCompletion,
              getTaskProgress,
              getActiveSDDPhase,
            } = await import('./slash-commands/sdd.js');
            const messages: string[] = [];
            const specSaved = await trySaveSpecFromAIOutput(output);
            if (specSaved)
              messages.push('✓ Spec detected and saved! Use /sdd approve to continue.');
            const planSaved = trySaveImplementationPlan(output);
            if (planSaved) messages.push('✓ Implementation plan saved!');
            const tasksSaved = await trySaveTasksFromAIOutput(output);
            if (tasksSaved) {
              const progress = getTaskProgress();
              const count = progress?.total ?? 0;
              messages.push(`✓ ${count} tasks detected and saved! Use /sdd approve to execute.`);
            }
            const sddPhase = getActiveSDDPhase();
            if (sddPhase === 'executing') {
              const autoCompleted = autoDetectTaskCompletion(output);
              if (autoCompleted > 0) {
                const progress = getTaskProgress();
                if (progress) {
                  messages.push(
                    `✓ ${autoCompleted} task(s) auto-completed! Progress: ${progress.completed}/${progress.total} (${progress.percentComplete}%)`,
                  );
                }
              }
            }
            return messages;
          },
          modeLabel: modeId,
          getModeLabel: () => {
            const metaMode = context.meta?.['mode'];
            return typeof metaMode === 'string' ? metaMode : (modeId ?? 'default');
          },
          registerDebugStreamCallback: async (cb: import('@wrongstack/providers').DebugStreamCallback) => {
            // Swap the debug-stream callback from stderr → TUI reducer.
            // Restored on TUI unmount via the cleanup in app.tsx.
            try {
              const { setDebugStreamCallback } = await import('@wrongstack/providers');
              setDebugStreamCallback(cb);
            } catch (err) {
              console.error(
                JSON.stringify({
                  level: 'error',
                  event: 'execution.debug_stream_register_failed',
                  message: err instanceof Error ? err.message : String(err),
                  timestamp: new Date().toISOString(),
                }),
              );
            }
          },
          restoreDebugStreamCallback: async () => {
            try {
              const { setDebugStreamCallback, defaultDebugStreamCallback } = await import(
                '@wrongstack/providers'
              );
              setDebugStreamCallback(defaultDebugStreamCallback);
            } catch (err) {
              console.error(
                JSON.stringify({
                  level: 'error',
                  event: 'execution.debug_stream_restore_failed',
                  message: err instanceof Error ? err.message : String(err),
                  timestamp: new Date().toISOString(),
                }),
              );
            }
          },
          restoredMessages,
          restoredToolCalls,
          // ── Session resume support ──────────────────────────────────
          listSessions: async (limit = 20) => {
            if (!activeSessionStore) return [];
            const summaries = await activeSessionStore.list(limit);
            const currentId = agent.ctx.session?.id ?? session.id;
            return summaries.map((s) => ({
              id: s.id,
              title: s.title ?? '',
              startedAt: s.startedAt ?? '',
              endedAt: s.endedAt,
              tokenTotal: s.tokenTotal ?? 0,
              iterationCount: s.iterationCount ?? 0,
              toolCallCount: s.toolCallCount ?? 0,
              toolErrorCount: s.toolErrorCount ?? 0,
              outcome: s.outcome,
              isCurrent: s.id === currentId,
            }));
          },
          onResumeSession: async (sessionId: string) => {
            if (!activeSessionStore) return null;
            // Refuse to resume a session that a LIVE process owns — two
            // writers on one session JSONL corrupt it. Thrown (not null) so
            // the resume picker surfaces the reason instead of a generic
            // failure. Best-effort: a broken registry must not block resume.
            try {
              const { SessionRegistry } = await import('@wrongstack/core');
              const registry = new SessionRegistry(path.dirname(wpaths.globalConfig));
              const live = (await registry.list()).find(
                (s) => s.sessionId === sessionId && s.status !== 'stale' && s.pid !== process.pid,
              );
              if (live) {
                throw new Error(
                  `Session is open in another running wstack (pid ${live.pid}) — it cannot be resumed here while live.`,
                );
              }
            } catch (err) {
              if (err instanceof Error && err.message.startsWith('Session is open')) throw err;
              // registry unreadable — fall through to the normal resume path
            }
            try {
              const resumed = await activeSessionStore.resume(sessionId);
              const meta = resumed.data.metadata;

              // Rebuild the agent's conversation context from the resumed
              // messages. Go through the observable state wrapper (NOT direct
              // array mutation) so onChange subscribers fire and tool-use
              // adjacency is re-checked on the next request.
              agent.ctx.state.replaceMessages(resumed.data.messages);

              // Sync the agent's model/provider to what was used in the
              // resumed session. If the resumed session used a different
              // provider or model, switch to it so the agent uses the
              // correct API endpoint and context window.
              if (meta.model && meta.model !== agent.ctx.model) {
                agent.ctx.model = meta.model;
              }
              if (meta.provider) {
                const currentProviderId = (agent.ctx.provider as { id?: string }).id;
                if (meta.provider !== currentProviderId && switchProviderAndModel) {
                  // Full provider switch — rebuilds the Provider instance
                  switchProviderAndModel(meta.provider as string, meta.model ?? agent.ctx.model);
                }
              }

              // Finalize the current session: append a session_end (so the
              // log ends cleanly and recovery/summaries see a completed
              // session), then close (flush + summary sidecar + index). Use
              // agent.ctx.session (the currently active writer) rather than
              // the captured `session` variable — the user may have resumed
              // before, in which case `session` is stale.
              // Fire-and-forget: don't block resume on the close.
              const oldWriter = agent.ctx.session;
              if (oldWriter && oldWriter !== resumed.writer) {
                // Capture the OLD session's usage synchronously — the counter
                // is reset for the resumed session below, and this closure
                // runs after that reset.
                const endedUsage = tokenCounter.total();
                void (async () => {
                  let appendOk = false;
                  try {
                    await oldWriter.append({
                      type: 'session_end',
                      ts: new Date().toISOString(),
                      usage: endedUsage,
                    });
                    appendOk = true;
                  } catch (err) {
                    console.error(
                      JSON.stringify({
                        level: 'error',
                        event: 'execution.session_end_append_failed',
                        message: err instanceof Error ? err.message : String(err),
                        timestamp: new Date().toISOString(),
                      }),
                    );
                  }
                  // Only close if session_end was successfully appended — closing
                  // a partially-written session file corrupts recovery/summaries.
                  if (appendOk) {
                    try {
                      await oldWriter.close();
                    } catch (err) {
                      console.error(
                        JSON.stringify({
                          level: 'error',
                          event: 'execution.session_close_failed',
                          message: err instanceof Error ? err.message : String(err),
                          timestamp: new Date().toISOString(),
                        }),
                      );
                    }
                  }
                })();
              }

              // Swap the session writer: new events (tool calls, LLM responses)
              // will append to the resumed session's JSONL, not the old one.
              agent.ctx.session = resumed.writer;

              // Token accounting is per-session: without a reset the resumed
              // session's summary/cost chips inherit the old session's totals.
              tokenCounter.reset();

              // Re-point crash recovery (active.json) at the resumed session —
              // otherwise a crash after this resume would offer recovery for
              // the OLD (cleanly finalized) session and miss the live one.
              // Fire-and-forget: do not block resume on recovery lock errors.
              void (async () => {
                // clear() failure is logged but write() still runs — recovery
                // lock pointing to the old session is worse than pointing to the
                // new one (which may not yet be fully initialized).
                try {
                  await activeRecoveryLock.clear();
                } catch (err) {
                  console.error(
                    JSON.stringify({
                      level: 'warn',
                      event: 'execution.recovery_lock_clear_failed',
                      message: err instanceof Error ? err.message : String(err),
                      timestamp: new Date().toISOString(),
                    }),
                  );
                }
                try {
                  await activeRecoveryLock.write(resumed.writer.id);
                } catch (err) {
                  console.error(
                    JSON.stringify({
                      level: 'error',
                      event: 'execution.recovery_lock_update_failed',
                      message: err instanceof Error ? err.message : String(err),
                      timestamp: new Date().toISOString(),
                    }),
                  );
                }
              })();

              // Replay the JSONL events as TUI history entries.
              const { replaySessionEvents } = await import('@wrongstack/tui');
              const entries = replaySessionEvents(resumed.data.events, /* startId */ 1);

              return {
                entries,
                nextId: entries.length + 1,
                sessionId: resumed.writer.id,
              };
            } catch (err) {
              console.error(
                JSON.stringify({
                  level: 'error',
                  event: 'execution.resume_session_failed',
                  message: err instanceof Error ? err.message : String(err),
                  timestamp: new Date().toISOString(),
                }),
              );
              return null;
            }
          },
          /**
           * Load project picker items from the global manifest.
           * Called each time the project picker panel opens (F1).
           */
          getProjectPickerItems: async () => {
            const { buildPickerItems } = await import('./project-picker.js');
            return buildPickerItems({
              globalConfigPath: wpaths.globalConfig,
              currentProjectRoot: projectRoot,
            });
          },
          /**
           * Called when the user selects a project in the picker.
           * Re-roots the live TUI process in place: new Context root, fresh
           * per-project session writer, rebuilt system prompt, and no spawned
           * replacement process.
           */
          onProjectSelect: async (slug: string, kind: 'project' | 'action') => {
            try {
              if (kind === 'action') {
                if (slug === 'new-session') {
                  const name = path.basename(projectRoot) || projectRoot;
                  const err = await switchProjectInPlace(projectRoot, name);
                  if (err) renderer.write(color.red(`Project switch failed: ${err}\n`));
                }
                // prev-sessions is handled inside the TUI (/resume picker).
                return;
              }

              const { loadManifest, saveManifest } = await import('./slash-commands/project-utils.js');
              const manifest = await loadManifest(wpaths.globalConfig);
              const project = manifest.projects.find((p) => p.slug === slug);
              if (!project) return;

              const targetRoot = path.resolve(project.root);
              if (path.resolve(projectRoot) === targetRoot) return;

              const fleetStatus = director?.status();
              const fleetRunning =
                fleetStatus?.subagents.filter((a) => a.status === 'running').length ?? 0;
              const eternalActive = getEternalEngine?.()?.currentState === 'running';
              const parallelActive = getParallelEngine?.()?.currentState === 'running';
              const hasActiveAgents = fleetRunning > 0 || eternalActive || parallelActive;

              if (hasActiveAgents) {
                const parts: string[] = [
                  color.yellow('⚠  Switching project in place; active background work is still tied to the previous project:'),
                ];
                if (fleetRunning > 0) parts.push(color.dim(`  • ${fleetRunning} subagent(s) currently running`));
                if (eternalActive) parts.push(color.dim('  • Eternal engine is active'));
                if (parallelActive) parts.push(color.dim('  • Parallel engine is active'));
                parts.push('');
                parts.push(color.dim(`  New project: ${project.name}`));
                renderer.write(`\n${parts.join('\n')}\n`);
              }

              project.lastSeen = new Date().toISOString();
              await saveManifest(manifest, wpaths.globalConfig);

              const err = await switchProjectInPlace(targetRoot, project.name);
              if (err) renderer.write(color.red(`Project switch failed: ${err}\n`));
            } catch (err) {
              renderer.write(
                color.red(
                  `Project switch failed: ${err instanceof Error ? err.message : String(err)}\n`,
                ),
              );
            }
          },
          // `wrongstack quick` sets flags.quick — open the F3 agents monitor by default.
          initialAgentsMonitorOpen: !!flags.quick,
          tokenSavingMode: normalizeTokenSavingTier(config.features.tokenSavingMode) !== 'off',
          toolCount: agent.tools.list().length,
          onPanelOpen,
        } as unknown as import('@wrongstack/tui').RunTuiOptions);

        // After TUI exits with PROJECT_SWITCH_EXIT_CODE, spawn wstack in the new project.
        // This replaces the old behavior of spawning mid-session (which left the TUI
        // running and corrupted the terminal state).
        const spawnResult = await handleProjectSwitchSpawn({ code, pendingProjectSwitch: state.pendingProjectSwitch });
        if (spawnResult !== null) return spawnResult;
      } finally {
        renderer.setSilent(false);
        // Cleanup: stop Director lifecycle listener so the coordinator no-op guard fires.
        offDirectorSpawned();
      }
    } else if (flags.webui) {
      code = await runWebUIDispatch({
        agent,
        events,
        session,
        config,
        flags,
        projectRoot,
        globalConfigPath: wpaths.globalConfig,
        projectSessionsDir: wpaths.projectSessions,
        modelsRegistry,
        mcpRegistry,
        brain,
        brainSettings,
        getBrainLog,
        subscribeEternalIteration,
        sessionStore: activeSessionStore,
        memoryStore,
        skillLoader,
        modeStore,
        modeId,
        needsSetup,
        renderer,
        onAutonomy,
        activeRecoveryLock,
      });
    } else {
      code = await runRepl({
        agent,
        renderer,
        reader,
        slashRegistry,
        tokenCounter,
        visionAdapters,
        supportsVision,
        attachments,
        effectiveMaxContext,
        projectName: path.basename(projectRoot) || undefined,
        projectRoot,
        appConfig: config,
        getAutonomy,
        onAutonomy,
        getNextPredict,
        onSuggestionsParsed,
        getSuggestions,
        getAutoSuggestions,
        getYolo,
        autonomyNextPrompt,
        autoProceedDelayMs,
        onValidateAutoProceed,
        autoProceedMaxIterations,
        getEternalEngine,
        getParallelEngine,
        skillLoader,
        agentsMonitorController,
        fleetStreamController,
        interruptController,
        onInterruptFleet: director
          ? () => {
              // Mirror the slash /fleet kill path: remove (not just terminate)
              // every running/idle subagent so a Ctrl+C stops the whole fleet.
              let killed = 0;
              for (const sa of director.status().subagents) {
                if (sa.status === 'running' || sa.status === 'idle') {
                  try {
                    director.remove(sa.id);
                    killed++;
                  } catch {
                    /* best-effort */
                  }
                }
              }
              return killed;
            }
          : undefined,
        onAgentIterationComplete: director
          ? (tokens) => director.setLeaderContextPressure(tokens)
          : undefined,
        onCountdownTick: deps.onCountdownTick,
        onDestroy: deps.onDestroy,
      });
    }
  } finally {
    // Tear down the live fleet status line first so the scroll region is
    // restored before any end-of-session output prints.
    fleetStatusLine?.stop();
    // Stop the AutonomousCoordinator so its while-loop exits cleanly.
    // This sets running=false; the loop terminates at the next iteration check.
    deps.onCoordinatorStop?.();
    // stats.render is synchronous but can throw — isolate it so cleanup
    // always runs regardless.
    try {
      stats.render(renderer);
    } catch (_err) {
      /* best-effort */
    }
    await Promise.resolve(detachTodosCheckpoint?.()).catch(() => undefined);
    await mcpRegistry.stopAll();
    // Use the CURRENT writer, not the one captured at startup — an in-app
    // resume (TUI/WebUI) swaps agent.ctx.session to the resumed session's
    // writer; session_end and close must land in THAT JSONL or the resumed
    // session never gets finalized (no summary sidecar, no index entry).
    const activeSession = agent.ctx.session ?? session;
    const pending = activeSession.pendingToolUses;
    await activeSession.append({
      type: 'session_end',
      ts: new Date().toISOString(),
      usage: tokenCounter.total(),
      pendingToolUses: pending.length > 0 ? pending : undefined,
    });
    events.emit('session.ended', { id: activeSession.id, usage: tokenCounter.total() });
    // Await chimera's in-flight work so the review result is written to the JSONL
    // before we close — without this, session.close() races against the subagent
    // and the review text is silently dropped because append returns early on closed.
    await pendingChimeraWork;
    await activeSession.close();
    await activeRecoveryLock
      .clear()
      .catch(() => undefined); /* best-effort: stale lock will be recovered on next startup */
    await reader.close();
  }
  return code;
}
