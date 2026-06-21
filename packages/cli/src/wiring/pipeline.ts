import {
  Agent,
  type AgentPipelines,
  applyModelRuntime,
  AutoCompactionMiddleware,
  type Context,
  createDefaultPipelines,
  createSessionEventBridge,
  type EventBus,
  estimateRequestTokensCalibrated,
  type Logger,
  type ModelsRegistry,
  type Provider,
  type ProviderRegistry,
  resolveAuditLevel,
  resolveContextWindowPolicy,
  type SessionEventBridge,
  TOKENS,
  type ToolRegistry,
} from '@wrongstack/core';
import { ToolExecutor } from '@wrongstack/core/execution';
import { resolveRuntimeMaxContext } from '../context-limit.js';

type CompactionDriver = ConstructorParameters<typeof AutoCompactionMiddleware>[0];

export function setupPipelines(params: {
  events: EventBus;
  logger: Logger;
  /**
   * Optional request overrides applied on every outgoing request. Used by the
   * model-runtime middleware to map shared reasoning/cache settings into the
   * provider `Request`, gated by the active model's capabilities.
   */
  modelRuntime?: {
    getSettings(): import('@wrongstack/core').ModelRuntimeConfig | undefined;
    getReasoningConfig(): import('@wrongstack/core').ReasoningConfig | undefined;
    onWarning?: ((message: string) => void) | undefined;
  } | undefined;
}): AgentPipelines {
  const { events, logger } = params;
  const pipelines = createDefaultPipelines();

  // Model-runtime middleware: overlay Config.modelRuntime onto every request.
  // Installed first so all hosts (REPL/TUI/WebUI) share one behavior — UIs only
  // need to mutate Config.modelRuntime for the change to take effect.
  if (params.modelRuntime) {
    const mr = params.modelRuntime;
    pipelines.request.use({
      name: 'ModelRuntimeSettings',
      async handler(req: import('@wrongstack/core').Request) {
        return applyModelRuntime(req, {
          getSettings: mr.getSettings,
          getReasoningConfig: mr.getReasoningConfig,
          onWarning: mr.onWarning,
        });
      },
    });
  }

  const installBoundary = <_T>(p: {
    setErrorHandler: (
      h: (ev: {
        middleware: string;
        owner?: string | undefined;
        err: unknown;
      }) => 'rethrow' | 'swallow',
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
  return pipelines;
}

export async function setupCompaction(params: {
  compactor: CompactionDriver;
  events: EventBus;
  modelsRegistry: ModelsRegistry;
  context: Context;
  config: {
    provider?: string | undefined;
    model?: string | undefined;
    providers?: import('@wrongstack/core').Config['providers'] | undefined;
    context: {
      mode?: import('@wrongstack/core').ContextWindowModeId | undefined;
      autoCompact?: boolean | undefined;
      warnThreshold: number;
      softThreshold: number;
      hardThreshold: number;
      preserveK?: number | undefined;
      eliseThreshold?: number | undefined;
      effectiveMaxContext?: number | undefined;
    };
    /** Slice that may contain session.auditLevel (for future richer logging). */
    session?: { auditLevel?: 'minimal' | 'standard' | 'full' | undefined } | undefined;
  };
  provider: Provider;
  pipelines: AgentPipelines;
  /** Full config object (preferred) so we can reliably read session.auditLevel. */
  fullConfig?:
    | { session?: { auditLevel?: 'minimal' | 'standard' | 'full' | undefined } | undefined }
    | undefined;
  /** Real SessionWriter (used if no pre-created bridge is passed). */
  sessionWriter?: import('@wrongstack/core').SessionWriter | undefined;
  /** Pre-created SessionEventBridge (preferred for sharing across error + compaction + future events). */
  sessionBridge?: SessionEventBridge | undefined;
}): Promise<{
  effectiveMaxContext: number;
  autoCompactor: AutoCompactionMiddleware | undefined;
  /** The bridge the auto-compactor writes through. Surfaced so the host can
   *  apply a live `auditLevel` change (TUI `/settings`) via setAuditLevel(). */
  sessionBridge: SessionEventBridge | undefined;
}> {
  const {
    compactor,
    events,
    modelsRegistry,
    context,
    config,
    provider,
    pipelines,
    fullConfig,
    sessionWriter,
    sessionBridge: providedBridge,
  } = params;
  const effectiveMaxContext = await resolveRuntimeMaxContext({
    modelsRegistry,
    config,
    provider,
    providerId: config.provider ?? provider.id,
    modelId: config.model ?? context.model,
  });
  const initialPolicy = resolveContextWindowPolicy(config.context);
  context.meta ??= {};
  context.meta['contextWindowMode'] = initialPolicy.id;
  context.meta['contextWindowPolicy'] = initialPolicy;
  let autoCompactor: AutoCompactionMiddleware | undefined;
  let resolvedBridge: SessionEventBridge | undefined;
  // Skip auto-compaction when the context window is unknown (0).
  // Guessing would trigger premature compaction and degrade the session.
  //
  // The middleware is installed whenever the window is known, REGARDLESS of the
  // autoCompact flag — the flag only sets the initial enabled state. This lets
  // the TUI `/settings` picker flip auto-compaction on/off live (the handler is
  // a pass-through while disabled) without re-registering middleware.
  if (effectiveMaxContext > 0) {
    // Resolve audit level from fullConfig (preferred) or the config slice.
    const auditLevel = resolveAuditLevel(fullConfig ?? config);

    // Use pre-provided bridge if available (recommended, so errors + compaction share the same bridge).
    // Otherwise fall back to creating one from the writer.
    const sessionBridge = providedBridge ?? createSessionEventBridge(sessionWriter, auditLevel);
    resolvedBridge = sessionBridge;

    autoCompactor = new AutoCompactionMiddleware(
      compactor,
      effectiveMaxContext,
      // Calibrated estimator: recordActualUsage() is called after each API
      // response so this converges on real token counts for compaction decisions.
      (ctx) =>
        estimateRequestTokensCalibrated(
          ctx.messages,
          ctx.systemPrompt,
          ctx.tools ?? [],
          `${ctx.provider?.id ?? 'unknown'}/${ctx.model}`,
        ).total,
      initialPolicy.thresholds,
      {
        aggressiveOn: initialPolicy.aggressiveOn,
        failureMode: 'throw_on_hard',
        events,
        policyProvider: (ctx) => {
          const policy = ctx.meta?.['contextWindowPolicy'];
          return policy && typeof policy === 'object'
            ? (policy as {
                thresholds: { warn: number; soft: number; hard: number };
                aggressiveOn: 'hard' | 'soft' | 'warn';
              })
            : null;
        },
        sessionBridge,
      },
    );
    // The autoCompact flag becomes the initial on/off state; the middleware
    // is always wired so /settings can toggle it live.
    autoCompactor.setEnabled(config.context.autoCompact !== false);
    pipelines.contextWindow.use({ name: 'AutoCompaction', handler: autoCompactor.handler() });
  }
  return { effectiveMaxContext, autoCompactor, sessionBridge: resolvedBridge };
}

export function createAgent(params: {
  container: import('@wrongstack/core').Container;
  tools: ToolRegistry;
  providers: ProviderRegistry;
  events: EventBus;
  pipelines: AgentPipelines;
  context: Context;
  config: {
    tools: {
      maxIterations: number;
      iterationTimeoutMs: number;
      defaultExecutionStrategy: 'parallel' | 'sequential' | 'smart';
      perIterationOutputCapBytes: number;
    };
  };
  confirmAwaiter: import('@wrongstack/core').AgentInit['confirmAwaiter'];
  permissionPolicy?: import('@wrongstack/core').PermissionPolicy | undefined;
  tracer?: import('@wrongstack/core').Tracer | undefined;
  /** Optional lifecycle hook runner — wired into the tool executor (PreToolUse/PostToolUse). */
  hookRunner?: import('@wrongstack/core').HookRunner | undefined;
}): Agent {
  const secretScrubber = params.container.resolve(TOKENS.SecretScrubber);
  const renderer = params.container.has(TOKENS.Renderer)
    ? params.container.resolve(TOKENS.Renderer)
    : undefined;
  const toolExecutor = new ToolExecutor(params.tools, {
    permissionPolicy: params.permissionPolicy ?? params.container.resolve(TOKENS.PermissionPolicy),
    secretScrubber,
    renderer,
    events: params.events,
    confirmAwaiter: params.confirmAwaiter,
    iterationTimeoutMs: params.config.tools.iterationTimeoutMs,
    perIterationOutputCapBytes: params.config.tools.perIterationOutputCapBytes,
    tracer: params.tracer,
    hookRunner: params.hookRunner,
  });

  return new Agent({
    container: params.container,
    tools: params.tools,
    providers: params.providers,
    events: params.events,
    pipelines: params.pipelines,
    context: params.context,
    maxIterations: params.config.tools.maxIterations,
    iterationTimeoutMs: params.config.tools.iterationTimeoutMs,
    executionStrategy: params.config.tools.defaultExecutionStrategy,
    perIterationOutputCapBytes: params.config.tools.perIterationOutputCapBytes,
    confirmAwaiter: params.confirmAwaiter,
    toolExecutor,
    tracer: params.tracer,
  });
}
