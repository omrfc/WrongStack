/**
 * ACP server → real WrongStack Agent wiring.
 *
 * `wstack acp` exposes WrongStack as an ACP v1 agent so any ACP-capable
 * client (Zed, JetBrains, VS Code ACP extension, etc.) can drive it. The
 * server-side `runTurn` adapter (`makeACPServerAgentTurn` in `@wrongstack/acp`)
 * needs a factory that produces a fresh, isolated `Agent` per session — this
 * module is that factory, reusing the same boot pieces the interactive CLI
 * uses (`setupProvider`, `createDefaultContainer`, builtin tools).
 *
 * Scope: a minimal but real agent. It deliberately does NOT wire MCP servers,
 * compaction middleware, model-runtime overlays, or lifecycle hooks — those
 * belong in the interactive host. The ACP server is a headless single-turn
 * surface; a future PR can layer richer session behaviour if needed.
 */
import {
  Agent,
  AutoApprovePermissionPolicy,
  Context,
  createDefaultPipelines,
  DefaultLogger,
  DefaultTokenCounter,
  EventBus,
  type Logger,
  TOKENS,
  type Tool,
  ToolRegistry,
  type WstackPaths,
} from '@wrongstack/core';
import { ToolExecutor } from '@wrongstack/core/execution';
import { createDefaultContainer } from '@wrongstack/runtime';
import type { SubcommandDeps } from './subcommands/index.js';
import { setupProvider } from './wiring/provider.js';

/**
 * Error thrown when the server cannot start because no model provider is
 * configured. The CLI handler catches this and prints a actionable message
 * (`wstack auth`) rather than a stack trace.
 */
export class AcpServerConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AcpServerConfigError';
  }
}

export interface AcpAgentFactoryOptions {
  /** Caller-supplied logger; a minimal stderr logger is created when omitted. */
  logger?: Logger | undefined;
}

/**
 * Build a per-session `Agent` factory suitable for `makeACPServerAgentTurn`.
 *
 * The provider registry + container are built once (they're stateless across
 * sessions); each `agentFor(sessionId, cwd)` call builds a fresh `EventBus`,
 * `Context`, and `Agent` so sessions stay isolated per the v1 spec.
 *
 * Throws `AcpServerConfigError` up front if no provider is configured.
 */
export function buildAcpServerAgentFactory(
  deps: SubcommandDeps,
  options: AcpAgentFactoryOptions = {},
): (sessionId: string, cwd: string) => Promise<Agent> {
  const config = deps.config;
  if (!config.provider || !config.model) {
    throw new AcpServerConfigError(
      'No model provider is configured. Run `wstack auth` to add credentials, ' +
        'or start the server with `wstack acp --echo` for a no-op connectivity test.',
    );
  }

  const logger = options.logger ?? new DefaultLogger({ stderr: true });
  const wpaths: WstackPaths = deps.paths;

  // Provider + registry — built once, reused across sessions.
  // setupProvider is async, but factory consumers expect a sync `agentFor`.
  // We kick it off lazily and memoize so the first session pays the one-time
  // models.dev lookup cost; later sessions reuse the resolved registry.
  type ProviderBoot = Awaited<ReturnType<typeof setupProvider>>;
  let providerBoot: Promise<ProviderBoot> | null = null;
  const bootProvider = (): Promise<ProviderBoot> => {
    if (!providerBoot) {
      providerBoot = setupProvider({ config, modelsRegistry: deps.modelsRegistry, logger });
    }
    return providerBoot;
  };

  // Container — built once; safe to share across sessions (it only holds
  // stateless service bindings, not per-run state).
  const container = createDefaultContainer({
    config,
    wpaths,
    logger,
    modelsRegistry: deps.modelsRegistry,
  });

  return async function agentFor(_sessionId: string, cwd: string): Promise<Agent> {
    const { provider, providerRegistry } = await bootProvider();

    // Per-session event bus — keeps each ACP session's tool/iteration events
    // isolated from the others.
    const events = new EventBus();

    // Tools: prefer the caller-supplied registry (already populated by the
    // subcommand dispatcher with builtin tools); fall back to an empty one.
    const tools: ToolRegistry = deps.toolRegistry ?? new ToolRegistry();

    // Headless policy: auto-approve. The ACP server has no interactive prompt
    // channel, mirroring the subagent posture in fleet/host.ts.
    const permissionPolicy = new AutoApprovePermissionPolicy();

    const tokenCounter = new DefaultTokenCounter({
      registry: deps.modelsRegistry,
      providerId: config.provider,
      events,
    });

    // Minimal session writer — ACP sessions don't persist to the JSONL
    // transcript store yet. A no-op writer keeps the Context contract happy.
    const session = { append: async () => {} } as never;

    const context = new Context({
      systemPrompt: [],
      provider,
      session,
      signal: new AbortController().signal,
      tokenCounter,
      cwd,
      projectRoot: cwd,
      allowOutsideProjectRoot: config.features?.allowOutsideProjectRoot ?? false,
      model: config.model,
      tools: [...tools.list()] as Tool[],
      agentId: 'acp-server',
      agentName: 'wrongstack-acp',
    });

    const toolExecutor = new ToolExecutor(tools, {
      permissionPolicy,
      secretScrubber: container.resolve(TOKENS.SecretScrubber),
      renderer: undefined,
      events,
      confirmAwaiter: undefined,
      iterationTimeoutMs: config.tools?.iterationTimeoutMs ?? 120_000,
      perIterationOutputCapBytes: config.tools?.perIterationOutputCapBytes ?? 100_000,
      tracer: undefined,
    });

    return new Agent({
      container,
      tools,
      providers: providerRegistry,
      events,
      pipelines: createDefaultPipelines(),
      context,
      permissionPolicy,
      toolExecutor,
    });
  };
}
