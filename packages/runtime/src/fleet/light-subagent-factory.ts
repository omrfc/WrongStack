// makeLightSubagentFactory — a dependency-light `AgentFactory` that builds a
// fresh, isolated `Agent` per subagent task WITHOUT the full director / budget /
// ACP machinery of the CLI's `MultiAgentHost`.
//
// Why this exists: `MultiAgentHost` lives in `@wrongstack/cli`, which the WebUI
// packages cannot import (layer rule: webui ⇏ cli). But `SddParallelRun` only
// needs an `AgentFactory` (a core interface) to run real parallel waves with
// per-task git-worktree isolation. This factory provides exactly that, built
// from primitives both webui servers already have (a DI container + the provider
// and tool registries + a session writer). It deliberately does NOT touch the
// budget/watchdog/director subsystems — those stay owned by the CLI host.
//
// Each call constructs a fresh `Context` + `EventBus` (true isolation) and
// honours `SubagentConfig.cwd` so per-task worktrees don't collide. Subagents
// cannot answer interactive permission prompts, so they run under an
// `AutoApprovePermissionPolicy` granted the wide work capabilities (fs.write,
// shell, …) — the user authorised the work when they pressed "Start Run".

import {
  Agent,
  AutoApprovePermissionPolicy,
  type AgentFactory,
  type AgentFactoryResult,
  type Config,
  type Container,
  Context,
  createDefaultPipelines,
  createFallbackModelExtension,
  EventBus,
  type ProviderRegistry,
  type SessionWriter,
  type SubagentConfig,
  type TextBlock,
  type Tool,
  ToolExecutor,
  ToolRegistry,
  TOKENS,
  WIDE_SUBAGENT_CAPABILITIES,
} from '@wrongstack/core';

export interface LightSubagentFactoryDeps {
  /** DI container — used to resolve configStore / tokenCounter / scrubber / prompt builder. */
  container: Container;
  /** Provider registry (already populated by the host) used to build per-subagent providers. */
  providerRegistry: ProviderRegistry;
  /** Full tool registry — each subagent gets an isolated clone of it. */
  toolRegistry: ToolRegistry;
  /** Parent session writer; subagent events are interleaved via a guarded shim. */
  session: SessionWriter;
  /** Project root anchor. */
  projectRoot: string;
  /** Default cwd when a SubagentConfig doesn't pin one (worktree path otherwise). */
  cwd?: string | undefined;
}

/**
 * Build a default subagent baseline so a leaf worker knows it's running under a
 * run, not as the user-facing leader. Kept terse — the system-prompt builder
 * already supplies identity/tools/skills when `subagent: true`.
 */
const SUBAGENT_BASELINE =
  'You are a subagent executing one delegated task end-to-end. Work autonomously with your tools; do not ask for confirmation on routine in-project actions. Keep output concise.';

// Slot in ctx.meta where the per-subagent AbortController is stored.
// Callers retrieve it via abortLightSubagent(agent).
const _SUBAGENT_ABORT = 'wrongstack:subagent-abort-controller';

/**
 * Retrieve and abort a light subagent's AbortController (stored in ctx.meta
 * by makeLightSubagentFactory). Idempotent — calling abort() on an already-aborted
 * signal is a no-op.
 */
export function abortLightSubagent(agent: Agent): void {
  const ac = agent.ctx.meta[_SUBAGENT_ABORT] as AbortController | undefined;
  ac?.abort();
}

export function makeLightSubagentFactory(deps: LightSubagentFactoryDeps): AgentFactory {
  const configStore = deps.container.resolve(TOKENS.ConfigStore);
  const tokenCounter = deps.container.resolve(TOKENS.TokenCounter);
  const secretScrubber = deps.container.resolve(TOKENS.SecretScrubber);
  const systemPromptBuilder = deps.container.resolve(TOKENS.SystemPromptBuilder);

  return async (subCfg: SubagentConfig): Promise<AgentFactoryResult> => {
    const events = new EventBus();
    const config = configStore.get();

    const effProvider = subCfg.provider ?? config.provider;
    const effModel = subCfg.model ?? config.model;
    const provider = buildProvider(deps.providerRegistry, config, effProvider, effModel);

    const subCwd = subCfg.cwd ?? deps.cwd ?? deps.projectRoot;

    // Isolated tool registry per subagent: the run wraps this factory with
    // `withDisabledToolFiltering`, which unregister()s tools (e.g. delegate) on
    // the agent's registry — that must never mutate the shared parent registry.
    const allowed = filterToolList(deps.toolRegistry, subCfg.tools);
    const subRegistry = new ToolRegistry();
    for (const t of allowed) subRegistry.register(t);

    const baseSystem: TextBlock[] = await systemPromptBuilder.build({
      cwd: subCwd,
      projectRoot: deps.projectRoot,
      tools: allowed,
      model: effModel,
      provider: effProvider,
      subagent: true,
    });
    baseSystem.unshift({ type: 'text', text: SUBAGENT_BASELINE });
    if (subCfg.systemPromptOverride) {
      baseSystem.push({ type: 'text', text: subCfg.systemPromptOverride });
    }

    const agentName = subCfg.name ?? subCfg.id ?? `sub_${cryptoId()}`;
    const session = makeSubagentSessionShim(deps.session);

    // Keep the AbortController reference so callers can abort this subagent's
    // work. Stored with a symbol key so it is opaque to general-purpose consumers.
    const ac = new AbortController();
    const ctx = new Context({
      systemPrompt: baseSystem,
      provider,
      session,
      signal: ac.signal,
      tokenCounter,
      cwd: subCwd,
      projectRoot: deps.projectRoot,
      allowOutsideProjectRoot:
        config.features?.allowOutsideProjectRoot ?? !(config.tools?.restrictToProjectRoot ?? false),
      model: effModel,
      tools: allowed,
      agentId: agentName,
      agentName,
    });
    if (subCfg.role) ctx.meta['agentRole'] = subCfg.role;
    // Store the AbortController so abortLightSubagent() can retrieve it.
    (ctx.meta[_SUBAGENT_ABORT] as AbortController) = ac;

    // Subagents can't answer prompts — auto-approve the wide work capability set
    // (the spawn site may narrow it via allowedCapabilities). `source: 'yolo'`
    // from this policy is the authoritative-auto waiver the ToolExecutor trusts
    // for dangerous caps (fs.write, shell), so code edits actually go through.
    const caps = subCfg.allowedCapabilities ?? WIDE_SUBAGENT_CAPABILITIES;
    const permissionPolicy = new AutoApprovePermissionPolicy(caps);

    const toolExecutor = new ToolExecutor(subRegistry, {
      permissionPolicy,
      secretScrubber,
      events,
      confirmAwaiter: undefined,
      iterationTimeoutMs: config.tools?.iterationTimeoutMs ?? 120_000,
      perIterationOutputCapBytes: config.tools?.perIterationOutputCapBytes ?? 100_000,
      tracer: undefined,
    });

    const agent = new Agent({
      container: deps.container,
      tools: subRegistry,
      providers: deps.providerRegistry,
      events,
      pipelines: createDefaultPipelines(),
      context: ctx,
      permissionPolicy,
      toolExecutor,
    });

    // Fallback chain for THIS worker: a per-task `fallbackModels` (set in the
    // WebUI) overrides the live config's chain; otherwise the config's explicit
    // list or smart default applies. Without this a 429/529/5xx on a worker's
    // model — after its own retries — fails the task instead of rotating. Mirrors
    // the CLI host factory so both surfaces behave identically.
    const subFallbacks = subCfg.fallbackModels;
    agent.extensions.register(
      createFallbackModelExtension({
        getConfig: () => {
          const live = configStore.get();
          return subFallbacks && subFallbacks.length ? { ...live, fallbackModels: subFallbacks } : live;
        },
        buildProvider: (id) => buildProvider(deps.providerRegistry, configStore.get(), id, effModel),
        events,
      }),
    );

    return { agent, events };
  };
}

// ── helpers ──────────────────────────────────────────────────────────────────

function filterToolList(registry: ToolRegistry, allow?: string[]): Tool[] {
  const all = registry.list();
  if (!allow || allow.length === 0) return all;
  const allowSet = new Set(allow);
  return all.filter((t) => allowSet.has(t.name));
}

function buildProvider(
  registry: ProviderRegistry,
  config: Config,
  providerId: string,
  model: string,
): ReturnType<ProviderRegistry['create']> {
  const providerConfig = config.providers?.[providerId] ?? {
    type: providerId,
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
  };
  if (!registry.has(providerId)) {
    throw new Error(
      `No provider factory registered for "${providerId}" — cannot build a subagent provider for the SDD run.`,
    );
  }
  return registry.create({ ...providerConfig, type: providerId, model });
}

/**
 * Guarded SessionWriter shim that interleaves subagent events into the parent
 * JSONL while NEVER touching checkpoint / in-flight / lifecycle state — those
 * belong to the parent and a subagent writing them would corrupt the parent's
 * rewind + crash-recovery markers. Mirrors the CLI host's fallback shim.
 */
function makeSubagentSessionShim(parent: SessionWriter): SessionWriter {
  return {
    id: parent.id,
    transcriptPath: parent.transcriptPath,
    get pendingToolUses(): string[] {
      return [];
    },
    append: (ev) => parent.append({ ...ev }),
    appendBatch: (evs) => parent.appendBatch(evs.map((e) => ({ ...e }))),
    flush: () => parent.flush(),
    close: async () => {},
    recordFileChange: () => {},
    writeCheckpoint: async () => {},
    writeFileSnapshot: async () => {},
    truncateToCheckpoint: async () => 0,
    clearSession: async () => {},
    writeInFlightMarker: async () => {},
    clearInFlightMarker: async () => {},
  } satisfies SessionWriter;
}

function cryptoId(): string {
  return crypto.randomUUID().slice(0, 8);
}
