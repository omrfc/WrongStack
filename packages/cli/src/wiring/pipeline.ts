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
  type ToolRegistry,
  createDefaultPipelines,
} from '@wrongstack/core';
import { capabilitiesFor } from '@wrongstack/providers';

type CompactionDriver = ConstructorParameters<typeof AutoCompactionMiddleware>[0];

export function setupPipelines(params: {
  events: EventBus;
  logger: Logger;
}): AgentPipelines {
  const { events, logger } = params;
  const pipelines = createDefaultPipelines();

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
  return pipelines;
}

export async function setupCompaction(params: {
  compactor: CompactionDriver;
  events: EventBus;
  modelsRegistry: ModelsRegistry;
  context: Context;
  config: {
    context: {
      autoCompact?: boolean;
      warnThreshold: number;
      softThreshold: number;
      hardThreshold: number;
      effectiveMaxContext?: number;
    };
  };
  provider: Provider;
  pipelines: AgentPipelines;
}): Promise<number> {
  const { compactor, events, modelsRegistry, context, config, provider, pipelines } = params;
  const resolvedCaps = await capabilitiesFor(modelsRegistry, provider.id, context.model).catch(() => undefined);
  const effectiveMaxContext =
    config.context.effectiveMaxContext ??
    (resolvedCaps as { maxContext?: number } | undefined)?.maxContext ??
    provider.capabilities.maxContext;
  console.error('[DEBUG] setupCompaction:', {
    providerId: provider.id,
    model: context.model,
    resolvedCapsMaxContext: (resolvedCaps as { maxContext?: number } | undefined)?.maxContext,
    providerCapMaxContext: provider.capabilities.maxContext,
    configEffectiveMaxContext: config.context.effectiveMaxContext,
    effectiveMaxContext,
    resolvedCapsKeys: resolvedCaps ? Object.keys(resolvedCaps) : null,
  });
  if (config.context.autoCompact !== false) {
    const autoCompactor = new AutoCompactionMiddleware(
      compactor,
      effectiveMaxContext,
      (ctx) => {
        let total = 0;
        for (const m of ctx.messages) {
          if (typeof m.content === 'string') {
            total += Math.ceil(m.content.length / 4);
          } else if (Array.isArray(m.content)) {
            for (const b of m.content) {
              if (b.type === 'text') {
                total += Math.ceil(b.text.length / 4);
              } else if (b.type === 'tool_use' || b.type === 'tool_result') {
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
      { aggressiveOn: 'soft', failureMode: 'throw_on_hard', events },
    );
    pipelines.contextWindow.use({ name: 'AutoCompaction', handler: autoCompactor.handler() });
  }
  return effectiveMaxContext;
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
}): Agent {
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
  });
}
