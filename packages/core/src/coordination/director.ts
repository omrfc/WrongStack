import { randomUUID } from 'node:crypto';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { atomicWrite } from '../utils/atomic-write.js';
import { DirectorStateCheckpoint, type DirectorStateSnapshot } from '../storage/director-state.js';
import type { BridgeMessage } from '../types/agent-bridge.js';
import type {
  CoordinatorStatus,
  MultiAgentConfig,
  SubagentConfig,
  SubagentRunner,
  TaskResult,
  TaskSpec,
} from '../types/multi-agent.js';
import type { SessionWriter } from '../types/session.js';
import type { JSONSchema, Tool } from '../types/tool.js';
import { InMemoryAgentBridge } from './agent-bridge.js';
import type { ICoordinator } from './icoordinator.js';
import {
  DEFAULT_DIRECTOR_PREAMBLE,
  DEFAULT_SUBAGENT_BASELINE,
  composeDirectorPrompt,
  composeSubagentPrompt,
  rosterSummaryFromConfigs,
} from './director-prompts.js';
import { FleetBus, type FleetUsage, FleetUsageAggregator } from './fleet-bus.js';
import { FleetManager } from './fleet-manager.js';
import { assignNickname } from './subagent-nicknames.js';
import { InMemoryBridgeTransport } from './in-memory-transport.js';
import { DefaultMultiAgentCoordinator } from './multi-agent-coordinator.js';
import { makeAskTool, makeAssignTool, makeAwaitTasksTool, makeCollabDebugTool, makeFleetEmitTool, makeFleetHealthTool, makeFleetSessionTool, makeFleetStatusTool, makeFleetUsageTool, makeRollUpTool, makeSpawnTool, makeTerminateTool } from './director-tools.js';
import { CollabSession, type CollabSessionOptions, type CollabDebugReport } from './collab-debug.js';

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
   * process. The N+1-th spawn call rejects with a `FleetSpawnBudgetError`.
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
  /**
   * Absolute path to a director-state checkpoint file. When set, the
   * director writes an incremental snapshot of pending/running/completed
   * tasks + spawned subagents on every state mutation. Distinct from
   * `manifestPath`: the manifest is a final record written on shutdown,
   * the checkpoint is a live mirror useful for crash recovery and the
   * `wstack resume` "you had N tasks in flight" banner.
   */
  stateCheckpointPath?: string;
  /**
   * Session writer the director should forward task lifecycle events to
   * (`agent_spawned`, `task_created`, `task_completed`, `task_failed`).
   * When omitted these events stay in-memory only — useful for tests but
   * lossy in production. Production callers (the CLI) pass the same
   * writer the host Agent uses so all events land in a single JSONL.
   */
  sessionWriter?: SessionWriter;
  /**
   * Debounce window for periodic manifest writes triggered by spawn/
   * assign/complete events. Default: 2000ms. Pass 0 to disable periodic
   * writes (the manifest will then only be written on `shutdown()`).
   */
  manifestDebounceMs?: number;
  /**
   * Fleet-wide cost ceiling. When set, `spawn()` refuses any new subagent
   * that would push the fleet's total cost above this limit. The cap
   * is checked BEFORE the spawn is recorded — a refused spawn must not
   * leak partial state into the manifest or fleet bus. Let in-flight
   * tasks complete; refuse new spawns only. When omitted or Infinity,
   * no cost cap applies.
   *
   * Distinct from SubagentBudget.maxCostUsd (per-subagent spend) — this
   * field caps the *entire fleet* total.
   */
  directorBudget?: {
    /**
     * Maximum total USD the fleet may spend across all subagents.
     * Default: Infinity (no cap).
     */
    maxCostUsd?: number;
  };
  /**
   * Maximum auto-extensions per subagent per budget kind before the
   * director denies further extensions. A subagent hitting the same
   * soft limit repeatedly (e.g. 3× budget.threshold_reached for
   * tool_calls) is likely looping on a prompt/config issue, not
   * making legitimate progress. Default: 2. Set to Infinity to
   * disable the cap (use with caution — a misconfigured subagent
   * could burn unlimited budget).
   */
  maxBudgetExtensions?: number;
  /**
   * Debounce window for state-checkpoint writes. Default: 250ms.
   * Bursts of spawn/assign/complete events collapse into one disk
   * hit. Higher values reduce write amplification on fast machines;
   * lower values improve crash-recovery fidelity (less state lost
   * on sudden process exit).
   */
  checkpointDebounceMs?: number;
  /**
   * Sessions root directory for per-subagent JSONL transcripts.
   * When set, the director can read subagent transcripts directly for
   * `fleet_session` tool — no bridge round-trip needed. Path convention:
   * `<sessionsRoot>/<directorRunId>/<subagentId>.jsonl`.
   */
  sessionsRoot?: string;
  /**
   * Director run id — namespaced under `sessionsRoot` to locate per-subagent
   * JSONLs. Defaults to the director's own `id` when omitted.
   */
  directorRunId?: string;
  /**
   * Pre-built fleet manager. When provided the Director delegates all
   * fleet-level policy (spawn budgets, manifest assembly, checkpointing)
   * to this instance and takes ownership of the coordinator + bridge
   * layer only. This enables unit-testing fleet policy in isolation
   * and swapping implementations without changing the Director surface.
   *
   * When omitted the Director creates its own fleet infrastructure
   * (same behavior as before this field was added).
   */
  fleetManager?: FleetManager;
  /**
   * Optional LLM classifier for the smart dispatcher. When set, the
   * `spawn_subagent` tool can accept a free-form `description` field
   * and the director will automatically route to the best-matching
   * catalog agent using `dispatchAgent()`. When omitted, routing is
   * pure heuristic (no provider call) — sufficient for most tasks.
   *
   * Build from a `complete(prompt) => string` function using
   * `makeLLMClassifier(complete)` from the dispatcher module.
   */
  dispatchClassifier?: import('../coordination/dispatcher.js').DispatchClassifier;
  /**
   * Maximum context load (as a fraction of maxContext) the leader agent
   * is allowed to reach before a new spawn is rejected. Default: 0.85.
   * When the leader's context pressure exceeds this threshold, spawning
   * a new subagent is refused — the leader must compact first.
   * Only used when no `fleetManager` is provided (inline mode).
   * Set to 1.0 to disable this check.
   */
  maxLeaderContextLoad?: number;
  /**
   * Provider's max context window in tokens. Used with `maxLeaderContextLoad`
   * to compute the absolute token threshold. Default: 128_000.
   * Only used when no `fleetManager` is provided (inline mode).
   */
  maxContext?: number;
}

/**
 * Thrown by `Director.spawn()` when a configured spawn cap (`maxSpawns`,
 * `maxSpawnDepth`) is hit. Distinct error class so callers — including
 * the `spawn_subagent` tool surface — can recognize the budget case and
 * report it cleanly instead of treating it like an unexpected failure.
 */
export class FleetSpawnBudgetError extends Error {
  readonly kind: 'max_spawns' | 'max_spawn_depth';
  readonly limit: number;
  readonly observed: number;
  constructor(kind: 'max_spawns' | 'max_spawn_depth', limit: number, observed: number) {
    super(
      kind === 'max_spawns'
        ? `Director spawn budget exceeded: tried to spawn #${observed} but maxSpawns is ${limit}`
        : `Director spawn depth budget exceeded: this director is at depth ${observed} and maxSpawnDepth is ${limit}`,
    );
    this.name = 'FleetSpawnBudgetError';
    this.kind = kind;
    this.limit = limit;
    this.observed = observed;
  }
}

/**
 * Thrown by `Director.spawn()` when the fleet-wide cost cap is exceeded.
 * Distinct from `FleetSpawnBudgetError` (spawn count/depth) — this is a
 * dollar-denominated ceiling that tracks cumulative spend across all
 * subagents in the fleet.
 */
export class FleetCostCapError extends Error {
  readonly kind: 'max_cost_usd';
  readonly limit: number;
  readonly observed: number;
  constructor(limit: number, observed: number) {
    super(
      `Director cost cap exceeded: total fleet spend ${observed.toFixed(4)} exceeds maxCostUsd ${limit.toFixed(4)}`,
    );
    this.name = 'FleetCostCapError';
    this.kind = 'max_cost_usd';
    this.limit = limit;
    this.observed = observed;
  }
}

/**
 * Thrown by `Director.spawn()` when the leader agent's context pressure
 * exceeds the configured threshold. The leader must compact before a new
 * subagent can be spawned — the context window is too full to safely
 * orchestrate additional agents.
 */
export class FleetContextOverflowError extends Error {
  readonly kind: 'max_context_load';
  readonly limit: number;
  readonly observed: number;
  constructor(limit: number, observed: number) {
    super(
      `Leader context overflow: leader has ${observed} tokens in flight (limit: ${limit}). Compact the leader context before spawning more subagents.`,
    );
    this.name = 'FleetContextOverflowError';
    this.kind = 'max_context_load';
    this.limit = limit;
    this.observed = observed;
  }
}

export class Director implements ICoordinator {
  /** Alias for the ICoordinator contract. `id` is retained for backward compatibility. */
  get coordinatorId(): string { return this.id; }
  readonly id: string;
  /**
   * The fleet event bus. Backed by `fleetManager?.fleet` when a FleetManager
   * is injected; otherwise own FleetBus instance (preserves existing behavior).
   */
  readonly fleet: FleetBus;
  /**
   * Usage rollup. Backed by `fleetManager?.usage` when a FleetManager is
   * injected; otherwise own FleetUsageAggregator.
   */
  readonly usage: FleetUsageAggregator;

  /**
   * Update the leader agent's current context pressure (full request tokens:
   * messages + systemPrompt + toolDefs). The director checks this before every
   * spawn — if the pressure exceeds `maxLeaderContextLoad * maxContext`,
   * spawning is refused with a `FleetContextOverflowError`.
   *
   * Call this after each leader agent iteration to keep the pressure current.
   * The compactor's `CompactReport.fullRequestTokensAfter` is a natural source.
   */
  setLeaderContextPressure(tokens: number): void {
    this.leaderContextPressure = tokens;
    // Mirror to FleetManager when available so the check is centralized.
    this.fleetManager?.setLeaderContextPressure(tokens);
  }

  /**
   * Read the leader agent's current context pressure.
   */
  getLeaderContextPressure(): number {
    return this.leaderContextPressure;
  }
  /**
   * Optional fleet-level policy container. When provided the Director
   * delegates spawn budgeting, manifest entries, and checkpointing to it
   * instead of managing those internally. All other behavior is unchanged.
   */
  readonly fleetManager: FleetManager | undefined;
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
  /** Tracks assigned nicknames so the same name is never reused in one fleet. */
  private readonly _usedNicknames = new Set<string>();
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
  /** Optional checkpoint mirror — writes the live task graph + roster to disk. */
  private readonly stateCheckpoint: DirectorStateCheckpoint | null;
  /** Optional session writer for emitting task_* / agent_* lifecycle events. */
  private readonly sessionWriter: SessionWriter | null;
  /** Debounce timer for periodic manifest writes. */
  private manifestTimer: NodeJS.Timeout | null = null;
  private readonly manifestDebounceMs: number;
  /** Fleet-wide cost cap (entire fleet total, distinct from SubagentBudget limits). Infinity means no cap. */
  private readonly maxFleetCostUsd: number;
  /** Max auto-extensions per subagent per budget kind before denying. */
  private readonly maxBudgetExtensions: number;
  /** Sessions root for direct subagent JSONL reads (fleet_session tool). */
  private readonly sessionsRoot?: string;
  /** Director run id for JSONL path resolution. */
  private readonly directorRunId: string;
  /** Resolves task descriptions back from `assign()` so completion events
   *  can also carry a human-readable title. */
  private readonly taskDescriptions = new Map<string, string>();
  /** Snapshot of which subagent owns each task — drives state-checkpoint
   *  status updates without re-walking the manifest. */
  private readonly taskOwners = new Map<string, string>();
  /** Cumulative auto-extension grants per subagent (all budget kinds). Lets
   *  /fleet render "⚡ extended ×N" without replaying the event stream. */
  private readonly extendTotals = new Map<string, number>();
  /**
   * Handle to the coordinator-side `task.completed` listener so we can
   * unsubscribe in `shutdown()`. Without this, repeated Director
   * construction (e.g. tests, hot reloads) accumulates listeners on a
   * cached coordinator and slowly drifts the EventEmitter past its
   * default cap.
   */
  private taskCompletedListener: ((payload: { task: TaskSpec; result: TaskResult }) => void) | null = null;
  /** Optional LLM classifier for smart dispatch. Passed from options. */
  readonly dispatchClassifier?: import('../coordination/dispatcher.js').DispatchClassifier;
  /** Leader agent's current context pressure (full request tokens). */
  private leaderContextPressure = 0;
  /** Maximum context load fraction before spawn is refused. */
  private readonly maxLeaderContextLoad: number;
  /** Provider's max context window in tokens. */
  private readonly maxContext: number;

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
    this.sessionWriter = opts.sessionWriter ?? null;
    this.manifestDebounceMs = opts.manifestDebounceMs ?? 2000;
    this.dispatchClassifier = opts.dispatchClassifier;
    this.maxFleetCostUsd = opts.directorBudget?.maxCostUsd ?? Number.POSITIVE_INFINITY;
    this.maxBudgetExtensions = opts.maxBudgetExtensions ?? 5;
    this.maxLeaderContextLoad = opts.maxLeaderContextLoad ?? 0.85;
    this.maxContext = opts.maxContext ?? 128_000;
    this.sessionsRoot = opts.sessionsRoot;
    this.directorRunId = opts.directorRunId ?? this.id;
    this.stateCheckpoint = opts.stateCheckpointPath
      ? new DirectorStateCheckpoint(opts.stateCheckpointPath, {
          directorRunId: this.id,
          maxSpawns: opts.maxSpawns,
          spawnDepth: this.spawnDepth,
          maxSpawnDepth: this.maxSpawnDepth,
          directorBudget: opts.directorBudget,
        }, opts.checkpointDebounceMs ?? 250)
      : null;
    this.fleetManager = opts.fleetManager;
    if (this.sharedScratchpadPath) {
      // Create the directory eagerly so subagents that try to write
      // there on first iteration don't trip on ENOENT. Fire-and-forget,
      // but surface failures via process.emitWarning — the downstream
      // ENOENT a subagent hits is opaque without this signal.
      void fsp
        .mkdir(this.sharedScratchpadPath, { recursive: true })
        .catch((err) =>
          this.logShutdownError('shared_scratchpad_mkdir', err),
        );
    }
    this.transport = new InMemoryBridgeTransport();
    this.bridge = new InMemoryAgentBridge(
      { agentId: this.id, coordinatorId: this.id },
      this.transport,
    );
    // Delegate to FleetManager when injected; otherwise create own instances
    // (preserves existing behavior for callers that don't pass fleetManager).
    if (this.fleetManager) {
      this.fleet = this.fleetManager.fleet;
      this.usage = this.fleetManager.usage;
    } else {
      this.fleet = new FleetBus();
      this.usage = new FleetUsageAggregator(
        this.fleet,
        (id, provider, model) => {
          if (provider && model) return this.priceLookups.get(`${provider}/${model}`);
          return undefined;
        },
        (id) => this.subagentMeta.get(id),
      );
    }
    this.coordinator = new DefaultMultiAgentCoordinator(
      { ...opts.config, coordinatorId: this.id },
      { runner: opts.runner },
    );
    this.coordinator.setFleetBus(this.fleet);
    this.fleetManager?.setCoordinator(this.coordinator);
    // Mirror coordinator completion events into the waiter table. This
    // lets `awaitTasks([...])` resolve on the *next* completion event
    // without polling — and the `completed` cache covers the case where
    // a caller asks after the fact.
    //
    // The listener is captured in a field (`taskCompletedListener`) so
    // `shutdown()` can `coordinator.off(...)` it cleanly — otherwise
    // repeated Director construction against a cached coordinator
    // (tests, hot reloads) leaks listeners and eventually trips
    // EventEmitter's max-listener warning.
    this.taskCompletedListener = (payload: { task: TaskSpec; result: TaskResult }) => {
      const r = payload.result;
      this.completed.set(r.taskId, r);
      const waiter = this.taskWaiters.get(r.taskId);
      if (waiter) {
        waiter.resolve(r);
        this.taskWaiters.delete(r.taskId);
      }
      // Mirror into the on-disk checkpoint + session event stream so a
      // crashed director leaves a complete picture of which tasks landed.
      const title = this.taskDescriptions.get(r.taskId) ?? payload.task.description ?? r.taskId;
      const failed = r.status !== 'success';
      // Disk-side state-checkpoint and session JSONL both store `error`
      // as a string for historical reasons. The structured SubagentError
      // envelope carries `kind`, `message`, `retryable`, etc. — flatten
      // to a `kind: message` string here so old readers stay valid and
      // grep-friendly. The full envelope is still available live via
      // the EventBus / TaskResult to in-process consumers.
      const errorString = r.error
        ? `${r.error.kind}: ${r.error.message}`
        : undefined;
      this.stateCheckpoint?.recordTaskStatus(r.taskId, {
        status: failed ? (r.status as 'failed' | 'timeout' | 'stopped') : 'completed',
        completedAt: new Date().toISOString(),
        iterations: r.iterations,
        toolCalls: r.toolCalls,
        durationMs: r.durationMs,
        error: errorString,
      });
      this.stateCheckpoint?.setUsage(this.usage.snapshot());
      void this.appendSessionEvent(
        failed
          ? {
              type: 'task_failed',
              ts: new Date().toISOString(),
              taskId: r.taskId,
              title,
              error: errorString ?? r.status,
            }
          : {
              type: 'task_completed',
              ts: new Date().toISOString(),
              taskId: r.taskId,
              title,
            },
      );
      // Flush immediately on task completion — the result should be
      // visible in the manifest without waiting for the debounce window.
      // Use flushManifest() so any pending debounce timer is also cleared.
      if (this.fleetManager) {
        this.fleetManager.flushManifest();
      } else {
        this.scheduleManifest();
      }
    };
    this.coordinator.on('task.completed', this.taskCompletedListener);

    // Wire budget.threshold_reached events from the FleetBus into the
    // coordinator's task completion path. When a subagent hits a soft
    // limit, the runner emits this event; we intercept it here, resolve
    // the decision promise (via extend/deny), and let the normal
    // task.completed flow handle the rest.
    //
    // Extension guard: a subagent that hits the same soft limit
    // `maxBudgetExtensions` times without completing its task is looping
    // on a prompt/config issue, not running out of budget legitimately.
    // After the configured number of extends we deny and let the task
    // fail — the host agent should then split the work or narrow the
    // scope. We track this per subagent+kind combination.
    const extendCounts = new Map<string, number>();
    // Per-subagent progress heartbeat: counts tool executions so the timeout
    // kind can extend indefinitely WHILE the agent is doing work, yet still
    // deny a wedged agent that produces no new tool calls between grants.
    // Wall-clock time always advances, so timeout alone is never a reliable
    // "stuck" signal — tool activity is.
    const progressBySubagent = new Map<string, number>();
    const lastTimeoutProgress = new Map<string, number>();
    this.fleet.filter('tool.executed', (e) => {
      progressBySubagent.set(e.subagentId, (progressBySubagent.get(e.subagentId) ?? 0) + 1);
    });
    this.fleet.filter('budget.threshold_reached', (e) => {
      const payload = e.payload as {
        kind: 'iterations' | 'tool_calls' | 'tokens' | 'cost' | 'timeout';
        used: number;
        limit: number;
        timeoutMs: number;
        extend: (extra: Record<string, unknown>) => void;
        deny: () => void;
      };
      // Timeout is governed by the heartbeat, not the extension cap. While the
      // subagent keeps executing tools it never dies on wall-clock time; once
      // it stops making progress between grants, it's genuinely stuck → deny.
      if (payload.kind === 'timeout') {
        const progress = progressBySubagent.get(e.subagentId) ?? 0;
        const lastProgress = lastTimeoutProgress.get(e.subagentId) ?? -1;
        if (progress <= lastProgress) {
          payload.deny();
          return;
        }
        lastTimeoutProgress.set(e.subagentId, progress);
        setImmediate(() => {
          // Generous extension with a 24 h hard ceiling so a runaway can't
          // extend forever even while spuriously emitting tool calls.
          const newLimit = Math.min(Math.ceil(payload.limit * 2), 24 * 60 * 60_000);
          this.recordExtension(e.subagentId, e.taskId, 'timeout', newLimit);
          payload.extend({ timeoutMs: newLimit });
        });
        return;
      }
      const guardKey = `${e.subagentId}:${payload.kind}`;
      const prior = extendCounts.get(guardKey) ?? 0;
      if (prior >= this.maxBudgetExtensions) {
        // Auto-extend cap hit — let the task fail so the host agent
        // can react rather than spinning forever.
        payload.deny();
        extendCounts.delete(guardKey);
        return;
      }
      // Fleet-wide cost ceiling also bounds per-subagent cost auto-extensions.
      // spawn() only checks maxFleetCostUsd when creating a NEW subagent; without
      // this, already-running subagents could each extend their per-agent cost
      // budget and collectively blow past a small fleet cap. Re-check here and
      // deny the extension once the aggregate fleet spend reaches the cap.
      if (payload.kind === 'cost' && this.maxFleetCostUsd < Number.POSITIVE_INFINITY) {
        const totalCost = this.usage.snapshot().total?.cost ?? 0;
        if (totalCost >= this.maxFleetCostUsd) {
          payload.deny();
          return;
        }
      }
      // Auto-extend: grant +50% ABOVE the current limit, up to a generous
      // absolute ceiling. The new limit is computed from `max(limit, used)`
      // so the patch always lands strictly above where the agent already is
      // — the old `min(used+100, 800)` / `min(limit*2, 1500)` caps could
      // resolve BELOW a large roster budget (8000 iters / 20000 tools),
      // making the "extension" a no-op reduction that just burned a slot
      // toward the deny cap. With +50% × maxBudgetExtensions the worst-case
      // growth stays bounded (~7.6× at the default 5), so the loop guard
      // still holds. Resolved on the next tick so other listeners can
      // override (e.g. a deny-listener for cost overrun).
      extendCounts.set(guardKey, prior + 1);
      setImmediate(() => {
        const extra: Record<string, unknown> = {};
        const base = Math.max(payload.limit, payload.used);
        const grow = (ceiling: number) => Math.min(Math.ceil(base * 1.5), ceiling);
        let newLimit = base;
        switch (payload.kind) {
          case 'iterations':
            newLimit = grow(50_000);
            extra.maxIterations = newLimit;
            break;
          case 'tool_calls':
            newLimit = grow(100_000);
            extra.maxToolCalls = newLimit;
            break;
          case 'tokens':
            newLimit = grow(5_000_000);
            extra.maxTokens = newLimit;
            break;
          case 'cost':
            newLimit = Math.min(base * 1.5, 100);
            extra.maxCostUsd = newLimit;
            break;
          // 'timeout' is handled earlier via the heartbeat path and returns
          // before reaching this switch.
        }
        this.recordExtension(e.subagentId, e.taskId, payload.kind, newLimit);
        payload.extend(extra);
      });
    });
  }

  /**
   * Record a granted budget extension and broadcast it on the FleetBus so
   * the host can re-emit `subagent.budget_extended` for live UI badges.
   * Called from both the timeout heartbeat path and the per-kind grant path.
   */
  private recordExtension(subagentId: string, taskId: string | undefined, kind: string, newLimit: number): void {
    const total = (this.extendTotals.get(subagentId) ?? 0) + 1;
    this.extendTotals.set(subagentId, total);
    this.fleet.emit({
      subagentId,
      taskId,
      ts: Date.now(),
      type: 'budget.extended',
      payload: { kind, newLimit, totalExtensions: total },
    });
  }

  /** Cumulative auto-extension count for one subagent (0 when never extended). */
  extensionsFor(subagentId: string): number {
    return this.extendTotals.get(subagentId) ?? 0;
  }

  /** Best-effort session-writer append. Swallows failures — the director
   *  must not break a fleet run because the session JSONL handle closed. */
  private async appendSessionEvent(event: Parameters<SessionWriter['append']>[0]): Promise<void> {
    if (!this.sessionWriter) return;
    try {
      await this.sessionWriter.append(event);
    } catch {
      // ignore
    }
  }

  /** Debounced manifest writer. A burst of spawn/assign/complete events
   *  collapses into one write. Set `manifestDebounceMs` to 0 to write
   *  synchronously (no debounce); set to negative to disable entirely. */
  private scheduleManifest(): void {
    if (!this.manifestPath) return;
    if (this.manifestDebounceMs === 0) {
      // 0 means instant flush — write synchronously, no timer.
      void this.writeManifest().catch((err) =>
        this.logShutdownError('manifest_write_debounced', err),
      );
      return;
    }
    if (this.manifestDebounceMs < 0) return;
    this.manifestTimer = setTimeout(() => {
      this.manifestTimer = null;
      void this.writeManifest().catch((err) =>
        this.logShutdownError('manifest_write_debounced', err),
      );
    }, this.manifestDebounceMs);
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
    // Delegate to FleetManager when available; use inline checks otherwise.
    if (this.fleetManager) {
      const rejection = this.fleetManager.canSpawn(config);
      if (rejection) {
        if (rejection.kind === 'max_spawn_depth') throw new FleetSpawnBudgetError('max_spawn_depth', rejection.limit, rejection.observed);
        if (rejection.kind === 'max_spawns') throw new FleetSpawnBudgetError('max_spawns', rejection.limit, rejection.observed);
        if (rejection.kind === 'max_cost_usd') throw new FleetCostCapError(rejection.limit, rejection.observed);
        if (rejection.kind === 'max_context_load') throw new FleetContextOverflowError(rejection.limit, rejection.observed);
      }
    } else {
      if (this.spawnDepth >= this.maxSpawnDepth) {
        throw new FleetSpawnBudgetError('max_spawn_depth', this.maxSpawnDepth, this.spawnDepth);
      }
      if (this.spawnCount >= this.maxSpawns) {
        throw new FleetSpawnBudgetError('max_spawns', this.maxSpawns, this.spawnCount + 1);
      }
      if (this.maxFleetCostUsd < Number.POSITIVE_INFINITY) {
        const totalCost = this.usage.snapshot().total?.cost ?? 0;
        if (totalCost >= this.maxFleetCostUsd) {
          throw new FleetCostCapError(this.maxFleetCostUsd, totalCost);
        }
      }
      // Context pressure check: reject spawn if leader context is too full.
      // maxLeaderContextLoad === 1.0 disables this check.
      if (this.maxLeaderContextLoad < 1.0) {
        const threshold = this.maxContext * this.maxLeaderContextLoad;
        if (this.leaderContextPressure >= threshold) {
          throw new FleetContextOverflowError(threshold, this.leaderContextPressure);
        }
      }
    }
    let result: { subagentId: string };
    // If the config came from the roster with the default "role-as-name" pattern,
    // upgrade to a memorable nickname before the coordinator sees it. This ensures
    // the manifest, fleet UI, and session logs all display human names like
    // "Einstein (Bug Hunter)" instead of "bug-hunter".
    const needsNickname = config.name === config.role || !config.name || config.name === 'subagent';
    if (needsNickname) {
      const role = config.role ?? 'subagent';
      if (this.fleetManager) {
        // FleetManager owns the used-nicknames set — ask it to assign + record atomically.
        // assignNicknameAndRecord writes the nickname into config.name before recording.
        this.fleetManager.assignNicknameAndRecord('', config, priceLookup);
      } else {
        config.name = assignNickname(role, this._usedNicknames);
        this._usedNicknames.add(config.name.split(' ')[0]!.toLowerCase().replace(/[^a-z0-9-]/g, '-'));
      }
    }
    result = await this.coordinator.spawn(config);
    // Record with FleetManager when available; otherwise manage inline.
    if (this.fleetManager) {
      // When needsNickname was true, assignNicknameAndRecord already recorded the spawn.
      // Otherwise we still need to record metadata here.
      if (!needsNickname) {
        this.fleetManager.recordSpawn(result.subagentId, config, priceLookup);
      }
    } else {
      this.spawnCount += 1;
      this.subagentMeta.set(result.subagentId, {
        provider: config.provider,
        model: config.model,
      });
      if (priceLookup && config.provider && config.model) {
        this.priceLookups.set(`${config.provider}/${config.model}`, priceLookup);
      }
    }
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
    // Record manifest entry only when not using FleetManager (it manages its own).
    if (!this.fleetManager) {
      this.manifestEntries.set(result.subagentId, {
        subagentId: result.subagentId,
        name: config.name,
        role: config.role,
        provider: config.provider,
        model: config.model,
        taskIds: [],
      });
      const spawnedAt = new Date().toISOString();
      this.stateCheckpoint?.recordSpawn(
        {
          id: result.subagentId,
          name: config.name,
          role: config.role,
          provider: config.provider,
          model: config.model,
          spawnedAt,
        },
        this.spawnCount,
      );
      void this.appendSessionEvent({
        type: 'agent_spawned',
        ts: spawnedAt,
        agentId: result.subagentId,
        role: config.role ?? config.name,
      });
      this.scheduleManifest();
    }
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
    await atomicWrite(this.manifestPath, JSON.stringify(manifest, null, 2), { mode: 0o600 });
    return this.manifestPath;
  }

  /**
   * Tear down the director: stop every subagent, close every bridge
   * endpoint, and (when configured) write the final manifest. Idempotent
   * — calling shutdown twice is a no-op on the second invocation.
   */
  async shutdown(): Promise<void> {
    if (this.manifestTimer) {
      clearTimeout(this.manifestTimer);
      this.manifestTimer = null;
    }
    // Detach the coordinator-side task.completed listener so a Director
    // that lives shorter than its coordinator (rare but possible in
    // tests + delegate auto-promotion) doesn't leak the closure on
    // the EventEmitter for the coordinator's remaining lifetime.
    if (this.taskCompletedListener) {
      this.coordinator.off('task.completed', this.taskCompletedListener);
      this.taskCompletedListener = null;
    }
    await this.coordinator.stopAll();
    for (const b of this.subagentBridges.values()) {
      await b.stop().catch((err) => this.logShutdownError('subagent_bridge_stop', err));
    }
    this.subagentBridges.clear();
    await this.bridge.stop().catch((err) => this.logShutdownError('director_bridge_stop', err));
    if (this.manifestPath)
      await this.writeManifest().catch((err) => this.logShutdownError('manifest_write', err));
    if (this.stateCheckpoint) {
      this.stateCheckpoint.setUsage(this.usage.snapshot());
      await this.stateCheckpoint
        .flush()
        .catch((err) => this.logShutdownError('state_checkpoint_flush', err));
      // Release the lock so a subsequent --resume can claim this checkpoint.
      // Without this, the next director run sees a stale lock and refuses.
      await this.stateCheckpoint
        .releaseLock()
        .catch((err) => this.logShutdownError('state_checkpoint_lock_release', err));
    }
  }

  /**
   * Funnel for shutdown-phase errors. We can't throw — `shutdown()` is
   * called from process-exit paths where an uncaught throw would lose
   * the manifest write that comes after. But we MUST NOT silently
   * swallow either — a persistent bridge-close failure would otherwise
   * mask a real bug. `process.emitWarning` is the right tier:
   * surfaces on stderr by default, lets the host plug a warning
   * listener for structured collection, and never affects exit code.
   */
  private logShutdownError(phase: string, err: unknown): void {
    const detail = err instanceof Error ? err.message : String(err);
    process.emitWarning(
      `Director shutdown phase "${phase}" failed: ${detail}`,
      'DirectorShutdownWarning',
    );
  }

  /**
   * Hand a task to the coordinator. Returns the assigned task id so
   * callers can wait on it via `awaitTasks([id])`. The coordinator's
   * concurrency limit applies — the task may queue before running.
   */
  async assign(task: TaskSpec): Promise<string> {
    const taskWithId: TaskSpec = task.id ? task : { ...task, id: randomUUID() };
    if (task.subagentId) {
      // Update manifest entry — delegate to FleetManager when available.
      if (this.fleetManager) {
        this.fleetManager.addTaskToSubagent(task.subagentId, taskWithId.id);
      } else {
        const entry = this.manifestEntries.get(task.subagentId);
        if (entry) entry.taskIds.push(taskWithId.id);
      }
    }
    await this.coordinator.assign(taskWithId);
    // Snapshot task metadata for completion-event titles + state checkpoint
    // bookkeeping. Done AFTER coordinator.assign() so we don't checkpoint a
    // task the coordinator rejected.
    this.taskDescriptions.set(taskWithId.id, taskWithId.description);
    if (taskWithId.subagentId) this.taskOwners.set(taskWithId.id, taskWithId.subagentId);
    const assignedAt = new Date().toISOString();
    this.stateCheckpoint?.recordTaskAssigned({
      taskId: taskWithId.id,
      subagentId: taskWithId.subagentId,
      description: taskWithId.description,
      status: 'running',
      assignedAt,
    });
    void this.appendSessionEvent({
      type: 'task_created',
      ts: assignedAt,
      taskId: taskWithId.id,
      title: taskWithId.description,
    });
    this.scheduleManifest();
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

  async remove(subagentId: string): Promise<void> {
    await this.coordinator.remove(subagentId);
  }

  status(): CoordinatorStatus {
    const base = this.coordinator.getStatus();
    // Enrich each row with its cumulative auto-extension count so /fleet can
    // render "⚡×N" without a separate lookup.
    return {
      ...base,
      subagents: base.subagents.map((s) => ({
        ...s,
        extensions: this.extendTotals.get(s.id) ?? 0,
      })),
    };
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

  /**
   * Inject a previously-saved checkpoint snapshot. Call this right after
   * constructing a Director during a `--resume` run so the in-memory state
   * (subagents, tasks, waiters) reflects the pre-crash reality instead of
   * starting from a blank slate. The director then resumes from there —
   * completing any in-flight tasks and ignoring tasks that already reached
   * a terminal state in the prior run.
   */
  setCheckpointState(snapshot: DirectorStateSnapshot): void {
    this.stateCheckpoint?.resume(snapshot);
  }

  /**
   * Read a subagent's JSONL transcript directly from disk (no bridge
   * round-trip needed). Returns the last assistant text, stop reason,
   * tool-use count, and line count — or null if the file is unavailable.
   * Requires `sessionsRoot` to be set on construction.
   */
  async readSession(subagentId: string, tail?: number): Promise<{
    lastAssistantText?: string;
    lastStopReason?: string;
    toolUsesObserved: number;
    events: number;
    path?: string;
  } | null> {
    if (!this.sessionsRoot) return null;
    const filePath = path.join(this.sessionsRoot, this.directorRunId, `${subagentId}.jsonl`);
    let raw: string;
    try {
      raw = await fsp.readFile(filePath, 'utf8');
    } catch {
      return null;
    }
    const lines = raw.split('\n').filter((l) => l.trim());
    const targetLines = tail ? lines.slice(-tail) : lines;
    let lastAssistantText: string | undefined;
    let lastStopReason: string | undefined;
    let toolUses = 0;
    for (const line of targetLines) {
      try {
        const ev = JSON.parse(line) as { type?: string; text?: string; stopReason?: string };
        if (ev.type === 'assistant' && typeof ev.text === 'string') {
          lastAssistantText = ev.text;
        } else if (ev.type === 'stop' && ev.stopReason) {
          lastStopReason = ev.stopReason;
        } else if (ev.type === 'tool_use') {
          toolUses++;
        }
      } catch {
        // skip malformed lines
      }
    }
    return {
      lastAssistantText,
      lastStopReason,
      toolUsesObserved: toolUses,
      events: targetLines.length,
      path: filePath,
    };
  }

  snapshot(): FleetUsage {
    return this.usage.snapshot();
  }

  /**
   * Look up provider/model metadata for a spawned subagent. Returns
   * undefined when the subagent id is unknown (not yet spawned, or
   * already torn down). Callers — notably the TUI fleet panel — use
   * this to render human-readable provider/model tags next to each
   * subagent row without reaching into private state.
   */
  getSubagentMeta(id: string): { provider?: string; model?: string; name?: string } | undefined {
    const usage = this.subagentMeta.get(id);
    const manifest = this.manifestEntries.get(id);
    if (!usage && !manifest) return undefined;
    return {
      provider: usage?.provider ?? manifest?.provider,
      model: usage?.model ?? manifest?.model,
      name: manifest?.name,
    };
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
    // Use stored roster as default — allows `director.tools()` to be
    // called without args when the roster was passed at construction.
    const effectiveRoster = roster ?? this.roster;
    const t: Tool[] = [
      makeSpawnTool(this, effectiveRoster),
      makeAssignTool(this),
      makeAwaitTasksTool(this),
      makeAskTool(this),
      makeRollUpTool(this),
      makeTerminateTool(this),
      makeFleetStatusTool(this),
      makeFleetUsageTool(this),
      makeFleetSessionTool(this),
      makeFleetHealthTool(this),
      makeCollabDebugTool(this),
      makeFleetEmitTool(this),
    ];
    return t;
  }

  /**
   * Attempt to acquire the checkpoint lock. Must be called before
   * resuming — if another director process is alive, this returns
   * false and the caller should not proceed with the resume.
   */
  async acquireCheckpointLock(): Promise<boolean> {
    return this.stateCheckpoint ? this.stateCheckpoint.acquireLock() : true;
  }

  /**
   * Start a collaborative debugging session: BugHunter, RefactorPlanner,
   * and Critic run in parallel on the same target files, with findings
   * flowing through the FleetBus (bug.found → refactor.plan →
   * critic.evaluation). Returns a structured CollabDebugReport when all
   * three agents complete or the session times out.
   */
  async spawnCollab(options: CollabSessionOptions): Promise<CollabDebugReport> {
    const session = new CollabSession(this, this.fleet, options);
    return session.start();
  }

  /**
   * Resume from a prior checkpoint snapshot (loaded via
   * `loadDirectorState()`). Re-attach to the fleet mid-flight so
   * subsequent spawn/assign calls update the checkpoint normally.
   */
  resumeFromCheckpoint(snapshot: DirectorStateSnapshot): void {
    this.stateCheckpoint?.resume(snapshot);
  }
}

