import * as fs from 'node:fs/promises';
import * as http from 'node:http';
import * as path from 'node:path';
import { createHttpServer } from './http-server.js';
import { SKIP_DIRS, isHiddenEntry, rankFiles } from './file-picker.js';
import {
  Agent,
  AutoCompactionMiddleware,
  Context,
  DefaultMemoryStore,
  DefaultModeStore,
  DefaultModelsRegistry,
  DefaultSessionReader,
  DefaultSessionStore,
  DefaultSkillLoader,
  DefaultSystemPromptBuilder,
  DefaultTokenCounter,
  AnnotationsStore,
  CollaborationBus,
  collabPauseMiddleware,
  collabInjectMiddleware,
  estimateRequestTokensCalibrated,
  EventBus,
  HybridCompactor,
  type ProviderConfig,
  type Provider,
  ProviderRegistry,
  TOKENS,
  ToolRegistry,
  atomicWrite,
  createDefaultPipelines,
  DEFAULT_CONTEXT_WINDOW_MODE_ID,
  DEFAULT_TOOLS_CONFIG,
  listContextWindowModes,
  repairToolUseAdjacency,
  resolveContextWindowPolicy,
} from '@wrongstack/core';
import { ToolExecutor } from '@wrongstack/core/execution';
import { decryptConfigSecrets, encryptConfigSecrets } from '@wrongstack/core/security';
import { buildProviderFactoriesFromRegistry, makeProviderFromConfig } from '@wrongstack/providers';
import { builtinToolsPack, forgetTool, rememberTool } from '@wrongstack/tools';
import { WebSocket, WebSocketServer } from 'ws';
import { randomBytes } from 'node:crypto';
import { createDefaultContainer } from '../../../runtime/src/container.js';
import { bootConfig, patchConfig, } from './boot.js';
import { AutoPhaseWebSocketHandler } from './autophase-ws-handler.js';
import { CollaborationWebSocketHandler } from './collaboration-ws-handler.js';
import { WorktreeWebSocketHandler } from './worktree-ws-handler.js';
import { verifyClient as verifyWsClient } from './ws-auth.js';
import { registerShutdownHandlers } from './lifecycle.js';
import { computeUsageCost, getCostRates } from './usage-cost.js';
import {
  addProvider as addProviderRecord,
  deleteKey as deleteKeyRecord,
  maskedKey,
  normalizeKeys,
  removeProvider as removeProviderRecord,
  setActiveKey as setActiveKeyRecord,
  upsertKey as upsertKeyRecord,
} from './provider-keys.js';
import { estimateContextBreakdown } from './token-estimator.js';

// Re-export types
export type { WebUIOptions, BackendServices } from './types.js';

/** Extract a human-readable message from an unknown thrown value. */
function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Internal message types
interface WSServerMessage {
  type: string;
  payload: unknown;
}

interface WSClientMessage {
  type: string;
  payload?: unknown;
}

interface ConnectedClient {
  ws: WebSocket;
  sessionId: string | null;
  connectedAt: number;
}

export async function startWebUI(opts: { wsPort?: number; wsHost?: string } = {}): Promise<void> {
  const wsPort = opts.wsPort ?? 3457;
  // Bind to loopback IP by default (not the string "localhost", which on some
  // hosts resolves to IPv6 ::1 and surprises older WS clients). Set WS_HOST or
  // pass opts.wsHost to override (e.g. "0.0.0.0" for LAN access).
  const wsHost = opts.wsHost ?? '127.0.0.1';

  console.log('[WebUI] Starting backend services...');

  // Boot configuration
  const boot = await bootConfig();
  const { config: baseConfig, vault, globalConfigPath, projectRoot, wpaths, logger } = boot;
  let config = baseConfig;

  // Serialize concurrent config writes to prevent races between model.switch
  // and key.add/key.update handlers that both read-modify-write globalConfigPath.
  let configWriteLock: Promise<void> = Promise.resolve();

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
    const firstKey = Object.keys(config.providers)[0]!;
    config = patchConfig(config, { provider: firstKey });
    console.log('[WebUI] No active provider — auto-selected:', firstKey);
  }

  // If still no provider, the frontend will show a no-provider welcome screen.
  // We still start the HTTP/WS servers so the user can configure via the UI.
  const needsProvider = !config.provider || !config.model;

  // ModelsRegistry
  const modelsRegistry = new DefaultModelsRegistry({
    cacheFile: wpaths.modelsCache,
    ttlSeconds: 24 * 3600,
  });

  // Container via shared factory
  const container = createDefaultContainer({ config, wpaths, logger, modelsRegistry });
  const configStore = container.resolve(TOKENS.ConfigStore);

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
    console.warn('[WebUI] Failed to load provider registry:', err);
  }

  // Tool registry
  const toolRegistry = new ToolRegistry();
  toolRegistry.registerAllOrThrow([...(builtinToolsPack.tools ?? [])], builtinToolsPack.name);

  // Memory tools
  const memoryStore = new DefaultMemoryStore({ paths: wpaths });
  if (config.features.memory) {
    toolRegistry.register(rememberTool(memoryStore));
    toolRegistry.register(forgetTool(memoryStore));
  }
  console.log('[WebUI] Tool registry loaded:', toolRegistry.list().length, 'tools');

  // Event bus
  const events = new EventBus();
  events.setLogger(logger);

  // Session store
  const sessionStore = new DefaultSessionStore({ dir: wpaths.projectSessions });
  // Session reader — same on-disk store, read-only access. Used by the
  // collaboration handler to replay the last N events to late-joining
  // observers (Phase 1.5 of idea #13).
  const sessionReader = new DefaultSessionReader({ store: sessionStore });
  // Annotations store — sidecar files for collaboration notes (Phase 2
  // of idea #13). Living under `projectSessions` so all per-session
  // data is colocated and travels with the project.
  const annotationsStore = new AnnotationsStore({ dir: wpaths.projectSessions });
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

  const skillLoader = config.features.skills
    ? new DefaultSkillLoader({ paths: wpaths })
    : undefined;
  const systemPromptBuilder = new DefaultSystemPromptBuilder({
    memoryStore,
    skillLoader,
    modeStore,
    modeId,
    modePrompt,
    modelCapabilities,
  });

  const systemPrompt = await systemPromptBuilder.build({
    cwd: projectRoot,
    projectRoot,
    tools: toolRegistry.list(),
    provider: config.provider,
    model: config.model,
  });

  // Build provider (only if provider is configured)
  let provider: ReturnType<ProviderRegistry['create']>;
  if (!needsProvider) {
    const providerConfig = config.providers?.[config.provider] ?? {
      type: config.provider,
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
    };
    try {
      const cfgWithType = { ...providerConfig, type: config.provider };
      if (config.features.modelsRegistry && providerRegistry.has(config.provider)) {
        provider = providerRegistry.create(cfgWithType);
      } else {
        provider = makeProviderFromConfig(config.provider, cfgWithType);
      }
    } catch (err) {
      console.error('[WebUI] Failed to create provider:', err);
      throw err;
    }
  } else {
    // No provider is actively selected, but saved providers exist.
    // Re-read the config to find one with a usable encrypted API key
    // and create a real provider from it (the vault is already initialized).
    const savedProviders = config.providers ?? {};
    const firstKey = Object.keys(savedProviders)[0];
    if (firstKey) {
      const firstProvider = savedProviders[firstKey]!;
      try {
        provider = makeProviderFromConfig(firstKey, {
          ...firstProvider,
          type: firstKey,
          family: firstProvider.family,
          apiKey: firstProvider.apiKey,
        });
        console.log('[WebUI] Using saved provider:', firstKey);
      } catch (err) {
        console.error('[WebUI] Could not create provider stub:', err);
        throw err;
      }
    } else {
      throw new Error(
        'No provider configured. Run `wrongstack init` first, or configure via the WebUI.',
      );
    }
  }

  // Context
  const context = new Context({
    systemPrompt,
    provider,
    session,
    signal: new AbortController().signal,
    tokenCounter,
    cwd: projectRoot,
    projectRoot,
    model: config.model,
  });
  const initialContextPolicy = resolveContextWindowPolicy(config.context);
  context.meta['contextWindowMode'] = initialContextPolicy.id;
  context.meta['contextWindowPolicy'] = initialContextPolicy;

  // Pipelines
  const pipelines = createDefaultPipelines();
  // Collaboration bus — process-singleton pause/resume signal. The
  // middleware below hooks it into the toolCall pipeline so a
  // `controller` participant can halt the agent before the next tool
  // call (Phase 3 of idea #13). The same bus instance is shared with
  // the CollaborationWebSocketHandler so client pause/resume requests
  // are routed to the kernel.
  const collabBus = new CollaborationBus();
  // prepend (not use) — the pause check must run first, before any
  // permission/retry middleware that would otherwise proceed.
  const collabPause = collabPauseMiddleware(collabBus, { logger });
  Object.defineProperty(collabPause, 'name', { value: 'collab-pause' });
  pipelines.toolCall.prepend(collabPause as never);
  // Phase 4 — collab-inject. Installed AFTER collab-pause so the
  // controller can pause + inject before the next tool runs. The
  // middleware checks the bus's injection queue and splices a
  // synthetic tool_result when a controller has queued one for
  // the current toolUse.id.
  const collabInject = collabInjectMiddleware(collabBus, { logger });
  Object.defineProperty(collabInject, 'name', { value: 'collab-inject' });
  pipelines.toolCall.prepend(collabInject as never);
  // Compactor
  const compactor = new HybridCompactor({
    preserveK: config.context?.preserveK ?? 20,
    eliseThreshold: config.context?.eliseThreshold ?? 0.7,
  });

  // Auto-compaction
  let autoCompactor: AutoCompactionMiddleware | undefined;
  if (config.context?.autoCompact !== false) {
    const effectiveMaxContext = config.context?.effectiveMaxContext ?? provider.capabilities.maxContext;
    autoCompactor = new AutoCompactionMiddleware(
      compactor,
      effectiveMaxContext,
      (ctx) => estimateRequestTokensCalibrated(ctx.messages, ctx.systemPrompt, ctx.tools ?? []).total,
      {
        warn: initialContextPolicy.thresholds.warn,
        soft: initialContextPolicy.thresholds.soft,
        hard: initialContextPolicy.thresholds.hard,
      },
      {
        events,
        aggressiveOn: initialContextPolicy.aggressiveOn,
        policyProvider: (ctx) => {
          const policy = ctx.meta['contextWindowPolicy'];
          return policy && typeof policy === 'object'
            ? (policy as ReturnType<typeof resolveContextWindowPolicy>)
            : initialContextPolicy;
        },
      },
    );
    pipelines.contextWindow.use({ name: 'AutoCompaction', handler: autoCompactor.handler() });
  }

  /** Refresh AutoCompactionMiddleware denominator when the active model changes. */
  async function updateAutoCompactionMaxContext(newProvider: Provider): Promise<void> {
    if (!autoCompactor) return;
    let newMaxContext = config.context?.effectiveMaxContext ?? newProvider.capabilities.maxContext;
    try {
      const m = await modelsRegistry.getModel(newProvider.id, context.model);
      newMaxContext = m?.capabilities?.maxContext ?? newMaxContext;
    } catch {
      // best-effort: use provider capability
    }
    autoCompactor.setMaxContext(newMaxContext);
  }

  // Agent
  const secretScrubber = container.resolve(TOKENS.SecretScrubber);
  const renderer = container.has(TOKENS.Renderer)
    ? container.resolve(TOKENS.Renderer)
    : undefined;
  const toolExecutor = new ToolExecutor(toolRegistry, {
    permissionPolicy: container.resolve(TOKENS.PermissionPolicy),
    secretScrubber,
    renderer,
    events,
    confirmAwaiter: undefined,
    iterationTimeoutMs: config.tools?.iterationTimeoutMs ?? DEFAULT_TOOLS_CONFIG.iterationTimeoutMs,
    perIterationOutputCapBytes: config.tools?.perIterationOutputCapBytes ?? DEFAULT_TOOLS_CONFIG.perIterationOutputCapBytes,
    tracer: undefined,
  });

  const agent = new Agent({
    container,
    tools: toolRegistry,
    providers: providerRegistry,
    events,
    pipelines,
    context,
    maxIterations: config.tools?.maxIterations ?? DEFAULT_TOOLS_CONFIG.maxIterations,
    iterationTimeoutMs: config.tools?.iterationTimeoutMs ?? DEFAULT_TOOLS_CONFIG.iterationTimeoutMs,
    executionStrategy: config.tools?.defaultExecutionStrategy ?? DEFAULT_TOOLS_CONFIG.defaultExecutionStrategy,
    perIterationOutputCapBytes: config.tools?.perIterationOutputCapBytes ?? DEFAULT_TOOLS_CONFIG.perIterationOutputCapBytes,
    confirmAwaiter: undefined,
    toolExecutor,
  });
  console.log('[WebUI] Agent initialized');

  // AutoPhase handler — manages AutoPhaseRunner lifecycle via WS messages.
  // Stored under the per-project autophase dir (not the shared SDD task-graphs).
  const autoPhaseHandler = new AutoPhaseWebSocketHandler(
    agent,
    context,
    logger,
    wpaths.projectAutophase,
    events,
    projectRoot,
  );

  // Worktree handler — subscribes to the shared EventBus `worktree.*` events
  // and streams live swim-lane / DAG state to connected clients.
  const worktreeHandler = new WorktreeWebSocketHandler(events, logger);

  // Collaboration handler — Phase 1 of idea #13. Lets a second client
  // (e.g. a senior dev) join an active agent run as a read-only
  // observer and watch a live mirror of kernel events. Annotated and
  // controller roles land in Phase 2/3. The session reader enables
  // replay-on-join for late observers.
  const collabHandler = new CollaborationWebSocketHandler(
    events,
    logger,
    sessionReader,
    annotationsStore,
    collabBus,
  );

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
    cwd: string;
    mode: string;
    contextMode: string;
    wsToken: string;
  }> {
    let maxContext = 0;
    let inputCost = 0;
    let outputCost = 0;
    let cacheReadCost = 0;
    try {
      const m = await modelsRegistry.getModel(config.provider, config.model);
      maxContext = m?.capabilities?.maxContext ?? 0;
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
      cwd: projectRoot,
      mode: modeId,
      contextMode: String(context.meta['contextWindowMode'] ?? DEFAULT_CONTEXT_WINDOW_MODE_ID),
      wsToken,
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
  const wsToken = randomBytes(16).toString('hex');
  // Token is sent to clients via session.start payload — log only a masked
  // prefix so operators can correlate without leaking the full secret.
  console.log(`[WebUI] WS auth token: ${wsToken.slice(0, 4)}…${wsToken.slice(-4)} (masked)`);

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
      wsHost,
      expectedToken: wsToken,
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

  // Per-connection message rate limiting: 60 messages per 60-second window.
  // Exceeding clients are temporarily blocked to prevent flooding.
  // Uses sessionId as the key once connected, falling back to ws for
  // pre-auth messages — prevents connection-reuse bypass.
  const RATE_LIMIT_MESSAGES = 60;
  const RATE_LIMIT_WINDOW_MS = 60_000;
  const rateLimits = new Map<string, { count: number; resetAt: number }>();

  function checkRateLimit(ws: WebSocket, client: ConnectedClient): boolean {
    const now = Date.now();
    // Prefer the per-client authenticated sessionId; fall back to the
    // WebSocket identity for pre-auth messages before session.start.
    const key = client.sessionId ?? String(ws);
    const limit = rateLimits.get(key);
    if (!limit || now > limit.resetAt) {
      rateLimits.set(key, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
      return true;
    }
    if (limit.count >= RATE_LIMIT_MESSAGES) return false;
    limit.count++;
    return true;
  }

  /** Holds the AbortController for the currently in-flight agent.run().
   *  Non-null while the agent is running; guarded at the user_message
   *  handler to prevent concurrent runs that would corrupt shared state
   *  (context, agent, tokenCounter). A second user_message while running
   *  is answered with an inline error instead of being queued — the
   *  caller should wait for run.result. */
  let runLock: AbortController | null = null;

  console.log(
    `[WebUI] WebSocket server running on ws://${wsHost}:${wsPort}` +
      (wssSecondary ? ` (and ws://[::1]:${wsPort})` : ''),
  );

  // Pending permission confirmations. When the agent emits
  // tool.confirm_needed, we store the resolve function here keyed by
  // toolUseId. When the client sends tool.confirm_result back, we look
  // it up and resolve — unblocking the agent loop.
  const pendingConfirms = new Map<string, (d: 'yes' | 'no' | 'always' | 'deny') => void>();

  // Event subscriptions
  function setupEvents() {
    events.on('iteration.started', (e) => {
      broadcast({
        type: 'iteration.started',
        payload: { index: e.index, maxIterations: config.tools?.maxIterations ?? 100 },
      });
    });

    events.on('provider.text_delta', (e) => {
      broadcast({ type: 'provider.text_delta', payload: { text: e.text, messageId: 'current' } });
    });

    events.on('provider.thinking_delta', (e) => {
      broadcast({ type: 'provider.thinking_delta', payload: { text: e.text } });
    });

    events.on('tool.started', (e) => {
      broadcast({
        type: 'tool.started',
        payload: { id: e.id, name: e.name, input: e.input, messageId: `tool_${e.id}` },
      });
    });

    events.on('tool.progress', (e) => {
      // Streaming progress (bash stdout chunks, fetch body deltas, scan
      // counts...). We forward the lightweight shape: id + type + text so
      // the UI can render an inline "live" preview while the tool is still
      // running. Heavy `data` blob is intentionally dropped here — the
      // frontend doesn't need it and broadcasting it would balloon the WS
      // traffic for tools that emit progress every few ms.
      broadcast({
        type: 'tool.progress',
        payload: {
          id: e.id,
          name: e.name,
          eventType: e.event.type,
          text: e.event.text,
        },
      });
    });

    events.on('tool.executed', (e) => {
      broadcast({
        type: 'tool.executed',
        payload: {
          // Forward the tool_use id so frontend can correlate with the
          // matching tool.started bubble — without this, parallel tool calls
          // all stay stuck on "Running…" because the frontend can't tell
          // which bubble this result belongs to.
          id: e.id,
          name: e.name,
          durationMs: e.durationMs,
          ok: e.ok,
          input: e.input,
          output: e.output,
        },
      });
      // Push the current todo snapshot too — the TodoWrite tool mutates
      // context.todos in place, and a side-panel that needs to react to
      // that change shouldn't have to poll. Cheap (todos are tiny).
      broadcast({
        type: 'todos.updated',
        payload: { todos: [...context.todos] },
      });
    });

    events.on('provider.response', (e) => {
      broadcast({
        type: 'provider.response',
        payload: {
          usage: e.usage,
          stopReason: e.stopReason,
          messageId: 'current',
        },
      });
    });

    events.on('context.repaired', (e) => {
      broadcast({
        type: 'context.repaired',
        payload: {
          removedToolUses: e.removedToolUses,
          removedToolResults: e.removedToolResults,
          removedMessages: e.removedMessages,
        },
      });
    });

    events.on('tool.confirm_needed', (e) => {
      const id = e.toolUseId ?? `confirm_${Date.now()}`;
      pendingConfirms.set(id, e.resolve);
      broadcast({
        type: 'tool.confirm_needed',
        payload: {
          id,
          toolName: e.tool?.name ?? 'unknown',
          input: e.input,
          suggestedPattern: e.suggestedPattern,
        },
      });
    });

    events.on('error', (e) => {
      broadcast({
        type: 'error',
        payload: {
          phase: e.phase,
          message: e.err instanceof Error ? e.err.message : String(e.err),
        },
      });
    });
  }

  function send(ws: WebSocket, msg: WSServerMessage): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }

  function broadcast(msg: WSServerMessage): void {
    const data = JSON.stringify(msg);
    for (const [ws] of clients) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(data);
      }
    }
  }

  const handleConnection = (ws: WebSocket): void => {
    const client: ConnectedClient = { ws, sessionId: session.id, connectedAt: Date.now() };
    clients.set(ws, client);
    console.log('[WebUI] Client connected, total:', clients.size);

    void sessionStartPayload().then((payload) => {
      send(ws, { type: 'session.start', payload });
    });

    // Register this client with the AutoPhase handler so it receives phase events
    autoPhaseHandler.addClient(ws);
    // …and the worktree handler for live isolation lanes.
    worktreeHandler.addClient(ws);
    // …and the collaboration handler for read-only session observation.
    collabHandler.addClient(ws);

    ws.on('message', async (data) => {
      if (!checkRateLimit(ws, client)) {
        send(ws, {
          type: 'error',
          payload: {
            phase: 'rate_limit',
            message: 'Too many messages. Please wait before sending more.',
          },
        });
        return;
      }
      try {
        // Prototype pollution guard: reject messages whose root-level payload
        // contains __proto__, constructor, or prototype keys. These could
        // cause prototype pollution via Object.assign({}, payload) or
        // spread {...payload}. The top-level check below catches the
        // dangerous keys; nested payload sub-objects are low-risk since
        // handlers don't do deep property merges.
        const rawObj = JSON.parse(data.toString());
        if (typeof rawObj === 'object' && rawObj !== null) {
          const obj = rawObj as Record<string, unknown>;
          if ('__proto__' in obj || 'constructor' in obj || 'prototype' in obj) {
            send(ws, { type: 'error', payload: { phase: 'parse', message: 'Invalid message object' } });
          } else {
            await handleMessage(ws, client, rawObj as WSClientMessage);
          }
        } else {
          // Non-object JSON (array, string, number…) — pass through
          await handleMessage(ws, client, rawObj as unknown as WSClientMessage);
        }
      } catch (err) {
        console.error('[WebUI] Failed to parse message', err);
      }
    });

    ws.on('close', () => {
      clients.delete(ws);
      rateLimits.delete(String(ws));
      console.log('[WebUI] Client disconnected, total:', clients.size);
      // If the client disconnects while a permission prompt is pending,
      // resolve all pending confirms with 'no' so the agent loop doesn't
      // hang forever waiting for a response that will never come.
      if (pendingConfirms.size > 0) {
        for (const [id, resolve] of pendingConfirms) {
          resolve('no');
          pendingConfirms.delete(id);
        }
      }
    });

    ws.on('error', (err) => {
      // Without this handler an errored socket would crash the process.
      console.warn('[WebUI] Client socket error:', err.message);
    });
  };

  let eventsArmed = false;
  const armOnce = (label: string): void => {
    if (eventsArmed) return;
    eventsArmed = true;
    console.log(`[WebUI] Backend ready (${label})`);
    setupEvents();
  };

  wssPrimary.on('listening', () => armOnce(`${wsHost}:${wsPort}`));
  wssPrimary.on('connection', handleConnection);
  wssPrimary.on('error', (err) => {
    console.error(`[WebUI] Primary WS server error (${wsHost}):`, err);
  });

  if (wssSecondary) {
    wssSecondary.on('listening', () => armOnce(`::1:${wsPort}`));
    wssSecondary.on('connection', handleConnection);
    wssSecondary.on('error', (err: NodeJS.ErrnoException) => {
      // Best-effort secondary: if IPv6 loopback isn't available on this host
      // (e.g. disabled in OS), just log and continue. Primary v4 is enough.
      if (err.code === 'EAFNOSUPPORT' || err.code === 'EADDRNOTAVAIL') {
        console.warn('[WebUI] IPv6 loopback not available, v4-only:', err.code);
      } else {
        console.error('[WebUI] Secondary WS server error (::1):', err);
      }
    });
  }

  async function handleMessage(
    ws: WebSocket,
    _client: ConnectedClient,
    msg: WSClientMessage,
  ): Promise<void> {
    switch (msg.type) {
      // Collaboration messages short-circuit the user/agent flow.
      // They don't touch runLock, the agent loop, or the message queue —
      // they're pure transport for the live observer mirror.
      case 'collab.join':
      case 'collab.leave':
      case 'collab.annotate':
      case 'collab.resolve': {
        collabHandler.handleMessage(ws, msg as { type: string; payload?: unknown });
        return;
      }
      case 'user_message': {
        const content = (msg as { payload: { content: string } }).payload.content;

        // Guard against concurrent agent runs — a second user_message while
        // the agent is already processing would kick off two agent.run()
        // calls on the same shared context/agent, leading to corrupted
        // state (duplicate tool bubbles, mixed text_delta streams, token
        // counter undercount). Reject with an inline error; the frontend
        // should wait for run.result before sending the next message.
        if (runLock) {
          send(ws, {
            type: 'error',
            payload: {
              phase: 'user_message',
              message: 'Agent is already processing a request. Wait for the current run to finish.',
            },
          });
          break;
        }

        runLock = new AbortController();
        // Capture so the finally block only clears its own lock — a
        // second race could set a new runLock between await and finally.
        const thisRun = runLock;

        try {
          const result = await agent.run(content, { signal: thisRun.signal });
          send(ws, {
            type: 'run.result',
            payload: {
              status: result.status,
              iterations: result.iterations,
              finalText: result.finalText,
              error: result.error
                ? {
                    code: result.error.code,
                    message: result.error.message,
                    recoverable: result.error.recoverable,
                  }
                : undefined,
            },
          });
        } catch (err) {
          send(ws, {
            type: 'error',
            payload: {
              phase: 'agent.run',
              message: errMessage(err),
            },
          });
        } finally {
          // Only clear runLock if it's still ours — otherwise we'd wipe a
          // newer run's controller set after we returned.
          if (runLock === thisRun) {
            runLock = null;
          }
        }
        break;
      }

      case 'tool.confirm_result': {
        const { id, decision } = (msg as { payload: { id: string; decision: 'yes' | 'no' | 'always' | 'deny' } }).payload;
        const resolve = pendingConfirms.get(id);
        if (resolve) {
          pendingConfirms.delete(id);
          resolve(decision);
        }
        break;
      }

      case 'abort':
        runLock?.abort();
        broadcast({ type: 'error', payload: { phase: 'abort', message: 'User aborted' } });
        break;

      case 'ping':
        send(ws, { type: 'pong', payload: {} });
        break;

      case 'session.new': {
        // Truly fresh chat: new on-disk session AND reset every piece of
        // in-memory state that survived (messages history, todos, read-file
        // tracking, token totals). Otherwise the model still sees the prior
        // turns even though the UI looks empty — that's the "ghost context"
        // bug. After this, the next user message goes out as turn 1 with no
        // prior history.
        session = await sessionStore.create({
          id: '',
          title: '',
          model: config.model,
          provider: config.provider,
        });
        context.session = session;
        context.state.replaceMessages([]);
        context.state.replaceTodos([]);
        context.readFiles.clear();
        context.fileMtimes.clear();
        tokenCounter.reset();
        sessionStartedAt = Date.now();
        broadcast({ type: 'session.start', payload: await sessionStartPayload() });
        break;
      }

      case 'context.clear': {
        // Same in-memory wipe as session.new, but reuses the current session
        // file (so the JSONL still has the history for audit / replay). The
        // user wants a clean slate on the model side; the disk record stays.
        context.state.replaceMessages([]);
        context.state.replaceTodos([]);
        context.readFiles.clear();
        context.fileMtimes.clear();
        tokenCounter.reset();
        sendResult(ws, true, 'Context cleared');
        broadcast({
          type: 'session.start',
          payload: { ...(await sessionStartPayload()), reset: true },
        });
        break;
      }

      case 'context.debug': {
        // Per-section token estimate so users can see what's actually eating
        // the context window. The breakdown maths lives in ./token-estimator.ts
        // (4-chars-per-token heuristic); we layer the active mode/policy on top.
        const breakdown = estimateContextBreakdown({
          systemPrompt: context.systemPrompt,
          tools: toolRegistry.list(),
          messages: context.messages,
        });
        send(ws, {
          type: 'context.debug',
          payload: {
            ...breakdown,
            mode: context.meta['contextWindowMode'] ?? DEFAULT_CONTEXT_WINDOW_MODE_ID,
            policy: context.meta['contextWindowPolicy'],
          },
        });
        break;
      }

      case 'context.compact': {
        const aggressive = !!(msg as { payload?: { aggressive?: boolean } }).payload?.aggressive;
        try {
          const report = await compactor.compact(context, { aggressive });
          send(ws, {
            type: 'context.compacted',
            payload: {
              before: report.before,
              after: report.after,
              saved: Math.max(0, report.before - report.after),
              reductions: report.reductions,
              repaired: report.repaired,
            },
          });
          sendResult(
            ws,
            true,
            `Compacted: ${report.before} → ${report.after} tokens (saved ~${Math.max(0, report.before - report.after)})`,
          );
        } catch (err) {
          sendResult(ws, false, errMessage(err));
        }
        break;
      }

      case 'context.repair': {
        const beforeMessages = context.messages.length;
        const repaired = repairToolUseAdjacency(context.messages);
        if (repaired.report.changed) {
          context.state.replaceMessages(repaired.messages);
        }
        const payload = {
          removedToolUses: repaired.report.removedToolUses,
          removedToolResults: repaired.report.removedToolResults,
          removedMessages: repaired.report.removedMessages,
          beforeMessages,
          afterMessages: context.messages.length,
        };
        broadcast({ type: 'context.repaired', payload });
        const removed =
          payload.removedToolUses.length +
          payload.removedToolResults.length +
          payload.removedMessages;
        sendResult(
          ws,
          true,
          removed > 0
            ? `Context repaired: removed ${removed} orphan protocol item(s)`
            : 'Context repair found no orphan protocol blocks',
        );
        break;
      }

      case 'context.modes.list': {
        const active = String(context.meta['contextWindowMode'] ?? DEFAULT_CONTEXT_WINDOW_MODE_ID);
        send(ws, {
          type: 'context.modes.list',
          payload: {
            activeId: active,
            modes: listContextWindowModes().map((m) => ({
              id: m.id,
              name: m.name,
              description: m.description,
              isActive: m.id === active,
              thresholds: m.thresholds,
              preserveK: m.preserveK,
              eliseThreshold: m.eliseThreshold,
            })),
          },
        });
        break;
      }

      case 'context.mode.switch': {
        const { id } = (msg as { payload: { id: string } }).payload;
        const policy = resolveContextWindowPolicy({}, id);
        if (policy.id !== id) {
          sendResult(ws, false, `Unknown context mode "${id}"`);
          break;
        }
        context.meta['contextWindowMode'] = policy.id;
        context.meta['contextWindowPolicy'] = policy;
        sendResult(ws, true, `Context mode switched to ${policy.id}`);
        broadcast({
          type: 'context.mode.changed',
          payload: { id: policy.id, name: policy.name, policy },
        });
        break;
      }

      case 'providers.list': {
        const providers = await modelsRegistry.listProviders();
        // "Configured" should mean *any* working credential, not just env vars.
        // Users register keys with `wstack auth`, which writes apiKey/apiKeys
        // into config.providers[<id>] — those are decrypted in memory here.
        const savedIds = new Set(Object.keys(config.providers ?? {}));
        send(ws, {
          type: 'provider.catalog',
          payload: {
            providers: providers.map((p) => ({
              id: p.id,
              name: p.name,
              family: p.family,
              apiBase: p.apiBase,
              envVars: p.envVars,
              modelCount: p.models.length,
              hasApiKey: savedIds.has(p.id) || p.envVars.some((v) => !!process.env[v]),
            })),
          },
        });
        break;
      }

    case 'providers.saved': {
      const saved = await loadSavedProviders();
      send(ws, {
        type: 'providers.saved',
        payload: {
          providers: Object.entries(saved).map(([id, cfg]) => {
            const keys = normalizeKeys(cfg);
            return {
              id,
              family: cfg.family ?? id,
              baseUrl: cfg.baseUrl,
              apiKeys: keys.map((k) => ({
                label: k.label,
                maskedKey: maskedKey(k.apiKey),
                isActive: k.label === cfg.activeKey,
                createdAt: k.createdAt,
              })),
            };
          }),
        },
      });
      break;
    }

      case 'provider.models': {
        const providerId = (msg as { payload: { providerId: string } }).payload.providerId;
        const provider = await modelsRegistry.getProvider(providerId);
        if (provider) {
          send(ws, {
            type: 'provider.models',
            payload: {
              provider: providerId,
              models: provider.models.map((m) => ({
                id: m.id,
                name: m.name,
                releaseDate: (m as { release_date?: string }).release_date,
                contextWindow: (m as { limit?: { context?: number } }).limit?.context,
                inputCost: (m as { cost?: { input?: number } }).cost?.input,
                outputCost: (m as { cost?: { output?: number } }).cost?.output,
                capabilities: [
                  ...((m as { tool_call?: boolean }).tool_call ? ['tools'] : []),
                  ...((m as { reasoning?: boolean }).reasoning ? ['reasoning'] : []),
                ],
              })),
            },
          });
        }
        break;
      }

      case 'model.switch': {
        const { provider: newProvider, model: newModel } = (
          msg as { payload: { provider: string; model: string } }
        ).payload;
        try {
          // Update config
          config = patchConfig(config, { provider: newProvider, model: newModel });
          configStore.update({ provider: newProvider, model: newModel });
          context.model = newModel;

          // Create new provider instance — fail loudly if the user picks a
          // provider with no creds rather than silently keeping the old one.
          const providerCfg = config.providers?.[newProvider] ?? { type: newProvider };
          const newProv = providerRegistry.has(newProvider)
            ? providerRegistry.create({ ...providerCfg, type: newProvider })
            : makeProviderFromConfig(newProvider, providerCfg);
          context.provider = newProv;

          // Update AutoCompactionMiddleware with the new model's maxContext so
          // backend threshold triggers (warn/soft/hard) use the correct denominator.
          // sessionStartPayload is called below (after this block) and uses
          // the new provider for its modelsRegistry lookup.
          updateAutoCompactionMaxContext?.(newProv);

          // Persist to global config file
          try {
            configWriteLock = configWriteLock.then(async () => {
              const raw = await fs.readFile(globalConfigPath, 'utf8');
              const parsed = JSON.parse(raw);
              parsed.provider = newProvider;
              parsed.model = newModel;
              await atomicWrite(globalConfigPath, JSON.stringify(parsed, null, 2));
            });
            await configWriteLock;
          } catch (err) {
            console.warn('[WebUI] Failed to save config:', err);
          }

          // Toast for the SettingsPanel
          send(ws, {
            type: 'key.operation_result',
            payload: { success: true, message: `Switched to ${newProvider} / ${newModel}` },
          });
        } catch (err) {
          send(ws, {
            type: 'key.operation_result',
            payload: {
              success: false,
              message: `Switch failed: ${errMessage(err)}`,
            },
          });
          break;
        }

        broadcast({ type: 'session.start', payload: await sessionStartPayload() });
        break;
      }

      case 'key.add':
      case 'key.update': {
        const { providerId, label, apiKey } = (
          msg as { payload: { providerId: string; label: string; apiKey: string } }
        ).payload;
        await handleKeyUpsert(ws, providerId, label, apiKey);
        break;
      }

      case 'key.delete': {
        const { providerId, label } = (msg as { payload: { providerId: string; label: string } })
          .payload;
        await handleKeyDelete(ws, providerId, label);
        break;
      }

      case 'key.set_active': {
        const { providerId, label } = (msg as { payload: { providerId: string; label: string } })
          .payload;
        await handleKeySetActive(ws, providerId, label);
        break;
      }

      case 'provider.add': {
        const p = (
          msg as { payload: { id: string; family: string; baseUrl?: string; apiKey?: string } }
        ).payload;
        await handleProviderAdd(ws, p);
        break;
      }

      case 'provider.remove': {
        const { providerId } = (msg as { payload: { providerId: string } }).payload;
        await handleProviderRemove(ws, providerId);
        break;
      }

      case 'sessions.list': {
        // Per-project history. Sessions live under .wrongstack/sessions/ for
        // this project; we never enumerate cross-project state.
        const limit = (msg as { payload?: { limit?: number } }).payload?.limit ?? 50;
        try {
          const list = await sessionStore.list(limit);
          send(ws, {
            type: 'sessions.list',
            payload: {
              sessions: list.map((s) => ({
                id: s.id,
                title: s.title,
                startedAt: s.startedAt,
                model: s.model,
                provider: s.provider,
                tokenTotal: s.tokenTotal,
                isCurrent: s.id === session.id,
              })),
            },
          });
        } catch (err) {
          send(ws, {
            type: 'sessions.list',
            payload: { sessions: [], error: errMessage(err) },
          });
        }
        break;
      }

      case 'session.delete': {
        const { id } = (msg as { payload: { id: string } }).payload;
        try {
          if (id === session.id) {
            sendResult(ws, false, 'Cannot delete the active session');
            break;
          }
          await sessionStore.delete(id);
          sendResult(ws, true, `Session ${id} deleted`);
        } catch (err) {
          sendResult(ws, false, errMessage(err));
        }
        break;
      }

      case 'session.resume': {
        // Load a past session's messages + usage, swap the active session
        // writer, hydrate the live Context, then broadcast a session.start
        // payload tagged with the replayed transcript so the UI can render
        // the chat history.
        const { id } = (msg as { payload: { id: string } }).payload;
        try {
          if (id === session.id) {
            sendResult(ws, false, 'Session is already active');
            break;
          }
          const resumed = await sessionStore.resume(id);
          // Close prior writer best-effort; swallow errors so we don't block
          // the resume on a crashed file handle.
          try {
            await session.close();
          } catch {
            /* noop */
          }
          session = resumed.writer;
          context.session = session;
          context.state.replaceMessages(resumed.data.messages);
          context.readFiles.clear();
          context.fileMtimes.clear();
          tokenCounter.reset();
          // Replay usage so the topbar shows accurate totals after resume.
          tokenCounter.account(resumed.data.usage, config.model);
          sessionStartedAt = Date.now();
          broadcast({
            type: 'session.start',
            payload: {
              ...(await sessionStartPayload()),
              reset: true,
              replayMessages: resumed.data.messages,
              replayUsage: resumed.data.usage,
            },
          });
          sendResult(ws, true, `Resumed session ${id}`);
        } catch (err) {
          sendResult(ws, false, errMessage(err));
        }
        break;
      }

      case 'session.save': {
        // SessionWriter already flushes after every event; this is mostly a
        // no-op marker so the user gets confirmation. Useful for habit
        // parity with the CLI /save command.
        sendResult(ws, true, `Session ${session.id} is auto-saved`);
        break;
      }

      case 'tools.list': {
        // Full tool registry dump for the /tools inspect view. We surface
        // name, description, and schema-derived param names so the user
        // can tell at a glance which tools the model can call right now.
        const list = toolRegistry.list().map((t) => {
          const schema =
            (t as { inputSchema?: { properties?: Record<string, unknown> } }).inputSchema ?? {};
          const params = schema.properties ? Object.keys(schema.properties) : [];
          return {
            name: t.name,
            description: (t as { description?: string }).description ?? '',
            params,
          };
        });
        send(ws, { type: 'tools.list', payload: { tools: list } });
        break;
      }

      case 'memory.list': {
        // All three scopes (project-agents, project-memory, user-memory)
        // rolled up as readAll already does. Returned as raw markdown so
        // the UI can render with the same style as everything else.
        try {
          const text = await memoryStore.readAll();
          send(ws, { type: 'memory.list', payload: { text } });
        } catch (err) {
          send(ws, {
            type: 'memory.list',
            payload: { text: '', error: errMessage(err) },
          });
        }
        break;
      }

      case 'memory.remember': {
        const { text, scope } = (
          msg as {
            payload: { text: string; scope?: 'project-agents' | 'project-memory' | 'user-memory' };
          }
        ).payload;
        try {
          await memoryStore.remember(text, scope ?? 'project-memory');
          sendResult(ws, true, 'Saved to memory');
        } catch (err) {
          sendResult(ws, false, errMessage(err));
        }
        break;
      }

      case 'memory.forget': {
        const { text, scope } = (
          msg as {
            payload: { text: string; scope?: 'project-agents' | 'project-memory' | 'user-memory' };
          }
        ).payload;
        try {
          const removed = await memoryStore.forget(text, scope ?? 'project-memory');
          sendResult(
            ws,
            removed > 0,
            removed > 0
              ? `Removed ${removed} entr${removed === 1 ? 'y' : 'ies'}`
              : 'No matching entries',
          );
        } catch (err) {
          sendResult(ws, false, errMessage(err));
        }
        break;
      }

      case 'skills.list': {
        if (!skillLoader) {
          send(ws, { type: 'skills.list', payload: { skills: [], enabled: false } });
          break;
        }
        try {
          const manifests = await skillLoader.list();
          const entries = await skillLoader.listEntries();
          const byName = new Map(entries.map((e) => [e.name, e]));
          send(ws, {
            type: 'skills.list',
            payload: {
              enabled: true,
              skills: manifests.map((m) => ({
                name: m.name,
                description: m.description,
                version: m.version ?? '',
                source: m.source,
                path: m.path,
                trigger: byName.get(m.name)?.trigger ?? '',
                scope: byName.get(m.name)?.scope ?? [],
              })),
            },
          });
        } catch (err) {
          send(ws, {
            type: 'skills.list',
            payload: {
              skills: [],
              enabled: true,
              error: errMessage(err),
            },
          });
        }
        break;
      }

      case 'diag.get': {
        // Snapshot of the moving parts so the user can debug "why is X
        // not working?" without diving into the server logs.
        const usage = tokenCounter.total();
        send(ws, {
          type: 'diag.get',
          payload: {
            provider: config.provider,
            model: config.model,
            cwd: projectRoot,
            sessionId: session.id,
            tools: {
              count: toolRegistry.list().length,
              names: toolRegistry.list().map((t) => t.name),
            },
            features: {
              memory: !!config.features?.memory,
              skills: !!config.features?.skills,
              modelsRegistry: !!config.features?.modelsRegistry,
            },
            mode: modeId ?? 'default',
            usage,
            messages: context.messages.length,
            todos: context.todos.length,
          },
        });
        break;
      }

      case 'todos.get': {
        // On-demand snapshot — used when a UI surface first mounts and
        // needs to render the live todo list without waiting for the next
        // tool.executed to broadcast.
        send(ws, {
          type: 'todos.updated',
          payload: { todos: [...context.todos] },
        });
        break;
      }

      case 'todos.clear': {
        // Manual override — the agent normally curates this list via
        // TodoWrite, but the user might want a clean slate without losing
        // the rest of the context. Use state.replaceTodos so observers
        // (checkpoint writer) stay in sync.
        context.state.replaceTodos([]);
        sendResult(ws, true, 'Todos cleared');
        broadcast({ type: 'todos.updated', payload: { todos: [] } });
        break;
      }

      case 'plan.get': {
        // On-demand plan snapshot — used when a UI surface first mounts
        // and needs to render the live plan without waiting for the next
        // tool.executed to broadcast.
        const planPath = (context.meta as Record<string, unknown>)['plan.path'];
        if (typeof planPath === 'string' && planPath) {
          try {
            const { loadPlan } = await import('@wrongstack/core');
            const plan = await loadPlan(planPath);
            send(ws, {
              type: 'plan.updated',
              payload: { plan: plan ?? { version: 1, sessionId: session.id, updatedAt: new Date().toISOString(), items: [] } },
            });
          } catch {
            send(ws, {
              type: 'plan.updated',
              payload: { plan: { version: 1, sessionId: session.id, updatedAt: new Date().toISOString(), items: [] } },
            });
          }
        } else {
          send(ws, {
            type: 'plan.updated',
            payload: { plan: null, error: 'Plan storage is not configured for this session.' },
          });
        }
        break;
      }

      case 'plan.template_use': {
        const { template } = (msg as { payload: { template: string } }).payload;
        const planPath = (context.meta as Record<string, unknown>)['plan.path'];
        if (typeof planPath !== 'string' || !planPath) {
          sendResult(ws, false, 'Plan storage is not configured for this session.');
          break;
        }
        try {
          const { getPlanTemplate, loadPlan, savePlan, emptyPlan, addPlanItem } = await import('@wrongstack/core');
          const tpl = getPlanTemplate(template);
          if (!tpl) {
            sendResult(ws, false, `Unknown template "${template}".`);
            break;
          }
          let plan = (await loadPlan(planPath)) ?? emptyPlan(session.id);
          for (const item of tpl.items) {
            ({ plan } = addPlanItem(plan, item.title, item.details));
          }
          await savePlan(planPath, plan);
          sendResult(ws, true, `Applied template "${tpl.name}" — ${tpl.items.length} items added.`);
          broadcast({
            type: 'plan.updated',
            payload: { plan },
          });
        } catch (err) {
          sendResult(ws, false, errMessage(err));
        }
        break;
      }

      case 'files.list': {
        // Lightweight project file picker for the chat `@` mention popup.
        // Walks projectRoot, skipping the heavyweight build/vcs/node_modules
        // dirs that would blow up the response on a real project. Applies
        // a fuzzy substring match against the (lowercased) query and caps
        // the result so the popup never has to paginate.
        const payload = (msg as { payload?: { query?: string; limit?: number } }).payload ?? {};
        const limit = payload.limit ?? 50;
        // Filtering (isHiddenEntry/SKIP_DIRS) and ranking (rankFiles) live in
        // ./file-picker.ts; the walk itself stays here since it's disk I/O.
        const results: string[] = [];
        async function walk(dir: string, rel: string, depth: number): Promise<void> {
          if (depth > 8 || results.length >= 600) return;
          let entries: import('node:fs').Dirent[] = [];
          try {
            entries = await fs.readdir(dir, { withFileTypes: true });
          } catch {
            return;
          }
          for (const e of entries) {
            if (results.length >= 600) return;
            if (isHiddenEntry(e.name)) continue;
            const childRel = rel ? `${rel}/${e.name}` : e.name;
            if (e.isDirectory()) {
              if (SKIP_DIRS.has(e.name)) continue;
              await walk(path.join(dir, e.name), childRel, depth + 1);
            } else if (e.isFile()) {
              results.push(childRel);
            }
          }
        }
        await walk(projectRoot, '', 0);
        send(ws, {
          type: 'files.list',
          payload: { files: rankFiles(results, payload.query ?? '', limit) },
        });
        break;
      }

      case 'modes.list': {
        try {
          const modes = await modeStore.listModes();
          const active = await modeStore.getActiveMode();
          send(ws, {
            type: 'modes.list',
            payload: {
              modes: modes.map((m) => ({
                id: m.id,
                name: m.name,
                description: m.description,
                isActive: m.id === (active?.id ?? 'default'),
              })),
              activeId: active?.id ?? 'default',
            },
          });
        } catch (err) {
          send(ws, {
            type: 'modes.list',
            payload: {
              modes: [],
              activeId: 'default',
              error: errMessage(err),
            },
          });
        }
        break;
      }

      case 'mode.switch': {
        const { id } = (msg as { payload: { id: string } }).payload;
        try {
          // 'default' is the implicit no-mode state — persisting null
          // clears the override. Anything else has to exist in the store.
          if (id === 'default') {
            await modeStore.setActiveMode(null);
          } else {
            const found = await modeStore.getMode(id);
            if (!found) throw new Error(`Unknown mode "${id}"`);
            await modeStore.setActiveMode(id);
          }
          modeId = id;
          // Rebuild the system prompt so the next turn picks up the new
          // mode's instructions. The builder caches the environment block
          // per projectRoot (including the modeId), so we clear the cache
          // and rebuild. The `buildMode()` method reads this.opts.modePrompt
          // which is set on the builder constructor — we construct a fresh
          // builder with the updated mode. This is cheap (no fs/net IO in
          // the constructor; the real work happens in build()).
          const modePrompt = id === 'default' ? '' : ((await modeStore.getMode(id))?.prompt ?? '');
          const freshBuilder = new DefaultSystemPromptBuilder({
            memoryStore,
            skillLoader,
            modeStore,
            modeId: id,
            modePrompt,
            modelCapabilities,
          });
          context.systemPrompt = await freshBuilder.build({
            cwd: projectRoot,
            projectRoot,
            tools: toolRegistry.list(),
            provider: config.provider,
            model: config.model,
          });
          sendResult(ws, true, `Switched to mode "${id}"`);
          broadcast({
            type: 'session.start',
            payload: { ...(await sessionStartPayload()) },
          });
        } catch (err) {
          sendResult(ws, false, errMessage(err));
        }
        break;
      }

      case 'stats.get': {
        // Mirror of the CLI's /stats: detailed session report.
        const usage = tokenCounter.total();
        const cacheStats = tokenCounter.cacheStats();
        const m = await modelsRegistry.getModel(config.provider, config.model).catch(() => null);
        const cost = computeUsageCost(usage, getCostRates(m));
        send(ws, {
          type: 'stats.get',
          payload: {
            sessionId: session.id,
            provider: config.provider,
            model: config.model,
            usage,
            cache: cacheStats,
            cost,
            messages: context.messages.length,
            readFiles: context.readFiles.size,
            tools: toolRegistry.list().length,
            elapsedMs: Date.now() - sessionStartedAt,
          },
        });
        break;
      }

      default:
        if (msg.type.startsWith('autophase.')) {
          // Delegate all AutoPhase lifecycle messages to the handler
          await autoPhaseHandler.handleMessage(msg as { type: string; payload?: Record<string, unknown> });
        } else {
          send(ws, { type: 'error', payload: { phase: 'handleMessage', message: `Unknown message type: ${msg.type}` } });
        }
    }
  }

  // ---- Provider/Key management helpers (mirror packages/cli/src/webui-server.ts) ----

  async function loadSavedProviders(): Promise<Record<string, ProviderConfig>> {
    try {
      const raw = await fs.readFile(globalConfigPath, 'utf8');
      const parsed = JSON.parse(raw) as { providers?: Record<string, ProviderConfig> };
      if (!parsed.providers) return {};
      return decryptConfigSecrets(parsed.providers, vault);
    } catch {
      return {};
    }
  }

  async function saveProviders(providers: Record<string, ProviderConfig>): Promise<void> {
    configWriteLock = configWriteLock.then(async () => {
      let parsed: Record<string, unknown>;
      try {
        const raw = await fs.readFile(globalConfigPath, 'utf8');
        parsed = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        parsed = {};
      }
      parsed['providers'] = providers;
      const encrypted = encryptConfigSecrets(parsed, vault);
      await atomicWrite(globalConfigPath, JSON.stringify(encrypted, null, 2), { mode: 0o600 });
    });
    await configWriteLock;
  }

  // Provider/API-key record transforms (normalizeKeys, writeKeysBack,
  // maskedKey, upsert/delete/setActive/add/remove) live in ./provider-keys.ts
  // as pure functions; the handlers below own the load/save I/O + WS reply.

  function sendResult(ws: WebSocket, success: boolean, message: string): void {
    send(ws, { type: 'key.operation_result', payload: { success, message } });
  }

  // Each handler loads the decrypted providers record, applies a pure transform
  // from ./provider-keys.ts, persists only on success, and reports the result.
  async function handleKeyUpsert(
    ws: WebSocket,
    providerId: string,
    label: string,
    apiKey: string,
  ): Promise<void> {
    try {
      const providers = await loadSavedProviders();
      const result = upsertKeyRecord(providers, providerId, label, apiKey, new Date().toISOString());
      if (result.ok) await saveProviders(providers);
      sendResult(ws, result.ok, result.message);
    } catch (err) {
      sendResult(ws, false, errMessage(err));
    }
  }

  async function handleKeyDelete(ws: WebSocket, providerId: string, label: string): Promise<void> {
    try {
      const providers = await loadSavedProviders();
      const result = deleteKeyRecord(providers, providerId, label);
      if (result.ok) await saveProviders(providers);
      sendResult(ws, result.ok, result.message);
    } catch (err) {
      sendResult(ws, false, errMessage(err));
    }
  }

  async function handleKeySetActive(
    ws: WebSocket,
    providerId: string,
    label: string,
  ): Promise<void> {
    try {
      const providers = await loadSavedProviders();
      const result = setActiveKeyRecord(providers, providerId, label);
      if (result.ok) await saveProviders(providers);
      sendResult(ws, result.ok, result.message);
    } catch (err) {
      sendResult(ws, false, errMessage(err));
    }
  }

  async function handleProviderAdd(
    ws: WebSocket,
    payload: { id: string; family: string; baseUrl?: string; apiKey?: string },
  ): Promise<void> {
    try {
      const providers = await loadSavedProviders();
      const result = addProviderRecord(providers, payload, new Date().toISOString());
      if (result.ok) await saveProviders(providers);
      sendResult(ws, result.ok, result.message);
    } catch (err) {
      sendResult(ws, false, errMessage(err));
    }
  }

  async function handleProviderRemove(ws: WebSocket, providerId: string): Promise<void> {
    try {
      const providers = await loadSavedProviders();
      const result = removeProviderRecord(providers, providerId);
      if (result.ok) await saveProviders(providers);
      sendResult(ws, result.ok, result.message);
    } catch (err) {
      sendResult(ws, false, errMessage(err));
    }
  }

  // HTTP server for the React frontend (port 3456) — see `http-server.ts`
  // for the static-serve, MIME matching, path-traversal guard, and CSP
  // header logic. Constructed here, listen()d below alongside the WS server.
  const httpServer = createHttpServer({
    host: wsHost,
    distDir: path.resolve(import.meta.dirname, '../../dist'),
    wsPort,
  });
  const httpPort = Number.parseInt(process.env['PORT'] ?? '3456', 10);
  httpServer.listen(httpPort, wsHost, () => {
    console.log(`[WebUI] HTTP server running on http://${wsHost}:${httpPort}`);
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
  });
}
