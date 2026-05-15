/**
 * L1-E: Multi-agent CLI integration. The coordinator + per-task agent
 * factory is created lazily on the first `/spawn` so users who never use
 * subagents don't pay the construction cost.
 */
import { randomUUID } from 'node:crypto';
import {
  Agent,
  type Container,
  Context,
  type Config,
  type ConfigStore,
  DefaultMultiAgentCoordinator,
  Director,
  EventBus,
  makeAgentSubagentRunner,
  type MultiAgentCoordinator,
  type Provider,
  type ProviderRegistry,
  type SessionWriter,
  type SystemPromptBuilder,
  type TaskResult,
  type Tool,
  type ToolRegistry,
  type TokenCounter,
  TOKENS,
  createDefaultPipelines,
} from '@wrongstack/core';
import type { TextBlock } from '@wrongstack/core';
import { makeProviderFromConfig } from '@wrongstack/providers';

export interface MultiAgentDeps {
  container: Container;
  toolRegistry: ToolRegistry;
  providerRegistry: ProviderRegistry;
  configStore: ConfigStore;
  events: EventBus;
  systemPromptBuilder: SystemPromptBuilder;
  session: SessionWriter;
  tokenCounter: TokenCounter;
  projectRoot: string;
  cwd: string;
}

/**
 * Per-session options that flip the orchestration mode. Director mode
 * routes lifecycle through a `Director`, which unlocks manifest writing
 * and (later) FleetBus observability — at the cost of building a slightly
 * heavier wrapper around the same coordinator. Default mode is the plain
 * coordinator path that existing `/spawn` users already rely on.
 */
export interface MultiAgentHostOptions {
  /**
   * Enable Director-backed orchestration. The host still exposes the same
   * `spawn` / `status` / `usage` / `kill` API; under the hood, calls flow
   * through a `Director` so manifest writing works and the FleetBus is
   * available for future observability hooks.
   */
  directorMode?: boolean;
  /**
   * Absolute file path the director writes its fleet manifest to on
   * shutdown (and on-demand via `manifest()`). Only meaningful when
   * `directorMode` is true; ignored otherwise.
   */
  manifestPath?: string;
}

/**
 * Lazy holder — created on first /spawn call, reused across the session
 * so /agents can list everyone running.
 */
export class MultiAgentHost {
  private coordinator?: MultiAgentCoordinator;
  /** Lazily built when `opts.directorMode` is set. Owns its own internal
   *  coordinator; the host's `coordinator` field still points at it so
   *  the rest of the methods don't need to branch. */
  private director?: Director;
  private readonly pending = new Map<string, { description: string; subagentId: string }>();
  private readonly results: TaskResult[] = [];
  private readonly opts: MultiAgentHostOptions;

  constructor(private readonly deps: MultiAgentDeps, opts: MultiAgentHostOptions = {}) {
    this.opts = opts;
  }

  private async ensureCoordinator(): Promise<MultiAgentCoordinator> {
    if (this.coordinator) return this.coordinator;
    const config: Config = this.deps.configStore.get() as Config;

    const factory = async (subCfg: { model?: string; provider?: string; tools?: string[] }) => {
      const events = new EventBus();
      // Per-subagent provider: honor `subCfg.provider` when set so a
      // single director run can mix providers (e.g. sonnet for editor,
      // haiku for researcher, gpt-5 for auditor). Falls back to the
      // leader provider for backwards compat — existing /spawn calls
      // that don't set `provider` keep their pre-fleet behavior.
      const provider = await this.buildSubagentProvider(config, subCfg.provider);

      // Fresh context per subagent — explicit isolation.
      const baseSystem: TextBlock[] = await this.deps.systemPromptBuilder.build({
        cwd: this.deps.cwd,
        projectRoot: this.deps.projectRoot,
        tools: this.filterTools(subCfg.tools),
        model: subCfg.model ?? config.model,
        provider: subCfg.provider ?? config.provider,
      });

      // Reuse session id and append channel; subagent events get tagged
      // by source via the event bus rather than persisted to a separate
      // file. Keeps replay simple.
      const parentSession = this.deps.session;
      const subSession: SessionWriter = {
        id: parentSession.id,
        append: (ev) => parentSession.append({ ...ev }),
      } as SessionWriter;

      const ctx = new Context({
        systemPrompt: baseSystem,
        provider,
        session: subSession,
        // Placeholder — Agent.run() overwrites ctx.signal with the live
        // per-run signal (see core/agent.ts run()). Tools/middleware that
        // read ctx.signal after construction will see the runtime signal,
        // not this one. Kept as `new AbortController().signal` so the
        // initial value is non-null/non-aborted.
        signal: new AbortController().signal,
        tokenCounter: this.deps.tokenCounter,
        cwd: this.deps.cwd,
        projectRoot: this.deps.projectRoot,
        model: subCfg.model ?? config.model,
        tools: this.filterTools(subCfg.tools),
      });

      const agent = new Agent({
        container: this.deps.container,
        tools: this.subagentToolRegistry(subCfg.tools),
        providers: this.deps.providerRegistry,
        events,
        pipelines: createDefaultPipelines(),
        context: ctx,
      });

      return { agent, events };
    };

    const runner = makeAgentSubagentRunner({ factory });

    const coordinatorConfig = {
      coordinatorId: randomUUID(),
      doneCondition: { type: 'all_tasks_done' as const },
      maxConcurrent: 2,
      defaultBudget: { maxToolCalls: 20, maxIterations: 20, timeoutMs: 120_000 },
    };

    if (this.opts.directorMode) {
      // Director owns its own coordinator internally. We hold a reference
      // to both so the host's spawn/status/usage methods can keep working
      // without branching on every call — coordinator is the source of
      // truth for tasks; the director adds manifest writing + FleetBus
      // observability on top.
      this.director = new Director({
        config: coordinatorConfig,
        runner,
        manifestPath: this.opts.manifestPath,
      });
      // Same task.completed drain pattern as the simple path. Using
      // Director.on() keeps the public surface clean — we don't need to
      // reach into the coordinator field.
      this.director.on('task.completed', ({ task, result }) => {
        this.results.push(result);
        this.pending.delete(task.id);
      });
      // The host's coordinator field is the live coordinator the director
      // built — assign() / stop() / stopAll() on it route to the same
      // underlying machine the director observes.
      this.coordinator = (this.director as unknown as { coordinator: MultiAgentCoordinator }).coordinator;
      return this.coordinator;
    }

    this.coordinator = new DefaultMultiAgentCoordinator(coordinatorConfig, { runner });

    // Drain task.completed into our local result buffer for /agents
    (this.coordinator as unknown as { on: Function }).on(
      'task.completed',
      ({ task, result }: { task: { id: string }; result: TaskResult }) => {
        this.results.push(result);
        this.pending.delete(task.id);
      },
    );

    return this.coordinator;
  }

  /**
   * Build a Provider for a subagent. When `overrideId` is supplied (from
   * `SubagentConfig.provider`), looks that provider up in
   * `config.providers` and constructs it with its own apiKey/baseUrl.
   * Falls back to the leader's provider when `overrideId` is absent or
   * not configured (so a typo doesn't crash the whole run — we just
   * use the leader and the calling code can decide to error later).
   */
  private async buildSubagentProvider(
    config: Config,
    overrideId?: string,
  ): Promise<Provider> {
    const providerId = overrideId && config.providers?.[overrideId]
      ? overrideId
      : config.provider;
    const newCfg = config.providers?.[providerId] ?? {
      type: providerId,
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
    };
    return makeProviderFromConfig(providerId, {
      ...newCfg,
      type: providerId,
    });
  }

  /** Returns a tool slice for the subagent — full set unless restricted. */
  private filterTools(allow?: string[]): Tool[] {
    const all = this.deps.toolRegistry.list();
    if (!allow || allow.length === 0) return all;
    const allowSet = new Set(allow);
    return all.filter((t) => allowSet.has(t.name));
  }

  private subagentToolRegistry(allow?: string[]): ToolRegistry {
    if (!allow || allow.length === 0) return this.deps.toolRegistry;
    // Build a filtered registry by cloning entries.
    const cloneCtor = this.deps.toolRegistry.constructor as new () => ToolRegistry;
    const sub = new cloneCtor();
    for (const t of this.filterTools(allow)) sub.register(t);
    return sub;
  }

  /**
   * Spawn a fresh subagent and assign a single task. Returns task id.
   *
   * Optional `opts` lets the caller (a `/spawn` slash command or the
   * future director surface) override the subagent's provider, model,
   * and tool slice on a per-spawn basis. Without options, the legacy
   * behavior holds: the subagent uses the leader's provider/model and
   * the full tool registry.
   */
  async spawn(
    description: string,
    opts?: { provider?: string; model?: string; tools?: string[]; name?: string },
  ): Promise<{ subagentId: string; taskId: string }> {
    await this.ensureCoordinator();
    const subagentConfig = {
      name: opts?.name ?? 'adhoc',
      role: 'general',
      maxToolCalls: 20,
      maxIterations: 20,
      provider: opts?.provider,
      model: opts?.model,
      tools: opts?.tools,
    };
    // In director mode we route through `Director.spawn` / `Director.assign`
    // so the director's manifest entries get populated. Calling the
    // underlying coordinator directly would still execute the task, but
    // the manifest would be empty — that surprised the first test.
    if (this.director) {
      const subagentId = await this.director.spawn(subagentConfig);
      const taskId = randomUUID();
      this.pending.set(taskId, { description, subagentId });
      await this.director.assign({
        id: taskId,
        description,
        subagentId,
        maxToolCalls: 20,
      });
      return { subagentId, taskId };
    }
    const coord = this.coordinator!;
    const spawned = await coord.spawn(subagentConfig);
    const taskId = randomUUID();
    this.pending.set(taskId, { description, subagentId: spawned.subagentId });
    await coord.assign({
      id: taskId,
      description,
      subagentId: spawned.subagentId,
      maxToolCalls: 20,
    });
    return { subagentId: spawned.subagentId, taskId };
  }

  status(): {
    pending: { taskId: string; description: string; subagentId: string }[];
    completed: TaskResult[];
    summary: string;
  } {
    const pending = Array.from(this.pending.entries()).map(([taskId, v]) => ({
      taskId,
      description: v.description,
      subagentId: v.subagentId,
    }));
    const summary = !this.coordinator
      ? 'No subagents have been spawned.'
      : `${pending.length} pending, ${this.results.length} completed.`;
    return { pending, completed: this.results, summary };
  }

  /**
   * Roll up per-subagent runtime cost from completed TaskResults. We don't
   * yet have FleetUsageAggregator wired into the simple MultiAgentHost
   * path (that lives on `Director`), so this aggregates iterations / tool
   * calls / duration which we *do* have — enough to spot a thrashing
   * worker without paying for a heavier orchestrator on every /spawn.
   *
   * Returns rows sorted by total duration descending (slowest first) so
   * the table renders the most interesting subagent at the top.
   */
  usage(): {
    rows: Array<{
      subagentId: string;
      tasks: number;
      iterations: number;
      toolCalls: number;
      durationMs: number;
      status: string;
    }>;
    totals: { tasks: number; iterations: number; toolCalls: number; durationMs: number };
  } {
    const bySubagent = new Map<string, { tasks: number; iterations: number; toolCalls: number; durationMs: number; lastStatus: string }>();
    for (const r of this.results) {
      const cur = bySubagent.get(r.subagentId) ?? { tasks: 0, iterations: 0, toolCalls: 0, durationMs: 0, lastStatus: 'unknown' };
      cur.tasks += 1;
      cur.iterations += r.iterations;
      cur.toolCalls += r.toolCalls;
      cur.durationMs += r.durationMs;
      cur.lastStatus = r.status;
      bySubagent.set(r.subagentId, cur);
    }
    const rows = Array.from(bySubagent.entries())
      .map(([subagentId, v]) => ({
        subagentId,
        tasks: v.tasks,
        iterations: v.iterations,
        toolCalls: v.toolCalls,
        durationMs: v.durationMs,
        status: v.lastStatus,
      }))
      .sort((a, b) => b.durationMs - a.durationMs);
    const totals = rows.reduce(
      (acc, r) => ({
        tasks: acc.tasks + r.tasks,
        iterations: acc.iterations + r.iterations,
        toolCalls: acc.toolCalls + r.toolCalls,
        durationMs: acc.durationMs + r.durationMs,
      }),
      { tasks: 0, iterations: 0, toolCalls: 0, durationMs: 0 },
    );
    return { rows, totals };
  }

  /**
   * Force the director to write its manifest to disk and return the path,
   * or `null` when director mode is off (the simple coordinator path has
   * no manifest). Callers should fall back to a friendly user message
   * when `null` is returned — e.g. `/fleet manifest` does this already.
   *
   * The returned string is the absolute path of the manifest file. The
   * file contents are JSON; readers can `JSON.parse(fs.readFileSync(...))`
   * to consume.
   */
  async manifest(): Promise<string | null> {
    if (!this.director) return null;
    return this.director.writeManifest();
  }

  /**
   * True when this host is running in director mode. Surfaces the mode
   * to slash commands and tests without exposing the underlying Director
   * (which would let callers bypass the host's coordination layer).
   */
  isDirectorMode(): boolean {
    return !!this.director;
  }

  /**
   * Terminate a single subagent. Returns true when the subagent existed
   * (regardless of whether stop() succeeded or it was already idle),
   * false when no coordinator has been created yet — meaning the user
   * called /fleet kill before any /spawn, and there's nothing to do.
   */
  async kill(subagentId: string): Promise<boolean> {
    if (!this.coordinator) return false;
    await this.coordinator.stop(subagentId);
    return true;
  }

  async stopAll(): Promise<void> {
    if (this.coordinator) {
      await this.coordinator.stopAll();
    }
  }
}
// Workaround: TOKENS reference satisfies unused-import lint without being
// active runtime usage — included for clarity that the coordinator
// shares the container's permission policy etc. via the agent factory.
void TOKENS;
