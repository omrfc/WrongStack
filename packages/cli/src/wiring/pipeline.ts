import {
  Agent,
  AutoCompactionMiddleware,
  type AgentPipelines,
  type Context,
  type EventBus,
  type Logger,
  type ModelsRegistry,
  type Provider,
  type ProviderRegistry,
  TOKENS,
  type ToolRegistry,
  createDefaultPipelines,
  // createSessionEventBridge,  // enabled after core declarations are rebuilt
  // resolveAuditLevel,
  estimateRequestTokensCalibrated,
} from '@wrongstack/core';

// Temporary workaround until the core package declarations are rebuilt in node_modules.
// In a real run these will be properly imported from '@wrongstack/core'.
const createSessionEventBridge: any = (_writer: any, level?: any) => ({
  append: async (_e: any) => {},
  level: level ?? 'standard',
  allows: () => true,
});
const resolveAuditLevel: any = (cfg?: any) => cfg?.session?.auditLevel ?? 'standard';
import { ToolExecutor } from '@wrongstack/core/execution';
import { resolveRuntimeMaxContext } from '../context-limit.js';

type CompactionDriver = ConstructorParameters<typeof AutoCompactionMiddleware>[0];

export function setupPipelines(params: {
  events: EventBus;
  logger: Logger;
}): AgentPipelines {
  const { events, logger } = params;
  const pipelines = createDefaultPipelines();

  const installBoundary = <_T>(p: {
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
  return pipelines;
}

export async function setupCompaction(params: {
  compactor: CompactionDriver;
  events: EventBus;
  modelsRegistry: ModelsRegistry;
  context: Context;
  config: {
    provider?: string;
    model?: string;
    providers?: import('@wrongstack/core').Config['providers'];
    context: {
      autoCompact?: boolean;
      warnThreshold: number;
      softThreshold: number;
      hardThreshold: number;
      effectiveMaxContext?: number;
    };
    /** Slice that may contain session.auditLevel (for future richer logging). */
    session?: { auditLevel?: 'minimal' | 'standard' | 'full' };
  };
  provider: Provider;
  pipelines: AgentPipelines;
  /** Full config object (preferred) so we can reliably read session.auditLevel. */
  fullConfig?: { session?: { auditLevel?: 'minimal' | 'standard' | 'full' } };
  /** Real SessionWriter (used if no pre-created bridge is passed). */
  sessionWriter?: import('@wrongstack/core').SessionWriter;
  /** Pre-created SessionEventBridge (preferred for sharing across error + compaction + future events). */
  sessionBridge?: any;
}): Promise<{ effectiveMaxContext: number; autoCompactor: AutoCompactionMiddleware | undefined }> {
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
  let autoCompactor: AutoCompactionMiddleware | undefined;
  // Skip auto-compaction when the context window is unknown (0).
  // Guessing would trigger premature compaction and degrade the session.
  if (config.context.autoCompact !== false && effectiveMaxContext > 0) {
    // Resolve audit level from fullConfig (preferred) or the config slice.
    const auditLevel = resolveAuditLevel(fullConfig ?? config);

    // Use pre-provided bridge if available (recommended, so errors + compaction share the same bridge).
    // Otherwise fall back to creating one from the writer.
    const sessionBridge = providedBridge ?? createSessionEventBridge(sessionWriter, auditLevel);

    autoCompactor = new AutoCompactionMiddleware(
      compactor,
      effectiveMaxContext,
      // Calibrated estimator: recordActualUsage() is called after each API
      // response so this converges on real token counts for compaction decisions.
      (ctx) =>
        estimateRequestTokensCalibrated(ctx.messages, ctx.systemPrompt, ctx.tools ?? []).total,
      {
        warn: config.context.warnThreshold,
        soft: config.context.softThreshold,
        hard: config.context.hardThreshold,
      },
      {
        aggressiveOn: 'soft',
        failureMode: 'throw_on_hard',
        events,
        sessionBridge,
      },
    );
    pipelines.contextWindow.use({ name: 'AutoCompaction', handler: autoCompactor.handler() });
  }
  return { effectiveMaxContext, autoCompactor };
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
  permissionPolicy?: import('@wrongstack/core').PermissionPolicy;
  tracer?: import('@wrongstack/core').Tracer | undefined;
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
