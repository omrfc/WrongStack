import * as fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import {
  Agent,
  AgentStatusTracker,
  AnnotationsStore,
  AutoCompactionMiddleware,
  applyToolDescriptionModes,
  applyToolResultRenderModes,
  atomicWrite,
  type BrainArbiter,
  type BrainAutoRisk,
  BrainMonitor,
  CollaborationBus,
  Context,
  cleanupStaleSddWorktrees,
  collabInjectMiddleware,
  collabPauseMiddleware,
  createAutonomyBrain,
  createDefaultPipelines,
  createSessionEventBridge,
  createStrategyCompactor,
  createTieredBrainArbiter,
  DEFAULT_CONTEXT_WINDOW_MODE_ID,
  DEFAULT_SESSION_PRUNE_DAYS,
  DEFAULT_TOOLS_CONFIG,
  DefaultBrainArbiter,
  DefaultMemoryStore,
  DefaultModelsRegistry,
  DefaultModeStore,
  DefaultPromptLoader,
  DefaultSessionReader,
  DefaultSessionStore,
  DefaultSkillLoader,
  DefaultSystemPromptBuilder,
  DefaultTokenCounter,
  EventBus,
  enhanceUserPrompt,
  estimateRequestTokensCalibrated,
  expectDefined,
  FleetNotifier,
  GlobalMailbox,
  gatedEnhancerReasoning,
  getSessionRegistry,
  installDesignStudioMiddleware,
  mailboxSessionTag,
  makeMailboxTool,
  makeMailInboxTool,
  makeMailSendTool,
  ObservableBrainArbiter,
  PromptUsageStore,
  type Provider,
  type ProviderConfig,
  ProviderRegistry,
  recentTextTurns,
  resolveContextWindowPolicy,
  resolveProjectDir,
  resolveProviderModelList,
  resolveSessionLoggingConfig,
  TOKENS,
  ToolRegistry,
  watchProviderConfig,
} from '@wrongstack/core';
import { readLiveLock } from '@wrongstack/core/coordination';
import { ToolExecutor } from '@wrongstack/core/execution';
import { decryptConfigSecrets, encryptConfigSecrets } from '@wrongstack/core/security';
import { SkillInstaller } from '@wrongstack/core/skills';
import { projectHash, toErrorMessage, wstackGlobalRoot } from '@wrongstack/core/utils';
import { MCPRegistry } from '@wrongstack/mcp';
import { buildProviderFactoriesFromRegistry, makeProviderFromConfig } from '@wrongstack/providers';
import { createDefaultContainer, makeLightSubagentFactory } from '@wrongstack/runtime';
import {
  builtinToolsPack,
  configureExecPolicy,
  ensureSessionShell,
  forgetTool,
  relatedMemoryTool,
  rememberTool,
  searchMemoryTool,
} from '@wrongstack/tools';
import { WebSocket, WebSocketServer } from 'ws';
import { type AutoPhaseRouteHandlers, handleAutoPhaseRoute } from './autophase-routes.js';
import { AutoPhaseWebSocketHandler } from './autophase-ws-handler.js';
import { bootConfig, patchConfig } from './boot.js';
import { createAgentServices } from './backend-services.js';
import { seedContextMeta } from './context-meta.js';
import { createConnectionHandler } from './connection-handler.js';
import { createMessageDispatcher } from './message-dispatcher.js';
import {
  persistPrefsToConfig as persistPrefsToConfigImpl,
  prefSnapshot as prefSnapshotImpl,
  updateGlobalConfig as updateGlobalConfigImpl,
  type PrefHelperDeps,
  type ConfigWriteLockHolder,
} from './pref-helpers.js';
import { resolveSetupProvider } from './setup-screen.js';
import { type BrainRouteHandlers, handleBrainRoute } from './brain-routes.js';
import { setupWebUICodebaseIndexing } from './codebase-indexing.js';
import { CollaborationWebSocketHandler } from './collaboration-ws-handler.js';
import { createToolLspCompletionSource, handleCompletionRequest } from './completion-handlers.js';
import { createCustomModeStore } from './custom-context-modes.js';
import {
  handleDesignList,
  handleDesignMaterialize,
  handleDesignSet,
  handleDesignState,
  handleDesignUse,
  handleDesignVerify,
} from './design-handlers.js';
import { discoverMailboxBridgeForWebui } from './discover-mailbox-bridge.js';
import { createEternalSubscription } from './eternal-iteration-broadcast.js';
import {
  handleFilesList,
  handleFilesRead,
  handleFilesTree,
  handleFilesWrite,
} from './file-handlers.js';
import { handleGitChanges, handleGitDiff, handleGitInfo } from './git-handlers.js';
import { handleGoalGet } from './goal-handlers.js';
import {
  handleWorklistMessage,
  type WorklistContext,
  type WorklistMessage,
} from './handlers/index.js';
import { createHttpServer } from './http-server.js';
import { registerInstance, unregisterInstance } from './instance-registry.js';
import { registerShutdownHandlers } from './lifecycle.js';
import {
  handleMailboxAgents,
  handleMailboxClear,
  handleMailboxMessages,
  handleMailboxPurge,
} from './mailbox-handlers.js';
import { handleMailboxRoute, type MailboxRouteHandlers } from './mailbox-routes.js';
import {
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
} from './mcp-handlers.js';
import { handleMcpRoute, type McpRouteHandlers } from './mcp-routes.js';
import { handleMemoryForget, handleMemoryList, handleMemoryRemember } from './memory-handlers.js';
import { createModeHandlers } from './mode-handlers.js';
import { handleModeRoute, type ModeRouteHandlers } from './mode-routes.js';
import { openBrowser } from './open-browser.js';
import { findFreePort } from './port-utils.js';
import { handlePrefsRoute, type PrefsRouteHandlers } from './prefs-routes.js';
import { handleProcessKill, handleProcessKillAll, handleProcessList } from './process-handlers.js';
import { createProjectHandlers } from './project-handlers.js';
import { handleProjectRoute, type ProjectRouteHandlers } from './project-routes.js';
import {
  ensureProjectDataDir,
  generateProjectSlug,
  loadManifest,
  saveManifest,
} from './projects-manifest.js';
import {
  handlePromptsContent,
  handlePromptsCreate,
  handlePromptsFavorite,
  handlePromptsList,
  handlePromptsRecent,
  handlePromptsSearch,
  handlePromptsUsed,
} from './prompts-handlers.js';
import { createProviderHandlers, projectSavedProviders } from './provider-handlers.js';
import { maskedKey, normalizeKeys } from './provider-keys.js';
import { handleProviderRoute, type ProviderRouteHandlers } from './provider-routes.js';
import {
  buildRoutes,
  type WebuiCallbacks,
  type WebuiDeps,
  type WebuiMutableState,
} from './routes.js';
import { handleSddBoardRoute, type SddBoardRouteHandlers } from './sdd-board-routes.js';
import { SddBoardWebSocketHandler } from './sdd-board-ws-handler.js';
import { handleSddWizardRoute, type SddWizardRouteHandlers } from './sdd-wizard-routes.js';
import { buildSddWizardDeps } from './sdd-wizard-wiring.js';
import { SddWizardWebSocketHandler } from './sdd-wizard-ws-handler.js';
import { createSessionHandlers } from './session-handlers.js';
import { handleSessionRoute, type SessionRouteHandlers } from './session-routes.js';
import { type FileWatcherMetrics, setupEvents } from './setup-events.js';
import { handleShellGitRoute, type ShellGitRouteHandlers } from './shell-git-routes.js';
import { handleShellOpen, type ShellOpenRequest, type ShellOpenResult } from './shell-open.js';
import {
  handleSkillsContent,
  handleSkillsCreate,
  handleSkillsEdit,
  handleSkillsExport,
  handleSkillsInstall,
  handleSkillsList,
  handleSkillsUninstall,
  handleSkillsUpdate,
} from './skills-handlers.js';
import { handleSpecsRoute, type SpecsRouteHandlers } from './specs-routes.js';
import { SpecsWebSocketHandler } from './specs-ws-handler.js';
import { TerminalWebSocketHandler } from './terminal-ws-handler.js';
import { computeUsageCost, getCostRates } from './usage-cost.js';
import { WorktreeWebSocketHandler } from './worktree-ws-handler.js';
import { verifyClient as verifyWsClient } from './ws-auth.js';
import {
  validateAutonomySwitchPayload,
  validateBrainAskPayload,
  validateBrainRiskPayload,
  validateGitDiffPayload,
  validateMailboxAgentsPayload,
  validateMailboxMessagesPayload,
  validateMailboxPurgePayload,
  validateModelSwitchPayload,
  validatePrefsUpdatePayload,
  validateShellOpenPayload,
} from './ws-payload-validation.js';
import {
  broadcast,
  buildWebUIAccessUrl,
  envFlag,
  errMessage,
  resolveAuthToken,
  send,
  sendResult,
} from './ws-utils.js';

// AutoPhase WebSocket handler — manages AutoPhase lifecycle via WS messages.
// Exported so the CLI's embedded webui-server can also handle autophase.*
// messages when running in --webui mode.
export { AutoPhaseWebSocketHandler } from './autophase-ws-handler.js';
export {
  type CompletionHandlerOptions,
  type CompletionItemKind,
  type CompletionSuggestion,
  createToolLspCompletionSource,
  handleCompletionRequest,
  type LspCompletionSource,
  type LspCompletionSourceRequest,
} from './completion-handlers.js';
// Custom context-mode store shared with the CLI's embedded server
// (context.mode.create/update/delete + custom-aware list/switch).
export {
  type CustomContextMode,
  type CustomModeStore,
  createCustomModeStore,
} from './custom-context-modes.js';
// Design Studio handlers — shared so the CLI's embedded server reaches parity.
export {
  type DesignContext,
  handleDesignList,
  handleDesignMaterialize,
  handleDesignSet,
  handleDesignState,
  handleDesignUse,
  handleDesignVerify,
} from './design-handlers.js';
// WebSocket utilities shared with CLI
export {
  createEternalSubscription,
  type EternalBroadcast,
  type EternalSubscribe,
  type EternalSubscription,
} from './eternal-iteration-broadcast.js';
// File operation handlers shared with CLI (files.tree, files.read, files.write, files.list)
export {
  handleFilesList,
  handleFilesRead,
  handleFilesTree,
  handleFilesWrite,
} from './file-handlers.js';
// Git info handler shared with CLI (git.info) — single source so the two
// servers can't drift on ahead/behind / insertion-deletion parsing.
export { handleGitChanges, handleGitDiff, handleGitInfo } from './git-handlers.js';
export type { CreateHttpServerOptions } from './http-server.js';
// Re-export the static-serve + multi-instance building blocks so other packages
// (the CLI's `--webui` mode) can serve the same React frontend, inject the live
// WS port, pick free ports, and register in the shared instance registry —
// without duplicating any of that logic.
export { buildCspHeader, createHttpServer, injectWsPort } from './http-server.js';
export {
  defaultBaseDir,
  formatInstances,
  listInstances,
  registerInstance,
  registryPath,
  unregisterInstance,
  type WebUIInstanceRecord,
} from './instance-registry.js';
// MCP operation handlers shared with CLI (mcp.list, mcp.add, mcp.remove, etc.)
export {
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
} from './mcp-handlers.js';
// Memory operation handlers shared with CLI (memory.list, memory.remember, memory.forget)
export {
  handleMemoryForget,
  handleMemoryList,
  handleMemoryRemember,
} from './memory-handlers.js';
export { browserOpenCommand, openBrowser } from './open-browser.js';
export { findFreePort, isPortFree } from './port-utils.js';
// Shared prompt-library handlers — one source of truth for both servers.
export {
  handlePromptsContent,
  handlePromptsCreate,
  handlePromptsFavorite,
  handlePromptsList,
  handlePromptsRecent,
  handlePromptsSearch,
  handlePromptsUsed,
  type PromptsContext,
} from './prompts-handlers.js';
// Provider config load/save (decrypt from / encrypt to global config)
export {
  createProviderConfigIO,
  loadSavedProviders,
  saveProviders,
} from './provider-config-io.js';
// Provider/API-key record transforms (pure functions, testable without I/O)
export {
  addProvider,
  deleteKey,
  type KeyOpResult,
  maskedKey,
  normalizeKeys,
  type ProvidersRecord,
  removeProvider,
  setActiveKey,
  upsertKey,
  writeKeysBack,
} from './provider-keys.js';
export { SddBoardWebSocketHandler } from './sdd-board-ws-handler.js';
export { buildSddWizardDeps, type SddWizardWiringOptions } from './sdd-wizard-wiring.js';
export { type SddWizardDeps, SddWizardWebSocketHandler } from './sdd-wizard-ws-handler.js';
export {
  handleShellOpen,
  type ShellOpenRequest,
  type ShellOpenResult,
  type ShellOpenTarget,
} from './shell-open.js';
// Shared skills WebSocket handlers — one source of truth for both this
// standalone server and the CLI's embedded --webui server. The CLI imports
// these so skills.content / install / uninstall / update / create / edit /
// export are handled there too (they previously fell through to the
// "Unhandled message type" warning).
export {
  handleSkillsContent,
  handleSkillsCreate,
  handleSkillsEdit,
  handleSkillsExport,
  handleSkillsInstall,
  handleSkillsUninstall,
  handleSkillsUpdate,
  type SkillsContext,
} from './skills-handlers.js';
export { SpecsWebSocketHandler } from './specs-ws-handler.js';
// Token estimator primitives — exposed for the CLI's embedded webui
// (which historically inlined its own copy and let it drift). Now
// there's exactly one definition. See
// packages/cli/src/webui-server.ts Phase 2 of the refactor plan.
export {
  type ContextBreakdown,
  estimateTokens,
  type MessageTokenEntry,
  messagePreview,
  messageTokens,
  stringifyContent,
  type ToolTokenEntry,
} from './token-estimator.js';
// Re-export types — shared message shapes and options used by both the
// standalone server and the CLI's `--webui` embedded mode.
export type {
  BackendServices,
  ConnectedClient,
  WebUIOptions,
  WSClientMessage,
  WSServerMessage,
} from './types.js';
export { WorktreeWebSocketHandler } from './worktree-ws-handler.js';
// WS auth — pure functions for verifying WebSocket connections
export {
  extractToken,
  hostHeaderOk,
  isLoopbackBind,
  isLoopbackHostname,
  tokenMatches,
  type VerifyClientInput,
  verifyClient,
} from './ws-auth.js';
export {
  broadcast,
  buildWebUIAccessUrl,
  envFlag,
  errMessage,
  generateAuthToken,
  hostForBrowserUrl,
  resolveAuthToken,
  send,
  sendResult,
} from './ws-utils.js';

// Message + client shapes now live in ./types.ts (shared with the CLI's
// embedded server). Imported here for internal use; re-exported above for
// external consumers. The previous local copies shadowed these and made the
// `Map<WebSocket, ConnectedClient>` passed to the extracted ws-utils helpers
// nominally distinct, which TS rejected.
import type { ConnectedClient, WebUIOptions, WSClientMessage } from './types.js';

export async function startWebUI(
  opts: WebUIOptions & {
    wsPort?: number | undefined;
    wsHost?: string | undefined;
    httpPort?: number | undefined;
    accessToken?: string | undefined;
    publicUrl?: string | undefined;
    publicWsUrl?: string | undefined;
    requireToken?: boolean | undefined;
    open?: boolean | undefined;
  } = {},
): Promise<void> {
  // Pin one stable shell for the session on Windows (PowerShell by default) via
  // WRONGSTACK_SHELL before the system-prompt builder is constructed below, so
  // the model is told exactly which shell + syntax to use. No-op on POSIX / when
  // the user already set WRONGSTACK_SHELL.
  ensureSessionShell();

  const requestedWsPort = opts.wsPort ?? 3457;
  // Bind to loopback IP by default (not the string "localhost", which on some
  // hosts resolves to IPv6 ::1 and surprises older WS clients). Set WS_HOST or
  // pass opts.wsHost to override (e.g. "0.0.0.0" for LAN access).
  const wsHost = opts.wsHost ?? process.env['WEBUI_HOST'] ?? process.env['WS_HOST'] ?? '127.0.0.1';
  const requestedHttpPort =
    opts.httpPort ??
    opts.webuiPort ??
    opts.port ??
    Number.parseInt(process.env['WEBUI_PORT'] ?? process.env['PORT'] ?? '3456', 10);
  const publicUrl = opts.publicUrl ?? process.env['WEBUI_PUBLIC_URL'];
  const publicWsUrl = opts.publicWsUrl ?? process.env['WEBUI_PUBLIC_WS_URL'];
  const requireToken = opts.requireToken ?? envFlag('WEBUI_REQUIRE_TOKEN');

  // Port resolution. Unless WEBUI_STRICT_PORT is set, auto-advance past any port
  // already taken by another instance so running `wstackui` several times "just
  // works" — the real ports are then stamped into the served HTML and the
  // instance registry. Strict mode keeps the requested ports and lets bind fail
  // loudly (useful behind a reverse proxy that expects fixed ports).
  const strictPort =
    process.env['WEBUI_STRICT_PORT'] === '1' || process.env['WEBUI_STRICT_PORT'] === 'true';
  let wsPort = requestedWsPort;
  let httpPort = requestedHttpPort;
  if (!strictPort) {
    // Resolve HTTP first, then WS excluding it, so successive instances land on
    // tidy adjacent pairs (3456/3457, 3458/3459, …) instead of interleaving.
    httpPort = await findFreePort(wsHost, requestedHttpPort);
    wsPort = await findFreePort(wsHost, requestedWsPort, { exclude: new Set([httpPort]) });
    if (httpPort !== requestedHttpPort) {
      console.warn(
        JSON.stringify({
          level: 'warn',
          event: 'webui.port_reassigned',
          protocol: 'HTTP',
          requested: requestedHttpPort,
          assigned: httpPort,
          timestamp: new Date().toISOString(),
        }),
      );
    }
    if (wsPort !== requestedWsPort) {
      console.warn(
        JSON.stringify({
          level: 'warn',
          event: 'webui.port_reassigned',
          protocol: 'WS',
          requested: requestedWsPort,
          assigned: wsPort,
          timestamp: new Date().toISOString(),
        }),
      );
    }
  }

  console.log('[WebUI] Starting backend services...');

  // Boot configuration
  const boot = await bootConfig();
  const { config: baseConfig, globalConfigPath, wpaths, logger } = boot;
  // PR 5 of Phase 2: when the caller (typically the CLI) supplies a
  // pre-built `BackendServices`, prefer its `vault` over the one the
  // default boot would construct. This lets `runWebUI` keep owning the
  // vault lifecycle (so it can decrypt/encrypt its own config writes
  // in lockstep with the rest of the CLI session) instead of having
  // the webui build a parallel vault it can never see.
  const vault = opts.services?.vault ?? boot.vault;
  let config = baseConfig;

  /** Mutable project root — updated on `projects.select`. File handlers,
   *  sessionStartPayload, and session store use this value. */
  let projectRoot = boot.projectRoot;
  /** Mutable working directory — starts at projectRoot, changeable via
   *  `working_dir.set` WS message. Must always stay inside projectRoot. */
  let workingDir = projectRoot;

  // Serialize concurrent config writes to prevent races between model.switch
  // and key.add/key.update handlers that both read-modify-write globalConfigPath.
  // Held in a mutable object so the pref-helpers (./pref-helpers.ts, Phase 1c)
  // can update the lock in place — TypeScript flattens Promise<Promise<void>>,
  // so we can't return the new lock from an async helper.
  const configWriteLock: ConfigWriteLockHolder = { lock: Promise.resolve() };

  // Unified global config mutation: read → decrypt → mutate → encrypt → write,
  // serialized behind configWriteLock. Implementation lives in
  // ./pref-helpers.ts; this thin wrapper preserves the two-arg signature the
  // route layer (provider routes, key handlers) expects.
  const prefHelperDeps: PrefHelperDeps = { globalConfigPath, vault, logger };
  const updateGlobalConfig = async (
    mutate: (cfg: Record<string, unknown>) => void,
    errorLabel: string,
  ): Promise<void> => updateGlobalConfigImpl(prefHelperDeps, configWriteLock, mutate, errorLabel);

  console.log('[WebUI] Config loaded:', config.provider ?? '(none)', '/', config.model ?? '(none)');

  // If no active provider is set but there are saved providers, pick the first one.
  // This handles configs written in older formats or by external tools.
  // Guard against config.providers being a string or other non-object value
  // (e.g., from a corrupted config or YAML parser misreading the value).
  if (
    !config.provider &&
    config.providers &&
    typeof config.providers === 'object' &&
    config.providers !== null &&
    !Array.isArray(config.providers) &&
    Object.keys(config.providers).length > 0
  ) {
    const firstKey = expectDefined(Object.keys(config.providers)[0]);
    config = patchConfig(config, { provider: firstKey });
    console.log('[WebUI] No active provider — auto-selected:', firstKey);
  }

  // If still no provider, the frontend will show a setup screen.
  // We still start the HTTP/WS servers so the user can configure via the UI.
  const needsProvider = !config.provider || !config.model;
  let needsSetup = needsProvider;

  // ModelsRegistry — use injected one if `services.modelsRegistry` was passed,
  // otherwise build a fresh one. The injected path lets the CLI's `runWebUI`
  // share a single registry across its own runtime and the webui surface.
  const modelsRegistry =
    opts.services?.modelsRegistry ??
    new DefaultModelsRegistry({
      cacheFile: wpaths.modelsCache,
      ttlSeconds: 24 * 3600,
    });

  // Container via shared factory
  const container = createDefaultContainer({ config, wpaths, logger, modelsRegistry });
  // PR 5 of Phase 2: when the caller (typically the CLI) supplies a
  // pre-built `BackendServices`, prefer its `configStore` over the one
  // the default container would resolve. This is the read+write
  // counterpart of the `vault` injection above: together they let
  // `runWebUI` own the global config lifecycle and have the webui
  // operate on the *same* in-memory store, so a `provider.switch`
  // from the webui is visible to the CLI's next call without a disk
  // round-trip in between.
  const configStore = opts.services?.configStore ?? container.resolve(TOKENS.ConfigStore);

  // Provider registry
  const providerRegistry = new ProviderRegistry();
  try {
    const factories = await buildProviderFactoriesFromRegistry({
      registry: modelsRegistry,
      log: logger,
    });
    for (const f of factories) providerRegistry.register(f);
    console.log('[WebUI] Provider registry loaded:', providerRegistry.list().length, 'providers');
  } catch (err) {
    console.warn(
      JSON.stringify({
        level: 'warn',
        event: 'webui.provider_registry_load_failed',
        message: toErrorMessage(err),
        timestamp: new Date().toISOString(),
      }),
    );
  }

  // Tool registry — use injected one if `services.toolRegistry` was passed.
  // When injected, the caller has already registered the tools they want
  // (the CLI's runWebUI registers its own runtime tools); startWebUI just
  // uses the registry as-is.
  const toolRegistry =
    opts.services?.toolRegistry ??
    (() => {
      const r = new ToolRegistry();
      r.registerAllOrThrow([...(builtinToolsPack.tools ?? [])], builtinToolsPack.name);
      return r;
    })();

  // Memory tools
  const memoryStore = new DefaultMemoryStore({ paths: wpaths });
  if (config.features.memory) {
    toolRegistry.register(rememberTool(memoryStore));
    toolRegistry.register(forgetTool(memoryStore));
    toolRegistry.register(searchMemoryTool(memoryStore));
    toolRegistry.register(relatedMemoryTool(memoryStore));
  }

  // Event bus — use injected one if `services.events` was passed. The CLI's
  // runWebUI owns the agent's EventBus so it can wire sub-agents onto the
  // same bus the webui dashboard reads from. When injected, we just
  // attach the logger and reuse the existing instance.
  const events = opts.services?.events ?? new EventBus();
  events.setLogger(logger);

  // Inter-agent mailbox tools — same project-level GlobalMailbox the CLI
  // registers, keyed by wpaths.projectDir so WebUI agents and terminal
  // agents on the same project share one inbox and can chat/broadcast.
  // mail_send/mail_inbox are the high-affordance thin wrappers.
  toolRegistry.register(makeMailboxTool({ projectDir: wpaths.projectDir, events }));
  toolRegistry.register(makeMailSendTool({ projectDir: wpaths.projectDir, events }));
  toolRegistry.register(makeMailInboxTool({ projectDir: wpaths.projectDir, events }));
  applyToolDescriptionModes(toolRegistry, config.tools?.descriptionMode);
  applyToolResultRenderModes(toolRegistry, config.tools?.resultRenderMode);
  // Apply the configured exec command policy (DEFAULT ∪ allow − deny). `allow`
  // is trusted-config-only; the config loader strips `tools.exec.allow` from
  // any in-project repo config before it reaches here.
  configureExecPolicy(config.tools?.exec ?? {});
  console.log('[WebUI] Tool registry loaded:', toolRegistry.list().length, 'tools');

  // ── MCP registry — the live counterpart to config.mcpServers. ────────────
  // The standalone WebUI server now owns a real registry (the CLI's embedded
  // server reuses the agent's), so the MCP settings panel can actually
  // start/stop servers and surface live status + tool names, not just edit
  // config. Enabled servers are connected at boot, mirroring the CLI host.
  const mcpRegistry = new MCPRegistry({
    toolRegistry,
    events,
    log: logger,
    // Lazy-connect (per-server `lazy`) manifest cache + default idle auto-sleep.
    cacheDir: wpaths.cacheDir,
  });
  if (config.features.mcp && config.mcpServers) {
    for (const [name, cfg] of Object.entries(config.mcpServers)) {
      if (cfg.enabled === false) continue;
      void mcpRegistry.start({ ...cfg, name }).catch((err) => {
        logger.warn(`MCP server "${name}" failed to start at boot`, err);
      });
    }
  }

  // Session store — mutable so projects.select can swap it to the new project's dir.
  // Use the injected one if `services.session` was passed. The CLI's
  // runWebUI already has its own session store pointing at the
  // right per-project dir; we reuse it here so the webui reads
  // the same history the CLI is writing.
  let sessionStore =
    opts.services?.session ?? new DefaultSessionStore({ dir: wpaths.projectSessions });
  // Prune old sessions on server start (non-blocking). Skipped when
  // an injected store is in use — the CLI's eternal loop is
  // responsible for its own lifecycle and pruning an in-use store
  // would race with the CLI's own prune policy.
  if (!opts.services?.session) {
    sessionStore
      .prune(DEFAULT_SESSION_PRUNE_DAYS)
      .then((count) => {
        if (count > 0) logger.info(`Pruned ${count} old session${count === 1 ? '' : 's'}.`);
      })
      .catch(() => undefined);
  }
  // Session reader — same on-disk store, read-only access. Used by the
  // collaboration handler to replay the last N events to late-joining
  // observers (Phase 1.5 of idea #13).
  const sessionReader = new DefaultSessionReader({ store: sessionStore });
  // Annotations store — sidecar files for collaboration notes (Phase 2
  // of idea #13). Living under `projectSessions` so all per-session
  // data is colocated and travels with the project.
  const annotationsStore = new AnnotationsStore({ dir: wpaths.projectSessions, events });
  let session = await sessionStore.create({
    id: '',
    title: '',
    model: config.model,
    provider: config.provider,
  });
  // Wall-clock when the *current* session started. Updated on /new and on
  // /resume so /stats can report accurate elapsed time per the active
  // session, not the daemon process uptime.
  let sessionStartedAt = Date.now();
  console.log('[WebUI] Session created:', session.id);

  // ── Cross-surface discovery ──────────────────────────────────────────
  // (1) Register/refresh this project in ~/.wrongstack/projects.json so
  // pickers and other surfaces see it regardless of which interface
  // opened it first. (2) Register this session in the cross-process
  // SessionRegistry so terminals' `/sessions status` lists this WebUI
  // (and vice versa). Both best-effort — discovery must not block boot.
  try {
    await touchProjectEntry(projectRoot, workingDir);
  } catch {
    /* best-effort */
  }
  let statusTracker: AgentStatusTracker | undefined;
  try {
    const registry = getSessionRegistry(wpaths.globalRoot);
    await registry.register({
      sessionId: session.id,
      projectSlug: wpaths.projectSlug,
      projectRoot,
      projectName: path.basename(projectRoot),
      workingDir,
      clientType: 'webui',
      pid: process.pid,
      startedAt: new Date().toISOString(),
    });
    // Push-on-write: nudge OTHER same-project WebUIs when our agents advance,
    // so a fleet of WebUI windows stays in lockstep without watch/poll lag.
    const fleetNotifier = new FleetNotifier({
      baseDir: wpaths.globalRoot,
      projectRoot,
      selfPid: process.pid,
    });
    statusTracker = new AgentStatusTracker({
      events,
      registry,
      onUpdate: () => fleetNotifier.notify(),
    });
    statusTracker.start();

    // ── HQ session telemetry — stream live state + full transcript to HQ ──
    let stopHqSessionBridge: (() => void) | undefined;
    let hqTelemetryPublisher: { close(): void } | undefined;
    try {
      const { createHqPublisherFromEnv, startSessionTelemetryBridge } = await import(
        '@wrongstack/core'
      );
      const hqTelemetry = createHqPublisherFromEnv({
        clientKind: 'webui',
        projectRoot,
        projectName: path.basename(projectRoot),
        appConfig: config as never as Parameters<typeof createHqPublisherFromEnv>[0]['appConfig'],
        socketFactory: (url: string) =>
          new WebSocket(url) as unknown as import('@wrongstack/core').HqSocketLike,
      });
      if (hqTelemetry) {
        hqTelemetry.connect();
        hqTelemetryPublisher = hqTelemetry;
        stopHqSessionBridge = startSessionTelemetryBridge({
          publisher: hqTelemetry,
          events,
          sessionId: session.id,
          projectRoot,
          projectName: path.basename(projectRoot),
          globalRoot: wpaths.globalRoot,
          initialAgents: statusTracker?.getAgents(),
          startedAt: new Date().toISOString(),
        });
      }
    } catch {
      /* telemetry optional */
    }

    const stopTracking = async () => {
      try {
        fleetNotifier.dispose();
        await registry.markClosing();
        statusTracker?.stop();
        stopHqSessionBridge?.();
        hqTelemetryPublisher?.close();
      } catch {
        /* ignore */
      }
    };
    process.once('beforeExit', () => {
      void stopTracking();
    });
    process.once('SIGINT', () => {
      void stopTracking();
    });
    process.once('SIGTERM', () => {
      void stopTracking();
    });
  } catch {
    /* best-effort — discovery degrades gracefully */
  }

  // Token counter
  const tokenCounter = new DefaultTokenCounter({
    registry: modelsRegistry,
    providerId: config.provider,
  });

  // Mode store
  const modeStore = new DefaultModeStore({ directory: wpaths.configDir });
  const activeMode = await modeStore.getActiveMode();
  let modeId = activeMode?.id ?? 'default';
  const modePrompt = activeMode?.prompt ?? '';

  // Custom context modes store — user-defined presets persisted to disk.
  // Loaded once on startup; merges with built-in modes in the list handler.
  const customModeStore = createCustomModeStore(wpaths.configDir);
  await customModeStore.load();
  console.log(
    '[WebUI] Custom context modes loaded:',
    customModeStore.list().filter((m) => (m as { custom?: boolean }).custom).length,
    'custom',
  );

  // System prompt builder
  const resolvedModel = await modelsRegistry.getModel(config.provider, config.model);
  const modelCapabilities = resolvedModel?.capabilities
    ? {
        maxContextTokens: resolvedModel.capabilities.maxContext,
        supportsTools: resolvedModel.capabilities.tools,
        supportsVision: resolvedModel.capabilities.vision,
        supportsReasoning: resolvedModel.capabilities.reasoning,
      }
    : undefined;
  const modelCapabilitiesRef: { current: typeof modelCapabilities } = {
    current: modelCapabilities,
  };

  const skillLoader = config.features.skills
    ? new DefaultSkillLoader({ paths: wpaths })
    : undefined;
  const skillInstaller = config.features.skills
    ? new SkillInstaller({
        manifestPath: path.join(wstackGlobalRoot(), 'installed-skills.json'),
        projectSkillsDir: path.join(projectRoot, '.wrongstack', 'skills'),
        globalSkillsDir: path.join(wstackGlobalRoot(), 'skills'),
        projectHash: projectHash(projectRoot),
        skillLoader,
      })
    : undefined;
  // Prompt library — on by default; `features.prompts: false` disables it
  // (the loader is withheld so handlers report it unavailable). Resolve the
  // bundled dataset shipped with @wrongstack/core (sibling of dist) so the
  // builtin prompts show up.
  const promptsEnabled = config.features.prompts !== false;
  const bundledPromptsDir = promptsEnabled
    ? (() => {
        try {
          const req = createRequire(import.meta.url);
          return path.join(
            path.dirname(req.resolve('@wrongstack/core/package.json')),
            'data',
            'prompts',
          );
        } catch {
          return undefined;
        }
      })()
    : undefined;
  const promptLoader = promptsEnabled
    ? new DefaultPromptLoader({ paths: wpaths, bundledDir: bundledPromptsDir })
    : undefined;
  const promptUsage = new PromptUsageStore(wpaths.promptUsage);
  const promptsCtx = { promptLoader, promptUsage };
  const systemPromptBuilder = new DefaultSystemPromptBuilder({
    memoryStore,
    skillLoader,
    modeStore,
    modeId,
    modePrompt,
    modelCapabilities: () => modelCapabilitiesRef.current,
    instructionPaths: {
      globalDir: wpaths.globalInstructions,
      projectDir: wpaths.inProjectInstructions,
    },
  });

  // Fetch online agents from the shared mailbox to include in system prompt
  let onlineAgents: import('@wrongstack/core').MailboxAgentStatus[] = [];
  try {
    const systemMailbox = new GlobalMailbox(wpaths.projectDir);
    onlineAgents = await systemMailbox.getAgentStatuses();
  } catch {
    // Non-fatal — mailbox errors should not block prompt building
  }

  const systemPrompt = await systemPromptBuilder.build({
    cwd: projectRoot,
    projectRoot,
    tools: toolRegistry.list(),
    provider: config.provider,
    model: config.model,
    onlineAgents,
  });

  // Build the active provider. The resolution ladder (configured → first
  // saved → stub + needsSetup) lives in ./setup-screen.ts so this reads as
  // orchestration rather than branching.
  const resolvedProvider = resolveSetupProvider({ config, needsProvider, providerRegistry });
  const provider = resolvedProvider.provider;
  if (resolvedProvider.needsSetup) needsSetup = true;

  // Context
  const context = new Context({
    systemPrompt,
    provider,
    session,
    signal: new AbortController().signal,
    tokenCounter,
    cwd: workingDir,
    projectRoot,
    model: config.model,
  });
  const initialContextPolicy = resolveContextWindowPolicy(config.context);
  context.meta['contextWindowMode'] = initialContextPolicy.id;
  context.meta['contextWindowPolicy'] = initialContextPolicy;

  // ── Seed runtime prefs from config ──────────────────────────────────────
  // The settings panel reads prefs via `prefs.get` → context.meta. Without
  // this seed the snapshot is empty and every browser shows localStorage
  // defaults (autonomy "off", etc.) regardless of what config.json says.
  // Mirrors the CLI's getSettings() mapping so TUI and WebUI agree.
  // (Projection lives in ./context-meta.ts — Phase 1c.)
  seedContextMeta(config, context);

  // Pref keys + snapshot + persistence live in ./pref-helpers.ts (Phase 1c).
  // Thin closures below keep the original signatures the route layer expects
  // while threading the live configWriteLock holder.
  const prefSnapshot = (): Record<string, unknown> => prefSnapshotImpl(context.meta);
  const persistPrefsToConfig = async (payload: Record<string, unknown>): Promise<void> =>
    persistPrefsToConfigImpl(prefHelperDeps, configWriteLock, payload);


  // ── Post-context agent services (pipelines, compaction, agent, Brain,
  // per-feature WS handlers) — built in ./backend-services.ts (Phase 1c).
  // The factory returns everything startWebUI needs to wire routes + the
  // dispatcher; the updateAutoCompactionMaxContext closure captures the
  // live autoCompactor / modelCapabilitiesRef it built.
  const agentServices = await createAgentServices({
    config,
    wpaths,
    logger,
    projectRoot,
    workingDir,
    context,
    provider,
    container,
    toolRegistry,
    providerRegistry,
    modelsRegistry,
    events,
    mcpRegistry,
    memoryStore,
    modeStore,
    customModeStore,
    skillLoader,
    skillInstaller,
    tokenCounter,
    pipelines: createDefaultPipelines(),
    modelCapabilitiesRef,
    sessionGetter: () => session,
    sessionReader,
    annotationsStore,
  });
  const {
    compactor,
    autoCompactor,
    agent,
    permissionPolicy,
    pipelines,
    brain,
    brainSettings,
    brainLog,
    brainMonitor,
    codebaseIndexing,
    autoPhaseHandler,
    specsHandler,
    sddBoardHandler,
    sddWizardHandler,
    worktreeHandler,
    terminalHandler,
    collabHandler,
    updateAutoCompactionMaxContext,
  } = agentServices;

  // Helper: build the rich session.start payload from current runtime state.
  // Centralised so initial connect, post-/new, and post-model.switch all
  // broadcast the same shape — frontend treats this as the single source of
  // truth for everything in the status bar (model, context window, project).
  async function sessionStartPayload(): Promise<{
    sessionId: string;
    model: string;
    provider: string;
    maxContext: number;
    /** USD per 1M input tokens (0 if unknown / free). */
    inputCost: number;
    /** USD per 1M output tokens. */
    outputCost: number;
    /** USD per 1M cache-read tokens. */
    cacheReadCost: number;
    projectName: string;
    projectRoot: string;
    cwd: string;
    mode: string;
    contextMode: string;
    needsSetup?: boolean | undefined;
  }> {
    let maxContext = 0;
    let inputCost = 0;
    let outputCost = 0;
    let cacheReadCost = 0;
    try {
      const m = await modelsRegistry.getModel(config.provider, config.model);
      maxContext = m?.capabilities?.maxContext ?? 0;
      // Fall back to the provider's raw model data from the registry when the
      // resolved model has no maxContext (e.g. a user-defined or API-proxied
      // model that wasn't in the models.dev catalog). DefaultModelsRegistry
      // exposes getProvider() which gives us the model's limit.context directly.
      if (!maxContext) {
        try {
          const provider = await (
            modelsRegistry as {
              getProvider(
                id: string,
              ): Promise<
                { models: Array<{ id: string; limit?: { context?: number } }> } | undefined
              >;
            }
          ).getProvider(config.provider);
          const rawModel = provider?.models.find((mod) => mod.id === config.model);
          maxContext = rawModel?.limit?.context ?? 0;
        } catch {
          /* best-effort — leave maxContext at whatever the registry set it */
        }
      }
      // models.dev pricing is dollars per 1M tokens; some providers omit the
      // field for free/unmetered plans (e.g. minimax-coding-plan) — in that
      // case we report 0 and the cost chip just stays at $0.
      const rates = getCostRates(m);
      inputCost = rates.input;
      outputCost = rates.output;
      cacheReadCost = rates.cacheRead;
    } catch {
      // best-effort
    }
    return {
      sessionId: session.id,
      model: config.model,
      provider: config.provider,
      maxContext,
      inputCost,
      outputCost,
      cacheReadCost,
      projectName: path.basename(projectRoot) || projectRoot,
      projectRoot,
      cwd: workingDir,
      mode: modeId,
      contextMode: String(context.meta['contextWindowMode'] ?? DEFAULT_CONTEXT_WINDOW_MODE_ID),
      ...(needsSetup ? { needsSetup: true } : {}),
    };
  }

  // WebSocket server(s).
  //
  // When the user keeps the default loopback bind (127.0.0.1), we ALSO open a
  // second listener on ::1 (IPv6 loopback). Reason: Chrome/Edge on Windows
  // resolve `localhost` to `[::1]` before `127.0.0.1`, so a single v4-only
  // bind causes "ws disconnect hep" — clients hammer the v6 socket, get
  // ECONNREFUSED, fall back to v4 inconsistently. Listening on both v4 and v6
  // loopback keeps the connection scope "this machine only" while removing
  // the resolution-order coin flip.
  //
  // When the user explicitly sets WS_HOST (e.g. 0.0.0.0 or a LAN IP), we
  // respect that choice exactly and don't add a second listener.
  // Generate a random WS auth token so only callers that know the token
  // can connect. Printed to console on startup; the frontend reads it from
  // the URL query param `?token=...`. Without a token, any client on the
  // network can connect and send `user_message`/`key.add`/`model.switch`.
  const wsToken = resolveAuthToken(opts.accessToken);
  // Token is delivered through the printed first-load URL and then exchanged
  // for an HttpOnly cookie by /ws-auth.
  console.log('[WebUI] WS auth token ready');
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

  // CSWSH guard + token auth: when the user exposes the socket beyond loopback,
  // require the shared token; loopback connections bootstrap without one. The
  // policy (DNS-rebinding Host guard, constant-time token compare, loopback
  // bootstrap) lives in ./ws-auth.ts as pure functions — this closure just
  // pulls the relevant fields off the incoming request and delegates.
  const verifyClient = (info: {
    origin: string;
    secure: boolean;
    req: import('node:http').IncomingMessage;
  }) =>
    verifyWsClient({
      origin: info.origin,
      url: info.req.url ?? '',
      hostHeader: info.req.headers.host,
      remoteAddress: info.req.socket.remoteAddress,
      // C-2 fix: accept the token via the HttpOnly cookie set by
      // `/ws-auth` (preferred) OR the URL query param (non-browser
      // fallback). The cookie path closes the C-598 query-string
      // exposure class.
      cookieHeader: info.req.headers.cookie,
      wsHost,
      expectedToken: wsToken,
      requireToken,
      allowedHostnames: publicHostnames,
      allowBrowserUrlToken: Boolean(publicWsUrl),
    });
  // Cap inbound frame size (8 MiB) so a single oversized message can't exhaust
  // memory. Agent messages are small; large pastes/attachments stay well under.
  const WS_MAX_PAYLOAD = 8 * 1024 * 1024;
  const wssPrimary = new WebSocketServer({
    port: wsPort,
    host: wsHost,
    verifyClient,
    maxPayload: WS_MAX_PAYLOAD,
  } as ConstructorParameters<typeof WebSocketServer>[0]);
  const wssSecondary =
    wsHost === '127.0.0.1'
      ? new WebSocketServer({
          port: wsPort,
          host: '::1',
          verifyClient,
          maxPayload: WS_MAX_PAYLOAD,
        } as ConstructorParameters<typeof WebSocketServer>[0])
      : null;
  const clients = new Map<WebSocket, ConnectedClient>();

  // ── Subscribe to working directory changes from the CLI ──────────────
  // When ctx.setWorkingDir() is called from the CLI (e.g. /wd, /cd, or
  // the set_working_dir tool), update the server's workingDir reference
  // and broadcast to all connected WebUI clients so the file explorer
  // and the WorkingDirChip UI stay in sync.
  context.onWorkingDirChanged((newDir) => {
    workingDir = newDir;
    broadcast(clients, {
      type: 'working_dir.changed',
      payload: { cwd: newDir, projectRoot },
    });
  });

  // ── Eternal-autonomy iteration broadcast (PR 4 of Phase 2) ─────────
  // When the CLI passes `opts.subscribeEternalIteration`, hook the
  // returned observer into a WS broadcast so every connected client
  // gets a live stream of `JournalEntry` items as the engine ticks.
  // The disposer is captured and invoked on shutdown() so the CLI's
  // engine subscription is properly torn down with the webui.
  let eternalSubscription: { dispose: () => void } | null = null;
  if (opts.subscribeEternalIteration) {
    eternalSubscription = createEternalSubscription(
      opts.subscribeEternalIteration,
      broadcast,
      () => clients,
    );
  }

  // Run-lock + pending confirms are shared between the connection handler
  // (./connection-handler.ts) and the message dispatcher
  // (./message-dispatcher.ts). Rate-limiting moved into the connection
  // handler; the runLock guards concurrent agent.run() calls and is read
  // through this control object so the dispatcher and the
  // state.abortRunLock wiring agree.
  let _runLock: AbortController | null = null;
  const runLockControl = {
    get: () => _runLock,
    set: (ctrl: AbortController | null) => {
      _runLock = ctrl;
    },
  };

  console.log(
    `[WebUI] WebSocket server running on ws://${wsHost}:${wsPort}` +
      (wssSecondary ? ` (and ws://[::1]:${wsPort})` : ''),
  );

  // Pending permission confirmations. When the agent emits
  // tool.confirm_needed, we store the resolve function here keyed by
  // toolUseId. When the client sends tool.confirm_result back, we look
  // it up and resolve — unblocking the agent loop.
  const pendingConfirms = new Map<string, (d: 'yes' | 'no' | 'always' | 'deny') => void>();

  // Audit-level-aware session log bridge — persists tool/error/provider
  // events to the session JSONL with the same contract as the CLI. The
  // getter form resolves the CURRENT writer on every append so events
  // follow session.new / session.resume / projects.select swaps.
  const sessionLogging = resolveSessionLoggingConfig(
    config as never as Parameters<typeof resolveSessionLoggingConfig>[0],
  );
  const sessionBridge = createSessionEventBridge(
    () => context.session ?? session,
    sessionLogging.auditLevel,
    { sampling: sessionLogging.sampling },
  );

  let eventsArmed = false;
  let disposeEvents: (() => void) | null = null;
  // Captured from setupEvents so `POST /api/fleet/ping` can trigger an
  // immediate fleet re-broadcast (push-on-write from a TUI/REPL).
  let fleetBroadcast: (() => Promise<void>) | null = null;
  const armOnce = (label: string): void => {
    if (eventsArmed) return;
    eventsArmed = true;
    console.log(`[WebUI] Backend ready (${label})`);
    disposeEvents = setupEvents({
      events,
      broadcast,
      clients,
      config,
      context,
      pendingConfirms,
      globalConfigPath,
      sessionBridge,
      wpaths,
      watcherMetrics,
      onFleetBroadcaster: (fn) => {
        fleetBroadcast = fn;
      },
    });
  };

  wssPrimary.on('listening', () => armOnce(`${wsHost}:${wsPort}`));
  wssPrimary.on('error', (err) => {
    console.error(
      JSON.stringify({
        level: 'error',
        event: 'webui.ws_server_error',
        host: wsHost,
        message: toErrorMessage(err),
        timestamp: new Date().toISOString(),
      }),
    );
  });

  if (wssSecondary) {
    wssSecondary.on('listening', () => armOnce(`::1:${wsPort}`));
    wssSecondary.on('error', (err: NodeJS.ErrnoException) => {
      // Best-effort secondary: if IPv6 loopback isn't available on this host
      // (e.g. disabled in OS), just log and continue. Primary v4 is enough.
      if (err.code === 'EAFNOSUPPORT' || err.code === 'EADDRNOTAVAIL') {
        console.warn(
          JSON.stringify({
            level: 'warn',
            event: 'webui.ipv6_unavailable',
            code: err.code,
            message: err.message,
            timestamp: new Date().toISOString(),
          }),
        );
      } else {
        console.error(
          JSON.stringify({
            level: 'error',
            event: 'webui.ws_server_error',
            host: '::1',
            message: err.message,
            timestamp: new Date().toISOString(),
          }),
        );
      }
    });
  }

  // ── Project manifest helpers ──────────────────────────────────────────

  /**
   * Idempotent manifest registration (mirrors the CLI's
   * touchProjectInManifest): create the projects.json entry when missing,
   * refresh lastSeen/lastWorkingDir when present.
   */
  async function touchProjectEntry(root: string, workDir?: string): Promise<void> {
    const resolved = path.resolve(root);
    const manifest = await loadManifest(globalConfigPath);
    const now = new Date().toISOString();
    const existing = manifest.projects.find((p) => path.resolve(p.root) === resolved);
    if (existing) {
      existing.lastSeen = now;
      if (workDir) existing.lastWorkingDir = path.resolve(workDir);
    } else {
      manifest.projects.push({
        name: path.basename(resolved),
        root: resolved,
        slug: generateProjectSlug(resolved),
        createdAt: now,
        lastSeen: now,
        lastWorkingDir: workDir ? path.resolve(workDir) : undefined,
      });
    }
    await saveManifest(manifest, globalConfigPath);
    await ensureProjectDataDir(generateProjectSlug(resolved), globalConfigPath);
  }

  // ---- Route table (extracted to ./routes.ts in Phase 1a) ----
  // The 947-line inline construction block that used to live here
  // moved into buildRoutes() in ./routes.ts. We bind the local mutables
  // (`config`, `projectRoot`, `workingDir`, ...) into a `state` object so
  // routes observe live updates (config switch, project swap, mode
  // change), pass the static services as `deps`, and forward the
  // handful of boot-local closures (config persistence, pref snapshot,
  // …) as `cb`.
  //
  // The 13 destructured names (`providerRoutes`, `sessionRoutes`, …)
  // are then referenced by `handleMessage` exactly the way the inline
  // `let *Routes` block was — no surface change.

  // Mutable bindings — wrapped by `state` for buildRoutes().
  const state: WebuiMutableState = {
    getConfig: () => config,
    setConfig: (next) => {
      config = next;
    },
    getProjectRoot: () => projectRoot,
    setProjectRoot: (next) => {
      projectRoot = next;
    },
    getWorkingDir: () => workingDir,
    setWorkingDir: (next) => {
      workingDir = next;
    },
    getSession: () => session,
    setSession: (next) => {
      session = next;
    },
    getSessionStartedAt: () => sessionStartedAt,
    setSessionStartedAt: (next) => {
      sessionStartedAt = next;
    },
    getSessionStore: () => sessionStore,
    setSessionStore: (next) => {
      sessionStore = next;
    },
    getModeId: () => modeId,
    setModeId: (next) => {
      modeId = next;
    },
    getModelCapabilities: () => modelCapabilitiesRef.current,
    getConfigWriteLock: () => configWriteLock.lock,
    setConfigWriteLock: (next) => {
      configWriteLock.lock = next;
    },
    abortRunLock: () => {
      const ctrl = runLockControl.get();
      if (ctrl) {
        ctrl.abort();
        runLockControl.set(null);
      }
    },
    getClients: () => clients,
  };

  const deps: WebuiDeps = {
    agent,
    context,
    container,
    toolRegistry,
    modelsRegistry,
    providerRegistry,
    provider,
    mcpRegistry,
    vault,
    globalConfigPath,
    wpaths,
    configStore,
    tokenCounter,
    permissionPolicy,
    pipelines,
    logger,
    memoryStore,
    modeStore,
    skillLoader,
    skillInstaller,
    customModeStore,
    compactor,
    autoCompactor,
    events,
    wsHost,
    requireToken,
    publicUrl,
    publicWsUrl,
    wsPort,
    httpPort,
    wssPrimary,
    wssSecondary,
    autoPhaseHandler,
    specsHandler,
    sddBoardHandler,
    sddWizardHandler,
    worktreeHandler,
    collabHandler,
    terminalHandler,
    brain,
    brainSettings,
    brainLog,
  };

  const cb: WebuiCallbacks = {
    sessionStartPayload,
    updateAutoCompactionMaxContext,
    updateGlobalConfig,
    persistPrefsToConfig,
    prefSnapshot,
  };

  // Hot-reload provider credentials when config.json changes on disk (another
  // terminal's `wstack auth`, a provider panel in another window, or a manual
  // edit). Rebuild the live agent's provider so the next message uses the new
  // key without restarting the server, and re-broadcast the saved-providers
  // projection so every connected panel re-renders. Mirrors `switchModel`'s
  // live-swap (routes.ts). Escape hatch: WRONGSTACK_DISABLE_CONFIG_WATCH=1.
  let credentialWatcherClose: (() => void) | undefined;
  if (process.env['WRONGSTACK_DISABLE_CONFIG_WATCH'] !== '1') {
    let lastActiveCfg = JSON.stringify(
      state.getConfig().providers?.[deps.context.provider.id] ?? null,
    );
    const credentialWatcher = watchProviderConfig(
      globalConfigPath,
      vault,
      (snapshot) => {
        // Refresh in-memory config + store so panels and the next switch read fresh.
        state.setConfig(
          patchConfig(state.getConfig(), {
            providers: snapshot.providers,
            ...(snapshot.apiKey !== undefined ? { apiKey: snapshot.apiKey } : {}),
            ...(snapshot.baseUrl !== undefined ? { baseUrl: snapshot.baseUrl } : {}),
          }),
        );
        deps.configStore.update({
          providers: snapshot.providers,
          ...(snapshot.apiKey !== undefined ? { apiKey: snapshot.apiKey } : {}),
          ...(snapshot.baseUrl !== undefined ? { baseUrl: snapshot.baseUrl } : {}),
        });
        broadcast(clients, {
          type: 'providers.saved',
          payload: { providers: projectSavedProviders(snapshot.providers) },
        });

        const activeId = deps.context.provider.id;
        const newCfgStr = JSON.stringify(snapshot.providers[activeId] ?? null);
        if (newCfgStr === lastActiveCfg) return; // active provider creds unchanged
        lastActiveCfg = newCfgStr;
        try {
          const providerCfg: ProviderConfig = snapshot.providers[activeId] ?? {
            type: activeId,
            ...(snapshot.apiKey !== undefined ? { apiKey: snapshot.apiKey } : {}),
            ...(snapshot.baseUrl !== undefined ? { baseUrl: snapshot.baseUrl } : {}),
          };
          const newProv = deps.providerRegistry.has(activeId)
            ? deps.providerRegistry.create({ ...providerCfg, type: activeId } as never)
            : makeProviderFromConfig(activeId, { ...providerCfg, type: activeId });
          deps.context.provider = newProv;
          void updateAutoCompactionMaxContext(newProv).catch(() => undefined);
          console.log(`[WebUI] Provider credentials reloaded from config.json (${activeId})`);
        } catch (err) {
          console.warn(
            `[WebUI] Credential hot-reload failed for ${activeId}: ${toErrorMessage(err)}`,
          );
        }
      },
      { warn: (m) => logger.warn(`Config watcher: ${m}`) },
    );
    credentialWatcherClose = credentialWatcher.close;
  }

  // Build the route table (Phase 1a) + the message dispatcher and connection
  // handler (Phase 1b). The dispatcher owns the inbound `switch (msg.type)`
  // and the runLock guard; the connection handler owns rate-limiting, F5
  // transcript replay, and per-client lifecycle. Both live in their own
  // modules so `startWebUI` reads as orchestration.
  const routes = buildRoutes(state, deps, cb);
  const handleMessage = createMessageDispatcher({
    state,
    deps,
    cb,
    routes,
    promptsCtx,
    codebaseIndexing,
    runLock: runLockControl,
    pendingConfirms,
  });
  const handleConnection = createConnectionHandler({
    getSessionId: () => session.id,
    sessionStartPayload,
    tokenCounter,
    context,
    clients,
    pendingConfirms,
    autoPhaseHandler,
    specsHandler,
    sddBoardHandler,
    sddWizardHandler,
    worktreeHandler,
    collabHandler,
    terminalHandler,
    handleMessage,
  });
  wssPrimary.on('connection', handleConnection);
  if (wssSecondary) wssSecondary.on('connection', handleConnection);
  // HTTP server for the React frontend (port 3456) — see `http-server.ts`
  // for the static-serve, MIME matching, path-traversal guard, and CSP
  // header logic. Constructed here, listen()d below alongside the WS server.
  // `globalRoot` powers the /api/sessions and /api/sessions/:id/agents
  // handlers (read the cross-process SessionRegistry); `apiToken` is the
  // shared auth token the HTTP API requires when bound to a non-loopback
  // host (LAN exposure). Loopback binds skip the token check, mirroring
  // the WS verifyClient loopback-bootstrap policy.

  // Shared metrics object for file watcher — populated by setupEvents and
  // exposed via the /debug/watcher-metrics HTTP endpoint.
  const watcherMetrics: FileWatcherMetrics = {
    fileChangesDetected: 0,
    filesProcessed: 0,
    broadcastsSent: 0,
    debounceResets: 0,
    totalDebounceDelayMs: 0,
    activeProjects: 0,
    averageDebounceDelayMs: 0,
    watcherActive: false,
  };

  const httpServer = createHttpServer({
    host: wsHost,
    distDir: path.resolve(import.meta.dirname, '../../dist'),
    wsPort,
    publicWsUrl,
    globalRoot: wpaths.globalRoot,
    apiToken: wsToken,
    requireToken,
    watcherMetrics,
    onFleetPing: () => {
      void fleetBroadcast?.();
    },
  });
  // httpPort/wsPort were resolved (and possibly auto-advanced) at the top.
  // Base dir for the running-instance registry — keep it next to the rest of
  // the wstack home state (config.json lives here too).
  const registryBaseDir = path.dirname(globalConfigPath);
  httpServer.listen(httpPort, wsHost, () => {
    const openUrl = buildWebUIAccessUrl({
      host: wsHost,
      port: httpPort,
      token: wsToken,
      publicUrl,
    });
    console.log(`[WebUI] HTTP server running on ${openUrl}`);
    // Optionally pop the browser open (best-effort; the URL is always printed).
    if (opts.open) openBrowser(openUrl);
    // Record this instance so `wstackui --list` (and `~/.wrongstack/
    // webui-instances.json`) show which ports are open for which project.
    // Best-effort: a registry write failure must not affect serving.
    void registerInstance(
      {
        pid: process.pid,
        httpPort,
        wsPort,
        host: wsHost,
        projectRoot,
        projectName: path.basename(projectRoot) || projectRoot,
        startedAt: new Date().toISOString(),
        url: buildWebUIAccessUrl({ host: wsHost, port: httpPort, publicUrl }),
      },
      registryBaseDir,
    ).catch((err) =>
      console.warn(
        JSON.stringify({
          level: 'warn',
          event: 'webui.instance_record_failed',
          message: errMessage(err),
          timestamp: new Date().toISOString(),
        }),
      ),
    );
  });

  // Graceful shutdown on SIGINT/SIGTERM — see `lifecycle.ts`. The session
  // flush (session_end + close) is passed as a thunk so lifecycle stays
  // decoupled from the session/tokenCounter types.
  registerShutdownHandlers({
    flushSession: async () => {
      await session.append({
        type: 'session_end',
        ts: new Date().toISOString(),
        usage: tokenCounter.total(),
      });
      await session.close();
    },
    clients: () => clients.keys(),
    servers: [httpServer, wssPrimary, wssSecondary],
    // Drop this instance from the registry on a clean exit so the file reflects
    // reality. Crash exits are healed by the next register()/list() prune pass.
    onShutdown: () => {
      credentialWatcherClose?.();
      brainMonitor.stop();
      void mcpRegistry.stopAll().catch(() => undefined);
      if (disposeEvents) {
        disposeEvents();
        disposeEvents = null;
      }
      if (eternalSubscription) {
        eternalSubscription.dispose();
        eternalSubscription = null;
      }
      codebaseIndexing.dispose();
      return unregisterInstance(process.pid, registryBaseDir);
    },
  });
}

/**
 * Webui-side mailbox bridge discovery.
 *
 * The webui doesn't spawn a bridge — the bridge (`wstack mailbox serve`)
 * is spawned by any CLI surface via the auto-bootstrap wiring. We just
 * probe the per-project lock for an already-running instance and stash
 * the discovered handle on `ctx.meta['mailboxBridge']` so any later
 * code (the `/mailbox` HTTP surface, agent-status broadcasters,
 * external-agent proxy) can find it without re-running discovery.
 *
 * If no bridge is running, we log a breadcrumb so the user knows
 * to start one (`wstack --repl`, `wstack --webui`, or
 * `wstack mailbox serve` standalone).
 *
 * Best-effort: never throws. A failure (missing lock dir, ENOENT,
 * etc.) logs at warn level and returns — the webui keeps running.
 */
// discoverMailboxBridgeForWebui extracted → ./discover-mailbox-bridge.ts
