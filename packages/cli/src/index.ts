import { writeFileSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import {
  Agent,
  AutoCompactionMiddleware,
  type Config,
  Container,
  Context,
  DefaultAttachmentStore,
  DefaultConfigStore,
  DefaultErrorHandler,
  DefaultHealthRegistry,
  DefaultLogger,
  DefaultMemoryStore,
  DefaultModeStore,
  DefaultModelsRegistry,
  DefaultPathResolver,
  DefaultPermissionPolicy,
  DefaultRetryPolicy,
  DefaultSecretScrubber,
  DefaultSessionStore,
  DefaultSkillLoader,
  DefaultSystemPromptBuilder,
  DefaultTokenCounter,
  Director,
  EventBus,
  FLEET_ROSTER,
  type HealthRegistry,
  HybridCompactor,
  InMemoryMetricsSink,
  type MetricsServerHandle,
  type MetricsSink,
  type Plugin,
  ProviderRegistry,
  QueueStore,
  RecoveryLock,
  SlashCommandRegistry,
  type SystemPromptBuilder,
  TOKENS,
  ToolRegistry,
  attachTodosCheckpoint,
  color,
  createContextManagerTool,
  createDefaultPipelines,
  createDelegateTool,
  loadDirectorState,
  loadPlan,
  loadPlugins,
  loadTodosCheckpoint,
  startMetricsServer,
  wireMetricsToEvents,
} from '@wrongstack/core';
import { MCPRegistry } from '@wrongstack/mcp';
import {
  buildProviderFactoriesFromRegistry,
  capabilitiesFor,
  makeProviderFromConfig,
} from '@wrongstack/providers';
import { forgetTool, rememberTool } from '@wrongstack/tools';
import { builtinTools } from '@wrongstack/tools/builtin';
import { boot } from './boot.js';
import { type ExecutionDeps, execute } from './execution.js';
import type { ReadlineInputReader } from './input-reader.js';
import { MultiAgentHost } from './multi-agent.js';
import { makeConfirmAwaiter, makePromptDelegate } from './permission-prompt.js';
import { buildPickableProviders } from './provider-helpers.js';
import type { TerminalRenderer } from './renderer.js';
import { SessionStats } from './session-stats.js';
import { buildBuiltinSlashCommands } from './slash-commands/index.js';
import { Spinner } from './spinner.js';
import { fmtTok, patchConfig } from './utils.js';

function resolveBundledSkillsDir(): string | undefined {
  try {
    const req = createRequire(import.meta.url);
    const corePkg = req.resolve('@wrongstack/core/package.json');
    return path.join(path.dirname(corePkg), 'skills');
  } catch {
    return undefined;
  }
}

import { CLI_VERSION } from './version.js';
export { CLI_VERSION };

export async function main(argv: string[]): Promise<number> {
  const ctx = await boot(argv);
  if (typeof ctx === 'number') return ctx;
  let {
    config,
    vault,
    wpaths,
    cwd,
    projectRoot,
    userHome,
    flags,
    positional,
    modelsRegistry,
    renderer,
    reader,
    logger,
  } = ctx;
  // PathResolver is created from the resolved projectRoot
  const pathResolver = new DefaultPathResolver(cwd);

  // Resolve provider details from models.dev. An alias may not match a
  // catalog id directly, so we also try `cfg.type` (which points at the
  // catalog entry the alias was derived from). When neither resolves AND
  // the user has explicitly set `family` in their config, this is a
  // deliberate custom/local provider — staying silent is the right call;
  // logging would just train people to ignore the warning.
  const savedProviderCfg = config.providers?.[config.provider];
  let resolvedProvider = await modelsRegistry.getProvider(config.provider).catch(() => undefined);
  if (!resolvedProvider && savedProviderCfg?.type && savedProviderCfg.type !== config.provider) {
    resolvedProvider = await modelsRegistry
      .getProvider(savedProviderCfg.type)
      .catch(() => undefined);
  }
  if (!resolvedProvider) {
    if (!savedProviderCfg?.family) {
      logger.warn(
        `Provider "${config.provider}" not found in models.dev. Continuing with raw config.`,
      );
    }
  } else if (resolvedProvider.family === 'unsupported' && !savedProviderCfg?.family) {
    // Catalog says unsupported AND the user hasn't supplied their own
    // family override — bail. With an override we trust the user knows
    // how to route this endpoint.
    process.stderr.write(
      `Provider "${config.provider}" uses an unsupported wire family (${resolvedProvider.npm}). ` +
        `Install a plugin to enable it, or pick a different provider.\n`,
    );
    await reader.close();
    return 2;
  }

  // Build container + services
  const container = new Container();
  // L1-B: a single ConfigStore is the source of truth for runtime config.
  // Subsystems that care about live updates (provider switching, extension
  // reload) resolve this and call .watch() — everything else can still read
  // the flat `config` snapshot. We mutate the store on /model and similar
  // commands so observers re-render automatically.
  const configStore = new DefaultConfigStore(config);
  container.bind(TOKENS.ConfigStore, () => configStore);
  container.bind(TOKENS.Logger, () => logger);
  container.bind(TOKENS.PathResolver, () => pathResolver);
  container.bind(TOKENS.SecretScrubber, () => new DefaultSecretScrubber());
  container.bind(TOKENS.RetryPolicy, () => new DefaultRetryPolicy());
  container.bind(TOKENS.ErrorHandler, () => new DefaultErrorHandler());
  container.bind(TOKENS.ModelsRegistry, () => modelsRegistry);
  container.bind(
    TOKENS.TokenCounter,
    () => new DefaultTokenCounter({ registry: modelsRegistry, providerId: config.provider }),
  );
  const modeStore = new DefaultModeStore({ directory: wpaths.configDir });
  container.bind(TOKENS.ModeStore, () => modeStore);
  container.bind(
    TOKENS.SessionStore,
    () => new DefaultSessionStore({ dir: wpaths.projectSessions }),
  );
  const memoryStore = new DefaultMemoryStore({ paths: wpaths });
  container.bind(TOKENS.MemoryStore, () => memoryStore);
  // Skills are an opt-in feature pack — when disabled we still bind a
  // loader that returns an empty list so the prompt builder doesn't
  // need a special path. This way `--no-features` doesn't drift behaviour.
  const skillLoader = new DefaultSkillLoader({
    paths: wpaths,
    bundledDir: config.features.skills ? resolveBundledSkillsDir() : undefined,
  });
  container.bind(TOKENS.SkillLoader, () => skillLoader);
  // Resolve modeId and modelCapabilities before building system prompt.
  const activeMode = await modeStore.getActiveMode();
  const modeId = activeMode?.id ?? 'default';
  const modePrompt = activeMode?.prompt ?? '';
  const resolvedModel = await modelsRegistry.getModel(config.provider, config.model);
  const modelCapabilities = resolvedModel?.capabilities
    ? {
        maxContextTokens: resolvedModel.capabilities.maxContext,
        supportsTools: resolvedModel.capabilities.tools,
        supportsVision: resolvedModel.capabilities.vision,
        supportsReasoning: resolvedModel.capabilities.reasoning,
      }
    : undefined;
  // Mutable ref the prompt builder reads on every build() to discover
  // the active session's plan path. Defined BEFORE the bind so the
  // getter closure captures a stable reference instead of the `let
  // session` declaration later in the function — referring to that
  // `let` directly hit a TDZ ReferenceError when build() was called
  // before the declaration line executed (the first build runs at
  // line ~432, the declaration is at ~474).
  const sessionRef: { current?: import('@wrongstack/core').SessionWriter } = {};
  container.bind(
    TOKENS.SystemPromptBuilder,
    () =>
      new DefaultSystemPromptBuilder({
        memoryStore,
        skillLoader: config.features.skills ? skillLoader : undefined,
        modeStore,
        modeId,
        modePrompt,
        modelCapabilities,
        // Reads the ref each time — returns undefined until the session
        // is created, then resolves to the per-session plan JSON path.
        planPath: () =>
          sessionRef.current
            ? path.join(wpaths.projectSessions, `${sessionRef.current.id}.plan.json`)
            : undefined,
      }),
  );
  container.bind(TOKENS.Renderer, () => renderer);
  container.bind(TOKENS.InputReader, () => reader);
  container.bind(
    TOKENS.PermissionPolicy,
    () =>
      new DefaultPermissionPolicy({
        trustFile: wpaths.projectTrust,
        yolo: config.yolo,
        promptDelegate: makePromptDelegate(reader),
      }),
  );
  container.bind(
    TOKENS.Compactor,
    () =>
      new HybridCompactor({
        preserveK: config.context.preserveK,
        eliseThreshold: config.context.eliseThreshold,
      }),
  );

  // Provider registry — populated dynamically from models.dev catalog
  // when enabled. With features.modelsRegistry=false we don't touch the
  // network at boot and rely on the user's config to declare the wire
  // family explicitly (see makeProviderFromConfig path below).
  const providerRegistry = new ProviderRegistry();
  if (config.features.modelsRegistry) {
    try {
      const factories = await buildProviderFactoriesFromRegistry({
        registry: modelsRegistry,
        log: logger,
      });
      for (const f of factories) providerRegistry.register(f);
    } catch (err) {
      process.stderr.write(
        `Failed to load models.dev registry: ${err instanceof Error ? err.message : err}\n` +
          `Try \`wstack models refresh\` once you have network access, or run with --no-features.\n`,
      );
      await reader.close();
      return 2;
    }
  }

  // Tool registry
  const toolRegistry = new ToolRegistry();
  for (const t of builtinTools) toolRegistry.register(t);
  toolRegistry.registerDefault(
    createContextManagerTool({ compactor: container.resolve(TOKENS.Compactor) }),
  );
  if (config.features.memory) {
    toolRegistry.register(rememberTool(memoryStore));
    toolRegistry.register(forgetTool(memoryStore));
  }

  const events = new EventBus();
  events.setLogger(logger);

  // Observability — opt-in via --metrics. Writes a snapshot to
  // <session-dir>/metrics.json on shutdown so users get a post-run summary
  // without standing up a scrape endpoint. The sink is also exposed via the
  // /metrics slash command for live inspection mid-session.
  let metricsSink: MetricsSink | undefined;
  let healthRegistry: HealthRegistry | undefined;
  let metricsServerHandle: MetricsServerHandle | undefined;
  // --metrics-port implies --metrics (you can't scrape what isn't recorded).
  const metricsPortFlag = flags['metrics-port'];
  const metricsPort =
    typeof metricsPortFlag === 'string' && metricsPortFlag.length > 0
      ? Number.parseInt(metricsPortFlag, 10)
      : undefined;
  if (metricsPort !== undefined && !flags.metrics) flags.metrics = true;
  if (flags.metrics) {
    metricsSink = new InMemoryMetricsSink();
    wireMetricsToEvents(events, metricsSink);
    healthRegistry = new DefaultHealthRegistry();
    healthRegistry.register({
      name: 'session-store',
      check: async () => {
        try {
          await fs.access(wpaths.projectSessions);
          return { status: 'healthy' };
        } catch (e) {
          return { status: 'unhealthy', detail: e instanceof Error ? e.message : 'access denied' };
        }
      },
    });
    healthRegistry.register({
      name: 'provider',
      check: async () => ({
        status: 'healthy',
        data: { id: config.provider, model: config.model },
      }),
    });

    const dumpMetrics = () => {
      if (!metricsSink) return;
      try {
        const out = path.join(wpaths.projectSessions, 'metrics.json');
        const snap = metricsSink.snapshot();
        // Sync write — async fs APIs can't survive process.exit().
        writeFileSync(out, JSON.stringify(snap, null, 2));
      } catch {
        // Snapshot is best-effort — never block shutdown on it.
      }
    };
    process.on('exit', dumpMetrics);
    process.on('SIGINT', () => {
      dumpMetrics();
      process.exit(130);
    });

    // L3-C: optional Prometheus scrape endpoint. Bound to 127.0.0.1 by
    // default — operators who want network-visible metrics set
    // METRICS_HOST=0.0.0.0 explicitly. Failure to bind is logged but does
    // not fail the run; the in-process sink keeps recording.
    if (metricsPort !== undefined && Number.isFinite(metricsPort)) {
      try {
        metricsServerHandle = await startMetricsServer({
          port: metricsPort,
          host: process.env.METRICS_HOST ?? '127.0.0.1',
          sink: metricsSink,
          // V2-C: mount /healthz on the same listener so k8s probes can
          // hit one endpoint per pod for both observability and liveness.
          healthRegistry,
        });
        logger.info(
          `metrics endpoint listening on ${metricsServerHandle.url} (healthz on same port)`,
        );
        process.on('exit', () => {
          void metricsServerHandle?.close().catch(() => {});
        });
      } catch (err) {
        logger.warn(
          `metrics endpoint failed to start: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  // Spinner: visible "thinking…" line during each model request.
  const spinner = new Spinner();
  // Track the latest provider request's input-token count so the spinner
  // can render a live context-window fullness bar (TUI parity).
  let lastInputTokens = 0;
  events.on('provider.response', (e) => {
    lastInputTokens = e.usage?.input ?? 0;
    updateSpinnerContext();
  });
  events.on('iteration.started', () => {
    updateSpinnerContext();
    spinner.start(color.dim(`${config.provider}/${config.model} thinking…`));
  });
  events.on('provider.response', () => {
    spinner.stop();
  });
  events.on('error', () => {
    spinner.stop();
  });

  // Live streaming output: first text_delta stops the spinner and starts
  // writing tokens directly so the user sees the model "type".
  let streamingActive = false;
  events.on('provider.text_delta', (p) => {
    if (!streamingActive) {
      spinner.stop();
      streamingActive = true;
    }
    renderer.write(p.text);
  });
  events.on('iteration.completed', () => {
    if (streamingActive) {
      renderer.write('\n');
      streamingActive = false;
    }
  });

  // Provider hiccups — render a single friendly line instead of leaving the
  // raw JSON body in logger output. retry events show a countdown; error
  // events surface a final failure that won't be retried.
  events.on('provider.retry', (p) => {
    spinner.stop();
    if (streamingActive) {
      renderer.write('\n');
      streamingActive = false;
    }
    const secs = (p.delayMs / 1000).toFixed(p.delayMs >= 1000 ? 1 : 2);
    process.stderr.write(color.yellow(`  ⟳ retry ${p.attempt} in ${secs}s — ${p.description}\n`));
    spinner.start(color.dim(`${config.provider}/${config.model} thinking…`));
  });
  events.on('provider.error', (p) => {
    spinner.stop();
    if (streamingActive) {
      renderer.write('\n');
      streamingActive = false;
    }
    process.stderr.write(color.red(`  ✗ ${p.description}\n`));
  });

  // Provider instance — registry-driven by default, but falls through to
  // config-only construction when the catalog is unavailable (or the
  // user explicitly disabled it).
  const providerConfig = config.providers?.[config.provider] ?? {
    type: config.provider,
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
  };
  let provider: ReturnType<ProviderRegistry['create']>;
  try {
    const cfgWithType = { ...providerConfig, type: config.provider };
    if (config.features.modelsRegistry && providerRegistry.has(config.provider)) {
      // Catalog-backed type: registry knows it, so use the factory. Config
      // overrides (family, baseUrl, envVars) still apply inside `makeProvider`.
      provider = providerRegistry.create(cfgWithType);
    } else {
      // Custom provider (not in catalog), or modelsRegistry feature
      // disabled. Requires `family` to be set in the saved config.
      provider = makeProviderFromConfig(config.provider, cfgWithType);
    }
  } catch (err) {
    process.stderr.write(
      `Failed to create provider: ${err instanceof Error ? err.message : err}\n`,
    );
    await reader.close();
    return 2;
  }

  // Build system prompt
  const promptBuilder = container.resolve(TOKENS.SystemPromptBuilder) as SystemPromptBuilder;
  const systemPrompt = await promptBuilder.build({
    cwd,
    projectRoot,
    tools: toolRegistry.list(),
    provider: config.provider,
    model: config.model,
  });

  // Session — fresh by default, or resumed from disk if --resume <id> was passed.
  const sessionStore = container.resolve(TOKENS.SessionStore);
  let resumeId = typeof flags['resume'] === 'string' ? flags['resume'] : undefined;

  // Crash recovery: if the last interactive run was killed mid-flight,
  // its `active.json` lockfile is still on disk and the session has no
  // `session_end` event. Offer to resume it before opening a fresh one.
  // Skipped when the user explicitly chose `--resume <id>` or asked to
  // bypass with `--no-recovery`.
  const recoveryLock = new RecoveryLock({
    dir: wpaths.projectSessions,
    sessionStore,
  });
  if (!resumeId && !flags['no-recovery']) {
    const abandoned = await recoveryLock.checkAbandoned();
    if (abandoned && abandoned.messageCount > 0) {
      const choice = await promptRecovery(reader, renderer, abandoned, !!flags['recover']);
      if (choice === 'resume') {
        resumeId = abandoned.sessionId;
      } else if (choice === 'delete') {
        await sessionStore.delete(abandoned.sessionId).catch(() => undefined);
        await recoveryLock.clear();
      } else {
        // 'skip' — leave the file on disk, just clear the lock so we
        // don't ask again every launch.
        await recoveryLock.clear();
      }
    } else if (abandoned) {
      // Empty session (no real work done) — silently discard.
      await sessionStore.delete(abandoned.sessionId).catch(() => undefined);
      await recoveryLock.clear();
    }
  }

  let session: import('@wrongstack/core').SessionWriter | undefined;
  let restoredMessages: import('@wrongstack/core').Message[] = [];
  if (resumeId) {
    try {
      const resumed = await sessionStore.resume(resumeId);
      session = resumed.writer;
      restoredMessages = resumed.data.messages;
      renderer.writeInfo(
        `Resumed session ${resumed.data.metadata.id} — ${restoredMessages.length} messages, ${resumed.data.usage.input + resumed.data.usage.output} tokens used previously.`,
      );
    } catch (err) {
      renderer.writeError(`Resume failed: ${err instanceof Error ? err.message : String(err)}`);
      return 2;
    }
  } else {
    session = await sessionStore.create({
      id: '',
      title: '',
      model: config.model,
      provider: config.provider,
    });
  }

  // Publish the live session to the prompt-builder ref so future
  // build() calls can locate the per-session plan path. Setting this
  // AFTER session is assigned guarantees the getter never sees a
  // partially-constructed writer.
  sessionRef.current = session;

  // Claim the lock for this session. Released in the finally block below.
  await recoveryLock.write(session.id).catch(() => undefined);

  // Attachment store: per-session, spooled under sessions/<id>/attachments/.
  const attachments = new DefaultAttachmentStore({
    spoolDir: path.join(wpaths.projectSessions, session.id, 'attachments'),
  });

  // Queue persistence (TUI only — the REPL has no concurrent input).
  // Lives next to attachments so deleting the session dir cleans both.
  const queueStore = new QueueStore({
    dir: path.join(wpaths.projectSessions, session.id),
  });

  const tokenCounter = container.resolve(TOKENS.TokenCounter);

  // Session stats tracker — subscribes to events; rendered at the end.
  const stats = new SessionStats(events, tokenCounter);

  // Last-N error ring buffer surfaced by /diag. Captures whatever `error`
  // events the agent emits during a run (provider failures, retries, etc).
  const errorRing: { ts: string; phase: string; code: string; message: string }[] = [];
  events.on('error', (e) => {
    const err = e.err as unknown;
    const code =
      err &&
      typeof err === 'object' &&
      'code' in err &&
      typeof (err as { code: unknown }).code === 'string'
        ? (err as { code: string }).code
        : 'UNKNOWN';
    const message = e.err instanceof Error ? e.err.message : String(e.err);
    errorRing.push({ ts: new Date().toISOString(), phase: e.phase, code, message });
    if (errorRing.length > 5) errorRing.shift();
  });

  const ctxSignal = new AbortController().signal;
  const context = new Context({
    systemPrompt,
    provider,
    session,
    signal: ctxSignal,
    tokenCounter,
    cwd,
    projectRoot,
    model: config.model,
  });
  // Hydrate the transcript when resuming so the model sees the prior
  // conversation. Order is preserved from the JSONL log.
  if (restoredMessages.length > 0) {
    context.state.replaceMessages(restoredMessages);
  }

  // ---- Todos checkpoint: persist ctx.todos to disk + reload on resume ----
  // Lives next to the JSONL session file so deleting one session cleans
  // its sidecar checkpoints in one shot. The checkpoint is plain JSON
  // (not JSONL) — overwritten atomically on every todos_replaced event.
  const todosCheckpointPath = path.join(wpaths.projectSessions, `${session.id}.todos.json`);
  if (resumeId) {
    try {
      const restoredTodos = await loadTodosCheckpoint(todosCheckpointPath);
      if (restoredTodos && restoredTodos.length > 0) {
        context.state.replaceTodos(restoredTodos);
        renderer.writeInfo(
          `Restored ${restoredTodos.length} todo${restoredTodos.length === 1 ? '' : 's'} from previous run.`,
        );
      }
    } catch {
      // Best-effort: a missing or unreadable checkpoint is the common
      // case for sessions that never used todos. Stay silent.
    }
  }
  const detachTodosCheckpoint = attachTodosCheckpoint(
    context.state,
    todosCheckpointPath,
    session.id,
  );

  // Seed the plan-tool path into ctx.meta so the LLM-callable `plan` tool
  // (and any future plan-aware middleware) knows where to read/write.
  // The slash command reads `planPath` from its own context separately;
  // this meta entry is purely for tool execution.
  const planPath = path.join(wpaths.projectSessions, `${session.id}.plan.json`);
  context.state.setMeta('plan.path', planPath);

  // Surface any prior director-state.json so the user knows a multi-agent
  // run was interrupted. The director itself reattaches via fleetRoot,
  // but we want a banner-level "you have unfinished fleet work" cue too.
  if (resumeId) {
    try {
      const fleetRoot = path.join(wpaths.projectSessions, session.id);
      const dirState = await loadDirectorState(path.join(fleetRoot, 'director-state.json'));
      if (dirState) {
        const tCounts: Record<string, number> = {};
        for (const t of dirState.tasks) {
          tCounts[t.status] = (tCounts[t.status] ?? 0) + 1;
        }
        const summary = Object.entries(tCounts)
          .map(([k, v]) => `${v} ${k}`)
          .join(', ');
        renderer.writeInfo(
          `Prior fleet state: ${dirState.subagents.length} subagent${dirState.subagents.length === 1 ? '' : 's'}, tasks ${summary || '(none)'}.`,
        );
      }
    } catch {
      // ignore — fleet rehydration is a UX hint, not load-bearing
    }
    // Symmetric plan banner: surface open plan items so the user (and the
    // model, on first turn) know the strategic roadmap survived the gap.
    try {
      const plan = await loadPlan(planPath);
      if (plan && plan.items.length > 0) {
        const open = plan.items.filter((p) => p.status !== 'done').length;
        const done = plan.items.length - open;
        renderer.writeInfo(
          `Plan: ${plan.items.length} item${plan.items.length === 1 ? '' : 's'} (${open} open, ${done} done). Use /plan to review.`,
        );
      }
    } catch {
      // ignore — plan banner is decorative
    }
  }

  const pipelines = createDefaultPipelines();

  // L1-F error boundary: a crashing plugin-owned middleware shouldn't kill
  // the agent run. Core-owned middleware still rethrows so genuine bugs in
  // the framework surface loudly. Plugin owners are identified by the
  // `owner` field set by the slash-command/middleware registration helper.
  const installBoundary = <T>(p: {
    setErrorHandler: (
      h: (ev: { middleware: string; owner?: string; err: unknown }) => 'rethrow' | 'swallow',
    ) => unknown;
  }) => {
    p.setErrorHandler((ev) => {
      const fromPlugin = !!ev.owner && ev.owner !== 'core';
      logger.error(
        `Pipeline middleware "${ev.middleware}" crashed (owner=${ev.owner ?? 'unknown'}); ${fromPlugin ? 'swallowed' : 'rethrown'}`,
        ev.err,
      );
      events.emit('error', {
        err: ev.err instanceof Error ? ev.err : new Error(String(ev.err)),
        phase: `pipeline:${ev.middleware}`,
      });
      return fromPlugin ? 'swallow' : 'rethrow';
    });
  };
  installBoundary(pipelines.request);
  installBoundary(pipelines.response);
  installBoundary(pipelines.toolCall);
  installBoundary(pipelines.userInput);
  installBoundary(pipelines.assistantOutput);
  installBoundary(pipelines.contextWindow);

  // Resolve compactor — bound earlier (strategy-aware binding moved before provider creation)
  const compactor = container.resolve(TOKENS.Compactor);

  // Auto-compaction: monitor token load and compact when thresholds are crossed.
  // Skipped when config.context.autoCompact is false.
  //
  // Resolve the *model-specific* maxContext via the registry — the
  // provider object only knows its family default (e.g. anthropic =
  // 200k), which is wrong for variants like Claude Opus 4.7 with the
  // 1M-context beta. Falls back to the provider baseline when the
  // registry can't resolve the model.
  const resolvedCaps = await capabilitiesFor(modelsRegistry, config.provider, context.model).catch(
    () => undefined,
  );
  const effectiveMaxContext =
    config.context.effectiveMaxContext ??
    resolvedCaps?.maxContext ??
    provider.capabilities.maxContext;

  // Helper: keep the spinner's context chip in sync with the latest
  // provider response and the resolved max-context ceiling.
  const updateSpinnerContext = () => {
    if (effectiveMaxContext > 0 && lastInputTokens > 0) {
      spinner.setContext({ used: lastInputTokens, max: effectiveMaxContext });
    } else {
      spinner.setContext(undefined);
    }
  };

  if (config.context.autoCompact !== false) {
    const autoCompactor = new AutoCompactionMiddleware(
      compactor,
      effectiveMaxContext,
      (ctx) => {
        const msgs = ctx.messages;
        let total = 0;
        for (const m of msgs) {
          if (typeof m.content === 'string') total += Math.ceil(m.content.length / 4);
          else if (Array.isArray(m.content)) {
            for (const b of m.content) {
              if (b.type === 'text') total += Math.ceil(b.text.length / 4);
              else if (b.type === 'tool_use' || b.type === 'tool_result') {
                total += Math.ceil(JSON.stringify(b).length / 4);
              }
            }
          }
        }
        return total;
      },
      {
        warn: config.context.warnThreshold,
        soft: config.context.softThreshold,
        hard: config.context.hardThreshold,
      },
      {
        aggressiveOn: 'soft',
        failureMode: 'throw_on_hard',
        events,
      },
    );
    pipelines.contextWindow.use({
      name: 'AutoCompaction',
      handler: autoCompactor.handler(),
    });
  }

  const agent = new Agent({
    container,
    tools: toolRegistry,
    providers: providerRegistry,
    events,
    pipelines,
    context,
    maxIterations: config.tools.maxIterations,
    iterationTimeoutMs: config.tools.iterationTimeoutMs,
    executionStrategy: config.tools.defaultExecutionStrategy,
    perIterationOutputCapBytes: config.tools.perIterationOutputCapBytes,
    confirmAwaiter: makeConfirmAwaiter(reader),
  });

  // MCP servers
  const mcpRegistry = new MCPRegistry({ toolRegistry, events, log: logger });
  if (config.features.mcp) {
    for (const cfg of Object.values(config.mcpServers ?? {})) {
      try {
        await mcpRegistry.start(cfg);
      } catch (err) {
        logger.warn(`MCP server "${cfg.name}" failed to start`, err);
      }
    }
  }

  // Slash registry — created before plugins so plugins can register commands.
  const slashRegistry = new SlashCommandRegistry();

  // Plugins
  if (config.features.plugins && config.plugins && config.plugins.length > 0) {
    const resolvedPlugins: Plugin[] = [];
    for (const p of config.plugins) {
      const spec = typeof p === 'string' ? p : p.name;
      try {
        const mod = (await import(spec)) as { default?: Plugin };
        if (mod.default) resolvedPlugins.push(mod.default);
      } catch (err) {
        logger.warn(`Plugin "${spec}" failed to load`, err);
      }
    }
    if (resolvedPlugins.length > 0) {
      const { default: createApi } = await import('./plugin-api-factory.js');
      await loadPlugins(resolvedPlugins, {
        log: logger,
        // Each plugin's `configSchema` is validated against the matching
        // `Config.extensions[name]` subtree before its `setup()` runs.
        // The plugin then reads the same data through `api.config.extensions`
        // (or, once L1-B lands, via `ConfigStore.getExtension(name)`).
        pluginOptions: config.extensions ?? {},
        apiFactory: (plugin) =>
          createApi(plugin.name, {
            container,
            events,
            pipelines: pipelines as unknown as Parameters<typeof createApi>[1]['pipelines'],
            toolRegistry,
            providerRegistry,
            slashCommandRegistry: slashRegistry,
            mcpRegistry,
            config,
            log: logger,
          }),
      });
    }
  }

  // Build provider+model switch as a single callback. The TUI picker
  // calls this after the user confirms a (provider, model) pair; we
  // construct a fresh Provider instance, swap it onto the live context,
  // and rebuild the frozen config so other consumers see the new ids.
  const switchProviderAndModel = (providerId: string, modelId: string): string | null => {
    try {
      const newCfg = config.providers?.[providerId] ?? {
        type: providerId,
        apiKey: config.apiKey,
        baseUrl: config.baseUrl,
      };
      const cfgWithType = { ...newCfg, type: providerId };
      const newProvider =
        config.features.modelsRegistry && providerRegistry.has(providerId)
          ? providerRegistry.create(cfgWithType)
          : makeProviderFromConfig(providerId, cfgWithType);
      context.provider = newProvider;
      context.model = modelId;
      config = patchConfig(config, { provider: providerId, model: modelId });
      // L1-B: propagate the change to the ConfigStore so any subsystem
      // that subscribed via .watch() re-renders. Crucially, /diag now
      // reads the live provider via the store.
      configStore.update({ provider: providerId, model: modelId });
      return null;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  };

  // L1-E: lazily-instantiated multi-agent host. Wired into /spawn and
  // /agents slash commands; constructed on first invocation so users
  // who never spawn subagents pay nothing.
  //
  // `--director` upgrades the host to Director mode — same external API,
  // but task lifecycle flows through a `Director` so manifest writing
  // works and the FleetBus is available for observability hooks. Manifest
  // path defaults to `<projectSessions>/<sessionId>/fleet.json`; users can
  // override via `WRONGSTACK_FLEET_MANIFEST` if they want a fixed path.
  const directorMode = flags['director'] === true;
  let director: Director | null = null;
  // Convention: director artifacts all live under the same fleet root —
  //   <projectSessions>/<sessionId>/
  //     ├─ fleet.json              (manifest)
  //     ├─ shared/                 (cross-agent scratchpad)
  //     └─ subagents/              (per-subagent JSONL transcripts)
  // The user can override the manifest path with WRONGSTACK_FLEET_MANIFEST
  // but the scratchpad + transcripts always sit relative to the session.
  const fleetRoot = directorMode ? path.join(wpaths.projectSessions, session.id) : undefined;
  const manifestPath = directorMode
    ? typeof process.env['WRONGSTACK_FLEET_MANIFEST'] === 'string'
      ? process.env['WRONGSTACK_FLEET_MANIFEST']
      : path.join(fleetRoot!, 'fleet.json')
    : undefined;
  const sharedScratchpadPath = directorMode ? path.join(fleetRoot!, 'shared') : undefined;
  const subagentSessionsRoot = directorMode ? path.join(fleetRoot!, 'subagents') : undefined;
  // Live director state checkpoint — written incrementally to disk on
  // every spawn/assign/complete event so a crashed director leaves a
  // recoverable snapshot. Distinct from manifestPath (final record).
  const stateCheckpointPath = directorMode
    ? path.join(fleetRoot!, 'director-state.json')
    : undefined;
  // Always derive a fleetRoot for runtime promotion — /director needs
  // a base dir to write manifest + scratchpad + per-subagent JSONLs into.
  const fleetRootForPromotion = path.join(wpaths.projectSessions, session.id);
  const multiAgentHost = new MultiAgentHost(
    {
      container,
      toolRegistry,
      providerRegistry,
      configStore,
      events,
      systemPromptBuilder: promptBuilder,
      session,
      tokenCounter,
      projectRoot,
      cwd,
    },
    {
      directorMode,
      manifestPath,
      sharedScratchpadPath,
      sessionsRoot: subagentSessionsRoot,
      directorRunId: session.id,
      fleetRoot: fleetRootForPromotion,
      stateCheckpointPath,
      sessionWriter: session,
    },
  );
  // ALWAYS register the `delegate` tool, even in non-director mode. It
  // auto-promotes the host to director mode on first call so the LLM
  // never has to know upfront whether multi-agent is "on" — it just
  // calls `delegate({ role, task })` when it judges a subtask warrants
  // a dedicated subagent. The system-prompt builder picks up this tool
  // and surfaces a "Delegation" section teaching the model when to use
  // it; without that block, the tool sits idle.
  toolRegistry.register(
    createDelegateTool({
      host: multiAgentHost,
      roster: FLEET_ROSTER,
      // Wire the per-subagent transcript location so the tool can
      // extract partial output on timeout / budget exhaustion. Without
      // this, a subagent that hit its iteration cap returns an empty
      // result and the host LLM has no idea what work was done.
      sessionsRoot: subagentSessionsRoot,
      directorRunId: session.id,
    }),
  );

  if (directorMode) {
    // Eagerly build the director so its 8 LLM-callable orchestration
    // tools (`spawn_subagent`, `assign_task`, `await_tasks`,
    // `ask_subagent`, `roll_up`, `terminate_subagent`, `fleet_status`,
    // `fleet_usage`) get registered into the leader's ToolRegistry
    // *before* the agent starts streaming. Without this the leader has
    // no way to discover the fleet surface and `--director` ends up as
    // a manifest-only flag with no orchestration. Pass `FLEET_ROSTER`
    // so `spawn_subagent` can accept `role: 'bug-hunter'` shortcuts.
    director = await multiAgentHost.ensureDirector();
    if (director) {
      for (const tool of director.tools(FLEET_ROSTER)) {
        toolRegistry.register(tool);
      }
      renderer.writeInfo(`Director mode enabled. Roster: ${Object.keys(FLEET_ROSTER).join(', ')}`);
      renderer.writeInfo(`  fleet root → ${fleetRoot}`);
      renderer.writeInfo(`  manifest   → ${manifestPath}`);
      renderer.writeInfo(`  scratchpad → ${sharedScratchpadPath}`);
      renderer.writeInfo(`  subagents  → ${subagentSessionsRoot}`);
    } else {
      renderer.writeInfo(`Director mode enabled. Fleet manifest → ${manifestPath}`);
    }
  }

  // Shared controller for the `/fleet stream on|off` toggle. The TUI
  // replaces `setEnabled` with a dispatch-backed setter on mount; before
  // that the no-op setter just keeps `enabled` in sync so callers see a
  // stable view even when invoked from a non-TUI surface.
  const fleetStreamController = {
    enabled: true,
    setEnabled(enabled: boolean) {
      this.enabled = enabled;
    },
  };

  const slashCmds = buildBuiltinSlashCommands({
    registry: slashRegistry,
    toolRegistry,
    compactor: container.resolve(TOKENS.Compactor),
    sessionStore,
    skillLoader,
    tokenCounter,
    renderer,
    memoryStore,
    context,
    metricsSink,
    healthRegistry,
    planPath,
    fleetStreamController,
    onSpawn: async (description, spawnOpts) => {
      const { subagentId, taskId } = await multiAgentHost.spawn(description, spawnOpts);
      const tags: string[] = [];
      if (spawnOpts?.provider) tags.push(spawnOpts.provider);
      if (spawnOpts?.model) tags.push(spawnOpts.model);
      if (spawnOpts?.name) tags.push(`"${spawnOpts.name}"`);
      const tag = tags.length > 0 ? ` (${tags.join(' / ')})` : '';
      return `Spawned subagent ${subagentId}${tag} for task ${taskId}. Use /agents to track progress.`;
    },
    onAgents: () => {
      const s = multiAgentHost.status();
      const lines = [s.summary];
      for (const p of s.pending) {
        lines.push(`  pending  ${p.taskId.slice(0, 8)} → ${p.description.slice(0, 60)}`);
      }
      for (const r of s.completed) {
        lines.push(
          `  ${r.status === 'success' ? color.green('✓') : color.red('✗')}        ${r.taskId.slice(0, 8)} ${r.iterations}it ${r.toolCalls}tc ${r.durationMs}ms`,
        );
      }
      return lines.join('\n');
    },
    onFleet: async (action, target) => {
      if (action === 'status') {
        const s = multiAgentHost.status();
        const lines = [color.bold('Fleet status'), `  ${s.summary}`];
        if (s.pending.length > 0) {
          lines.push('', color.dim('  Pending'));
          for (const p of s.pending) {
            lines.push(
              `    ${p.taskId.slice(0, 8)} → ${p.subagentId.slice(0, 8)} · ${p.description.slice(0, 60)}`,
            );
          }
        }
        if (s.completed.length > 0) {
          lines.push('', color.dim('  Completed'));
          for (const r of s.completed) {
            const mark = r.status === 'success' ? color.green('✓') : color.red('✗');
            lines.push(
              `    ${mark} ${r.taskId.slice(0, 8)} → ${r.subagentId.slice(0, 8)} · ${r.iterations}it ${r.toolCalls}tc ${r.durationMs}ms`,
            );
          }
        }
        return lines.join('\n');
      }
      if (action === 'usage') {
        const u = multiAgentHost.usage();
        if (u.rows.length === 0) return 'No completed subagent tasks yet.';
        const lines = [
          color.bold('Fleet usage'),
          color.dim('  subagent          tasks  iter  tools     ms  status'),
        ];
        for (const r of u.rows) {
          lines.push(
            `  ${r.subagentId.slice(0, 14).padEnd(14)}  ${String(r.tasks).padStart(5)}  ${String(r.iterations).padStart(4)}  ${String(r.toolCalls).padStart(5)}  ${String(r.durationMs).padStart(5)}  ${r.status}`,
          );
        }
        lines.push(
          color.dim('  ─'.repeat(28)),
          `  ${'TOTAL'.padEnd(14)}  ${String(u.totals.tasks).padStart(5)}  ${String(u.totals.iterations).padStart(4)}  ${String(u.totals.toolCalls).padStart(5)}  ${String(u.totals.durationMs).padStart(5)}`,
        );
        return lines.join('\n');
      }
      if (action === 'kill') {
        if (!target) return 'Usage: /fleet kill <subagent-id>';
        const ok = await multiAgentHost.kill(target);
        return ok
          ? `Sent stop signal to ${target}.`
          : 'No coordinator is running yet — nothing to kill.';
      }
      if (action === 'manifest') {
        if (!multiAgentHost.isDirectorMode()) {
          return 'Manifest is only available when the run was started with --director.';
        }
        const p = await multiAgentHost.manifest();
        if (!p) {
          return 'Director is active but no subagents have been spawned — nothing to record yet.';
        }
        return `Manifest written → ${p}`;
      }
      return `Unknown fleet action: ${action}`;
    },
    onFleetLog: async (subagentId, mode) => {
      // Per-subagent JSONLs live under <fleetRoot>/subagents/<runId>/<subagentId>.jsonl
      // and the runId is namespace-stable (session id by default), so we
      // walk the subagents dir to discover both runs and subagents.
      const subagentsRoot = path.join(fleetRootForPromotion, 'subagents');
      let runDirs: string[];
      try {
        runDirs = await fs.readdir(subagentsRoot);
      } catch {
        return 'No fleet transcripts on disk — no subagents have been spawned for this session.';
      }
      // Collect every transcript across every run-dir for this session.
      const found: Array<{ runId: string; subagentId: string; file: string; size: number }> = [];
      for (const runId of runDirs) {
        const runDir = path.join(subagentsRoot, runId);
        let files: string[];
        try {
          files = await fs.readdir(runDir);
        } catch {
          continue;
        }
        for (const f of files) {
          if (!f.endsWith('.jsonl')) continue;
          const full = path.join(runDir, f);
          try {
            const stat = await fs.stat(full);
            found.push({
              runId,
              subagentId: f.replace(/\.jsonl$/, ''),
              file: full,
              size: stat.size,
            });
          } catch {
            // skip
          }
        }
      }
      if (found.length === 0) {
        return 'No subagent transcripts found on disk.';
      }
      // Listing mode (no id provided).
      if (!subagentId) {
        const lines = [
          `${found.length} subagent transcript${found.length === 1 ? '' : 's'} on disk:`,
        ];
        for (const t of found) {
          lines.push(
            `  ${color.cyan(t.subagentId.padEnd(18))}  ${color.dim(t.runId.slice(0, 18))}  ${color.dim(`${(t.size / 1024).toFixed(1)} KB`)}`,
          );
        }
        lines.push('Use `/fleet log <subagentId>` for a summary, or append `raw` for the full JSONL.');
        return lines.join('\n');
      }
      // Match by exact id or prefix; ambiguous matches return the list.
      const matches = found.filter(
        (t) => t.subagentId === subagentId || t.subagentId.startsWith(subagentId),
      );
      if (matches.length === 0) {
        return `No transcript matched "${subagentId}". Run \`/fleet log\` to list available ids.`;
      }
      if (matches.length > 1) {
        return [
          `Ambiguous id "${subagentId}" — ${matches.length} matches:`,
          ...matches.map((m) => `  ${m.subagentId}  (${m.runId})`),
        ].join('\n');
      }
      const t = matches[0]!;
      const raw = await fs.readFile(t.file, 'utf8');
      if (mode === 'raw') return raw;

      // Summary: walk JSONL events, count types, list the first user/llm
      // pair + the last few iterations. Designed to fit in one terminal
      // screen even for verbose transcripts.
      const lines = raw.split('\n').filter((l) => l.trim());
      const counts: Record<string, number> = {};
      let firstUser: string | null = null;
      let lastResponse: string | null = null;
      let totalIterations = 0;
      const toolNames = new Map<string, number>();
      for (const line of lines) {
        try {
          const ev = JSON.parse(line) as { type: string; content?: unknown; name?: string };
          counts[ev.type] = (counts[ev.type] ?? 0) + 1;
          if (ev.type === 'user_input' && !firstUser) {
            const txt =
              typeof ev.content === 'string'
                ? ev.content
                : Array.isArray(ev.content)
                  ? ev.content
                      .filter((b): b is { type: 'text'; text: string } => (b as { type?: string }).type === 'text')
                      .map((b) => b.text)
                      .join(' ')
                  : '';
            firstUser = txt.slice(0, 120);
          }
          if (ev.type === 'llm_response') {
            if (Array.isArray(ev.content)) {
              const txt = (ev.content as Array<{ type?: string; text?: string }>)
                .filter((b) => b.type === 'text')
                .map((b) => b.text ?? '')
                .join(' ');
              if (txt) lastResponse = txt.slice(0, 240);
            }
            totalIterations += 1;
          }
          if (ev.type === 'tool_use' && typeof ev.name === 'string') {
            toolNames.set(ev.name, (toolNames.get(ev.name) ?? 0) + 1);
          }
        } catch {
          // skip malformed
        }
      }
      const toolBreakdown =
        toolNames.size > 0
          ? Array.from(toolNames.entries())
              .sort((a, b) => b[1] - a[1])
              .map(([n, c]) => `${n}×${c}`)
              .join(', ')
          : '(none)';
      const out: string[] = [
        color.bold(`Subagent ${t.subagentId}`) + color.dim(`  (run ${t.runId})`),
        `  ${lines.length} events  ·  ${totalIterations} llm iterations  ·  ${(t.size / 1024).toFixed(1)} KB`,
        `  tools: ${toolBreakdown}`,
      ];
      if (firstUser) out.push('', color.dim('  task:'), `  ${firstUser}`);
      if (lastResponse) out.push('', color.dim('  last response:'), `  ${lastResponse}`);
      out.push('', color.dim('  event mix:'));
      for (const [type, count] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
        out.push(`    ${type.padEnd(20)} ${count}`);
      }
      out.push('', color.dim('Use `/fleet log <id> raw` for the full JSONL.'));
      return out.join('\n');
    },
    onFleetRetry: async (taskId) => {
      if (!multiAgentHost.isDirectorMode()) {
        const promoted = await multiAgentHost.promoteToDirector();
        if (!promoted) {
          return 'Cannot retry: a coordinator already exists in non-director mode.';
        }
        for (const tool of promoted.tools(FLEET_ROSTER)) {
          toolRegistry.register(tool);
        }
      }
      const dir = await multiAgentHost.ensureDirector();
      if (!dir) return 'Director is not available.';
      const dirStatePath = path.join(fleetRootForPromotion, 'director-state.json');
      const prior = await loadDirectorState(dirStatePath);
      if (!prior) {
        return 'No prior director-state.json found — nothing to retry.';
      }
      // "Interrupted" = whatever was running/pending when the previous
      // process died. Completed/failed/timeout/stopped tasks are final.
      const interrupted = prior.tasks.filter(
        (t) => t.status === 'running' || t.status === 'pending',
      );
      if (interrupted.length === 0) {
        return 'No interrupted tasks: every prior task reached a terminal state.';
      }

      // List mode — no target given.
      if (!taskId) {
        const lines = [
          `${interrupted.length} interrupted task${interrupted.length === 1 ? '' : 's'} from prior run:`,
        ];
        for (const t of interrupted) {
          const owner = t.subagentId
            ? prior.subagents.find((s) => s.id === t.subagentId)
            : undefined;
          const tag = owner ? `${owner.name ?? owner.id} (${owner.role ?? 'no-role'})` : 'no-owner';
          lines.push(
            `  ${t.taskId.slice(0, 12)}  ${t.status.padEnd(8)} ${tag}  ${(t.description ?? '').slice(0, 60)}`,
          );
        }
        lines.push('Run `/fleet retry <taskId>` or `/fleet retry all` to re-assign.');
        return lines.join('\n');
      }

      const targets =
        taskId === 'all'
          ? interrupted
          : interrupted.filter(
              (t) => t.taskId === taskId || t.taskId.startsWith(taskId),
            );
      if (targets.length === 0) {
        return `No interrupted task matched "${taskId}".`;
      }

      const results: string[] = [];
      for (const t of targets) {
        const owner = t.subagentId
          ? prior.subagents.find((s) => s.id === t.subagentId)
          : undefined;
        if (!owner) {
          results.push(`  - ${t.taskId.slice(0, 12)}: no owner record, skipped.`);
          continue;
        }
        // Re-spawn from the roster when role is set (preferred path —
        // role-based spawns get their full prompt/tool slice). Otherwise
        // synthesize a minimal SubagentConfig from the prior record.
        const rosterCfg = owner.role ? FLEET_ROSTER[owner.role] : undefined;
        const cfg = rosterCfg
          ? { ...rosterCfg }
          : {
              name: owner.name ?? owner.id,
              role: owner.role,
              provider: owner.provider,
              model: owner.model,
            };
        try {
          const newSubId = await dir.spawn(cfg);
          const newTaskId = await dir.assign({
            id: '',
            description: t.description ?? '(no description)',
            subagentId: newSubId,
          });
          results.push(
            `  ${color.green('✓')} ${t.taskId.slice(0, 12)} → re-spawned ${newSubId.slice(0, 12)} (task ${newTaskId.slice(0, 12)})`,
          );
        } catch (err) {
          results.push(
            `  ${color.red('✗')} ${t.taskId.slice(0, 12)} → ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      return [`Retried ${targets.length} task${targets.length === 1 ? '' : 's'}:`, ...results].join(
        '\n',
      );
    },
    onDirector: async () => {
      const director = await multiAgentHost.promoteToDirector();
      if (!director) return null;
      // Register the 8 LLM-callable orchestration tools into the leader's
      // ToolRegistry so the agent can discover fleet surface mid-session.
      for (const tool of director.tools(FLEET_ROSTER)) {
        toolRegistry.register(tool);
      }
      const mp = path.join(fleetRootForPromotion, 'fleet.json');
      const sp = path.join(fleetRootForPromotion, 'shared');
      const ss = path.join(fleetRootForPromotion, 'subagents');
      const lines = [
        `${color.green('✓')} Promoted to director mode.`,
        `  Roster: ${Object.keys(FLEET_ROSTER).join(', ')}`,
        `  Manifest → ${mp}`,
        `  Scratchpad → ${sp}`,
        `  Subagents → ${ss}`,
      ];
      return lines.join('\n');
    },
    onExit: () => {
      void mcpRegistry.stopAll();
    },
    onClear: () => {
      // In TUI mode Ink owns the live area; writing `\x1b[2J` here would
      // fight Ink's cursor math and leave the status bar smeared. The
      // context/memory reset inside /clear is enough — the user can
      // scroll up to see prior turns in scrollback. In REPL we erase
      // the visible screen + scrollback (`\x1b[3J`) so the next prompt
      // starts on a fresh terminal.
      if (flags.tui && !flags['no-tui']) return;
      try {
        process.stdout.write('\x1b[2J\x1b[3J\x1b[H');
      } catch {
        // stdout may be closed during shutdown — ignore.
      }
    },
    onDiag: () => {
      const u = tokenCounter.total();
      const cost = tokenCounter.estimateCost();
      const errSection =
        errorRing.length === 0
          ? []
          : [
              '',
              `${color.bold('Recent errors')} (last ${errorRing.length}):`,
              ...errorRing.map((e) => `  [${e.ts}] ${e.phase} ${e.code} — ${e.message}`),
            ];
      // Read current provider from the ConfigStore so /diag always shows
      // the live value, even if /model swapped it mid-session (L1-B).
      const liveCfg = configStore.get();
      return [
        `${color.bold('WrongStack diag')}`,
        `  provider:     ${liveCfg.provider} / ${context.model}`,
        `  projectRoot:  ${projectRoot}`,
        `  tokens:       in ${u.input}  out ${u.output}  cacheR ${u.cacheRead ?? 0}`,
        `  cost:         $${cost.total.toFixed(4)}`,
        `  tools:        ${toolRegistry.list().length}`,
        `  mcpServers:   ${mcpRegistry.list().length}`,
        ...errSection,
      ].join('\n');
    },
    onStats: () => stats.format(),
  });
  for (const cmd of slashCmds) slashRegistry.register(cmd);

  // Dispatch to execution phase — single-shot, TUI, REPL, or WebUI.
  return execute({
    agent,
    events,
    slashRegistry,
    attachments,
    tokenCounter,
    config,
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
    savedProviderCfg: savedProviderCfg as ExecutionDeps['savedProviderCfg'],
    resolvedProvider: resolvedProvider ?? undefined,
    getPickableProviders: () => buildPickableProviders(modelsRegistry, config),
    switchProviderAndModel,
    director: director ?? null,
    fleetRoster: FLEET_ROSTER as Record<string, { name: string }>,
    fleetStreamController,
  });
}

/**
 * Prompt the user about an abandoned session. The lockfile lifecycle
 * guarantees we only get here when the previous instance died without
 * writing `session_end` AND there's real work on disk (≥1 message).
 *
 * `--recover` short-circuits to "resume" without asking; piped/non-TTY
 * input degrades to the same — the alternative is hanging on stdin or
 * forcing the user to remember a flag they never typed.
 */
async function promptRecovery(
  reader: ReadlineInputReader,
  renderer: TerminalRenderer,
  abandoned: import('@wrongstack/core').AbandonedSession,
  autoRecover: boolean,
): Promise<'resume' | 'delete' | 'skip'> {
  const minutes = Math.round(abandoned.ageMs / 60_000);
  const ageLabel =
    minutes < 1
      ? `${Math.round(abandoned.ageMs / 1000)}s ago`
      : minutes < 60
        ? `${minutes} min ago`
        : `${Math.round(minutes / 60)}h ago`;
  const summary = `Previous session was killed mid-run: ${abandoned.sessionId} (${abandoned.messageCount} messages, ${ageLabel}).`;
  if (autoRecover) {
    renderer.writeInfo(`${summary} Auto-resuming (--recover).`);
    return 'resume';
  }
  if (!process.stdin.isTTY) {
    renderer.writeInfo(
      `${summary} Non-interactive — leaving as-is. Use \`wstack resume ${abandoned.sessionId}\` or pass \`--recover\` to auto-resume.`,
    );
    return 'skip';
  }
  renderer.writeInfo(summary);
  const answer = await reader.readKey(
    `${color.amber('?')} Recover it? ${color.dim('[')}${color.bold('Y')}es / ${color.bold('n')}o / ${color.bold('d')}elete${color.dim(']')} `,
    [
      { key: 'y', label: 'yes', value: 'resume' },
      { key: 'Y', label: 'yes', value: 'resume' },
      { key: '\r', label: 'yes', value: 'resume' },
      { key: '\n', label: 'yes', value: 'resume' },
      { key: 'n', label: 'no', value: 'skip' },
      { key: 'N', label: 'no', value: 'skip' },
      { key: 'd', label: 'delete', value: 'delete' },
      { key: 'D', label: 'delete', value: 'delete' },
    ],
  );
  return answer as 'resume' | 'delete' | 'skip';
}

const isMain =
  import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}` ||
  process.argv[1]?.endsWith('/cli/dist/index.js') ||
  process.argv[1]?.endsWith('\\cli\\dist\\index.js');
if (isMain) {
  main(process.argv.slice(2)).then(
    (c) => {
      // Set exitCode and let Node drain async handles (undici TLS, log file
      // flushes) naturally. Force-exit after a brief grace period so we don't
      // hang if a plugin or MCP server leaks. Avoids libuv UV_HANDLE_CLOSING
      // assertions seen on Windows when process.exit() races with handle teardown.
      process.exitCode = c;
      setTimeout(() => process.exit(c), 200).unref();
    },
    (err) => {
      process.stderr.write((err instanceof Error ? err.stack : String(err)) + '\n');
      process.exitCode = 1;
      setTimeout(() => process.exit(1), 200).unref();
    },
  );
}
