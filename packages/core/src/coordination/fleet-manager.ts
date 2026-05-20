import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { SubagentConfig } from '../types/multi-agent.js';
import type { SessionWriter } from '../types/session.js';
import { DirectorStateCheckpoint } from '../storage/director-state.js';
import { FleetBus, FleetUsageAggregator } from './fleet-bus.js';
import type { FleetUsage } from './fleet-bus.js';
import type { IFleetManager } from './ifleet-manager.js';

/** Options for constructing a FleetManager. */
export interface FleetManagerOptions {
  manifestPath?: string;
  sessionsRoot?: string;
  directorRunId?: string;
  maxSpawns?: number;
  maxSpawnDepth?: number;
  spawnDepth?: number;
  stateCheckpointPath?: string;
  sessionWriter?: SessionWriter;
  manifestDebounceMs?: number;
  checkpointDebounceMs?: number;
  directorBudget?: { maxCostUsd?: number };
}

/**
 * Fleet-level policy container extracted from `Director`. Owns:
 * - FleetBus + FleetUsageAggregator
 * - Spawn caps and counters
 * - Manifest entries and debounced writing
 * - State checkpointing
 *
 * This lets the `Director` focus on orchestration (spawn/assign/await/ask)
 * while fleet-level decisions live in one place. The class implements
 * `IFleetManager` so it remains swappable in future.
 *
 * @example
 * ```typescript
 * const fm = new FleetManager({ manifestPath: '/tmp/fleet.json' });
 * const err = fm.canSpawn({ name: 'worker' });
 * if (!err) fm.recordSpawn('sub-1', { name: 'worker' });
 * await fm.writeManifest();
 * ```
 */
export class FleetManager implements IFleetManager {
  /** The fleet-wide event bus. */
  readonly fleet: FleetBus;
  /** Usage rollup across all subagents. */
  readonly usage: FleetUsageAggregator;

  private readonly manifestPath?: string;
  private readonly sessionsRoot?: string;
  private readonly directorRunId: string;
  /** Spawn cap (lifetime total). Infinity means unlimited. */
  readonly maxSpawns: number;
  /** Nesting cap. */
  readonly maxSpawnDepth: number;
  /** This director's depth in a director chain. Root = 0. */
  readonly spawnDepth: number;
  /** Live spawn counter. */
  private spawnCount = 0;
  private readonly stateCheckpoint: DirectorStateCheckpoint | null;
  private readonly sessionWriter: SessionWriter | null;
  private manifestTimer: NodeJS.Timeout | null = null;
  private readonly manifestDebounceMs: number;
  /** Fleet-wide cost cap. Infinity = no cap. Distinct from SubagentBudget limits,
   *  which track per-subagent spend — this field caps the entire fleet total. */
  private readonly maxFleetCostUsd: number;
  private readonly manifestEntries = new Map<
    string,
    { subagentId: string; name: string; role?: string; provider?: string; model?: string; taskIds: string[] }
  >();
  /** Pending tasks with their descriptions — populated by `addPendingTask`
   *  and cleared by `removePendingTask`. Replaces the host-side `pending`
   *  Map so task descriptions live in one place (FleetManager). */
  private readonly pendingTasks = new Map<string, { subagentId: string; description: string }>();
  private readonly subagentMeta = new Map<string, { provider?: string; model?: string }>();
  private readonly priceLookups = new Map<string, { input?: number; output?: number; cacheRead?: number; cacheWrite?: number }>();

  constructor(opts: FleetManagerOptions = {}) {
    this.manifestPath = opts.manifestPath;
    this.sessionsRoot = opts.sessionsRoot;
    this.directorRunId = opts.directorRunId ?? randomUUID();
    this.maxSpawns = opts.maxSpawns ?? Number.POSITIVE_INFINITY;
    this.maxSpawnDepth = opts.maxSpawnDepth ?? 2;
    this.spawnDepth = opts.spawnDepth ?? 0;
    this.sessionWriter = opts.sessionWriter ?? null;
    this.manifestDebounceMs = opts.manifestDebounceMs ?? 2000;
    this.maxFleetCostUsd = opts.directorBudget?.maxCostUsd ?? Number.POSITIVE_INFINITY;
    this.stateCheckpoint = opts.stateCheckpointPath
      ? new DirectorStateCheckpoint(
          opts.stateCheckpointPath,
          {
            directorRunId: this.directorRunId,
            maxSpawns: opts.maxSpawns,
            spawnDepth: this.spawnDepth,
            maxSpawnDepth: this.maxSpawnDepth,
            directorBudget: opts.directorBudget,
          },
          opts.checkpointDebounceMs ?? 250,
        )
      : null;

    this.fleet = new FleetBus();
    this.usage = new FleetUsageAggregator(
      this.fleet,
      (id) => this.priceLookups.get(id),
      (id) => this.subagentMeta.get(id),
    );
  }

  // -----------------------------------------------------------------------
  // IFleetManager surface
  // -----------------------------------------------------------------------

  get fleetBus(): FleetBus {
    return this.fleet;
  }

  snapshot(): FleetUsage {
    return this.usage.snapshot();
  }

  getSubagentMeta(id: string): { provider?: string; model?: string; name?: string } | undefined {
    return this.subagentMeta.get(id);
  }

  /**
   * Returns null if the spawn is allowed, or an object describing
   * which cap was exceeded. Does NOT throw — the caller decides
   * how to surface the rejection.
   */
  canSpawn(config: SubagentConfig): { kind: 'max_spawns' | 'max_spawn_depth' | 'max_cost_usd'; limit: number; observed: number } | null {
    if (this.spawnDepth >= this.maxSpawnDepth) {
      return { kind: 'max_spawn_depth', limit: this.maxSpawnDepth, observed: this.spawnDepth };
    }
    if (this.spawnCount >= this.maxSpawns) {
      return { kind: 'max_spawns', limit: this.maxSpawns, observed: this.spawnCount + 1 };
    }
    if (this.maxFleetCostUsd < Number.POSITIVE_INFINITY) {
      const totalCost = this.usage.snapshot().total?.cost ?? 0;
      if (totalCost >= this.maxFleetCostUsd) {
        return { kind: 'max_cost_usd', limit: this.maxFleetCostUsd, observed: totalCost };
      }
    }
    return null;
  }

  /**
   * Records a spawn: increments counter, stores metadata, updates state checkpoint,
   * and schedules a debounced manifest write. Call AFTER the coordinator
   * has successfully spawned the subagent.
   *
   * @param subagentId The subagent's id (from coordinator.spawn result)
   * @param config The SubagentConfig that was used
   * @param priceLookup Optional per-subagent pricing data
   */
  recordSpawn(
    subagentId: string,
    config: SubagentConfig,
    priceLookup?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number },
  ): void {
    this.spawnCount += 1;
    this.subagentMeta.set(subagentId, {
      provider: config.provider,
      model: config.model,
    });
    if (priceLookup) this.priceLookups.set(subagentId, priceLookup);
    this.manifestEntries.set(subagentId, {
      subagentId,
      name: config.name,
      role: config.role,
      provider: config.provider,
      model: config.model,
      taskIds: [],
    });
    // State checkpoint: persist the spawn even before any task is assigned
    this.stateCheckpoint?.recordSpawn({
      id: subagentId,
      name: config.name,
      role: config.role,
      provider: config.provider,
      model: config.model,
      spawnedAt: new Date().toISOString(),
    }, this.spawnCount);
    void this.appendSessionEvent({
      type: 'agent_spawned',
      ts: new Date().toISOString(),
      agentId: subagentId,
      role: config.role ?? config.name,
    });
    this.scheduleManifest();
  }

  async writeManifest(): Promise<string | null> {
    if (!this.manifestPath) return null;
    const manifest = {
      version: 1,
      directorRunId: this.directorRunId,
      generatedAt: new Date().toISOString(),
      children: Array.from(this.manifestEntries.values()).map((entry) => ({
        id: entry.subagentId,
        name: entry.name,
        role: entry.role,
        provider: entry.provider,
        model: entry.model,
        taskIds: entry.taskIds,
      })),
      usage: this.usage.snapshot(),
    };
    await fsp.mkdir(path.dirname(this.manifestPath), { recursive: true });
    await fsp.writeFile(this.manifestPath, JSON.stringify(manifest, null, 2), { mode: 0o600 });
    return this.manifestPath;
  }

  /**
   * Attach task ids to an already-spawned subagent. Called by
   * `Director.assign()` after the coordinator assigns a task.
   */
  addTaskToSubagent(subagentId: string, taskId: string): void {
    const entry = this.manifestEntries.get(subagentId);
    if (entry) entry.taskIds.push(taskId);
  }

  /**
   * Debounced manifest write. Call after any state mutation
   * (spawn, assign, complete) so a burst collapses into one write.
   */
  scheduleManifest(): void {
    if (!this.manifestPath || this.manifestDebounceMs <= 0) return;
    if (this.manifestTimer) return;
    this.manifestTimer = setTimeout(() => {
      this.manifestTimer = null;
      void this.writeManifest().catch(() => undefined);
    }, this.manifestDebounceMs);
  }

  /** Best-effort session event writer. Swallows failures. */
  private async appendSessionEvent(event: Parameters<SessionWriter['append']>[0]): Promise<void> {
    if (!this.sessionWriter) return;
    try {
      await this.sessionWriter.append(event);
    } catch {
      // ignore
    }
  }

  // -----------------------------------------------------------------------
  // Pending task management — eliminates host-side state duplication
  // -----------------------------------------------------------------------

  addPendingTask(taskId: string, subagentId: string, description: string): void {
    this.pendingTasks.set(taskId, { subagentId, description });
  }

  removePendingTask(taskId: string): void {
    this.pendingTasks.delete(taskId);
  }

  getFleetStatus(): {
    pending: { taskId: string; description: string; subagentId: string }[];
    live: { subagentId: string; status: string; task?: string }[];
  } {
    const pending = Array.from(this.pendingTasks.entries()).map(([taskId, v]) => ({
      taskId,
      description: v.description,
      subagentId: v.subagentId,
    }));
    // live is populated by MultiAgentHost from the coordinator — fleet
    // manager has no direct visibility into subagent status
    return { pending, live: [] };
  }
}