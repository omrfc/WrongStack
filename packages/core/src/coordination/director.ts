import { randomUUID } from 'node:crypto';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import type { BridgeMessage } from '../types/agent-bridge.js';
import type {
  CoordinatorStatus,
  MultiAgentConfig,
  SubagentConfig,
  SubagentRunner,
  TaskResult,
  TaskSpec,
} from '../types/multi-agent.js';
import type { JSONSchema, Tool } from '../types/tool.js';
import { InMemoryAgentBridge } from './agent-bridge.js';
import {
  DEFAULT_DIRECTOR_PREAMBLE,
  DEFAULT_SUBAGENT_BASELINE,
  composeDirectorPrompt,
  composeSubagentPrompt,
  rosterSummaryFromConfigs,
} from './director-prompts.js';
import { FleetBus, type FleetUsage, FleetUsageAggregator } from './fleet-bus.js';
import { InMemoryBridgeTransport } from './in-memory-transport.js';
import { DefaultMultiAgentCoordinator } from './multi-agent-coordinator.js';

/**
 * Director — high-level orchestrator that owns a `MultiAgentCoordinator`,
 * a `FleetBus`, and a `FleetUsageAggregator`. Exposes a small imperative
 * API (`spawn`, `assign`, `awaitTasks`, `terminate`, `status`, `usage`)
 * that's easy to test, and a `tools()` factory that wraps the same API
 * as agent-callable `Tool`s so an LLM can drive the orchestration.
 *
 * This class is intentionally *not* an `Agent`. It's a coordinator +
 * observability surface. To make it LLM-driven, construct an Agent
 * with `director.tools()` registered. That keeps the construction
 * symmetric with how other agents are built and avoids smuggling a
 * heavy LLM dependency into core just for the director path.
 */
export interface DirectorOptions {
  config: MultiAgentConfig;
  runner?: SubagentRunner;
  /**
   * When set, the director writes a `fleet.json` manifest to this path
   * recording every spawned subagent (id, provider, model, role, task
   * ids). Used by `wstack replay <runId>` to rehydrate a fleet. Pass an
   * absolute file path — the directory must already exist (the
   * director-session factory creates it when used together).
   */
  manifestPath?: string;
  /**
   * Optional roster used by `leaderSystemPrompt()` to render a roles
   * summary into the leader's preamble. Same shape as the roster passed
   * to `tools()` — typically the same value.
   */
  roster?: Record<string, SubagentConfig>;
  /**
   * Override the built-in fleet preamble (see `DEFAULT_DIRECTOR_PREAMBLE`).
   * Pass an empty string to suppress the preamble entirely.
   */
  directorPreamble?: string;
  /**
   * Override the built-in subagent baseline (see
   * `DEFAULT_SUBAGENT_BASELINE`). Pass an empty string to suppress.
   */
  subagentBaseline?: string;
  /**
   * Absolute path to a directory the fleet can use as a shared scratchpad
   * (read + write by every subagent). When set, the director creates it on
   * construction and `subagentSystemPrompt()` automatically injects a
   * "Shared notes" block telling subagents where to drop their findings.
   * This is the cheap fleet-coordination channel — agents don't need each
   * other's transcripts, just each other's conclusions.
   *
   * Convention: under a fleet run rooted at `<sessionsRoot>/<runId>/`,
   * pass `<sessionsRoot>/<runId>/shared/` here.
   */
  sharedScratchpadPath?: string;
  /**
   * Maximum number of spawns this director can perform across its
   * lifetime. Default: unlimited. Acts as a hard fleet-wide cost cap —
   * a runaway leader that keeps spawning workers gets cut off cleanly
   * instead of burning provider tokens until the user kills the
   * process. The N+1-th spawn call rejects with a `DirectorBudgetError`.
   */
  maxSpawns?: number;
  /**
   * Maximum nesting depth for spawns. The director constructed by the
   * user is at depth `spawnDepth` (default 0); any subagent that itself
   * acts as a director would construct its own `Director` with
   * `spawnDepth: parent.spawnDepth + 1`. When `spawnDepth >= maxSpawnDepth`,
   * `spawn()` rejects. Default: 2 (root director can spawn workers; a
   * worker that becomes a sub-director cannot itself spawn further).
   * This stops infinite recursive director chains from a hostile or
   * confused prompt.
   */
  maxSpawnDepth?: number;
  /**
   * Current spawn-chain depth for this director instance. Defaults to 0.
   * A nested director should pass `parent.spawnDepth + 1`. Together with
   * `maxSpawnDepth` this bounds the chain.
   */
  spawnDepth?: number;
}

/**
 * Thrown by `Director.spawn()` when a configured spawn cap (`maxSpawns`,
 * `maxSpawnDepth`) is hit. Distinct error class so callers — including
 * the `spawn_subagent` tool surface — can recognize the budget case and
 * report it cleanly instead of treating it like an unexpected failure.
 */
export class DirectorBudgetError extends Error {
  readonly kind: 'max_spawns' | 'max_spawn_depth';
  readonly limit: number;
  readonly observed: number;
  constructor(kind: 'max_spawns' | 'max_spawn_depth', limit: number, observed: number) {
    super(
      kind === 'max_spawns'
        ? `Director spawn budget exceeded: tried to spawn #${observed} but maxSpawns is ${limit}`
        : `Director spawn depth budget exceeded: this director is at depth ${observed} and maxSpawnDepth is ${limit}`,
    );
    this.name = 'DirectorBudgetError';
    this.kind = kind;
    this.limit = limit;
    this.observed = observed;
  }
}

export class Director {
  readonly id: string;
  readonly fleet: FleetBus;
  readonly usage: FleetUsageAggregator;
  /**
   * Director-side bridge endpoint. Subagents are wired to the same
   * in-memory transport so the director can `ask()` them synchronously
   * and they can `send()` progress back. Exposed so external code (e.g.
   * the TUI) can subscribe to inbound messages.
   */
  readonly bridge: InMemoryAgentBridge;
  private readonly transport: InMemoryBridgeTransport;
  private readonly coordinator: DefaultMultiAgentCoordinator;
  /** Resolves with the matching `TaskResult` the first time the
   *  coordinator emits `task.completed` for a given task id. Each entry
   *  is created lazily on first poll/await and cleared once consumed. */
  private readonly taskWaiters = new Map<
    string,
    {
      promise: Promise<TaskResult>;
      resolve: (r: TaskResult) => void;
    }
  >();
  /** Cache of completed results in case the consumer asks AFTER the
   *  coordinator already fired the event — `awaitTasks(['t-1'])` after
   *  t-1 finished should resolve immediately, not hang. */
  private readonly completed = new Map<string, TaskResult>();
  /** Per-subagent provider/model metadata, captured at spawn time so the
   *  FleetUsageAggregator's metaLookup can surface readable rows. */
  private readonly subagentMeta = new Map<string, { provider?: string; model?: string }>();
  private readonly priceLookups = new Map<
    string,
    { input?: number; output?: number; cacheRead?: number; cacheWrite?: number }
  >();
  /** Bridge endpoints we created per subagent (so we can `stop()` them
   *  on shutdown and free transport subscriptions). */
  private readonly subagentBridges = new Map<string, InMemoryAgentBridge>();
  /** Tracks per-spawn config + assigned task ids for manifest writing. */
  private readonly manifestEntries = new Map<
    string,
    {
      subagentId: string;
      name: string;
      role?: string;
      provider?: string;
      model?: string;
      taskIds: string[];
    }
  >();
  private readonly manifestPath?: string;
  private readonly roster?: Record<string, SubagentConfig>;
  private readonly directorPreamble: string;
  private readonly subagentBaseline: string;
  /** Absolute path to the fleet's shared scratchpad directory, or null
   *  when none was configured. Exposed as a readonly getter for callers
   *  that need to surface the path to the user (e.g. the CLI logging
   *  the location after `--director` boots). */
  readonly sharedScratchpadPath: string | null;
  /** Spawn cap (lifetime total). Infinity means unlimited. */
  readonly maxSpawns: number;
  /** Nesting cap. The N-th director in a chain has `spawnDepth = N-1`. */
  readonly maxSpawnDepth: number;
  /** This director's position in a director chain. Root director = 0. */
  readonly spawnDepth: number;
  /** Live spawn counter for `maxSpawns` enforcement. */
  private spawnCount = 0;

  constructor(opts: DirectorOptions) {
    this.id = opts.config.coordinatorId || randomUUID();
    this.manifestPath = opts.manifestPath;
    this.roster = opts.roster;
    this.directorPreamble = opts.directorPreamble ?? DEFAULT_DIRECTOR_PREAMBLE;
    this.subagentBaseline = opts.subagentBaseline ?? DEFAULT_SUBAGENT_BASELINE;
    this.sharedScratchpadPath = opts.sharedScratchpadPath ?? null;
    this.maxSpawns = opts.maxSpawns ?? Number.POSITIVE_INFINITY;
    this.maxSpawnDepth = opts.maxSpawnDepth ?? 2;
    this.spawnDepth = opts.spawnDepth ?? 0;
    if (this.sharedScratchpadPath) {
      // Create the directory eagerly so subagents that try to write
      // there on first iteration don't trip on ENOENT. Fire-and-forget;
      // any failure surfaces later when an agent actually writes.
      void fsp.mkdir(this.sharedScratchpadPath, { recursive: true }).catch(() => undefined);
    }
    this.transport = new InMemoryBridgeTransport();
    this.bridge = new InMemoryAgentBridge(
      { agentId: this.id, coordinatorId: this.id },
      this.transport,
    );
    this.fleet = new FleetBus();
    this.usage = new FleetUsageAggregator(
      this.fleet,
      (id) => this.priceLookups.get(id),
      (id) => this.subagentMeta.get(id),
    );
    this.coordinator = new DefaultMultiAgentCoordinator(
      { ...opts.config, coordinatorId: this.id },
      { runner: opts.runner },
    );
    // Mirror coordinator completion events into the waiter table. This
    // lets `awaitTasks([...])` resolve on the *next* completion event
    // without polling — and the `completed` cache covers the case where
    // a caller asks after the fact.
    this.coordinator.on('task.completed', (payload: { task: TaskSpec; result: TaskResult }) => {
      const r = payload.result;
      this.completed.set(r.taskId, r);
      const waiter = this.taskWaiters.get(r.taskId);
      if (waiter) {
        waiter.resolve(r);
        this.taskWaiters.delete(r.taskId);
      }
    });
  }

  /**
   * Spawn a subagent. Identical to the coordinator's `spawn()` but
   * captures provider/model metadata for the usage aggregator and
   * lets the FleetBus attach to the runner's EventBus when the task
   * actually runs (see `attachSubagentBus`).
   *
   * Caller-supplied `priceLookup` is optional but recommended — without
   * it the `cost` column in `usage.snapshot()` stays at 0.
   */
  async spawn(
    config: SubagentConfig,
    priceLookup?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number },
  ): Promise<string> {
    // Enforce safety caps BEFORE touching the coordinator — a refused
    // spawn must not leak partial state into the manifest or fleet bus.
    if (this.spawnDepth >= this.maxSpawnDepth) {
      throw new DirectorBudgetError('max_spawn_depth', this.maxSpawnDepth, this.spawnDepth);
    }
    if (this.spawnCount >= this.maxSpawns) {
      throw new DirectorBudgetError('max_spawns', this.maxSpawns, this.spawnCount + 1);
    }
    this.spawnCount += 1;
    const result = await this.coordinator.spawn(config);
    this.subagentMeta.set(result.subagentId, {
      provider: config.provider,
      model: config.model,
    });
    if (priceLookup) this.priceLookups.set(result.subagentId, priceLookup);
    // Auto-wire a bridge per spawn — same transport as the director, so
    // `director.ask(subagentId, …)` and the subagent's own `bridge.send()`
    // round-trip without the caller having to plumb anything. Runners
    // grab their bridge from `ctx.bridge` (already populated by the
    // coordinator from `subagent.context.parentBridge`).
    const subagentBridge = new InMemoryAgentBridge(
      { agentId: result.subagentId, coordinatorId: this.id },
      this.transport,
    );
    this.coordinator.setSubagentBridge(result.subagentId, subagentBridge);
    this.subagentBridges.set(result.subagentId, subagentBridge);
    // Record for manifest. Task ids attach as they're assigned via
    // `assign()` below.
    this.manifestEntries.set(result.subagentId, {
      subagentId: result.subagentId,
      name: config.name,
      role: config.role,
      provider: config.provider,
      model: config.model,
      taskIds: [],
    });
    return result.subagentId;
  }

  /**
   * Synchronously ask a subagent something via the bridge. Sends a
   * `task` message addressed to the subagent and awaits a matching
   * reply (matched by message id). Subagent runners that handle these
   * requests subscribe to `ctx.bridge` and reply with a message whose
   * `id` equals the incoming request's id (see `InMemoryAgentBridge`'s
   * `request<T>` implementation).
   *
   * Returns the response payload directly (the bridge wrapper is
   * unwrapped for ergonomics). Times out after `timeoutMs` (default
   * matches the bridge's own default of 30s) — surface those rejections
   * to the caller as actionable errors instead of letting tools hang.
   */
  async ask<T = unknown>(subagentId: string, payload: unknown, timeoutMs?: number): Promise<T> {
    if (!this.subagentBridges.has(subagentId)) {
      throw new Error(
        `ask: unknown subagent "${subagentId}" (spawn() it first; current fleet: ${Array.from(this.subagentBridges.keys()).join(', ') || '(empty)'})`,
      );
    }
    const msg: BridgeMessage = {
      id: randomUUID(),
      type: 'task',
      from: this.id,
      to: subagentId,
      payload,
      timestamp: Date.now(),
      priority: 'normal',
    };
    const reply = await this.bridge.request<T>(msg, timeoutMs);
    return reply.payload;
  }

  /**
   * Read completed task results and format them as a structured text
   * block the director's LLM can paste into its own context. The
   * Director keeps every completed `TaskResult` in `completed` so this
   * is a pure read — no bridge round-trip, cheap to call.
   *
   * The returned string is intentionally markdown-flavored: headers per
   * subagent, a one-line meta row (iter / tools / ms), and the task's
   * result text. Pass `style: 'json'` for a programmatic shape instead
   * (useful when the director model is doing structured-output work).
   */
  rollUp(taskIds: string[], style: 'markdown' | 'json' = 'markdown'): string {
    const rows = taskIds.map((id) => this.completed.get(id)).filter((r): r is TaskResult => !!r);
    if (style === 'json') {
      return JSON.stringify(
        rows.map((r) => ({
          taskId: r.taskId,
          subagentId: r.subagentId,
          status: r.status,
          iterations: r.iterations,
          toolCalls: r.toolCalls,
          durationMs: r.durationMs,
          result: r.result,
          error: r.error,
        })),
        null,
        2,
      );
    }
    if (rows.length === 0) {
      return '_No completed tasks for the requested ids — try waiting first._';
    }
    const lines: string[] = [];
    for (const r of rows) {
      const meta = this.subagentMeta.get(r.subagentId);
      const tag = meta?.provider && meta?.model ? ` · ${meta.provider}/${meta.model}` : '';
      lines.push(`### ${r.subagentId}${tag}`);
      lines.push(`_${r.status} — ${r.iterations} iter · ${r.toolCalls} tools · ${r.durationMs}ms_`);
      lines.push('');
      if (r.error) lines.push(`**Error:** ${r.error}`);
      else if (typeof r.result === 'string') lines.push(r.result);
      else if (r.result !== undefined)
        lines.push('```json\n' + JSON.stringify(r.result, null, 2) + '\n```');
      else lines.push('_(no output)_');
      lines.push('');
    }
    return lines.join('\n').trimEnd();
  }

  /**
   * Write the fleet manifest to `manifestPath`. Returns the path written
   * or null when no path was configured. Captures every spawn + its
   * assigned tasks — paired with per-subagent JSONLs, this is enough to
   * replay an entire director run.
   */
  async writeManifest(): Promise<string | null> {
    if (!this.manifestPath) return null;
    const manifest = {
      directorRunId: this.id,
      writtenAt: new Date().toISOString(),
      children: Array.from(this.manifestEntries.values()).map((e) => ({
        ...e,
        // Surface final status from `completed` when available — manifest
        // becomes much more useful for replay when it carries the
        // success/failure state.
        results: e.taskIds.map((tid) => {
          const r = this.completed.get(tid);
          return r
            ? {
                taskId: tid,
                status: r.status,
                iterations: r.iterations,
                toolCalls: r.toolCalls,
                durationMs: r.durationMs,
              }
            : { taskId: tid, status: 'pending' as const };
        }),
      })),
      usage: this.usage.snapshot(),
    };
    await fsp.mkdir(path.dirname(this.manifestPath), { recursive: true });
    await fsp.writeFile(this.manifestPath, JSON.stringify(manifest, null, 2), { mode: 0o600 });
    return this.manifestPath;
  }

  /**
   * Tear down the director: stop every subagent, close every bridge
   * endpoint, and (when configured) write the final manifest. Idempotent
   * — calling shutdown twice is a no-op on the second invocation.
   */
  async shutdown(): Promise<void> {
    await this.coordinator.stopAll();
    for (const b of this.subagentBridges.values()) {
      await b.stop().catch(() => undefined);
    }
    this.subagentBridges.clear();
    await this.bridge.stop().catch(() => undefined);
    if (this.manifestPath) await this.writeManifest().catch(() => undefined);
  }

  /**
   * Hand a task to the coordinator. Returns the assigned task id so
   * callers can wait on it via `awaitTasks([id])`. The coordinator's
   * concurrency limit applies — the task may queue before running.
   */
  async assign(task: TaskSpec): Promise<string> {
    const taskWithId: TaskSpec = task.id ? task : { ...task, id: randomUUID() };
    if (task.subagentId) {
      const entry = this.manifestEntries.get(task.subagentId);
      if (entry) entry.taskIds.push(taskWithId.id);
    }
    await this.coordinator.assign(taskWithId);
    return taskWithId.id;
  }

  /**
   * Block until every task id resolves. Returns results in the same
   * order as the input. If any task hasn't completed by the time this
   * is called, the promise hangs until it does — pair with a timeout
   * at the caller if that's a concern. Resolves immediately for ids
   * whose results were already cached.
   */
  awaitTasks(taskIds: string[]): Promise<TaskResult[]> {
    return Promise.all(
      taskIds.map((id) => {
        const cached = this.completed.get(id);
        if (cached) return cached;
        const existing = this.taskWaiters.get(id);
        if (existing) return existing.promise;
        let resolve!: (r: TaskResult) => void;
        const promise = new Promise<TaskResult>((res) => {
          resolve = res;
        });
        this.taskWaiters.set(id, { promise, resolve });
        return promise;
      }),
    );
  }

  async terminate(subagentId: string): Promise<void> {
    await this.coordinator.stop(subagentId);
  }

  async terminateAll(): Promise<void> {
    await this.coordinator.stopAll();
  }

  status(): CoordinatorStatus {
    return this.coordinator.getStatus();
  }

  /**
   * Subscribe to coordinator events. Currently only `task.completed` is
   * exposed (the others are internal lifecycle). Returns an unsubscribe
   * function. External callers (e.g. the CLI's `MultiAgentHost`) use this
   * to drive their own pending/results tracking without poking the
   * coordinator directly.
   */
  on(
    event: 'task.completed',
    handler: (payload: { task: TaskSpec; result: TaskResult }) => void,
  ): () => void {
    // EventEmitter.on returns `this`; wrap so callers get a stable
    // unsubscribe closure (matches the rest of our event API).
    this.coordinator.on(event, handler);
    return () => {
      this.coordinator.off(event, handler);
    };
  }

  /**
   * Snapshot of every task that has resolved (success, failed, timeout,
   * stopped) since the director started. Returned in completion order
   * via the internal map's iteration order. Used by `/fleet status` to
   * paint the completed table without reaching into private state.
   */
  completedResults(): TaskResult[] {
    return Array.from(this.completed.values());
  }

  snapshot(): FleetUsage {
    return this.usage.snapshot();
  }

  /**
   * Compose the leader/director-agent system prompt: fleet preamble +
   * (optional) roster summary + user base prompt. Pass the result to your
   * leader Agent's `ctx.systemPrompt` when constructing it.
   *
   * `basePrompt` defaults to `config.leaderSystemPrompt` so callers can
   * use the no-arg form when the multi-agent config already carries it.
   */
  leaderSystemPrompt(basePrompt?: string): string {
    return composeDirectorPrompt({
      basePrompt: basePrompt ?? this.coordinator.config.leaderSystemPrompt,
      directorPreamble: this.directorPreamble,
      rosterSummary: this.roster ? rosterSummaryFromConfigs(this.roster) : undefined,
    });
  }

  /**
   * Compose a subagent's system prompt for a given `SubagentConfig`:
   * baseline + role + task + per-spawn override. Returned by value — does
   * not mutate the config. Factories (the user-supplied `AgentFactory`)
   * should call this when building each subagent's Agent so the bridge
   * contract, role context, and override are all surfaced.
   *
   * When `taskBrief` is omitted the Task section is dropped. Pass the
   * actual task description here to reinforce it in the system prompt
   * (the runner already passes it as user input — duplicating in the
   * system prompt is optional but improves anchoring on small models).
   */
  subagentSystemPrompt(config: SubagentConfig, taskBrief?: string): string {
    return composeSubagentPrompt({
      baseline: this.subagentBaseline,
      role: config.prompt,
      task: taskBrief,
      sharedScratchpad: this.sharedScratchpadPath ?? undefined,
      override: config.systemPromptOverride,
    });
  }

  /**
   * Build the tool set the LLM-driven director uses to orchestrate.
   * Returns an array of `Tool` definitions; register these on the
   * director's `Agent` to expose `spawn_subagent`, `assign_task`, etc.
   * Each tool's `execute()` delegates straight to the matching method
   * above.
   *
   * Tools all carry `permission: 'auto'` — the *user* has already
   * approved running the director when they kicked off the run, so
   * gating individual orchestration calls behind a confirm prompt
   * would just be noise. The actual subagent tools they spawn are
   * still permission-checked normally.
   */
  tools(roster?: Record<string, SubagentConfig>): Tool[] {
    const t: Tool[] = [
      makeSpawnTool(this, roster),
      makeAssignTool(this),
      makeAwaitTasksTool(this),
      makeAskTool(this),
      makeRollUpTool(this),
      makeTerminateTool(this),
      makeFleetStatusTool(this),
      makeFleetUsageTool(this),
    ];
    return t;
  }
}

// ---------------------------------------------------------------------------
// Director-facing tool factories.
//
// Each tool's input schema is intentionally minimal — the director model
// reads the descriptions and gets clean structured shapes. We avoid deep
// nested schemas because they confuse smaller models.

function makeSpawnTool(director: Director, roster?: Record<string, SubagentConfig>): Tool {
  const inputSchema: JSONSchema = {
    type: 'object',
    properties: {
      role: {
        type: 'string',
        description:
          'Roster role id (preferred). When set, the spawn uses the matching config from the roster and ignores other fields.',
      },
      name: {
        type: 'string',
        description: 'Display name for the subagent. Required when not using roster.',
      },
      provider: {
        type: 'string',
        description:
          'Provider id (e.g. "anthropic", "openai"). Defaults to the leader provider when omitted.',
      },
      model: {
        type: 'string',
        description: 'Model id within the provider. Defaults to the leader model when omitted.',
      },
      systemPromptOverride: {
        type: 'string',
        description: 'Extra prompt text appended after the role-base prompt.',
      },
      maxIterations: { type: 'number' },
      maxToolCalls: { type: 'number' },
      maxCostUsd: { type: 'number' },
    },
    required: [],
  };
  return {
    name: 'spawn_subagent',
    description:
      'Create a new subagent under this director. Returns the subagent id. Use this when you need a worker with a specific provider, model, or role to handle a piece of the plan.',
    usageHint:
      'Either pass `role` (matches the roster) OR pass `name` + optional `provider`/`model`. Returns `{ subagentId }`.',
    permission: 'auto',
    mutating: false,
    inputSchema,
    async execute(input: unknown) {
      const i = (input ?? {}) as Record<string, unknown>;
      const role = typeof i.role === 'string' ? i.role : undefined;
      const base: SubagentConfig | undefined = role && roster ? roster[role] : undefined;
      if (role && !base) {
        return {
          error: `unknown role "${role}". roster has: ${roster ? Object.keys(roster).join(', ') : '(empty)'}`,
        };
      }
      const cfg: SubagentConfig = {
        ...(base ?? { name: (i.name as string) ?? 'subagent' }),
      };
      if (typeof i.name === 'string') cfg.name = i.name;
      if (typeof i.provider === 'string') cfg.provider = i.provider;
      if (typeof i.model === 'string') cfg.model = i.model;
      if (typeof i.systemPromptOverride === 'string')
        cfg.systemPromptOverride = i.systemPromptOverride;
      if (typeof i.maxIterations === 'number') cfg.maxIterations = i.maxIterations;
      if (typeof i.maxToolCalls === 'number') cfg.maxToolCalls = i.maxToolCalls;
      if (typeof i.maxCostUsd === 'number') cfg.maxCostUsd = i.maxCostUsd;
      try {
        const subagentId = await director.spawn(cfg);
        return { subagentId, provider: cfg.provider, model: cfg.model, name: cfg.name };
      } catch (err) {
        // Surface DirectorBudgetError (and any other spawn failure) as a
        // structured `{ error, kind }` payload so the leader model can
        // read the cap and replan — throwing would tear down the whole
        // tool call and give the model no signal to recover from.
        if (err instanceof DirectorBudgetError) {
          return { error: err.message, kind: err.kind, limit: err.limit, observed: err.observed };
        }
        return { error: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}

function makeAssignTool(director: Director): Tool {
  const inputSchema: JSONSchema = {
    type: 'object',
    properties: {
      subagentId: { type: 'string', description: 'Target subagent id. Required.' },
      description: {
        type: 'string',
        description: 'The task in natural language — what you want this subagent to do.',
      },
      maxToolCalls: { type: 'number', description: 'Optional per-task tool-call budget override.' },
      timeoutMs: { type: 'number', description: 'Optional per-task timeout in ms.' },
    },
    required: ['subagentId', 'description'],
  };
  return {
    name: 'assign_task',
    description:
      'Hand a task to a previously spawned subagent. Returns the task id — pass it to `await_tasks` to block on completion.',
    permission: 'auto',
    mutating: false,
    inputSchema,
    async execute(input: unknown) {
      const i = input as {
        subagentId: string;
        description: string;
        maxToolCalls?: number;
        timeoutMs?: number;
      };
      const task: TaskSpec = {
        id: randomUUID(),
        description: i.description,
        subagentId: i.subagentId,
        maxToolCalls: i.maxToolCalls,
        timeoutMs: i.timeoutMs,
      };
      const taskId = await director.assign(task);
      return { taskId, subagentId: i.subagentId };
    },
  };
}

function makeAwaitTasksTool(director: Director): Tool {
  const inputSchema: JSONSchema = {
    type: 'object',
    properties: {
      taskIds: {
        type: 'array',
        items: { type: 'string' },
        description:
          'One or more task ids returned by `assign_task`. The call blocks until every id resolves.',
      },
    },
    required: ['taskIds'],
  };
  return {
    name: 'await_tasks',
    description:
      'Block until every named task completes. Returns the array of TaskResult — use this to gather subagent output before deciding the next step.',
    permission: 'auto',
    mutating: false,
    inputSchema,
    async execute(input: unknown) {
      const i = input as { taskIds: string[] };
      const results = await director.awaitTasks(i.taskIds);
      return { results };
    },
  };
}

function makeAskTool(director: Director): Tool {
  const inputSchema: JSONSchema = {
    type: 'object',
    properties: {
      subagentId: {
        type: 'string',
        description: 'Subagent to ask. Must be a previously spawned id.',
      },
      question: {
        type: 'string',
        description: 'The question or instruction. Sent as the bridge message payload.',
      },
      timeoutMs: { type: 'number', description: 'Optional timeout in ms (default 30s).' },
    },
    required: ['subagentId', 'question'],
  };
  return {
    name: 'ask_subagent',
    description:
      'Synchronously ask a subagent a question. Blocks until the subagent replies via the bridge (or the timeout fires). Use this when you need a one-shot answer without spawning a fresh task.',
    permission: 'auto',
    mutating: false,
    inputSchema,
    async execute(input: unknown) {
      const i = input as { subagentId: string; question: string; timeoutMs?: number };
      try {
        const answer = await director.ask(i.subagentId, { question: i.question }, i.timeoutMs);
        return { ok: true, answer };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}

function makeRollUpTool(director: Director): Tool {
  const inputSchema: JSONSchema = {
    type: 'object',
    properties: {
      taskIds: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Completed task ids to aggregate. Pass the ids returned by previous `assign_task` calls.',
      },
      style: {
        type: 'string',
        enum: ['markdown', 'json'],
        description:
          'Output flavor — markdown (default) for in-prompt summarization, json for structured downstream processing.',
      },
    },
    required: ['taskIds'],
  };
  return {
    name: 'roll_up',
    description:
      "Aggregate completed task results into a single formatted summary. Use this after `await_tasks` to fold subagent outputs back into the director's context before deciding the next step.",
    permission: 'auto',
    mutating: false,
    inputSchema,
    async execute(input: unknown) {
      const i = input as { taskIds: string[]; style?: 'markdown' | 'json' };
      const summary = director.rollUp(i.taskIds, i.style ?? 'markdown');
      return { summary, count: i.taskIds.length };
    },
  };
}

function makeTerminateTool(director: Director): Tool {
  const inputSchema: JSONSchema = {
    type: 'object',
    properties: {
      subagentId: { type: 'string', description: 'Subagent to abort.' },
    },
    required: ['subagentId'],
  };
  return {
    name: 'terminate_subagent',
    description:
      'Forcibly abort a subagent. Use sparingly — prefer waiting on the natural budget to expire. The current task (if any) ends with status "stopped".',
    permission: 'auto',
    mutating: true,
    inputSchema,
    async execute(input: unknown) {
      const i = input as { subagentId: string };
      await director.terminate(i.subagentId);
      return { ok: true };
    },
  };
}

function makeFleetStatusTool(director: Director): Tool {
  return {
    name: 'fleet_status',
    description:
      "Snapshot of the fleet — every subagent's current status, pending vs. completed task counts, and the running total iteration count. Cheap; call freely.",
    permission: 'auto',
    mutating: false,
    inputSchema: { type: 'object', properties: {}, required: [] },
    async execute() {
      return director.status();
    },
  };
}

function makeFleetUsageTool(director: Director): Tool {
  return {
    name: 'fleet_usage',
    description:
      'Token + cost breakdown across the fleet, per-subagent and totals. Use this to reason about which workers to assign costly tasks to or when to wrap up to stay within budget.',
    permission: 'auto',
    mutating: false,
    inputSchema: { type: 'object', properties: {}, required: [] },
    async execute() {
      return director.snapshot();
    },
  };
}
