import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  Agent,
  AutoCompactionMiddleware,
  type Config,
  Container,
  Context,
  DefaultConfigLoader,
  DefaultConfigStore,
  DefaultErrorHandler,
  DefaultLogger,
  DefaultMemoryStore,
  DefaultModeStore,
  DefaultModelsRegistry,
  DefaultPathResolver,
  DefaultPermissionPolicy,
  DefaultRetryPolicy,
  DefaultSecretScrubber,
  DefaultSecretVault,
  DefaultSessionStore,
  DefaultSkillLoader,
  DefaultSystemPromptBuilder,
  DefaultTokenCounter,
  EventBus,
  HybridCompactor,
  type ProviderApiKey,
  type ProviderConfig,
  ProviderRegistry,
  TOKENS,
  ToolRegistry,
  type WstackPaths,
  atomicWrite,
  createDefaultPipelines,
  migratePlaintextSecrets,
  resolveWstackPaths,
} from '@wrongstack/core';
import { buildProviderFactoriesFromRegistry, makeProviderFromConfig } from '@wrongstack/providers';
import { forgetTool, rememberTool } from '@wrongstack/tools';
import { builtinTools } from '@wrongstack/tools/builtin';
import { WebSocket, WebSocketServer } from 'ws';

// Re-export types
export type { WebUIOptions, BackendServices } from './types.js';

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
}

interface BootResult {
  config: Config;
  vault: DefaultSecretVault;
  globalConfigPath: string;
  projectRoot: string;
  wpaths: WstackPaths;
  logger: InstanceType<typeof DefaultLogger>;
}

/**
 * Boot config the same way the CLI does (mirrors packages/cli/src/boot-config.ts):
 *   - resolve wstack paths
 *   - create the real DefaultSecretVault (AES-GCM, not XOR) backed by ~/.wrongstack/.key
 *   - migrate any plaintext secrets in config files to encrypted form
 *   - load + merge global/project config with apiKeys auto-decrypted by the vault
 *
 * This ensures the WebUI uses the SAME stored credentials and SAME on-disk
 * format as `wstack` / `wstack auth`. Anything you registered in the CLI just
 * works here.
 */
async function bootConfig(): Promise<BootResult> {
  const cwd = process.cwd();
  const pathResolver = new DefaultPathResolver(cwd);
  const projectRoot = pathResolver.projectRoot;
  const userHome = os.homedir();
  const wpaths = resolveWstackPaths({ projectRoot, userHome });

  await fs.mkdir(wpaths.globalRoot, { recursive: true });
  await fs.mkdir(wpaths.projectDir, { recursive: true });
  await fs.mkdir(wpaths.projectSessions, { recursive: true });

  // Vault must come before the config loader so it can decrypt apiKey-like
  // fields. Lazily creates ~/.wrongstack/.key on first use.
  const vault = new DefaultSecretVault({ keyFile: wpaths.secretsKey });

  // Auto-encrypt any plaintext secrets the user still has in their config
  // (left over from before the vault, or hand-written). Same flow as CLI boot.
  for (const file of [wpaths.globalConfig, wpaths.projectLocalConfig]) {
    try {
      const { migrated } = await migratePlaintextSecrets(file, vault);
      if (migrated > 0) {
        process.stderr.write(`[WebUI] Encrypted ${migrated} plaintext secret(s) in ${file}\n`);
      }
    } catch {
      // best-effort — never block boot on migration issues
    }
  }

  const configLoader = new DefaultConfigLoader({ paths: wpaths, vault });
  const config = await configLoader.load({ cliFlags: {} });

  const logger = new DefaultLogger({
    level: config.log?.level ?? 'info',
    file: wpaths.logFile,
  });

  return {
    config,
    vault,
    globalConfigPath: wpaths.globalConfig,
    projectRoot,
    wpaths,
    logger,
  };
}

function patchConfig(config: Config, updates: Partial<Config>): Config {
  return Object.freeze({ ...config, ...updates });
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

  console.log('[WebUI] Config loaded:', config.provider, '/', config.model);

  // ModelsRegistry
  const modelsRegistry = new DefaultModelsRegistry({
    cacheFile: wpaths.modelsCache,
    ttlSeconds: 24 * 3600,
  });

  // Container & bindings
  const container = new Container();
  const configStore = new DefaultConfigStore(config);
  container.bind(TOKENS.ConfigStore, () => configStore);
  container.bind(TOKENS.Logger, () => logger);
  container.bind(TOKENS.SecretScrubber, () => new DefaultSecretScrubber());
  container.bind(TOKENS.RetryPolicy, () => new DefaultRetryPolicy());
  container.bind(TOKENS.ErrorHandler, () => new DefaultErrorHandler());
  container.bind(TOKENS.ModelsRegistry, () => modelsRegistry);
  container.bind(
    TOKENS.PermissionPolicy,
    () =>
      new DefaultPermissionPolicy({
        trustFile: wpaths.projectTrust,
        yolo: false,
        promptDelegate: undefined,
      }),
  );

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
  for (const t of builtinTools) toolRegistry.register(t);

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

  // Build provider
  const providerConfig = config.providers?.[config.provider] ?? {
    type: config.provider,
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
  };
  let provider: ReturnType<ProviderRegistry['create']>;
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

  // Pipelines
  const pipelines = createDefaultPipelines();

  // Compactor
  const compactor = new HybridCompactor({
    preserveK: config.context?.preserveK ?? 20,
    eliseThreshold: config.context?.eliseThreshold ?? 0.7,
  });

  // Auto-compaction
  if (config.context?.autoCompact !== false) {
    const autoCompactor = new AutoCompactionMiddleware(
      compactor,
      200000,
      (ctx) => {
        let total = 0;
        for (const m of ctx.messages) {
          if (typeof m.content === 'string') total += Math.ceil(m.content.length / 4);
        }
        return total;
      },
      { warn: 0.7, soft: 0.85, hard: 0.95 },
      { events },
    );
    pipelines.contextWindow.use({ name: 'AutoCompaction', handler: autoCompactor.handler() });
  }

  // Agent
  const agent = new Agent({
    container,
    tools: toolRegistry,
    providers: providerRegistry,
    events,
    pipelines,
    context,
    maxIterations: config.tools?.maxIterations ?? 100,
    iterationTimeoutMs: config.tools?.iterationTimeoutMs ?? 120000,
    executionStrategy: config.tools?.defaultExecutionStrategy ?? 'sequential',
    perIterationOutputCapBytes: config.tools?.perIterationOutputCapBytes ?? 50000,
    confirmAwaiter: undefined,
  });
  console.log('[WebUI] Agent initialized');

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
      const cost = (
        m as { cost?: { input?: number; output?: number; cache_read?: number } } | undefined
      )?.cost;
      inputCost = cost?.input ?? 0;
      outputCost = cost?.output ?? 0;
      cacheReadCost = cost?.cache_read ?? 0;
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
  const wssPrimary = new WebSocketServer({ port: wsPort, host: wsHost });
  const wssSecondary =
    wsHost === '127.0.0.1' ? new WebSocketServer({ port: wsPort, host: '::1' }) : null;
  const clients = new Map<WebSocket, ConnectedClient>();
  let abortController: AbortController | null = null;

  console.log(
    `[WebUI] WebSocket server running on ws://${wsHost}:${wsPort}` +
      (wssSecondary ? ` (and ws://[::1]:${wsPort})` : ''),
  );

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
    const client: ConnectedClient = { ws, sessionId: session.id };
    clients.set(ws, client);
    console.log('[WebUI] Client connected, total:', clients.size);

    void sessionStartPayload().then((payload) => {
      send(ws, { type: 'session.start', payload });
    });

    ws.on('message', async (data) => {
      try {
        const msg = JSON.parse(data.toString()) as WSClientMessage;
        await handleMessage(ws, client, msg);
      } catch (err) {
        console.error('[WebUI] Failed to parse message', err);
      }
    });

    ws.on('close', () => {
      clients.delete(ws);
      console.log('[WebUI] Client disconnected, total:', clients.size);
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
    client: ConnectedClient,
    msg: WSClientMessage,
  ): Promise<void> {
    switch (msg.type) {
      case 'user_message': {
        const content = (msg as { payload: { content: string } }).payload.content;

        // Abort any existing run
        abortController?.abort();
        abortController = new AbortController();

        try {
          const result = await agent.run(content, { signal: abortController.signal });
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
              message: err instanceof Error ? err.message : String(err),
            },
          });
        } finally {
          abortController = null;
        }
        break;
      }

      case 'abort':
        abortController?.abort();
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
        // the context window. Uses the simple 4-chars-per-token heuristic —
        // not exact, but close enough to spot which section is bloated.
        const estimate = (s: string): number => Math.ceil(s.length / 4);
        const stringifyContent = (c: unknown): string => {
          if (typeof c === 'string') return c;
          try {
            return JSON.stringify(c);
          } catch {
            return String(c);
          }
        };
        const sysTokens = context.systemPrompt.reduce((acc, b) => acc + estimate(b.text ?? ''), 0);
        // Tool schemas: each tool sends a JSON schema to the model on every
        // turn. With 20+ builtins these can be 10-20k by themselves.
        const tools = toolRegistry.list();
        const toolBreakdown = tools.map((t) => {
          const schema = (t as { inputSchema?: unknown }).inputSchema ?? {};
          const desc = (t as { description?: string }).description ?? '';
          return {
            name: t.name,
            tokens: estimate(t.name) + estimate(desc) + estimate(stringifyContent(schema)),
          };
        });
        const toolTokens = toolBreakdown.reduce((a, b) => a + b.tokens, 0);
        const messageBreakdown = context.messages.map((m, i) => {
          let tk = 0;
          if (typeof m.content === 'string') {
            tk = estimate(m.content);
          } else if (Array.isArray(m.content)) {
            for (const b of m.content) {
              if (b.type === 'text') tk += estimate(b.text ?? '');
              else if (b.type === 'tool_use') tk += estimate(stringifyContent(b.input));
              else if (b.type === 'tool_result') tk += estimate(stringifyContent(b.content));
              else tk += estimate(stringifyContent(b));
            }
          }
          return {
            index: i,
            role: m.role,
            tokens: tk,
            preview:
              typeof m.content === 'string'
                ? m.content.slice(0, 60)
                : Array.isArray(m.content)
                  ? m.content
                      .map((b) =>
                        b.type === 'text'
                          ? (b.text ?? '').slice(0, 40)
                          : b.type === 'tool_use'
                            ? `[tool_use: ${b.name}]`
                            : b.type === 'tool_result'
                              ? `[tool_result]`
                              : `[${b.type}]`,
                      )
                      .join(' ')
                      .slice(0, 60)
                  : '',
          };
        });
        const msgTokens = messageBreakdown.reduce((a, b) => a + b.tokens, 0);
        const total = sysTokens + toolTokens + msgTokens;
        send(ws, {
          type: 'context.debug',
          payload: {
            total,
            systemPrompt: sysTokens,
            tools: { total: toolTokens, count: tools.length, breakdown: toolBreakdown },
            messages: {
              total: msgTokens,
              count: context.messages.length,
              breakdown: messageBreakdown,
            },
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
            },
          });
          sendResult(
            ws,
            true,
            `Compacted: ${report.before} → ${report.after} tokens (saved ~${Math.max(0, report.before - report.after)})`,
          );
        } catch (err) {
          sendResult(ws, false, err instanceof Error ? err.message : String(err));
        }
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

          // Persist to global config file
          try {
            const raw = await fs.readFile(globalConfigPath, 'utf8');
            const parsed = JSON.parse(raw);
            parsed.provider = newProvider;
            parsed.model = newModel;
            await atomicWrite(globalConfigPath, JSON.stringify(parsed, null, 2));
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
              message: `Switch failed: ${err instanceof Error ? err.message : String(err)}`,
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

      case 'providers.saved': {
        try {
          const providers = await loadSavedProviders();
          send(ws, {
            type: 'providers.saved',
            payload: {
              providers: Object.entries(providers).map(([id, cfg]) => ({
                id,
                family: cfg.family,
                baseUrl: cfg.baseUrl,
                apiKeys: normalizeKeys(cfg).map((k) => ({
                  label: k.label,
                  maskedKey: maskedKey(k.apiKey),
                  isActive: k.label === cfg.activeKey,
                  createdAt: k.createdAt ?? '',
                })),
              })),
            },
          });
        } catch {
          send(ws, { type: 'providers.saved', payload: { providers: [] } });
        }
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
            payload: { sessions: [], error: err instanceof Error ? err.message : String(err) },
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
          sendResult(ws, false, err instanceof Error ? err.message : String(err));
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
          sendResult(ws, false, err instanceof Error ? err.message : String(err));
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
            payload: { text: '', error: err instanceof Error ? err.message : String(err) },
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
          sendResult(ws, false, err instanceof Error ? err.message : String(err));
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
          sendResult(ws, false, err instanceof Error ? err.message : String(err));
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
              error: err instanceof Error ? err.message : String(err),
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
        // the rest of the context. Drop the array in place so any code
        // path still holding a reference sees the change (`length = 0`
        // mutates instead of replacing).
        context.todos.length = 0;
        sendResult(ws, true, 'Todos cleared');
        broadcast({ type: 'todos.updated', payload: { todos: [] } });
        break;
      }

      case 'files.list': {
        // Lightweight project file picker for the chat `@` mention popup.
        // Walks projectRoot, skipping the heavyweight build/vcs/node_modules
        // dirs that would blow up the response on a real project. Applies
        // a fuzzy substring match against the (lowercased) query and caps
        // the result so the popup never has to paginate.
        const payload = (msg as { payload?: { query?: string; limit?: number } }).payload ?? {};
        const query = (payload.query ?? '').toLowerCase();
        const limit = payload.limit ?? 50;
        const SKIP_DIRS = new Set([
          '.git',
          'node_modules',
          'dist',
          'build',
          '.next',
          '.turbo',
          '.cache',
          'target',
          'coverage',
          '.nyc_output',
          'out',
          '.pnpm-store',
          '.parcel-cache',
        ]);
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
            if (e.name.startsWith('.') && e.name !== '.wrongstack' && e.name !== '.env.example') {
              // hide dotfiles by default; pick a couple common ones the user
              // might want anyway
              if (e.name !== '.gitignore' && e.name !== '.eslintrc' && e.name !== '.prettierrc')
                continue;
            }
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
        // Score: exact basename match > prefix > substring. Cheap heuristic
        // that's good enough for a picker.
        const scored: Array<{ path: string; score: number }> = [];
        for (const p of results) {
          if (!query) {
            scored.push({ path: p, score: 0 });
            continue;
          }
          const lower = p.toLowerCase();
          const base = lower.split('/').pop() ?? lower;
          let score = 0;
          if (base === query) score = 100;
          else if (base.startsWith(query)) score = 60;
          else if (lower.includes(query)) score = 20;
          else continue;
          // Penalise depth so root files come first.
          score -= p.split('/').length;
          scored.push({ path: p, score });
        }
        scored.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
        send(ws, {
          type: 'files.list',
          payload: { files: scored.slice(0, limit).map((s) => s.path) },
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
              error: err instanceof Error ? err.message : String(err),
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
          sendResult(ws, true, `Switched to mode "${id}"`);
          broadcast({
            type: 'session.start',
            payload: { ...(await sessionStartPayload()) },
          });
        } catch (err) {
          sendResult(ws, false, err instanceof Error ? err.message : String(err));
        }
        break;
      }

      case 'stats.get': {
        // Mirror of the CLI's /stats: detailed session report.
        const usage = tokenCounter.total();
        const cacheStats = tokenCounter.cacheStats();
        const m = await modelsRegistry.getModel(config.provider, config.model).catch(() => null);
        const inputCost = (m as { cost?: { input?: number } } | null)?.cost?.input ?? 0;
        const outputCost = (m as { cost?: { output?: number } } | null)?.cost?.output ?? 0;
        const cacheReadCost =
          (m as { cost?: { cache_read?: number } } | null)?.cost?.cache_read ?? 0;
        const cost =
          (usage.input * inputCost +
            usage.output * outputCost +
            (usage.cacheRead ?? 0) * cacheReadCost) /
          1_000_000;
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
    }
  }

  // ---- Provider/Key management helpers (mirror packages/cli/src/webui-server.ts) ----

  async function loadSavedProviders(): Promise<Record<string, ProviderConfig>> {
    try {
      const raw = await fs.readFile(globalConfigPath, 'utf8');
      const parsed = JSON.parse(raw) as { providers?: Record<string, ProviderConfig> };
      return parsed.providers ?? {};
    } catch {
      return {};
    }
  }

  async function saveProviders(providers: Record<string, ProviderConfig>): Promise<void> {
    let parsed: Record<string, unknown>;
    try {
      const raw = await fs.readFile(globalConfigPath, 'utf8');
      parsed = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      parsed = {};
    }
    parsed['providers'] = providers;
    await atomicWrite(globalConfigPath, JSON.stringify(parsed, null, 2), { mode: 0o600 });
  }

  function normalizeKeys(cfg: ProviderConfig): ProviderApiKey[] {
    if (Array.isArray(cfg.apiKeys) && cfg.apiKeys.length > 0) {
      return cfg.apiKeys.map((k) => ({ ...k }));
    }
    if (typeof cfg.apiKey === 'string' && cfg.apiKey.length > 0) {
      return [{ label: 'default', apiKey: cfg.apiKey, createdAt: '' }];
    }
    return [];
  }

  function writeKeysBack(cfg: ProviderConfig, keys: ProviderApiKey[]): void {
    if (keys.length === 0) {
      delete cfg.apiKeys;
      delete cfg.apiKey;
      delete cfg.activeKey;
      return;
    }
    cfg.apiKeys = keys;
    const active = keys.find((k) => k.label === cfg.activeKey) ?? keys[0]!;
    cfg.apiKey = active.apiKey;
    if (!cfg.activeKey || !keys.some((k) => k.label === cfg.activeKey)) {
      cfg.activeKey = active.label;
    }
  }

  function maskedKey(key: string | undefined): string {
    if (!key) return '—';
    if (key.length <= 8) return '•'.repeat(key.length);
    return `${key.slice(0, 4)}…${key.slice(-4)}`;
  }

  function sendResult(ws: WebSocket, success: boolean, message: string): void {
    send(ws, { type: 'key.operation_result', payload: { success, message } });
  }

  async function handleKeyUpsert(
    ws: WebSocket,
    providerId: string,
    label: string,
    apiKey: string,
  ): Promise<void> {
    try {
      const providers = await loadSavedProviders();
      const existing: ProviderConfig = providers[providerId] ?? { type: providerId };
      const keys = normalizeKeys(existing);
      const idx = keys.findIndex((k) => k.label === label);
      const nowIso = new Date().toISOString();
      if (idx >= 0) {
        keys[idx] = { ...keys[idx]!, apiKey, createdAt: nowIso };
      } else {
        keys.push({ label, apiKey, createdAt: nowIso });
      }
      writeKeysBack(existing, keys);
      if (!existing.activeKey) existing.activeKey = label;
      providers[providerId] = existing;
      await saveProviders(providers);
      sendResult(ws, true, `Key "${label}" saved for ${providerId}`);
    } catch (err) {
      sendResult(ws, false, err instanceof Error ? err.message : String(err));
    }
  }

  async function handleKeyDelete(ws: WebSocket, providerId: string, label: string): Promise<void> {
    try {
      const providers = await loadSavedProviders();
      const existing = providers[providerId];
      if (!existing) {
        sendResult(ws, false, `Provider "${providerId}" not found`);
        return;
      }
      const keys = normalizeKeys(existing).filter((k) => k.label !== label);
      if (keys.length === 0) {
        delete providers[providerId];
      } else {
        writeKeysBack(existing, keys);
        if (existing.activeKey === label) existing.activeKey = keys[0]!.label;
        providers[providerId] = existing;
      }
      await saveProviders(providers);
      sendResult(ws, true, `Key "${label}" deleted from ${providerId}`);
    } catch (err) {
      sendResult(ws, false, err instanceof Error ? err.message : String(err));
    }
  }

  async function handleKeySetActive(
    ws: WebSocket,
    providerId: string,
    label: string,
  ): Promise<void> {
    try {
      const providers = await loadSavedProviders();
      const existing = providers[providerId];
      if (!existing) {
        sendResult(ws, false, `Provider "${providerId}" not found`);
        return;
      }
      existing.activeKey = label;
      writeKeysBack(existing, normalizeKeys(existing));
      providers[providerId] = existing;
      await saveProviders(providers);
      sendResult(ws, true, `Active key for ${providerId} set to "${label}"`);
    } catch (err) {
      sendResult(ws, false, err instanceof Error ? err.message : String(err));
    }
  }

  async function handleProviderAdd(
    ws: WebSocket,
    payload: { id: string; family: string; baseUrl?: string; apiKey?: string },
  ): Promise<void> {
    try {
      const providers = await loadSavedProviders();
      if (providers[payload.id]) {
        sendResult(ws, false, `Provider "${payload.id}" already exists. Use key.add to add a key.`);
        return;
      }
      const newProv: ProviderConfig = {
        type: payload.id,
        family: payload.family as ProviderConfig['family'],
        baseUrl: payload.baseUrl,
      };
      if (payload.apiKey) {
        newProv.apiKeys = [
          { label: 'default', apiKey: payload.apiKey, createdAt: new Date().toISOString() },
        ];
        newProv.activeKey = 'default';
      }
      providers[payload.id] = newProv;
      await saveProviders(providers);
      sendResult(ws, true, `Provider "${payload.id}" added`);
    } catch (err) {
      sendResult(ws, false, err instanceof Error ? err.message : String(err));
    }
  }

  async function handleProviderRemove(ws: WebSocket, providerId: string): Promise<void> {
    try {
      const providers = await loadSavedProviders();
      if (!providers[providerId]) {
        sendResult(ws, false, `Provider "${providerId}" not found`);
        return;
      }
      delete providers[providerId];
      await saveProviders(providers);
      sendResult(ws, true, `Provider "${providerId}" removed`);
    } catch (err) {
      sendResult(ws, false, err instanceof Error ? err.message : String(err));
    }
  }

  // Graceful shutdown
  const shutdown = async () => {
    console.log('[WebUI] Shutting down...');
    try {
      await session.append({
        type: 'session_end',
        ts: new Date().toISOString(),
        usage: tokenCounter.total(),
      });
      await session.close();
    } catch (e) {
      console.warn('[WebUI] Error closing session:', e);
    }
    for (const [ws] of clients) ws.close();
    wssPrimary.close();
    wssSecondary?.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
