/**
 * L1-E: Multi-agent CLI integration. The coordinator + per-task agent
 * factory is created lazily on the first `/spawn` so users who never use
 * subagents don't pay the construction cost.
 */
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import {
  Agent,
  type Config,
  type ConfigStore,
  type Container,
  Context,
  DefaultMultiAgentCoordinator,
  Director,
  type DirectorSessionFactory,
  EventBus,
  type MultiAgentCoordinator,
  type Provider,
  type ProviderRegistry,
  type SessionWriter,
  type SystemPromptBuilder,
  TOKENS,
  type TaskResult,
  type TokenCounter,
  type Tool,
  type ToolRegistry,
  createDefaultPipelines,
  makeAgentSubagentRunner,
  makeDirectorSessionFactory,
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
  /**
   * Absolute path to the fleet's shared scratchpad directory. When set,
   * subagent system prompts are augmented with a "Shared notes" block
   * pointing here so agents can pass conclusions through the filesystem
   * without going through the bridge. Directory is created on first
   * spawn. Only meaningful in director mode.
   */
  sharedScratchpadPath?: string;
  /**
   * Absolute path to the directory under which per-subagent JSONL
   * transcripts land — typically `<projectSessions>/<sessionId>/subagents/`.
   * When set, the host builds a `DirectorSessionFactory` rooted there and
   * each spawned subagent gets its own session writer (instead of sharing
   * the parent session). Director mode only.
   */
  sessionsRoot?: string;
  /**
   * Director run id for namespacing per-subagent JSONLs. Defaults to the
   * coordinator id when omitted. Pass an explicit id when resuming from a
   * prior fleet manifest.
   */
  directorRunId?: string;
  /**
   * Base directory for fleet artifacts (manifest, shared scratchpad,
   * subagent sessions). When set and director mode is promoted at runtime
   * (via /director), paths are derived as:
   *   <fleetRoot>/fleet.json        (manifest)
   *   <fleetRoot>/shared/           (scratchpad)
   *   <fleetRoot>/subagents/        (per-subagent JSONL)
   */
  fleetRoot?: string;
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
  /** Lazily built alongside the director — produces per-subagent JSONL
   *  writers under `<sessionsRoot>/<runId>/`. Null in non-director mode. */
  private sessionFactory?: DirectorSessionFactory;
  private readonly pending = new Map<string, { description: string; subagentId: string }>();
  private readonly results: TaskResult[] = [];
  private readonly opts: MultiAgentHostOptions;

  constructor(
    private readonly deps: MultiAgentDeps,
    opts: MultiAgentHostOptions = {},
  ) {
    this.opts = opts;
  }

  /**
   * Force the lazy build path to run *now* and return the live Director,
   * or null when director mode is off. Used by the CLI to register the
   * fleet's LLM-callable orchestration tools (spawn_subagent,
   * assign_task, await_tasks, ask_subagent, roll_up, terminate_subagent,
   * fleet_status, fleet_usage) into the leader's ToolRegistry before the
   * agent starts — without this, the leader literally cannot see the
   * orchestration tools and `--director` becomes a no-op.
   */
  async ensureDirector(): Promise<Director | null> {
    if (!this.opts.directorMode) return null;
    await this.ensureCoordinator();
    return this.director ?? null;
  }

  private async ensureCoordinator(): Promise<MultiAgentCoordinator> {
    if (this.coordinator) return this.coordinator;
    const config: Config = this.deps.configStore.get() as Config;

    // Build the per-subagent session factory when both director mode and
    // a sessions root are configured.
    if (this.opts.directorMode && this.opts.sessionsRoot && !this.sessionFactory) {
      this.sessionFactory = makeDirectorSessionFactory({
        sessionsRoot: this.opts.sessionsRoot,
        directorRunId: this.opts.directorRunId,
      });
    }

    const runner = this.buildSubagentRunner(config);
    return this.buildCoordinator(runner);
  }

  /**
   * Build the per-subagent runner: agent factory → runner. Extracted so
   * ensureCoordinator stays focused on orchestration setup.
   */
  private buildSubagentRunner(config: Config): ReturnType<typeof makeAgentSubagentRunner> {
    const factory = async (subCfg: {
      id?: string;
      name?: string;
      model?: string;
      provider?: string;
      tools?: string[];
    }) => {
      const events = new EventBus();
      const provider = await this.buildSubagentProvider(config, subCfg.provider);

      const baseSystem: TextBlock[] = await this.deps.systemPromptBuilder.build({
        cwd: this.deps.cwd,
        projectRoot: this.deps.projectRoot,
        tools: this.filterTools(subCfg.tools),
        model: subCfg.model ?? config.model,
        provider: subCfg.provider ?? config.provider,
      });

      let subSession: SessionWriter;
      if (this.sessionFactory) {
        const subagentName = subCfg.name ?? subCfg.id ?? `sub_${randomUUID().slice(0, 8)}`;
        subSession = await this.sessionFactory.createSubagentSession({
          subagentId: subagentName,
          provider: subCfg.provider ?? config.provider,
          model: subCfg.model ?? config.model,
          title: `subagent: ${subagentName}`,
        });
      } else {
        const parentSession = this.deps.session;
        subSession = {
          id: parentSession.id,
          append: (ev) => parentSession.append({ ...ev }),
        } as SessionWriter;
      }

      const ctx = new Context({
        systemPrompt: baseSystem,
        provider,
        session: subSession,
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

    return makeAgentSubagentRunner({ factory });
  }

  /**
   * Build the coordinator (or Director wrapper) with task-completion
   * drain wired into the host's result buffer.
   */
  private buildCoordinator(
    runner: ReturnType<typeof makeAgentSubagentRunner>,
  ): MultiAgentCoordinator {
    const coordinatorConfig = {
      coordinatorId: randomUUID(),
      doneCondition: { type: 'all_tasks_done' as const },
      maxConcurrent: 2,
      defaultBudget: { maxToolCalls: 20, maxIterations: 20, timeoutMs: 120_000 },
    };

    if (this.opts.directorMode) {
      this.director = new Director({
        config: coordinatorConfig,
        runner,
        manifestPath: this.opts.manifestPath,
        sharedScratchpadPath: this.opts.sharedScratchpadPath,
      });
      this.director.on('task.completed', ({ task, result }) => {
        this.results.push(result);
        this.pending.delete(task.id);
      });
      this.coordinator = (
        this.director as unknown as { coordinator: MultiAgentCoordinator }
      ).coordinator;
      return this.coordinator;
    }

    this.coordinator = new DefaultMultiAgentCoordinator(coordinatorConfig, { runner });

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
  private async buildSubagentProvider(config: Config, overrideId?: string): Promise<Provider> {
    const providerId = overrideId && config.providers?.[overrideId] ? overrideId : config.provider;
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
    const bySubagent = new Map<
      string,
      {
        tasks: number;
        iterations: number;
        toolCalls: number;
        durationMs: number;
        lastStatus: string;
      }
    >();
    for (const r of this.results) {
      const cur = bySubagent.get(r.subagentId) ?? {
        tasks: 0,
        iterations: 0,
        toolCalls: 0,
        durationMs: 0,
        lastStatus: 'unknown',
      };
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
   * Promote a non-director session to director mode at runtime. Only
   * succeeds when no subagents have been spawned yet — once a coordinator
   * is running, the state cannot be migrated. Returns the live Director
   * so the caller can register orchestration tools into the ToolRegistry.
   *
   * Idempotent: calling promoteToDirector on an already-promoted host
   * returns the existing director without side effects.
   */
  async promoteToDirector(): Promise<Director | null> {
    if (this.director) return this.director;
    if (this.coordinator) {
      // A coordinator already exists (subagents were spawned). Cannot
      // safely replace a running coordinator with a Director wrapper.
      return null;
    }
    // Force director mode on so ensureCoordinator builds a Director.
    this.opts.directorMode = true;
    // Derive fleet paths from fleetRoot when available.
    if (this.opts.fleetRoot && !this.opts.manifestPath) {
      this.opts.manifestPath = path.join(this.opts.fleetRoot, 'fleet.json');
    }
    if (this.opts.fleetRoot && !this.opts.sharedScratchpadPath) {
      this.opts.sharedScratchpadPath = path.join(this.opts.fleetRoot, 'shared');
    }
    if (this.opts.fleetRoot && !this.opts.sessionsRoot) {
      this.opts.sessionsRoot = path.join(this.opts.fleetRoot, 'subagents');
    }
    await this.ensureDirector();
    return this.director ?? null;
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
