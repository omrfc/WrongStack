/**
 * Execution phase — single-shot, TUI, REPL, and WebUI dispatch.
 * Extracted from index.ts so the main() function focuses on
 * boot + wiring; this file owns the three run modes and cleanup.
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type {
  Agent,
  AttachmentStore,
  Config,
  ConfigStore,
  Director,
  EventBus,
  ModelsRegistry,
  RecoveryLock,
  SessionWriter,
  SlashCommandRegistry,
  TokenCounter,
} from '@wrongstack/core';
import { color, mergeCustomModelDefs, writeOut, type AutonomyStage, decryptConfigSecrets, encryptConfigSecrets, atomicWrite } from '@wrongstack/core';
import { filterSafeForProject, persistAutonomySetting } from './settings-menu.js';
import type { ProviderConfig, ResolvedProvider, WstackPaths } from '@wrongstack/core';
import type { MCPRegistry } from '@wrongstack/mcp';
import { createToolVisionAdapters } from '@wrongstack/runtime/vision';
import { capabilitiesFor } from '@wrongstack/providers';
import type { ReadlineInputReader } from './input-reader.js';
import type { TerminalRenderer } from './renderer.js';
import { contextOverflowHint } from './context-overflow-diagnostic.js';
import { FleetStatusLine } from './fleet-statusline.js';
import { type PredictLLMProvider, predictNextTasks } from './next-task-predictor.js';
import { runRepl } from './repl.js';
import type { SessionStats } from './session-stats.js';
import { fmtTok } from './utils.js';
import { CLI_VERSION } from './version.js';

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
  stats: SessionStats;
  detachTodosCheckpoint?: (() => void | Promise<void>) | undefined;
  savedProviderCfg: ProviderConfig | undefined;
  resolvedProvider: ResolvedProvider | undefined;
  getPickableProviders: () => Promise<Array<{ id: string; family: string; models: string[] }>>;
  switchProviderAndModel: (providerId: string, modelId: string) => string | null;
  /** Live director instance for the TUI fleet panel. Null when director mode is off. */
  director: Director | null;
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
  /** Shared controller for the `/enhance on|off` prompt-refinement toggle. */
  enhanceController?: {
    enabled: boolean;
    setEnabled: (enabled: boolean) => void;
  };
  /** Status bar hidden items controller (passed to TUI). */
  statuslineHiddenItems: Array<'todos' | 'plan' | 'fleet' | 'git' | 'elapsed' | 'context' | 'cost'>;
  setStatuslineHiddenItems: (
    items: Array<'todos' | 'plan' | 'fleet' | 'git' | 'elapsed' | 'context' | 'cost'>,
  ) => void;
  /** Agents monitor overlay controller (passed to TUI). */
  agentsMonitorController?: {
    visible: boolean;
    setVisible: (visible: boolean) => void;
  };
  /** Query the live YOLO state from the permission policy. */
  getYolo?: (() => boolean) | undefined;
  /** Query the live autonomy mode. */
  getAutonomy?: (() => import('./slash-commands/autonomy.js').AutonomyMode) | undefined;
  /** Set autonomy mode (used by SIGINT handler to flip back to 'off'). */
  onAutonomy?: ((mode: import('./slash-commands/autonomy.js').AutonomyMode) => void) | undefined;
  /** Whether next-task prediction is enabled (toggled via /next). */
  getNextPredict?: (() => boolean) | undefined;
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
  /** Skill loader for the skill generator wizard. */
  skillLoader?: import('@wrongstack/core').SkillLoader | undefined;
  /** Active agent mode id shown in the status bar (e.g. "teach", "brief"). */
  modeId?: string | undefined;
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
    recoveryLock,
    wpaths,
    modelsRegistry,
    projectRoot,
    flags,
    positional,
    effectiveMaxContext,
    queueStore,
    context,
    stats,
    detachTodosCheckpoint,
    savedProviderCfg,
    resolvedProvider,
    getPickableProviders,
    switchProviderAndModel,
    director,
    fleetRoster,
    fleetStreamController,
    enhanceController,
    statuslineHiddenItems,
    setStatuslineHiddenItems,
    agentsMonitorController,
    getYolo,
    getAutonomy,
    onAutonomy,
    getNextPredict,
    getEternalEngine,
    getParallelEngine,
    subscribeEternalIteration,
    subscribeEternalStage,
    skillLoader,
    modeId,
  } = deps;

  let code = 0;
  let fleetStatusLine: FleetStatusLine | null = null;
  try {
    const visionAdapters = () => createToolVisionAdapters(agent.tools);
    const supportsVision = async (): Promise<boolean> => {
      try {
        const providerConfig = config.providers?.[context.provider.id];
        const mergedModels = mergeCustomModelDefs(
          providerConfig?.customModels,
          config.models,
        );
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
      const query = positional.join(' ');
      const ctrl = new AbortController();
      const onSigint = () => ctrl.abort();
      process.on('SIGINT', onSigint);
      const startedAt = Date.now();
      const before = tokenCounter.total();
      const costBefore = tokenCounter.estimateCost().total;
      let result: import('@wrongstack/core').RunResult;
      try {
        result = await agent.run(query, { signal: ctrl.signal });
      } finally {
        process.off('SIGINT', onSigint);
        // Clean up any lingering bash/exec processes.
        const { getProcessRegistry } = await import('@wrongstack/tools');
        getProcessRegistry().killAll();
      }
      const after = tokenCounter.total();
      const costAfter = tokenCounter.estimateCost().total;
      const usage = {
        input: after.input - before.input,
        output: after.output - before.output,
        iterations: result.iterations,
        cost: costAfter - costBefore,
        elapsedMs: Date.now() - startedAt,
      };
      if (flags['output-json']) {
        const json = JSON.stringify({
          status: result.status,
          finalText: result.finalText ?? null,
          error: result.error
            ? {
                code: result.error.code,
                subsystem: result.error.subsystem,
                severity: result.error.severity,
                recoverable: result.error.recoverable,
                message: result.error.message,
                context: result.error.context ?? null,
              }
            : null,
          usage,
        });
        writeOut(json + '\n');
      } else {
        if (result.status === 'failed') {
          code = 1;
          const err = result.error;
          if (err) {
            const tag = err.recoverable ? ' (recoverable)' : '';
            renderer.writeError(`Failed [${err.severity}]${tag}: ${err.describe()}`);
            const hint = contextOverflowHint(err);
            if (hint) renderer.writeWarning(hint);
          } else {
            renderer.writeError('Failed.');
          }
        } else if (result.status === 'aborted') {
          code = 130;
          renderer.writeWarning('Aborted.');
        } else if (result.status === 'max_iterations') {
          code = 1;
          renderer.writeWarning(`Hit max iterations (${result.iterations}).`);
        }
        if (result.finalText) renderer.write('\n' + result.finalText + '\n');
        // Surface any delegate subagent completion banners.
        const r = result as {
          delegateSummaries?: Array<{ summary: string | undefined; ok: boolean }>;
          messages?: Array<unknown> | undefined;
        };
        renderer.writeDelegateSummaries(r);
        renderer.write(
          '\n' +
            color.dim(
              `[in: ${fmtTok(usage.input)}  out: ${fmtTok(usage.output)}  iters: ${usage.iterations}  cost: ${usage.cost.toFixed(4)}  ${(usage.elapsedMs / 1000).toFixed(1)}s]`,
            ) +
            '\n',
        );
      }
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
      const banneredFamily = savedProviderCfg?.family ?? resolvedProvider?.family;
      const banneredKey =
        savedProviderCfg?.apiKey ??
        config.apiKey ??
        (resolvedProvider?.envVars ?? savedProviderCfg?.envVars ?? [])
          .map((v) => process.env[v])
          .find((v): v is string => !!v);
      const banneredKeyTail =
        banneredKey && banneredKey.length >= 3 ? banneredKey.slice(-3) : undefined;

      // AutoPhase event forwarding — subscribes to PhaseOrchestrator events
      // on the main EventBus and forwards them to the TUI handler so the
      // PhaseMonitor/PhasePanel stay in sync with the running graph.
      const autoPhaseHandlers = new Map<string, (payload: unknown) => void>();
      const subscribeAutoPhase = (
        handler: (event: string, payload: unknown) => void,
      ): (() => void) => {
        const registrations: Array<() => void> = [];
        const autoPhaseEvents = [
          'phase.started',
          'phase.completed',
          'phase.failed',
          'phase.statusChange',
          'phase.taskCompleted',
          'phase.taskFailed',
          'phase.taskRetrying',
          'phase.verifying',
          'phase.verifyFailed',
          'phase.repairing',
          'phase.conflictResolving',
          'phase.conflictResolved',
          'autonomous.tick',
          'graph.completed',
          'graph.failed',
          'agent.assigned',
          'agent.released',
          // Git-worktree isolation lifecycle → TUI worktree panel/monitor.
          'worktree.allocated',
          'worktree.committed',
          'worktree.merged',
          'worktree.conflict',
          'worktree.released',
          'worktree.failed',
        ];
        // AutoPhase events are emitted on the untyped surface of the bus
        // (the orchestrator casts `emit` to a string-keyed signature), so we
        // subscribe through the same untyped view rather than the typed
        // event-name overloads.
        // Bind to `events` — pulling the method off the bus as a bare
        // reference loses `this`, so `on`/`off` would read `this.listeners`
        // off `undefined` and throw ("Cannot read properties of undefined
        // (reading 'listeners')") the moment AutoPhase subscribes.
        const onUntyped = events.on.bind(events) as unknown as (
          event: string,
          handler: (payload: unknown) => void,
        ) => void;
        const offUntyped = events.off.bind(events) as unknown as (
          event: string,
          handler: (payload: unknown) => void,
        ) => void;
        for (const ev of autoPhaseEvents) {
          const h = (p: unknown) => handler(ev, p);
          autoPhaseHandlers.set(ev, h);
          onUntyped(ev, h);
          registrations.push(() => offUntyped(ev, h));
        }
        return () => {
          for (const unregister of registrations) unregister();
          autoPhaseHandlers.clear();
        };
      };

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
          getEternalEngine,
          subscribeEternalIteration,
          subscribeEternalStage: subscribeEternalStage as never,
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
          getSettings: () => {
            const cfg = configStore.get();
            const autonomy = cfg.autonomy as Record<string, unknown> | undefined;
            const rawMode = autonomy?.defaultMode as string | undefined;
            const mode: 'off' | 'suggest' | 'auto' =
              rawMode === 'suggest' || rawMode === 'auto' ? rawMode : 'off';
            return {
              mode,
              delayMs: (autonomy?.autoProceedDelayMs as number) ?? 45_000,
              titleAnimation: autonomy?.terminalTitleAnimation !== false,
              yolo: (autonomy?.yolo as boolean) ?? false,
              streamFleet: autonomy?.streamFleet !== false,
              chime: (autonomy?.chime as boolean) ?? false,
              confirmExit: autonomy?.confirmExit !== false,
              nextPrediction: cfg.nextPrediction ?? false,
              featureMcp: cfg.features?.mcp !== false,
              featurePlugins: cfg.features?.plugins !== false,
              featureMemory: cfg.features?.memory !== false,
              featureSkills: cfg.features?.skills !== false,
              featureModelsRegistry: cfg.features?.modelsRegistry !== false,
              contextAutoCompact: cfg.context?.autoCompact !== false,
              contextStrategy: cfg.context?.strategy ?? 'hybrid',
              logLevel: cfg.log?.level ?? 'info',
              auditLevel: cfg.session?.auditLevel ?? 'standard',
              indexOnStart: cfg.indexing?.onSessionStart !== false,
              maxIterations: cfg.tools?.maxIterations ?? 500,
              debugStream: cfg.debugStream ?? false,
              configScope: cfg.configScope ?? 'global',
              enhanceDelayMs: (cfg.autonomy as Record<string, unknown> | undefined)?.enhanceDelayMs as number ?? 60_000,
            };
          },
          async saveSettings(s: {
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
            contextAutoCompact?: boolean | undefined;
            contextStrategy?: string | undefined;
            logLevel?: string | undefined;
            auditLevel?: string | undefined;
            indexOnStart?: boolean | undefined;
            maxIterations?: number | undefined;
            debugStream?: boolean | undefined;
            configScope?: 'global' | 'project' | undefined;
            enhanceDelayMs?: number | undefined;
          }) {
            try {
              // Persist autonomy section (existing behaviour).
              await persistAutonomySetting(
                {
                  configStore,
                  globalConfigPath: wpaths.globalConfig,
                  inProjectConfigPath: wpaths.inProjectConfig,
                  vault: { encrypt: (v) => v, decrypt: (v) => v, isEncrypted: () => false },
                },
                (autonomy) => {
                  autonomy.defaultMode = s.mode;
                  autonomy.autoProceedDelayMs = s.delayMs;
                  const a = autonomy as Record<string, unknown>;
                  a['terminalTitleAnimation'] = s.titleAnimation ?? true;
                  a['yolo'] = s.yolo ?? false;
                  a['streamFleet'] = s.streamFleet ?? true;
                  a['chime'] = s.chime ?? false;
                  a['confirmExit'] = s.confirmExit ?? true;
                },
              );

              // Persist other config sections that the SettingsPicker now exposes.
              // Use the same read → modify → encrypt → atomic-write pattern as
              // persistAutonomySetting, but applied to the full config.
              if (
                s.featureMcp !== undefined ||
                s.featurePlugins !== undefined ||
                s.featureMemory !== undefined ||
                s.featureSkills !== undefined ||
                s.featureModelsRegistry !== undefined ||
                s.contextAutoCompact !== undefined ||
                s.contextStrategy !== undefined ||
                s.logLevel !== undefined ||
                s.auditLevel !== undefined ||
                s.indexOnStart !== undefined ||
                s.maxIterations !== undefined ||
                s.nextPrediction !== undefined ||
                s.debugStream !== undefined ||
                s.configScope !== undefined ||
                s.enhanceDelayMs !== undefined
              ) {
                // Resolve target config path based on scope.
                // When scope is 'project', write to projectLocalConfig
                // so provider/model/ux settings live in the project folder.
                const configScope = s.configScope ?? (configStore.get().configScope ?? 'global');
                const targetPath =
                  configScope === 'project' && wpaths.inProjectConfig
                    ? wpaths.inProjectConfig
                    : wpaths.globalConfig;
                const raw = await fs.readFile(targetPath, 'utf8').catch(() => '{}');
                const parsed = JSON.parse(raw) as Record<string, unknown>;
                const vault = { encrypt: (v: string) => v, decrypt: (v: string) => v, isEncrypted: () => false };
                const decrypted = decryptConfigSecrets(parsed, vault) as Record<string, unknown>;

                if (s.nextPrediction !== undefined) {
                  decrypted.nextPrediction = s.nextPrediction;
                }
                if (
                  s.featureMcp !== undefined ||
                  s.featurePlugins !== undefined ||
                  s.featureMemory !== undefined ||
                  s.featureSkills !== undefined ||
                  s.featureModelsRegistry !== undefined
                ) {
                  const feats = (decrypted.features as Record<string, unknown>) ?? {};
                  if (s.featureMcp !== undefined) feats.mcp = s.featureMcp;
                  if (s.featurePlugins !== undefined) feats.plugins = s.featurePlugins;
                  if (s.featureMemory !== undefined) feats.memory = s.featureMemory;
                  if (s.featureSkills !== undefined) feats.skills = s.featureSkills;
                  if (s.featureModelsRegistry !== undefined) feats.modelsRegistry = s.featureModelsRegistry;
                  decrypted.features = feats;
                }
                if (s.contextAutoCompact !== undefined || s.contextStrategy !== undefined) {
                  const ctx = (decrypted.context as Record<string, unknown>) ?? {};
                  if (s.contextAutoCompact !== undefined) ctx.autoCompact = s.contextAutoCompact;
                  if (s.contextStrategy !== undefined) ctx.strategy = s.contextStrategy;
                  decrypted.context = ctx;
                }
                if (s.logLevel !== undefined) {
                  const log = (decrypted.log as Record<string, unknown>) ?? {};
                  log.level = s.logLevel;
                  decrypted.log = log;
                }
                if (s.auditLevel !== undefined) {
                  const sess = (decrypted.session as Record<string, unknown>) ?? {};
                  sess.auditLevel = s.auditLevel;
                  decrypted.session = sess;
                }
                if (s.indexOnStart !== undefined) {
                  const idx = (decrypted.indexing as Record<string, unknown>) ?? {};
                  idx.onSessionStart = s.indexOnStart;
                  decrypted.indexing = idx;
                }
                if (s.maxIterations !== undefined) {
                  const tools = (decrypted.tools as Record<string, unknown>) ?? {};
                  tools.maxIterations = s.maxIterations;
                  decrypted.tools = tools;
                }
                if (s.debugStream !== undefined) {
                  decrypted.debugStream = s.debugStream;
                  // Flip the runtime singleton so the toggle takes effect
                  // on the next provider request without a restart.
                  const { setDebugStreamEnabled } = await import('@wrongstack/providers');
                  setDebugStreamEnabled(s.debugStream);
                }
                if (s.configScope !== undefined) {
                  decrypted.configScope = s.configScope;
                }
                if (s.enhanceDelayMs !== undefined) {
                  const autonomy = (decrypted.autonomy as Record<string, unknown>) ?? {};
                  autonomy.enhanceDelayMs = s.enhanceDelayMs;
                  decrypted.autonomy = autonomy;
                }
                // When writing to the project-local config, strip credentials
                // so apiKey / providers / sync never leak into a per-project file.
                const toWrite =
                  targetPath === wpaths.globalConfig ? decrypted : filterSafeForProject(decrypted);
                const encrypted = encryptConfigSecrets(toWrite, vault);
                // Ensure the project directory exists before writing
                if (targetPath !== wpaths.globalConfig) {
                  await fs.mkdir(path.dirname(targetPath), { recursive: true }).catch((err) => console.debug(`[execution] mkdir failed: ${err}`));
                }
                await atomicWrite(targetPath, JSON.stringify(encrypted, null, 2), { mode: 0o600 });

                // Sync in-memory config store.
                configStore.update({
                  ...(s.nextPrediction !== undefined ? { nextPrediction: s.nextPrediction } : {}),
                  ...(s.featureMcp !== undefined || s.featurePlugins !== undefined || s.featureMemory !== undefined || s.featureSkills !== undefined || s.featureModelsRegistry !== undefined
                    ? { features: decrypted.features as Config['features'] }
                    : {}),
                  ...(s.contextAutoCompact !== undefined || s.contextStrategy !== undefined
                    ? { context: decrypted.context as Config['context'] }
                    : {}),
                  ...(s.logLevel !== undefined ? { log: decrypted.log as Config['log'] } : {}),
                  ...(s.auditLevel !== undefined ? { session: decrypted.session as Config['session'] } : {}),
                  ...(s.indexOnStart !== undefined ? { indexing: decrypted.indexing as Config['indexing'] } : {}),
                  ...(s.maxIterations !== undefined ? { tools: decrypted.tools as Config['tools'] } : {}),
                  ...(s.debugStream !== undefined ? { debugStream: s.debugStream } : {}),
                  ...(s.configScope !== undefined ? { configScope: s.configScope as 'global' | 'project' } : {}),
                  ...(s.enhanceDelayMs !== undefined
                    ? { autonomy: { ...((configStore.get().autonomy as Record<string, unknown>) ?? {}), enhanceDelayMs: s.enhanceDelayMs } as Config['autonomy'] }
                    : {}),
                });
              }

              // Apply runtime effects immediately.
              if (s.streamFleet !== undefined) {
                fleetStreamController?.setEnabled(s.streamFleet);
              }
              return null;
            } catch (err) {
              return err instanceof Error ? err.message : String(err);
            }
          },
          effectiveMaxContext,
          // Terminal title animation: read from config (default on).
          titleAnimation: ((config.autonomy as Record<string, unknown> | undefined)?.['terminalTitleAnimation'] as boolean) ?? true,
          // Completion chime: terminal bell when agent finishes.
          chime: ((config.autonomy as Record<string, unknown> | undefined)?.['chime'] as boolean) ?? false,
          // Normal exit.
          confirmExit: ((config.autonomy as Record<string, unknown> | undefined)?.['confirmExit'] as boolean) ?? true,
          director,
          fleetRoster,
          onClearHistory: (
            dispatch: (action: { type: 'clearHistory' } | { type: 'resetContextChip' }) => void,
          ) => {
            dispatch({ type: 'clearHistory' });
            dispatch({ type: 'resetContextChip' });
          },
          fleetStreamController,
          enhanceController,
          statuslineHiddenItems,
          setStatuslineHiddenItems,
          agentsMonitorController,
          initialGoal: goalFlag,
          initialAsk: askFlag,
          projectRoot,
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
          registerDebugStreamCallback: (cb) => {
            // Swap the debug-stream callback from stderr → TUI reducer.
            // Restored on TUI unmount via the cleanup in app.tsx.
            void import('@wrongstack/providers')
              .then(({ setDebugStreamCallback }) => setDebugStreamCallback(cb))
              .catch((err) =>
                console.error('[execution] failed to register debug stream callback:', err),
              );
          },
          restoreDebugStreamCallback: () => {
            void import('@wrongstack/providers')
              .then(({ setDebugStreamCallback, defaultDebugStreamCallback }) =>
                setDebugStreamCallback(defaultDebugStreamCallback),
              )
              .catch((err) =>
                console.error('[execution] failed to restore debug stream callback:', err),
              );
          },
        });
      } finally {
        renderer.setSilent(false);
      }
    } else if (flags.webui) {
      // Route permission confirmations to the browser (tool.confirm_needed
      // events) instead of inline terminal prompts — runWebUI forwards them to
      // the WebUI and resolves on the client's tool.confirm_result. Without
      // this, approvals appear in the terminal even when you're driving the
      // agent from the browser.
      agent.disableInteractiveConfirmation();
      const { runWebUI } = await import('./webui-server.js');
      const webuiPromise = runWebUI({
        agent,
        events,
        session,
        port: Number.parseInt(String(flags.port ?? '3457'), 10),
        projectRoot,
        open: !!flags.open,
        modelsRegistry,
        globalConfigPath: wpaths.globalConfig,
        subscribeEternalIteration,
      });
      try {
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
          getAutonomy,
          onAutonomy,
          getNextPredict,
          getEternalEngine,
          getParallelEngine,
          skillLoader,
          agentsMonitorController,
          fleetStreamController,
          // Report context pressure to the Director after each iteration so
          // the spawn pre-check (maxLeaderContextLoad) stays accurate.
          onAgentIterationComplete: director
            ? (tokens) => director.setLeaderContextPressure(tokens)
            : undefined,
        });
      } finally {
        // webuiPromise must be awaited regardless of whether runRepl threw,
        // so the HTTP/WS server can shut down cleanly.
        await webuiPromise.catch((err) => console.debug(`[execution] webui shutdown failed: ${err}`));
      }
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
        getAutonomy,
        onAutonomy,
        getNextPredict,
        getEternalEngine,
        getParallelEngine,
        skillLoader,
        agentsMonitorController,
        fleetStreamController,
        onAgentIterationComplete: director
          ? (tokens) => director.setLeaderContextPressure(tokens)
          : undefined,
      });
    }
  } finally {
    // Tear down the live fleet status line first so the scroll region is
    // restored before any end-of-session output prints.
    fleetStatusLine?.stop();
    // stats.render is synchronous but can throw — isolate it so cleanup
    // always runs regardless.
    try {
      stats.render(renderer);
    } catch (_err) {
      /* best-effort */
    }
    await Promise.resolve(detachTodosCheckpoint?.()).catch(() => undefined);
    await mcpRegistry.stopAll();
    await session.append({
      type: 'session_end',
      ts: new Date().toISOString(),
      usage: tokenCounter.total(),
    });
    await session.close();
    await recoveryLock.clear().catch(() => undefined);
    await reader.close();
  }
  return code;
}
