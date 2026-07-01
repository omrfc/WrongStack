/**
 * Fleet spawn / assign / terminate / awaitTasks / remove for the Director.
 *
 * Owns the methods that hand work to the `MultiAgentCoordinator` and
 * tear it down: `spawn`, `assign`, `awaitTasks`, `terminate`,
 * `terminateAll`, `remove`. Extracted out of `director.ts` to keep
 * that file under review-able size.
 *
 * Public surface (called from `Director` methods):
 *   - `spawn`        — create a new subagent
 *   - `assign`       — hand a task to a (possibly new) subagent
 *   - `awaitTasks`   — block until a set of tasks resolve
 *   - `terminate`    — stop a single subagent
 *   - `terminateAll` — stop every subagent
 *   - `remove`       — drop a subagent from internal indexes
 */
import { InMemoryAgentBridge } from './agent-bridge.js';
import { assignNickname, nicknameKeyFromDisplay } from './subagent-nicknames.js';
import { resolveModelMatrix } from './model-matrix.js';
import {
  FleetSpawnBudgetError,
  FleetCostCapError,
  FleetContextOverflowError,
} from './director/director-errors.js';
import type { DirectorStateCheckpoint } from '../storage/director-state.js';
import type { SubagentConfig, TaskResult, TaskSpec } from '../types/multi-agent.js';
import type { FleetBus } from './fleet-bus.js';
import type { FleetManager } from './fleet-manager.js';
import type { FleetUsageAggregator } from './fleet-bus.js';
import type { ModelMatrixSource } from './director.js';
import type { DefaultMultiAgentCoordinator } from './multi-agent-coordinator.js';
import type { InMemoryBridgeTransport } from './in-memory-transport.js';

/**
 * Narrow interface the helpers in this file need from the Director.
 * Kept here (instead of importing the full Director class) to avoid a
 * circular import: director.ts re-exports the helpers.
 */
export interface DirectorFleetHost {
  // Identity
  readonly id: string;

  // Coordinator / transport
  readonly coordinator: DefaultMultiAgentCoordinator;
  readonly fleet: FleetBus;
  readonly transport: InMemoryBridgeTransport;
  readonly stateCheckpoint: DirectorStateCheckpoint | null;

  // Spawn budget + counters
  workCompleteFlag: boolean;
  spawnCount: number;
  readonly maxSpawns: number;
  readonly maxSpawnDepth: number;
  readonly spawnDepth: number;
  readonly maxFleetCostUsd: number;
  readonly maxLeaderContextLoad: number;
  leaderContextPressure: number;
  readonly modelMatrix?: ModelMatrixSource | undefined;

  // Aggregator
  readonly usage: FleetUsageAggregator;
  readonly fleetManager: FleetManager | undefined;

  // Per-subagent state
  readonly manifestEntries: Map<string, unknown>;
  readonly completed: Map<string, TaskResult>;
  readonly subagentBridges: Map<string, InMemoryAgentBridge>;
  readonly taskWaiters: Map<string, { promise: Promise<TaskResult>; resolve: (r: TaskResult) => void }>;
  readonly subagentMeta: Map<string, { provider?: string | undefined; model?: string | undefined }>;
  readonly taskDescriptions: Map<string, string>;
  readonly taskOwners: Map<string, string>;
  readonly priceLookups: Map<
    string,
    {
      input?: number | undefined;
      output?: number | undefined;
      cacheRead?: number | undefined;
      cacheWrite?: number | undefined;
    }
  >;

  // Nickname tracking
  readonly _usedNicknames: Set<string>;

  // Helpers exposed back to the helpers
  appendSessionEvent(event: unknown): Promise<void>;
  scheduleManifest(): void;
  resolveMaxContext(): number;
}

/**
 * Spawn a subagent. See `Director.spawn` for the full contract.
 */
export async function spawn(
  host: DirectorFleetHost,
  config: SubagentConfig,
  priceLookup?: {
    input?: number | undefined;
    output?: number | undefined;
    cacheRead?: number | undefined;
    cacheWrite?: number | undefined;
  },
): Promise<string> {
  // workComplete() signal: once the director decides the work is done,
  // refuse to spawn new subagents so the fleet winds down naturally.
  if (host.workCompleteFlag) {
    throw new FleetSpawnBudgetError(
      'max_spawns',
      host.maxSpawns,
      host.spawnCount + 1,
      'workComplete() has been called — director closed further spawning',
    );
  }
  // Per-task model matrix: when the caller didn't pin a model, resolve one
  // from the matrix by role (→ phase → `*`). Done here, before the spawned
  // event + manifest + coordinator handoff, so the fleet UI and the agent
  // itself all reflect the matched model. Explicit per-spawn models win.
  if (!config.model && host.modelMatrix) {
    const matrix = typeof host.modelMatrix === 'function' ? host.modelMatrix() : host.modelMatrix;
    const entry = resolveModelMatrix(matrix, config.role);
    if (entry?.model) {
      config.model = entry.model;
      if (entry.provider) config.provider = entry.provider;
      if (entry.modelRuntime) config.modelRuntime = entry.modelRuntime;
    }
  }
  // Enforce safety caps BEFORE touching the coordinator — a refused
  // spawn must not leak partial state into the manifest or fleet bus.
  // Delegate to FleetManager when available; use inline checks otherwise.
  if (host.fleetManager) {
    const rejection = host.fleetManager.canSpawn(config);
    if (rejection) {
      if (rejection.kind === 'max_spawn_depth')
        throw new FleetSpawnBudgetError('max_spawn_depth', rejection.limit, rejection.observed);
      if (rejection.kind === 'max_spawns')
        throw new FleetSpawnBudgetError('max_spawns', rejection.limit, rejection.observed);
      if (rejection.kind === 'max_cost_usd')
        throw new FleetCostCapError(rejection.limit, rejection.observed);
      if (rejection.kind === 'max_context_load')
        throw new FleetContextOverflowError(rejection.limit, rejection.observed);
    }
  } else {
    if (host.spawnDepth >= host.maxSpawnDepth) {
      throw new FleetSpawnBudgetError('max_spawn_depth', host.maxSpawnDepth, host.spawnDepth);
    }
    if (host.spawnCount >= host.maxSpawns) {
      throw new FleetSpawnBudgetError('max_spawns', host.maxSpawns, host.spawnCount + 1);
    }
    if (host.maxFleetCostUsd < Number.POSITIVE_INFINITY) {
      const totalCost = host.usage.snapshot().total?.cost ?? 0;
      if (totalCost >= host.maxFleetCostUsd) {
        throw new FleetCostCapError(host.maxFleetCostUsd, totalCost);
      }
    }
    // Context pressure check: reject spawn if leader context is too full.
    // maxLeaderContextLoad === 1.0 disables this check.
    if (host.maxLeaderContextLoad < 1.0) {
      const maxContext = host.resolveMaxContext();
      const threshold = maxContext * host.maxLeaderContextLoad;
      if (host.leaderContextPressure >= threshold) {
        throw new FleetContextOverflowError(threshold, host.leaderContextPressure);
      }
    }
  }
  // If the config came from the roster with the default "role-as-name" pattern,
  // OR the name is one of the synthetic defaults used by ad-hoc spawn paths,
  // upgrade to a memorable nickname before the coordinator sees it. This ensures
  // the manifest, fleet UI, and session logs all display human names like
  // "Einstein (Bug Hunter)" instead of "adhoc" or "general".
  const needsNickname =
    config.name === config.role ||
    !config.name ||
    config.name === 'subagent' ||
    config.name === 'adhoc';
  if (needsNickname) {
    const role = config.role ?? 'subagent';
    if (host.fleetManager) {
      // FleetManager owns the used-nicknames set — just assign the nickname.
      // recordSpawn is called after spawn regardless of needsNickname to ensure
      // the manifest is keyed by the real subagentId.
      host.fleetManager.assignNicknameAndRecord(config);
    } else {
      const { key, display } = assignNickname(role, host._usedNicknames);
      config.name = display;
      host._usedNicknames.add(key);
    }
  }
  const result = await host.coordinator.spawn(config);
  // Record with FleetManager when available; otherwise manage inline.
  if (host.fleetManager) {
    // Always record the spawn with the real subagentId so the manifest is keyed correctly.
    host.fleetManager.recordSpawn(result.subagentId, config, priceLookup);
  } else {
    host.spawnCount += 1;
    host.subagentMeta.set(result.subagentId, {
      provider: config.provider,
      model: config.model,
    });
    if (priceLookup && config.provider && config.model) {
      host.priceLookups.set(`${config.provider}/${config.model}`, priceLookup);
    }
  }
  // Auto-wire a bridge per spawn — same transport as the director, so
  // `director.ask(subagentId, …)` and the subagent's own `bridge.send()`
  // round-trip without the caller having to plumb anything. Runners
  // grab their bridge from `ctx.bridge` (already populated by the
  // coordinator from `subagent.context.parentBridge`).
  const subagentBridge = new InMemoryAgentBridge(
    { agentId: result.subagentId, coordinatorId: host.id },
    host.transport,
  );
  host.coordinator.setSubagentBridge(result.subagentId, subagentBridge);
  host.subagentBridges.set(result.subagentId, subagentBridge);
  // Emit subagent.spawned on the FleetBus so the TUI can track collab agents
  // (which bypass MultiAgentHost.spawn and go through director.spawn directly).
  host.fleet.emit({
    subagentId: result.subagentId,
    ts: Date.now(),
    type: 'subagent.spawned',
    payload: {
      subagentId: result.subagentId,
      taskId: '', // taskId will be set when assign() is called
      name: config.name,
      role: config.role,
      provider: config.provider,
      model: config.model,
    },
  });
  // Record manifest entry only when not using FleetManager (it manages its own).
  if (!host.fleetManager) {
    host.manifestEntries.set(result.subagentId, {
      subagentId: result.subagentId,
      name: config.name,
      role: config.role,
      provider: config.provider,
      model: config.model,
      taskIds: [],
    });
    const spawnedAt = new Date().toISOString();
    host.stateCheckpoint?.recordSpawn(
      {
        id: result.subagentId,
        name: config.name,
        role: config.role,
        provider: config.provider,
        model: config.model,
        spawnedAt,
      },
      host.spawnCount,
    );
    void host.appendSessionEvent({
      type: 'agent_spawned',
      ts: spawnedAt,
      agentId: result.subagentId,
      role: config.role ?? config.name,
    });
    host.scheduleManifest();
  }
  return result.subagentId;
}

/**
 * Hand a task to the coordinator. Returns the assigned task id so
 * callers can wait on it via `awaitTasks([id])`. The coordinator's
 * concurrency limit applies — the task may queue before running.
 *
 * `appendTaskDescription` and `recordTaskOwner` are injected because
 * they touch Director's `taskDescriptions` / `taskOwners` Maps which
 * are out of scope for this file's surface.
 */
export async function assign(
  host: DirectorFleetHost,
  task: TaskSpec,
  taskId: string,
  appendTaskDescription: (taskId: string, description: string | undefined) => void,
  recordTaskOwner: (taskId: string, subagentId: string) => void,
): Promise<string> {
  const taskWithId: TaskSpec = task.id ? task : { ...task, id: taskId };
  // When workComplete() has been called, drain the pending queue as aborted
  // rather than dispatching new work. The director has decided the goal is
  // satisfied — queued tasks never get a chance to run, so synthesize their
  // completion now so any caller awaiting them unblocks immediately.
  if (host.workCompleteFlag) {
    const synthetic: TaskResult = {
      subagentId: taskWithId.subagentId ?? 'unassigned',
      taskId: taskWithId.id,
      status: 'stopped',
      error: {
        kind: 'aborted_by_parent',
        message: 'Director called workComplete() — no further tasks will run',
        retryable: false,
      },
      iterations: 0,
      toolCalls: 0,
      durationMs: 0,
    };
    host.completed.set(taskWithId.id, synthetic);
    const waiter = host.taskWaiters.get(taskWithId.id);
    if (waiter) {
      waiter.resolve(synthetic);
      host.taskWaiters.delete(taskWithId.id);
    }
    return taskWithId.id;
  }
  if (task.subagentId) {
    const entry = host.manifestEntries.get(task.subagentId);
    if (entry) (entry as { taskIds: string[] }).taskIds.push(taskWithId.id);
  }
  await host.coordinator.assign(taskWithId);
  // Snapshot task metadata for completion-event titles + state checkpoint
  // bookkeeping. Done AFTER coordinator.assign() so we don't checkpoint a
  // task the coordinator rejected.
  appendTaskDescription(taskWithId.id, taskWithId.description);
  if (taskWithId.subagentId) recordTaskOwner(taskWithId.id, taskWithId.subagentId);
  const assignedAt = new Date().toISOString();
  host.stateCheckpoint?.recordTaskAssigned({
    taskId: taskWithId.id,
    subagentId: taskWithId.subagentId,
    description: taskWithId.description,
    status: 'running',
    assignedAt,
  });
  void host.appendSessionEvent({
    type: 'task_created',
    ts: assignedAt,
    taskId: taskWithId.id,
    title: taskWithId.description,
  });
  host.scheduleManifest();
  return taskWithId.id;
}

/** Await a set of tasks by id, preserving input order. */
export function awaitTasks(
  host: DirectorFleetHost,
  taskIds: string[],
): Promise<TaskResult[]> {
  return Promise.all(
    taskIds.map((id) => {
      const cached = host.completed.get(id);
      if (cached) return cached;
      const existing = host.taskWaiters.get(id);
      if (existing) return existing.promise;
      let resolveFn!: (r: TaskResult) => void;
      const promise = new Promise<TaskResult>((res) => {
        resolveFn = res;
      });
      host.taskWaiters.set(id, { promise, resolve: resolveFn });
      return promise;
    }),
  );
}

/** Stop a single subagent by id. */
export function terminate(host: DirectorFleetHost, subagentId: string): Promise<void> {
  return host.coordinator.stop(subagentId);
}

/** Stop every subagent managed by the coordinator. */
export function terminateAll(host: DirectorFleetHost): Promise<void> {
  return host.coordinator.stopAll();
}

/**
 * Drop a subagent from the director's local indexes after the coordinator
 * has already torn it down. Idempotent.
 */
export async function remove(
  host: DirectorFleetHost,
  subagentId: string,
): Promise<void> {
  await host.coordinator.remove(subagentId);

  // Clean up the bridge so it stops consuming resources.
  const bridge = host.subagentBridges.get(subagentId);
  if (bridge) {
    await bridge.stop();
    host.subagentBridges.delete(subagentId);
  }

  // Clean up the aggregator so terminated subagent data doesn't accumulate.
  host.usage.removeSubagent(subagentId);

  // Delegate nickname cleanup to FleetManager when available; otherwise handle
  // it directly here. This frees the slot so the same name can be reused.
  if (host.fleetManager) {
    host.fleetManager.removeSubagent(subagentId);
  } else {
    const entry = host.manifestEntries.get(subagentId) as { name?: string } | undefined;
    if (entry?.name) {
      const nicknameKey = nicknameKeyFromDisplay(entry.name);
      if (nicknameKey) host._usedNicknames.delete(nicknameKey);
    }
  }

  // Remove all local state entries for this subagent.
  host.manifestEntries.delete(subagentId);
  host.taskOwners.delete(subagentId);
  host.taskDescriptions.delete(subagentId);
}
