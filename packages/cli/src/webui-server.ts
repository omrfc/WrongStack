/**
 * CLI embedded WebUI server — the backend behind `wrongstack --webui`.
 *
 * `runWebUI(opts)` boots a WebSocket bridge (and, when the webui package
 * is built, the static HTTP frontend) over the *same* agent/events/
 * session instances the REPL and eternal-autonomy loop use, then routes
 * browser messages through a `handleMessage` switch.
 *
 * Issue #30 (the webui-server N-PR refactor) pulled the self-contained
 * concerns out of this file into focused `webui-server/*` modules. Where
 * each concern now lives:
 *
 *   webui-server/logger-shim.ts        — console→Logger adapter (PR 1)
 *   webui-server/cost-helpers.ts       — token/usage cost math (PR 2)
 *   webui-server/context-breakdown.ts  — context-window estimation (PR 3)
 *   webui-server/provider-config.ts    — provider-config IO + the
 *                                        ProviderConfigStore facade
 *                                        (PR 4 + follow-up)
 *   webui-server/static-serve.ts       — dist discovery + HTTP bring-up (PR 6)
 *   webui-server/lifecycle.ts          — instance registry, ready banner +
 *                                        open-browser, SIGINT/SIGTERM
 *                                        graceful shutdown (PR 7)
 *   webui-server/ws-handlers/          — every `handleMessage` case, one
 *                                        topic file per group, each threaded
 *                                        through a per-group context that
 *                                        extends the small `WsCommon` base
 *                                        (PR 5 + 5b–5k):
 *       providers · brain · introspection · worklist · agent-config ·
 *       prefs · projects · context · process · sessions · connection
 *   webui-server/stream-coalescer.ts   — server-side coalescing of
 *                                        text/thinking deltas + tool
 *                                        progress (PR 9)
 *   webui-server/client-registration.ts — mailbox presence + HQ telemetry
 *                                        heartbeat for this instance (PR 10)
 *   webui-server/session-start-payload.ts — session.start payload builder
 *                                        with cost rates + max context (PR 11)
 *
 * `handleMessage` now only routes: each case unpacks the payload and calls
 * the matching `handleXxx(ctx, …)`. The per-group contexts are all built
 * once (before the WS connection handler is wired, so a fast client message
 * can't reach a handler before its context initializes). The file/memory/
 * mailbox/shell cases delegate to the shared `@wrongstack/webui/server`
 * handlers.
 *
 * Public surface: `runWebUI` plus the `WSServerMessage` / `WSClientMessage`
 * message shapes. Everything else is internal to the run.
 */
import * as os from 'node:os';
import * as path from 'node:path';
import type {
  Agent,
  BrainArbiter,
  BrainAutoRisk,
  Context,
  EventBus,
  MemoryStore,
  ModelsRegistry,
  ModeStore,
  PromptLoader,
  ProviderConfig,
  SessionStore,
  SessionWriter,
  SkillLoader,
} from '@wrongstack/core';
import {
  DefaultSecretScrubber,
  PromptUsageStore,
  resolveWstackPaths,
  TOKENS,
  type TodoItem,
  watchProviderConfig,
  wstackGlobalRoot,
} from '@wrongstack/core';
import { makeProviderFromConfig } from '@wrongstack/providers';
import { toErrorMessage } from '@wrongstack/core/utils/error';
import { SkillInstaller } from '@wrongstack/core/skills';
import type { MCPRegistry } from '@wrongstack/mcp';
import {
  AutoPhaseWebSocketHandler,
  SpecsWebSocketHandler,
  SddBoardWebSocketHandler,
  SddWizardWebSocketHandler,
  buildSddWizardDeps,
  type CustomModeStore,
  createCustomModeStore,
  createToolLspCompletionSource,
  findFreePort,
  resolveAuthToken,
  buildWebUIAccessUrl,
  envFlag,
  handleCompletionRequest,
  handleFilesList,
  handleFilesRead,
  handleFilesTree,
  handleFilesWrite,
  handleGitChanges,
  handleGitDiff,
  handleGitInfo,
  handleMcpAdd,
  handleMcpDisable,
  handleMcpDiscover,
  handleMcpEnable,
  handleMcpList,
  handleMcpRemove,
  handleMcpRestart,
  handleMcpSleep,
  handleMcpUpdate,
  handleMcpWake,
  handleMemoryForget,
  handleMemoryList,
  handleMemoryRemember,
  handleShellOpen,
  handleSkillsContent,
  handleSkillsCreate,
  handleSkillsEdit,
  handleSkillsExport,
  handleSkillsInstall,
  handleSkillsUninstall,
  handleSkillsUpdate,
  type SkillsContext,
  type PromptsContext,
  handlePromptsList,
  handlePromptsSearch,
  handlePromptsContent,
  handlePromptsFavorite,
  handlePromptsCreate,
  handlePromptsUsed,
  handlePromptsRecent,
  type DesignContext,
  handleDesignList,
  handleDesignMaterialize,
  handleDesignSet,
  handleDesignUse,
  handleDesignState,
  handleDesignVerify,
  WorktreeWebSocketHandler,
} from '@wrongstack/webui/server';
import { WebSocket, WebSocketServer } from 'ws';
// PR 8 of Issue #30: extracted to `./webui-server/prefs-seeding.js`.
import { createPrefsSeeding, seedConfigToMeta } from './webui-server/prefs-seeding.js';
import {
  announceWebuiReady,
  createWebuiShutdown,
  registerWebuiInstance,
  registerWebuiSignalHandlers,
} from './webui-server/lifecycle.js';
// ── Console logger adapter for AutoPhaseWebSocketHandler ──────────────────────
// AutoPhaseWebSocketHandler requires a Logger. The CLI uses console.log/error
// directly, so we adapt that to the Logger interface expected by the handler.
// PR 1 of Issue #30: extracted to `./webui-server/logger-shim.js`.
import { consoleLogger } from './webui-server/logger-shim.js';
import { createProviderConfigStore, getVault } from './webui-server/provider-config.js';
import { createWebuiClientRegistration } from './webui-server/client-registration.js';
import { createSessionStartPayloadBuilder } from './webui-server/session-start-payload.js';
import { createStreamCoalescer } from './webui-server/stream-coalescer.js';
import { createSetupEvents } from './webui-server/setup-events.js';
import { startSessionStatusPoll } from './webui-server/session-status-poll.js';
import { createConnectionHandler, type ConnectedClient } from './webui-server/connection-handler.js';
import { startStaticServe } from './webui-server/static-serve.js';
import {
  type AgentConfigContext,
  type BrainHandlerContext,
  type ConnectionContext,
  type ContextHandlerContext,
  handleAbort,
  handleAutonomySwitch,
  handleBrainAsk,
  handleBrainRisk,
  handleBrainStatus,
  handleContextClear,
  handleContextCompact,
  handleContextDebug,
  handleContextModeCreate,
  handleContextModeDelete,
  handleContextModeSwitch,
  handleContextModesList,
  handleContextModeUpdate,
  handleContextRepair,
  handleDiagGet,
  handleGoalGet,
  broadcastSaved,
  handleKeyDelete,
  handleKeySetActive,
  handleKeyUpsert,
  handleModelRefine,
  handleModelSwitch,
  handleModeSwitch,
  handleModesList,
  handleOAuthCancel,
  handleOAuthCode,
  handleOAuthStart,
  handlePing,
  handlePlanGet,
  handlePlanItemUpdate,
  handlePlanTemplateUse,
  handlePrefsGet,
  handlePrefsUpdate,
  handleProcessKill,
  handleProcessKillAll,
  handleProcessList,
  handleProjectsAdd,
  handleProjectsList,
  handleProjectsSelect,
  handleProviderAdd,
  handleProviderClearModels,
  handleProviderModels,
  handleProviderProbe,
  handleProviderRemove,
  handleProvidersList,
  handleProvidersSaved,
  handleProviderUndoClear,
  handleProviderUpdate,
  handleSessionCheckpoints,
  handleSessionDelete,
  handleSessionNew,
  handleSessionResume,
  handleSessionRewind,
  handleSessionSave,
  handleSessionsList,
  handleSkillsList,
  handleStatsGet,
  handleTasksGet,
  handleTaskUpdate,
  handleTodosClear,
  handleTodosGet,
  handleTodosRemove,
  handleTodoUpdate,
  handleToolConfirmResult,
  handleToolsList,
  handleUserMessage,
  handleWorkingDirSet,
  type IntrospectionContext,
  type MailboxContext,
  type PendingConfirm,
  type PrefsContext,
  type ProjectsContext,
  type SessionsContext,
  type WorklistContext,
  type WsCommon,
  type WsHandlerContext,
} from './webui-server/ws-handlers/index.js';
import {
  handleMailboxAgents,
  handleMailboxClear,
  handleMailboxMessages,
  handleMailboxPurge,
} from './webui-server/ws-handlers/mailbox.js';

// Re-export types from webui for type checking
// At runtime, the actual types are resolved via workspace resolution

// WSServerMessage and WSClientMessage types (mirrors packages/webui/src/types.ts)
export interface WSServerMessage {
  type: string;
  payload: unknown;
}

export interface WSClientMessage {
  type: string;
  payload?: unknown | undefined;
}

/**
 * CLI-shaped webui options. Distinct from the standalone
 * `WebUIOptions` exported by `@wrongstack/webui/server` (which is the
 * type `startWebUI` accepts): the CLI builds its own agent/events/
 * session/etc. up front because the same instances power the
 * eternal-autonomy loop, and just hands the webui the surfaces it
 * needs. This type used to be called `WebUIOptions` too, which
 * caused a name collision with the standalone one whenever both
 * were imported into the same module (the CLI here imports from
 * `@wrongstack/webui/server` for shared helpers, so the collision
 * was a real source of confusion when reading this file).
 */
interface CliWebUIOptions {
  agent: Agent;
  events: EventBus;
  session: SessionWriter;
  /** WebSocket backend port. Defaults to 3457 (auto-advances if taken). */
  port?: number | undefined;
  /** Host/interface to bind HTTP and WS servers. Defaults to 127.0.0.1. */
  host?: string | undefined;
  /** HTTP port serving the React frontend. Defaults to 3456 (auto-advances). */
  httpPort?: number | undefined;
  /** Fixed access token/password. Defaults to WEBUI_TOKEN or random per process. */
  accessToken?: string | undefined;
  /** Browser-facing HTTP URL, used when WebUI is exposed behind a tunnel/proxy. */
  publicUrl?: string | undefined;
  /** Browser-facing WebSocket URL injected into the frontend. */
  publicWsUrl?: string | undefined;
  /** Force token/password protection even on loopback binds. */
  requireToken?: boolean | undefined;
  /** Project root — recorded in the running-instance registry. */
  projectRoot?: string | undefined;
  /** Full app config, used for HQ client publishing settings. */
  appConfig?: import('@wrongstack/core').Config | undefined;
  /** Pop the browser open to the served URL once the frontend is ready. */
  open?: boolean | undefined;
  /**
   * Fired once the WebSocket server is accepting connections. Useful for
   * callers (and tests) that must not connect before the server is ready —
   * port resolution now makes startup asynchronous, so a synchronous bind can
   * no longer be assumed.
   */
  onListening?: (info: { httpPort: number; wsPort: number; host: string; url: string }) => void;
  modelsRegistry?: ModelsRegistry | undefined;
  globalConfigPath?: string | undefined;
  /**
   * Live MCP registry — the SAME instance the agent loop and `/mcp` use. When
   * provided, the WebUI MCP settings panel can add/remove/enable/disable and
   * actually start/stop servers (not just edit config). Threaded in from the
   * CLI host (`execution.ts`), where the registry is constructed.
   */
  mcpRegistry?: MCPRegistry | undefined;
  /**
   * Subscribe to live per-iteration events from the eternal-autonomy
   * engine. When provided, the WebUI broadcasts each iteration to every
   * connected client. Observability-only — starting the loop still goes
   * through REPL/TUI or the `--eternal` flag (the WebUI has no slash
   * command dispatch surface yet).
   */
  subscribeEternalIteration?:
    | ((fn: (entry: import('@wrongstack/core').JournalEntry) => void) => () => void)
    | undefined;
  /** Callback to invoke when the WebUI is shut down by a client request. */
  onExit?: (() => void) | undefined;
  /**
   * Per-task agent factory (the host's director-backed `makeSubagentFactory`).
   * When present, the WebUI exposes the "New SDD Project" wizard, which runs the
   * same multi-agent fleet as `/sdd execute`. Omitted → wizard is unavailable.
   */
  sddSubagentFactory?: import('@wrongstack/core').AgentFactory | undefined;
  /** Session store — enables session.resume and session.delete from the WebUI. */
  sessionStore?: SessionStore | undefined;
  /** Host Brain arbiter (same instance bound at TOKENS.BrainArbiter). */
  brain?: BrainArbiter | undefined;
  /** Host brain settings — the SAME object /brain mutates (shared ceiling). */
  brainSettings?: { maxAutoRisk: BrainAutoRisk } | undefined;
  /** Read the host's rolling brain decision log (newest last, ≤20 entries). */
  getBrainLog?:
    | (() => Array<{ at: number; kind: string; question: string; outcome: string }>)
    | undefined;
  /**
   * Absolute path to the project's sessions directory (wpaths.projectSessions).
   * Used by checkpoint/rewind handlers to locate session JSONL files. When
   * absent, falls back to the legacy <projectRoot>/.wrongstack/sessions path.
   */
  sessionsDir?: string | undefined;
  /**
   * Called after session.resume swaps the active writer, with the new session
   * id. The host uses this to re-point crash-recovery state (active.json) at
   * the session that is now actually being written.
   */
  onSessionSwapped?: ((newSessionId: string) => void) | undefined;
  /** Memory store — enables the MemoryPanel (memory.list, memory.remember, memory.forget). */
  memoryStore?: MemoryStore | undefined;
  /** Skill loader — enables the SkillsPanel (skills.list). */
  skillLoader?: SkillLoader | undefined;
  /** Prompt loader — enables the prompt library (prompts.list/search/content/favorite/create). */
  promptLoader?: PromptLoader | undefined;
  /** Mode store — enables the ModePicker (modes.list, mode.switch). */
  modeStore?: ModeStore | undefined;
  /** Active agent mode id passed to the frontend via session.start. */
  modeId?: string | undefined;
  /**
   * Host callback invoked after model.switch resolves the active model's
   * context window. The CLI uses this to refresh the shared auto-compactor
   * denominator and context chip state.
   */
  onModelContextResolved?:
    | ((providerId: string, modelId: string, maxContext: number) => void)
    | undefined;
  /** When true, the frontend shows a provider/model setup screen instead of the chat. */
  needsSetup?: boolean | undefined;
  /**
   * Forward `autonomy.switch` to the CLI's real autonomy state (the same
   * setter the TUI/REPL use). Without it the switch only lands in
   * context.meta and the running loop never changes mode.
   */
  onAutonomySwitch?: ((mode: string) => void) | undefined;
  /** Forward browser YOLO changes to the host's live permission policy. */
  onYoloSwitch?: ((enabled: boolean) => void) | undefined;
}

// ConnectedClient is defined in ./webui-server/connection-handler.ts (PR 14
// of Issue #30) — imported below alongside createConnectionHandler.

export async function runWebUI(opts: CliWebUIOptions): Promise<void> {
  const host = opts.host ?? process.env['WEBUI_HOST'] ?? process.env['WS_HOST'] ?? '127.0.0.1';
  const publicUrl = opts.publicUrl ?? process.env['WEBUI_PUBLIC_URL'];
  const publicWsUrl = opts.publicWsUrl ?? process.env['WEBUI_PUBLIC_WS_URL'];
  const requireToken = opts.requireToken ?? envFlag('WEBUI_REQUIRE_TOKEN');
  const requestedWsPort = opts.port ?? 3457;
  const requestedHttpPort = opts.httpPort ?? 3456;
  // Auto-advance past busy ports (unless WEBUI_STRICT_PORT) so this works
  // alongside other WebUI instances. HTTP resolved first → tidy adjacent pairs.
  const strictPort =
    process.env['WEBUI_STRICT_PORT'] === '1' || process.env['WEBUI_STRICT_PORT'] === 'true';
  let httpPort = requestedHttpPort;
  let wsPort = requestedWsPort;
  if (!strictPort) {
    httpPort = await findFreePort(host, requestedHttpPort);
    wsPort = await findFreePort(host, requestedWsPort, { exclude: new Set([httpPort]) });
  }
  const port = wsPort; // existing WS code below refers to `port`
  const globalRoot = opts.globalConfigPath ? path.dirname(opts.globalConfigPath) : wstackGlobalRoot();
  // Per-connection message rate limit. OFF by default — this is a local,
  // single-user tool and the limit (which counted pings/list calls too) was
  // tripping during normal use. Opt back in by setting WEBUI_RATE_LIMIT to a
  // positive messages-per-60s number (useful only when exposing on a LAN).
  const rateLimitMax = Number.parseInt(process.env['WEBUI_RATE_LIMIT'] ?? '0', 10);
  const clients = new Map<WebSocket, ConnectedClient>();
  // Pending permission confirmations keyed by toolUseId. When the agent emits
  // tool.confirm_needed, we stash its resolver here and forward the prompt to
  // the browser; the client's tool.confirm_result resolves it. This is what
  // makes approvals appear in the WebUI instead of the terminal.
  const pendingConfirms = new Map<string, PendingConfirm>();
  const secretScrubber = new DefaultSecretScrubber();
  let abortController: AbortController | null = null;
  // Per-WebSocket abort controllers. The legacy single-slot `abortController`
  // above is the project-switch path's view (it always aborts the in-flight
  // run, no matter which socket initiated the switch) — kept for behavior
  // parity. The per-socket map scopes `case 'abort'` and `handleUserMessage`
  // so a second browser tab or a rapid same-tab abort cannot kill another
  // socket's run. Both are kept in sync.
  const abortControllers = new Map<WebSocket, AbortController>();

  // Custom context modes — file-backed (~/.wrongstack/custom-context-modes.json),
  // shared with the standalone server. Lazily loaded on first mode operation.
  let customModeStoreP: Promise<CustomModeStore> | null = null;
  const getCustomModeStore = (): Promise<CustomModeStore> => {
    customModeStoreP ??= (async () => {
      const store = createCustomModeStore(globalRoot);
      await store.load();
      return store;
    })();
    return customModeStoreP;
  };

  // AutoPhase handler — manages AutoPhase lifecycle via WS messages.
  // Initialized here so it can be used in the connection handler and message switch.
  const autoPhaseStoreDir = opts.projectRoot
    ? path.join(opts.projectRoot, '.wrongstack', 'autophase')
    : path.join(os.tmpdir(), '.wrongstack', 'autophase');
  const autoPhaseHandler = new AutoPhaseWebSocketHandler(
    opts.agent,
    opts.agent.ctx as Context,
    consoleLogger,
    autoPhaseStoreDir,
    opts.events,
    opts.projectRoot,
  );
  const worktreeHandler = new WorktreeWebSocketHandler(opts.events, consoleLogger);

  // Specs handler — FORGE-style dependency board over the shared per-project
  // SDD stores (where /sdd persists specs + task graphs).
  const specsPaths = opts.projectRoot
    ? resolveWstackPaths({ projectRoot: opts.projectRoot })
    : null;
  const specsHandler = new SpecsWebSocketHandler(
    specsPaths?.projectSpecs ?? path.join(os.tmpdir(), '.wrongstack', 'specs'),
    specsPaths?.projectTaskGraphs ?? path.join(os.tmpdir(), '.wrongstack', 'task-graphs'),
  );

  // SDD live board handler — same process as the run, so it streams instantly
  // off the shared EventBus (no disk polling) and steers via the control file.
  const sddBoardHandler = new SddBoardWebSocketHandler(
    specsPaths?.projectSddBoards ?? path.join(os.tmpdir(), '.wrongstack', 'sdd-boards'),
    opts.events,
  );

  // SDD wizard — interactive "New SDD Project" flow. Available only when the
  // host threaded its director-backed subagent factory (so the run uses the
  // same fleet as `/sdd execute`). The interview turns + run share that factory.
  const sddWizardHandler =
    opts.sddSubagentFactory && specsPaths
      ? new SddWizardWebSocketHandler(
          buildSddWizardDeps({
            agent: opts.agent,
            events: opts.events,
            projectRoot: opts.projectRoot ?? process.cwd(),
            subagentFactory: opts.sddSubagentFactory,
            paths: {
              projectSpecs: specsPaths.projectSpecs,
              projectTaskGraphs: specsPaths.projectTaskGraphs,
              projectSddBoards: specsPaths.projectSddBoards,
              projectDir: specsPaths.projectDir,
            },
          }),
        )
      : null;

  // ── Settings parity with the TUI ─────────────────────────────────────
  // Seed agent.ctx.meta from config.json on startup, then snapshot/persist
  // via the prefs handlers. Extracted to prefs-seeding.ts (PR 8 of Issue #30).
  await seedConfigToMeta(opts);
  if (typeof opts.agent.ctx?.meta?.['yolo'] === 'boolean') {
    opts.onYoloSwitch?.(opts.agent.ctx.meta['yolo']);
  }

  const { prefSnapshot, persistPrefs } = createPrefsSeeding(opts);

  // Captured once at startup so stats.get can report elapsed time since the
  // session was opened, rather than the hardcoded 0 it used to send.
  const sessionStartedAt = Date.now();

  // session.start payload builder — cost rates + max-context enrichment.
  // PR 11 of Issue #30: extracted to `./webui-server/session-start-payload.ts`.
  const buildSessionStartPayload = createSessionStartPayloadBuilder(opts);

  // ── Client (REPL/TUI/WebUI) registration ─────────────────────────────────
  // Mailbox presence + HQ telemetry for this WebUI instance. PR 10 of
  // Issue #30: extracted to `./webui-server/client-registration.ts`.
  const { register: registerWebuiClient, unregister: unregisterWebuiClient } =
    createWebuiClientRegistration({
      projectRoot: opts.projectRoot,
      appConfig: opts.appConfig,
      events: opts.events,
      hqSessionId: opts.session.id,
      getSessionId: () => opts.agent.ctx.session?.id ?? opts.session.id,
    });

  // Register immediately (fire-and-forget so it doesn't block server startup)
  registerWebuiClient();

  // Generate auth token for WS connections and HTTP /ws-auth endpoint.
  // The token is passed to the frontend via the URL query param, which the
  // frontend then exchanges for an HttpOnly cookie via /ws-auth?token=...
  // This closes C-598 (query-string token exposure) after the first request.
  const wsToken = resolveAuthToken(opts.accessToken);
  const publicHostnames = [publicUrl, publicWsUrl]
    .map((value) => {
      if (!value) return undefined;
      try {
        return new URL(value).hostname;
      } catch {
        return undefined;
      }
    })
    .filter((value): value is string => Boolean(value));
  const accessUrl = buildWebUIAccessUrl({
    host,
    port: httpPort,
    token: wsToken,
    publicUrl,
  });

  const wss = new WebSocketServer({ port, host, maxPayload: 1 * 1024 * 1024 });

  console.log(`[WebUI] WebSocket server starting on ws://${host}:${port}`);

  // Serve the React frontend over HTTP so `wrongstack --webui` is a one-command
  // launch (open the printed URL) instead of only a WS bridge. The dist
  // discovery + HTTP server bring-up live in
  // `webui-server/static-serve.ts`; we just hand it the options and
  // wire the open-browser callback on top. If the webui package
  // isn't built, `startStaticServe` returns null and we degrade
  // gracefully to WS-only (the original behavior).
  // Captured from the status block below so `POST /api/fleet/ping` can trigger
  // an immediate fleet re-broadcast (push-on-write from a TUI/REPL).
  let fleetBroadcastCli: (() => Promise<void>) | null = null;
  const httpServer = startStaticServe({
    host,
    httpPort,
    wsPort,
    globalRoot,
    onFleetPing: () => {
      void fleetBroadcastCli?.();
    },
    publicWsUrl,
    apiToken: wsToken,
    requireToken,
  });
  if (httpServer) {
    announceWebuiReady({
      server: httpServer.server,
      host,
      httpPort,
      wsPort,
      open: !!opts.open,
      wsToken,
      publicUrl,
    });
  } else {
    console.warn(
      `[WebUI] Frontend not served (run \`pnpm --filter @wrongstack/webui build\`). ` +
        `WS bridge still active on ws://${host}:${wsPort}.`,
    );
  }

  // Record this instance so it shows up in `wstackui --list` /
  // ~/.wrongstack/webui-instances.json alongside standalone instances.
  const registryBaseDir = globalRoot;
  if (opts.projectRoot) {
    registerWebuiInstance({
      pid: process.pid,
      host,
      httpPort,
      wsPort,
      publicUrl,
      projectRoot: opts.projectRoot,
      startedAt: new Date().toISOString(),
      registryBaseDir,
    });
  }
  // Auth token is delivered through the printed first-load URL and then
  // exchanged for an HttpOnly cookie by /ws-auth.

  // Subscribe to events once
  const eventUnsubscribers: Array<() => void> = [];

  const currentSessionId = (): string => opts.agent.ctx.session?.id ?? opts.session.id;
  const sessionPayload = <T extends Record<string, unknown>>(payload: T): T & { sessionId: string } => {
    const provided = payload['sessionId'];
    const sessionId = typeof provided === 'string' && provided.length > 0 ? provided : currentSessionId();
    return { ...payload, sessionId };
  };

  // Coalesce high-volume live events on the server before they hit every
  // connected browser tab. PR 9 of Issue #30: extracted to
  // `./webui-server/stream-coalescer.ts`.
  const {
    queueTextDelta,
    queueThinkingDelta,
    queueToolProgress,
    flushThinkingDelta,
    flushAllStreamBuffers,
  } = createStreamCoalescer({ broadcast, sessionPayload });

  // ── Event arming ─────────────────────────────────────────────────────────
  // Every EventBus → browser broadcast subscription (incl. the fleet
  // concurrency gauge state). PR 12 of Issue #30: extracted to
  // `./webui-server/setup-events.ts`.
  const setupEvents = createSetupEvents({
    events: opts.events,
    agent: opts.agent,
    subscribeEternalIteration: opts.subscribeEternalIteration,
    broadcast,
    sessionPayload,
    currentSessionId,
    queueTextDelta,
    queueThinkingDelta,
    queueToolProgress,
    flushThinkingDelta,
    flushAllStreamBuffers,
    pendingConfirms,
    secretScrubber,
    getClients: () => clients,
    eventUnsubscribers,
  });

  // Shared state for the extracted ws-handler groups (PR 5 of #30).
  // `send`/`broadcast` are hoisted function declarations, so capturing
  // them here is safe even though they're defined further down.
  const wsHandlerCtx: WsHandlerContext = {
    providerStore: createProviderConfigStore(
      opts.globalConfigPath,
      // Use the in-memory merged config providers so the WebUI sees the
      // same provider list the agent uses. Without this, providers stored
      // only in the project-local config (config.local.json) would be
      // invisible to the WebUI's saved-providers panel because the store
      // reads exclusively from the global config file.
      () => (opts.appConfig?.providers as Record<string, ProviderConfig> | undefined) ?? {},
    ),
    modelsRegistry: opts.modelsRegistry,
    send,
    broadcast,
    log: (m) => console.log(m),
  };

  // Hot-reload provider credentials when config.json changes on disk (another
  // terminal's `wstack auth`, a provider panel in a different window, or a
  // manual edit). Rebuild the live agent's provider so the next message uses
  // the new key without a server restart, and re-broadcast the saved-providers
  // projection so every connected panel re-renders. Mirrors the live-swap that
  // `handleModelSwitch` already does. Escape hatch: WRONGSTACK_DISABLE_CONFIG_WATCH=1.
  let credentialWatcherClose: (() => void) | undefined;
  if (opts.globalConfigPath && process.env['WRONGSTACK_DISABLE_CONFIG_WATCH'] !== '1') {
    let lastActiveCfg = JSON.stringify(
      opts.appConfig?.providers?.[opts.agent.ctx.provider.id] ?? null,
    );
    const watcher = watchProviderConfig(
      opts.globalConfigPath,
      getVault(opts.globalConfigPath),
      (snapshot) => {
        // Best-effort: refresh the in-memory providers ref the panel reads from
        // (skipped silently when appConfig is frozen — the broadcast below still
        // pushes the fresh map, so panels stay correct either way).
        try {
          if (opts.appConfig && !Object.isFrozen(opts.appConfig)) {
            opts.appConfig.providers = snapshot.providers;
          }
        } catch {
          /* frozen / read-only appConfig — ignore */
        }
        broadcastSaved(wsHandlerCtx, snapshot.providers);

        const activeId = opts.agent.ctx.provider.id;
        const newCfgStr = JSON.stringify(snapshot.providers[activeId] ?? null);
        if (newCfgStr === lastActiveCfg) return; // active provider creds unchanged
        lastActiveCfg = newCfgStr;
        try {
          const newCfg = snapshot.providers[activeId] ?? {
            type: activeId,
            ...(snapshot.apiKey !== undefined ? { apiKey: snapshot.apiKey } : {}),
            ...(snapshot.baseUrl !== undefined ? { baseUrl: snapshot.baseUrl } : {}),
          };
          const oldMax = opts.agent.ctx.provider.capabilities?.maxContext;
          const prov = makeProviderFromConfig(activeId, { ...newCfg, type: activeId });
          // Key-only change keeps the same model/context window — preserve the
          // resolved maxContext instead of falling back to the family default.
          if (oldMax != null && prov.capabilities) prov.capabilities.maxContext = oldMax;
          opts.agent.ctx.provider = prov;
          console.log(`[WebUI] Provider credentials reloaded from config.json (${activeId})`);
        } catch (err) {
          console.warn(
            `[WebUI] Credential hot-reload failed for ${activeId}: ${toErrorMessage(err)}`,
          );
        }
      },
      { warn: (m) => console.warn(`[WebUI] Config watcher: ${m}`) },
    );
    credentialWatcherClose = watcher.close;
  }

  const brainCtx: BrainHandlerContext = {
    brainSettings: opts.brainSettings,
    getBrainLog: opts.getBrainLog,
    // Prefer the host-supplied arbiter; otherwise resolve the one bound
    // in the agent container (if any). Mirrors the former inline lookup.
    resolveArbiter: () =>
      opts.brain ??
      (opts.agent.container.has(TOKENS.BrainArbiter)
        ? opts.agent.container.resolve(TOKENS.BrainArbiter)
        : undefined),
    getSessionId: currentSessionId,
    send,
    broadcast,
    log: (m) => console.log(m),
  };

  const introspectionCtx: IntrospectionContext = {
    agent: opts.agent,
    skillLoader: opts.skillLoader,
    modelsRegistry: opts.modelsRegistry,
    projectRoot: opts.projectRoot,
    sessionId: opts.session.id,
    sessionStartedAt,
    send,
    broadcast,
    log: (m) => console.log(m),
  };

  // Shared skills handlers context. The CLI passes its own skillLoader; the
  // installer (backing install/uninstall/update) is constructed here the same
  // way the standalone WebUI server does. Absent skillLoader ⇒ skills feature
  // disabled and the handlers respond with an "enabled: false" payload.
  const skillsProjectRoot =
    opts.projectRoot ?? (opts.agent.ctx as { projectRoot?: string }).projectRoot ?? '';
  const skillsPaths = skillsProjectRoot
    ? resolveWstackPaths({
        projectRoot: skillsProjectRoot,
        globalRoot,
      })
    : undefined;
  const skillsCtx: SkillsContext = {
    skillLoader: opts.skillLoader,
    skillInstaller: opts.skillLoader
      ? new SkillInstaller({
          manifestPath: path.join(
            skillsPaths?.globalRoot ?? wstackGlobalRoot(),
            'installed-skills.json',
          ),
          projectSkillsDir:
            skillsPaths?.inProjectSkills ?? path.join(skillsProjectRoot, '.wrongstack', 'skills'),
          globalSkillsDir: skillsPaths?.globalSkills ?? path.join(wstackGlobalRoot(), 'skills'),
          projectHash: skillsPaths?.projectHash ?? '',
          skillLoader: opts.skillLoader,
        })
      : undefined,
    projectRoot: skillsProjectRoot,
    projectSkillsDir: skillsPaths?.inProjectSkills,
    globalSkillsDir: skillsPaths?.globalSkills,
  };

  // Prompt library context — shared handlers, one source of truth with the
  // standalone server. Absent promptLoader ⇒ handlers respond "unavailable".
  const promptsCtx: PromptsContext = {
    promptLoader: opts.promptLoader,
    promptUsage: new PromptUsageStore(path.join(wstackGlobalRoot(), 'prompt-usage.json')),
  };

  // Design Studio context — same project root, live agent ctx so design.use
  // pins the active kit for the next turn.
  const designCtx: DesignContext = {
    projectRoot: skillsProjectRoot,
    agentMeta: opts.agent.ctx as unknown as { meta: Record<string, unknown> },
  };

  const worklistCtx: WorklistContext = {
    agent: opts.agent,
    sessionId: opts.session.id,
    send,
    broadcast,
    log: (m) => console.log(m),
  };

  const agentConfigCtx: AgentConfigContext = {
    agent: opts.agent,
    modeStore: opts.modeStore,
    globalConfigPath: opts.globalConfigPath,
    buildSessionStart: (overrides) => buildSessionStartPayload(overrides),
    modelsRegistry: opts.modelsRegistry,
    onMaxContextResolved: opts.onModelContextResolved,
    persistPrefs,
    send,
    broadcast,
    log: (m) => console.log(m),
  };

  const prefsCtx: PrefsContext = {
    agent: opts.agent,
    prefSnapshot,
    persistPrefs,
    onYoloSwitch: opts.onYoloSwitch,
    onAutonomySwitch: opts.onAutonomySwitch,
    pendingConfirms,
    send,
    broadcast,
    log: (m) => console.log(m),
  };

  // Project add/select are disabled in WebUI; `opts` remains shared because
  // projects.list and working_dir.set still read the live project root/config.
  const projectsCtx: ProjectsContext = {
    opts,
    abortControllers,
    abortLegacyRun: () => {
      if (abortController) {
        abortController.abort();
        abortController = null;
      }
    },
    buildSessionStart: (overrides) => buildSessionStartPayload(overrides),
    send,
    broadcast,
    log: (m) => console.log(m),
  };

  const contextHandlerCtx: ContextHandlerContext = {
    agent: opts.agent,
    buildSessionStart: (overrides) => buildSessionStartPayload(overrides),
    getCustomModeStore,
    send,
    broadcast,
    log: (m) => console.log(m),
  };

  // Bare messaging surface for handler groups that need no run-loop state.
  const wsCommon: WsCommon = { send, broadcast, log: (m) => console.log(m) };

  // Bare mailbox context for the mailbox ws-handlers (PR 8 of Issue #30).
  const mailboxCtx: MailboxContext = {
    agent: opts.agent as MailboxContext['agent'],
    globalConfigPath: opts.globalConfigPath ?? '',
    events: opts.events,
    send: send as unknown as (ws: unknown, msg: Record<string, unknown>) => void,
    broadcast: broadcast as unknown as (msg: Record<string, unknown>) => void,
    log: (m: string) => console.log(m),
  };

  // `opts` is passed by reference so the session handlers read live
  // agent.ctx.session / opts.sessionStore at call time.
  const sessionsCtx: SessionsContext = {
    opts,
    buildSessionStart: (overrides) => buildSessionStartPayload(overrides),
    send,
    broadcast,
    log: (m) => console.log(m),
  };

  // Connection-level cases (user_message/abort/ping/tool.confirm_result).
  // `opts` is by reference so `user_message` runs the live agent; the two
  // maps are the SAME instances the connection/close handlers mutate.
  const connectionCtx: ConnectionContext = {
    opts,
    abortControllers,
    pendingConfirms,
    send,
    broadcast,
    log: (m) => console.log(m),
  };
  const stopped = new Promise<void>((resolve) => {
    wss.on('listening', () => {
      console.log(`[WebUI] WebSocket server running on ws://${host}:${port}`);
      setupEvents();
      opts.onListening?.({ httpPort, wsPort, host, url: accessUrl });

      // ── Live session status poll ──────────────────────────────────
      // Cross-process SessionRegistry → sessions.status_update broadcasts
      // (5s fallback poll + fs.watch push). PR 13 of Issue #30: extracted
      // to `./webui-server/session-status-poll.ts`.
      if (globalRoot) {
        startSessionStatusPoll({
          globalRoot,
          broadcast,
          eventUnsubscribers,
          onBroadcastReady: (fn) => {
            fleetBroadcastCli = fn;
          },
        });
      }
    });

    // WebSocket connection handler — per-tab error handling, auth, client
    // registration, rate limiting, message dispatch, close cleanup, and the
    // initial session.start push. PR 14 of Issue #30: extracted to
    // `./webui-server/connection-handler.ts`.
    wss.on(
      'connection',
      createConnectionHandler({
        host,
        wsToken,
        requireToken,
        publicHostnames,
        publicWsUrl,
        clients,
        currentSessionId,
        autoPhaseHandler,
        specsHandler,
        sddBoardHandler,
        sddWizardHandler,
        worktreeHandler,
        rateLimitMax,
        send,
        sessionPayload,
        handleMessage,
        abortControllers,
        pendingConfirms,
        buildSessionStartPayload,
        needsSetup: opts.needsSetup ?? false,
      }),
    );

    wss.on('error', (err) => {
      console.error(
        JSON.stringify({
          level: 'error',
          event: 'webui_server.error',
          message: err instanceof Error ? err.message : String(err),
          timestamp: new Date().toISOString(),
        }),
      );
    });

    // Graceful shutdown (extracted to webui-server/lifecycle.ts, PR 7 of
    // #30). Idempotent: every runWebUI call registers its own SIGINT/SIGTERM
    // handlers, so a signal after this server already stopped (multiple
    // servers per process — tests, /webui restarts) must not re-run teardown
    // or fire a second unregister against a gone registry. The teardown
    // sequence (abort in-flight runs → unsubscribe events → close clients →
    // unregister → close HTTP/WS → resolve) lives in lifecycle.ts; the
    // run-loop state stays here and is threaded in as callbacks.
    const signalShutdown = createWebuiShutdown({
      abortInFlight: () => {
        // Both the legacy single slot (project-switch path) and every
        // per-socket controller must be aborted — they are independent.
        if (abortController) {
          abortController.abort();
          abortController = null;
        }
        for (const c of abortControllers.values()) c.abort();
        abortControllers.clear();
      },
      unsubscribeEvents: () => {
        flushAllStreamBuffers();
        for (const unsub of eventUnsubscribers) unsub();
      },
      closeClients: () => {
        for (const [ws] of clients) ws.close();
        clients.clear();
      },
      closeHttpServer: () => {
        httpServer?.server.close();
      },
      wss,
      pid: process.pid,
      registryBaseDir,
      onStopped: resolve,
    });

    registerWebuiSignalHandlers(signalShutdown);
  });

  // ── Message router ──────────────────────────────────────────────────
  // A declarative route table keyed by WSClientMessage['type']. Each entry
  // is a closure that captures the context objects in scope. Replaces the
  // former 112-case switch statement. Prefix-based handlers (autophase.*,
  // specs.*, sdd.*) fall through to the fallback chain in handleMessage().
  type WsRouteHandler = (msg: WSClientMessage, ws: WebSocket) => void | Promise<void>;
  const noop = () => {};
  const sessionBoundRouteTypes = new Set<string>([
    'user_message',
    'abort',
    'tool.confirm_result',
    'diag.get',
    'stats.get',
    'side_effects.list',
    'session.new',
    'session.resume',
    'session.save',
    'session.checkpoints',
    'session.rewind',
    'context.clear',
    'context.compact',
    'context.repair',
    'context.debug',
    'context.modes.list',
    'context.mode.switch',
    'context.mode.create',
    'context.mode.update',
    'context.mode.delete',
    'todos.get',
    'todos.clear',
    'todos.remove',
    'todo.update',
    'tasks.get',
    'task.update',
    'plan.get',
    'plan.template_use',
    'plan.item.update',
  ]);

  const requestedSessionId = (msg: WSClientMessage): string | undefined => {
    const payload = msg.payload;
    return payload && typeof payload === 'object' && typeof (payload as { sessionId?: unknown }).sessionId === 'string'
      ? (payload as { sessionId: string }).sessionId
      : undefined;
  };

  const ensureRouteSession = (ws: WebSocket, msg: WSClientMessage): boolean => {
    if (!sessionBoundRouteTypes.has(msg.type)) return true;
    const requested = requestedSessionId(msg);
    const current = currentSessionId();
    if (!requested || requested === current) return true;
    send(ws, {
      type: 'error',
      payload: sessionPayload({
        phase: msg.type,
        message: `Request targeted session ${requested}, but this WebUI runtime is currently on ${current}.`,
        requestedSessionId: requested,
      }),
    });
    return false;
  };

  const projectRootFor = () =>
    opts.projectRoot ?? (opts.agent.ctx as { projectRoot?: string }).projectRoot ?? '';

  /** Validate an `auth.oauth.*` message's `kind` field. */
  const oauthKindOf = (msg: unknown): 'chatgpt' | 'claude' | 'copilot' | null => {
    const kind = (msg as { payload?: { kind?: unknown } })?.payload?.kind;
    return kind === 'chatgpt' || kind === 'claude' || kind === 'copilot' ? kind : null;
  };

  const wsRoutes: Record<string, WsRouteHandler> = {
    // ── Core connection ──
    user_message: (msg, ws) =>
      handleUserMessage(
        connectionCtx,
        ws,
        (msg as { payload: { content: string } }).payload.content,
        (msg as { payload?: { sessionId?: string } }).payload?.sessionId,
      ),
    abort: (msg, ws) =>
      handleAbort(connectionCtx, ws, (msg as { payload?: { sessionId?: string } }).payload?.sessionId),
    ping: (_msg, ws) => handlePing(connectionCtx, ws),
    'tool.confirm_result': (msg, _ws) => {
      const { id, decision } = (
        msg as { payload: { id: string; decision: 'yes' | 'no' | 'always' | 'deny'; sessionId?: string } }
      ).payload;
      handleToolConfirmResult(
        connectionCtx,
        id,
        decision,
        (msg as { payload: { sessionId?: string } }).payload.sessionId,
      );
    },
    'webui.shutdown': () => {
      console.log('[WebUI] Shutdown requested from client');
      shutdown();
    },

    // ── Providers / keys ──
    'providers.list': (_msg, ws) => handleProvidersList(wsHandlerCtx, ws),
    'provider.models': (msg, ws) =>
      handleProviderModels(
        wsHandlerCtx,
        ws,
        (msg as { payload: { providerId: string } }).payload.providerId,
      ),
    'providers.saved': (_msg, ws) => handleProvidersSaved(wsHandlerCtx, ws),
    'key.add': (msg, ws) => {
      const m = msg as { payload: { providerId: string; label: string; apiKey: string } };
      handleKeyUpsert(wsHandlerCtx, ws, m.payload.providerId, m.payload.label, m.payload.apiKey);
    },
    'key.update': (msg, ws) => {
      const m = msg as { payload: { providerId: string; label: string; apiKey: string } };
      handleKeyUpsert(wsHandlerCtx, ws, m.payload.providerId, m.payload.label, m.payload.apiKey);
    },
    'key.delete': (msg, ws) => {
      const m = msg as { payload: { providerId: string; label: string } };
      handleKeyDelete(wsHandlerCtx, ws, m.payload.providerId, m.payload.label);
    },
    'key.set_active': (msg, ws) => {
      const m = msg as { payload: { providerId: string; label: string } };
      handleKeySetActive(wsHandlerCtx, ws, m.payload.providerId, m.payload.label);
    },
    'provider.add': (msg, ws) =>
      handleProviderAdd(
        wsHandlerCtx,
        ws,
        (msg as { payload: { id: string; family: string; baseUrl?: string; apiKey?: string } })
          .payload,
      ),
    'provider.remove': (msg, ws) =>
      handleProviderRemove(
        wsHandlerCtx,
        ws,
        (msg as { payload: { providerId: string } }).payload.providerId,
      ),
    'provider.clear_models': (msg, ws) =>
      handleProviderClearModels(
        wsHandlerCtx,
        ws,
        (msg as { payload: { providerId: string } }).payload.providerId,
      ),
    'provider.undo_clear': (msg, ws) => {
      const m = msg as { payload: { providerId: string; previousModels: string[] } };
      handleProviderUndoClear(wsHandlerCtx, ws, m.payload.providerId, m.payload.previousModels);
    },
    'provider.update': (msg, ws) =>
      handleProviderUpdate(
        wsHandlerCtx,
        ws,
        (
          msg as {
            payload: {
              id: string;
              family?: string;
              baseUrl?: string;
              envVars?: string[];
              models?: string[];
            };
          }
        ).payload,
      ),
    'provider.probe': (msg, ws) => {
      const m = msg as { payload: { providerId: string; timeoutMs?: number } };
      handleProviderProbe(wsHandlerCtx, ws, m.payload.providerId, m.payload.timeoutMs);
    },

    // ── Subscription OAuth login (ChatGPT / Claude / Copilot) ──
    'auth.oauth.start': (msg, ws) => {
      const kind = oauthKindOf(msg);
      if (kind) void handleOAuthStart(wsHandlerCtx, ws, kind);
    },
    'auth.oauth.code': (msg, ws) => {
      const kind = oauthKindOf(msg);
      const input = (msg as { payload?: { input?: unknown } }).payload?.input;
      if (kind && typeof input === 'string' && input.trim()) {
        void handleOAuthCode(wsHandlerCtx, ws, kind, input);
      }
    },
    'auth.oauth.cancel': (msg, ws) => {
      const kind = oauthKindOf(msg);
      if (kind) handleOAuthCancel(wsHandlerCtx, ws, kind);
    },

    // ── Todos / goals / plans / tasks ──
    'todos.get': (_msg, ws) => handleTodosGet(worklistCtx, ws),
    'todos.clear': (_msg, ws) => handleTodosClear(worklistCtx, ws),
    'todos.remove': (msg, ws) =>
      handleTodosRemove(
        worklistCtx,
        ws,
        msg.payload as { id?: string; index?: number } | undefined,
      ),
    'todo.update': (msg, ws) =>
      handleTodoUpdate(
        worklistCtx,
        ws,
        msg.payload as { id: string; status?: TodoItem['status']; activeForm?: string },
      ),
    'goal.get': (_msg, ws) => handleGoalGet(sessionsCtx, ws),
    'plan.get': (_msg, ws) => handlePlanGet(worklistCtx, ws),
    'plan.template_use': (msg, ws) =>
      handlePlanTemplateUse(
        worklistCtx,
        ws,
        (msg as { payload: { template: string } }).payload.template,
      ),
    'plan.item.update': (msg, ws) =>
      handlePlanItemUpdate(
        worklistCtx,
        ws,
        msg.payload as { target: string; status: 'open' | 'in_progress' | 'done' },
      ),
    'tasks.get': (_msg, ws) => handleTasksGet(worklistCtx, ws),
    'task.update': (msg, ws) =>
      handleTaskUpdate(
        worklistCtx,
        ws,
        msg.payload as {
          id: string;
          status: 'pending' | 'in_progress' | 'blocked' | 'failed' | 'review' | 'completed';
        },
      ),

    // ── Sessions ──
    'sessions.list': (msg, ws) =>
      handleSessionsList(
        sessionsCtx,
        ws,
        (msg as { payload?: { limit?: number } }).payload?.limit ?? 50,
      ),
    'session.new': (_msg, ws) => handleSessionNew(sessionsCtx, ws),
    'session.delete': (msg, ws) =>
      handleSessionDelete(sessionsCtx, ws, (msg as { payload: { id: string } }).payload.id),
    'session.save': (_msg, ws) => handleSessionSave(sessionsCtx, ws),
    'session.resume': (msg, ws) =>
      handleSessionResume(sessionsCtx, ws, (msg as { payload: { id: string } }).payload.id),
    'session.checkpoints': (_msg, ws) => handleSessionCheckpoints(sessionsCtx, ws),
    'session.rewind': (msg, ws) =>
      handleSessionRewind(
        sessionsCtx,
        ws,
        (msg as { payload: { checkpointIndex: number } }).payload.checkpointIndex,
      ),

    // ── Context ──
    'context.clear': (_msg, ws) => handleContextClear(contextHandlerCtx, ws),
    'context.debug': (_msg, ws) => handleContextDebug(contextHandlerCtx, ws),
    'context.compact': (msg, ws) =>
      handleContextCompact(
        contextHandlerCtx,
        ws,
        !!(msg as { payload?: { aggressive?: boolean } }).payload?.aggressive,
      ),
    'context.repair': (_msg, ws) => handleContextRepair(contextHandlerCtx, ws),
    'context.modes.list': (_msg, ws) => handleContextModesList(contextHandlerCtx, ws),
    'context.mode.switch': (msg, ws) =>
      handleContextModeSwitch(
        contextHandlerCtx,
        ws,
        (msg as { payload: { id: string } }).payload.id,
      ),
    'context.mode.create': (msg, ws) =>
      handleContextModeCreate(
        contextHandlerCtx,
        ws,
        (
          msg as {
            payload: {
              id: string;
              name: string;
              description: string;
              thresholds: { warn: number; soft: number; hard: number };
              preserveK: number;
              eliseThreshold: number;
            };
          }
        ).payload,
      ),
    'context.mode.update': (msg, ws) =>
      handleContextModeUpdate(
        contextHandlerCtx,
        ws,
        (
          msg as {
            payload: {
              id: string;
              name?: string;
              description?: string;
              thresholds?: { warn?: number; soft?: number; hard?: number };
              preserveK?: number;
              eliseThreshold?: number;
            };
          }
        ).payload,
      ),
    'context.mode.delete': (msg, ws) =>
      handleContextModeDelete(
        contextHandlerCtx,
        ws,
        (msg as { payload: { id: string } }).payload.id,
      ),

    // ── Agent config: modes / models ──
    'modes.list': (_msg, ws) => handleModesList(agentConfigCtx, ws),
    'mode.switch': (msg, ws) =>
      handleModeSwitch(agentConfigCtx, ws, (msg as { payload: { id: string } }).payload.id),
    'model.switch': (msg, ws) =>
      handleModelSwitch(
        agentConfigCtx,
        ws,
        (msg as { payload: { provider: string; model: string } }).payload,
      ),
    'model.refine': (msg, ws) =>
      handleModelRefine(agentConfigCtx, ws, (msg as { payload: { text: string } }).payload.text),

    // ── Process management ──
    'process.list': (_msg, ws) => handleProcessList(wsCommon, ws),
    'process.kill': (msg, ws) =>
      handleProcessKill(wsCommon, ws, (msg as { payload: { pid: number } }).payload.pid),
    'process.killAll': (_msg, ws) => handleProcessKillAll(wsCommon, ws),

    // ── Diagnostics / introspection ──
    'diag.get': (_msg, ws) => handleDiagGet(introspectionCtx, ws),
    'stats.get': (_msg, ws) => handleStatsGet(introspectionCtx, ws),
    'side_effects.list': (_msg, ws) => {
      const sideEffects = opts.agent.ctx.sideEffects ?? [];
      send(ws, {
        type: 'side_effects',
        payload: sessionPayload({
          sideEffects: sideEffects.slice(-50).map((se) => ({
            toolUseId: se.toolUseId,
            toolName: se.toolName,
            ts: se.ts,
            input: se.input,
            outcome: se.outcome,
            risk: se.risk,
          })),
        }),
      });
    },
    'tools.list': (_msg, ws) => handleToolsList(introspectionCtx, ws),

    // ── Autonomy ──
    'autonomy.switch': (msg, ws) =>
      handleAutonomySwitch(prefsCtx, ws, (msg as { payload: { mode: string } }).payload.mode),

    // ── Brain ──
    'brain.status': (_msg, ws) => handleBrainStatus(brainCtx, ws),
    'brain.risk': (msg, ws) =>
      handleBrainRisk(brainCtx, ws, (msg as { payload?: { level?: string } }).payload?.level ?? ''),
    'brain.ask': (msg, ws) =>
      handleBrainAsk(brainCtx, ws, (msg as { payload?: { question?: string } }).payload?.question),

    // ── Preferences ──
    'prefs.get': (_msg, ws) => handlePrefsGet(prefsCtx, ws),
    'prefs.update': (msg, ws) =>
      handlePrefsUpdate(prefsCtx, ws, (msg as { payload: Record<string, unknown> }).payload),

    // ── File operations (delegated to shared file-handlers.ts) ──
    'files.list': (msg, ws) => handleFilesList(ws, msg, projectRootFor()),
    'files.tree': (msg, ws) => handleFilesTree(ws, msg, projectRootFor()),
    'files.read': (msg, ws) => handleFilesRead(ws, msg, projectRootFor()),
    'files.write': (msg, ws) => handleFilesWrite(ws, msg, projectRootFor()),
    'completion.request': (msg, ws) =>
      handleCompletionRequest(ws, msg, {
        projectRoot: projectRootFor(),
        provider: opts.agent.ctx.provider,
        model: opts.agent.ctx.model,
        indexDir:
          typeof opts.agent.ctx.meta['codebaseIndexDir'] === 'string'
            ? opts.agent.ctx.meta['codebaseIndexDir']
            : undefined,
        lspCompletion: createToolLspCompletionSource(
          opts.agent.ctx.tools.find((tool) => tool.name === 'lsp_completion'),
          opts.agent.ctx,
        ),
      }),

    // ── Memory (guarded — opts.memoryStore may be undefined) ──
    'memory.list': (_msg, ws) => {
      if (!opts.memoryStore) {
        send(ws, {
          type: 'memory.list',
          payload: { text: '', error: 'Memory store not available' },
        });
        return;
      }
      return handleMemoryList(ws, opts.memoryStore);
    },
    'memory.remember': (msg, ws) => {
      if (!opts.memoryStore) {
        sendResult(ws, false, 'Memory store not available');
        return;
      }
      return handleMemoryRemember(ws, msg, opts.memoryStore);
    },
    'memory.forget': (msg, ws) => {
      if (!opts.memoryStore) {
        sendResult(ws, false, 'Memory store not available');
        return;
      }
      return handleMemoryForget(ws, msg, opts.memoryStore);
    },

    // ── MCP operations (shared handlers from @wrongstack/webui/server) ──
    'mcp.list': (msg, ws) => handleMcpList(ws, msg, opts.globalConfigPath ?? '', opts.mcpRegistry),
    'mcp.add': (msg, ws) => handleMcpAdd(ws, msg, opts.globalConfigPath ?? '', opts.mcpRegistry),
    'mcp.remove': (msg, ws) =>
      handleMcpRemove(ws, msg, opts.globalConfigPath ?? '', opts.mcpRegistry),
    'mcp.update': (msg, ws) =>
      handleMcpUpdate(ws, msg, opts.globalConfigPath ?? '', opts.mcpRegistry),
    'mcp.wake': (msg, ws) => handleMcpWake(ws, msg, opts.globalConfigPath ?? '', opts.mcpRegistry),
    'mcp.sleep': (msg, ws) =>
      handleMcpSleep(ws, msg, opts.globalConfigPath ?? '', opts.mcpRegistry),
    'mcp.discover': (msg, ws) =>
      handleMcpDiscover(ws, msg, opts.globalConfigPath ?? '', opts.mcpRegistry),
    'mcp.enable': (msg, ws) =>
      handleMcpEnable(ws, msg, opts.globalConfigPath ?? '', opts.mcpRegistry),
    'mcp.disable': (msg, ws) =>
      handleMcpDisable(ws, msg, opts.globalConfigPath ?? '', opts.mcpRegistry),
    'mcp.restart': (msg, ws) =>
      handleMcpRestart(ws, msg, opts.globalConfigPath ?? '', opts.mcpRegistry),

    // ── Skills ──
    'skills.list': (_msg, ws) => handleSkillsList(introspectionCtx, ws),
    'skills.content': (msg, ws) => handleSkillsContent(ws, skillsCtx, msg),
    'skills.install': (msg, ws) => handleSkillsInstall(ws, skillsCtx, msg),
    'skills.uninstall': (msg, ws) => handleSkillsUninstall(ws, skillsCtx, msg),
    'skills.update': (msg, ws) => handleSkillsUpdate(ws, skillsCtx, msg),
    'skills.create': (msg, ws) => handleSkillsCreate(ws, skillsCtx, msg),
    'skills.edit': (msg, ws) => handleSkillsEdit(ws, skillsCtx, msg),
    'skills.export': (_msg, ws) => handleSkillsExport(ws, skillsCtx),

    // ── Prompt library ──
    'prompts.list': (_msg, ws) => handlePromptsList(ws, promptsCtx),
    'prompts.search': (msg, ws) => handlePromptsSearch(ws, promptsCtx, msg),
    'prompts.content': (msg, ws) => handlePromptsContent(ws, promptsCtx, msg),
    'prompts.favorite': (msg, ws) => handlePromptsFavorite(ws, promptsCtx, msg),
    'prompts.create': (msg, ws) => handlePromptsCreate(ws, promptsCtx, msg),
    'prompts.used': (msg, ws) => handlePromptsUsed(ws, promptsCtx, msg),
    'prompts.recent': (_msg, ws) => handlePromptsRecent(ws, promptsCtx),

    // ── Design Studio ──
    'design.list': (_msg, ws) => handleDesignList(ws, designCtx),
    'design.use': (msg, ws) => handleDesignUse(ws, designCtx, msg),
    'design.state': (_msg, ws) => handleDesignState(ws, designCtx),
    'design.set': (msg, ws) => handleDesignSet(ws, designCtx, msg),
    'design.materialize': (msg, ws) => handleDesignMaterialize(ws, designCtx, msg),
    'design.verify': (_msg, ws) => handleDesignVerify(ws, designCtx),

    // ── Projects / working dir ──
    'projects.list': (_msg, ws) => handleProjectsList(projectsCtx, ws),
    'projects.select': (msg, ws) =>
      handleProjectsSelect(
        projectsCtx,
        ws,
        (msg as { payload: { root: string; name?: string } }).payload,
      ),
    'projects.add': (msg, ws) =>
      handleProjectsAdd(
        projectsCtx,
        ws,
        (msg as { payload: { root: string; name?: string } }).payload,
      ),
    'working_dir.set': (msg, ws) =>
      handleWorkingDirSet(projectsCtx, ws, (msg as { payload: { path: string } }).payload.path),

    // ── Git ──
    'git.changes': (_msg, ws) => handleGitChanges(ws, projectRootFor()),
    'git.diff': (msg, ws) =>
      handleGitDiff(
        ws,
        projectRootFor(),
        (msg as { payload?: { path?: string } }).payload?.path ?? '',
      ),
    'git.info': (_msg, ws) => handleGitInfo(ws, projectRootFor()),

    // ── Shell ──
    'shell.open': async (msg, ws) => {
      const result = await handleShellOpen(
        msg.payload as Parameters<typeof handleShellOpen>[0],
        consoleLogger,
      );
      sendResult(ws, result.success, result.message);
    },

    // ── Mailbox ──
    'mailbox.messages': (msg, ws) =>
      handleMailboxMessages(mailboxCtx, msg as Parameters<typeof handleMailboxMessages>[1], ws),
    'mailbox.agents': (msg, ws) =>
      handleMailboxAgents(mailboxCtx, msg as Parameters<typeof handleMailboxAgents>[1], ws),
    'mailbox.clear': (_msg, ws) => handleMailboxClear(mailboxCtx, ws),
    'mailbox.purge': (msg, ws) =>
      handleMailboxPurge(mailboxCtx, msg as Parameters<typeof handleMailboxPurge>[1], ws),

    // ── Silent no-ops (standalone server wires real handlers) ──
    'collab.join': noop,
    'collab.leave': noop,
    'collab.annotate': noop,
    'collab.resolve': noop,
    'collab.request_pause': noop,
    'collab.resume': noop,
    'collab.grant_control': noop,
    'collab.inject_tool': noop,
    'terminal.create': noop,
    'terminal.input': noop,
    'terminal.resize': noop,
    'terminal.close': noop,
  };

  async function handleMessage(
    ws: WebSocket,
    _client: ConnectedClient,
    msg: WSClientMessage,
  ): Promise<void> {
    if (!ensureRouteSession(ws, msg)) return;
    const handler = wsRoutes[msg.type];
    if (handler) {
      await handler(msg, ws);
      return;
    }
    // ── Prefix-based fallback for delegated handlers ──
    const msgType = (msg as { type: string }).type;
    if (msgType.startsWith('autophase.')) {
      await autoPhaseHandler.handleMessage(
        msg as { type: string; payload?: Record<string, unknown> },
      );
    } else if (msgType.startsWith('specs.')) {
      await specsHandler.handleMessage(msg as { type: string; payload?: Record<string, unknown> });
    } else if (msgType.startsWith('sdd.board.')) {
      await sddBoardHandler.handleMessage(
        msg as { type: string; payload?: Record<string, unknown> },
      );
    } else if (msgType.startsWith('sdd.spec.') || msgType.startsWith('sdd.run.')) {
      await sddWizardHandler?.handleMessage(
        msg as { type: string; payload?: Record<string, unknown> },
      );
    } else if (msgType.startsWith('worktree.')) {
      await worktreeHandler.handleMessage(msg as { type: string; payload?: Record<string, unknown> });
    } else {
      console.debug(`[WebUI] Unhandled message type: ${msgType}`);
    }
  }

  function send(ws: WebSocket, msg: WSServerMessage): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }

  function shutdown(): void {
    console.log('[WebUI] Shutting down...');
    credentialWatcherClose?.();
    flushAllStreamBuffers();
    worktreeHandler.dispose();
    unregisterWebuiClient();
    httpServer?.server.close();
    opts.onExit?.();
  }

  function broadcast(msg: WSServerMessage): void {
    const data = JSON.stringify(msg);
    for (const [ws] of clients) {
      if (ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(data);
        } catch {
          // Client disconnected between the readyState check and the send
          // — let the 'close' handler remove it from the map naturally.
        }
      }
    }
  }

  // ---- Config I/O helpers (delegated to webui-server/provider-config) ----

  function sendResult(ws: WebSocket, success: boolean, message: string): void {
    send(ws, { type: 'key.operation_result', payload: { success, message } });
  }

  return stopped;
} // end of runWebUI
