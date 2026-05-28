import type { FleetBus, FleetUsage } from './fleet-bus.js';
import type { SubagentConfig } from '../types/multi-agent.js';

/**
 * Interface for fleet-level lifecycle and policy. Covers:
 * - Spawn lifecycle hooks (canSpawn check, recordSpawn after-effects)
 * - Budget enforcement (fleet-wide cost cap, spawn count/depth caps)
 * - Fleet manifest assembly and writing
 * - Subagent metadata and usage tracking
 *
 * `FleetBus` is pure event fan-out and implements no policy.
 * `FleetManager` encapsulates all fleet-level policy decisions.
 * `Director` currently owns all of this — this interface lets us
 * extract it into a swappable component in Phase 5.
 */
export interface IFleetManager {
  /** The FleetBus this manager publishes lifecycle events to. */
  readonly fleetBus: FleetBus;

  /**
   * Snapshot of fleet-wide token usage and cost rollup.
   * Safe to call from a tool's execute() body.
   */
  snapshot(): FleetUsage;

  /**
   * Per-subagent metadata captured at spawn time (provider/model/name).
   * Returns undefined if the subagent is not known to this manager.
   */
  getSubagentMeta(id: string): { provider?: string; model?: string; name?: string } | undefined;

  /**
   * Called before a spawn is recorded. Returns a reason string if the
   * spawn should be rejected (budget cap, depth limit, cost cap, etc.),
   * or null to proceed. Director.spawn() calls this internally.
   */
  canSpawn(config: SubagentConfig): { kind: 'max_spawns' | 'max_spawn_depth' | 'max_cost_usd'; limit: number; observed: number } | null;

  /**
   * Called after a spawn succeeds. Records metadata for the usage
   * aggregator and manifest.
   *
   * @param priceLookup Per-token rate lookup for cost calculation.
   *   When omitted the cost column in usage snapshots stays at 0.
   */
  recordSpawn(subagentId: string, config: SubagentConfig, priceLookup?: Record<string, number>): void;

  /**
   * Write the fleet manifest to disk. Returns the path written
   * or null when no manifest path is configured.
   */
  writeManifest(): Promise<string | null>;

  /**
   * Bypass the debounce timer and write the manifest immediately.
   * Clears any pending debounce timer before writing.
   */
  flushManifest(): Promise<void>;

  /**
   * Aggregate fleet-wide status: pending tasks with descriptions and
   * live subagent snapshot from the coordinator. Used by
   * `MultiAgentHost.status()` to eliminate host-side state duplication.
   */
  getFleetStatus(): {
    pending: { taskId: string; description: string; subagentId: string }[];
    live: { subagentId: string; status: string; task?: string }[];
  };

  /**
   * Register a pending task with its description. Called by
   * `MultiAgentHost.spawn()` after `_spawnAndAssign()` returns so
   * the description is available in `status()` without host-side storage.
   */
  addPendingTask(taskId: string, subagentId: string, description: string): void;

  /**
   * Remove a pending task. Called when the task completes so the
   * pending list stays accurate.
   */
  removePendingTask(taskId: string): void;

  /**
   * Wire the coordinator so `getFleetStats()` can delegate to it.
   * Called by `Director` after constructing the coordinator so
   * FleetManager's stats reflect live subagent data.
   */
  setCoordinator(coordinator: { getStats(): { total: number; running: number; idle: number; stopped: number; inFlight: number; pending: number; completed: number } }): void;

  /**
   * Coordinator stats snapshot for the TUI and monitoring tools.
   * Returns actionable counts (total/running/idle/stopped/inFlight/
   * pending/completed) plus per-subagent status details.
   * Delegates to the coordinator when available; returns zeros
   * if the coordinator has not yet been set.
   */
  getFleetStats(): {
    total: number;
    running: number;
    idle: number;
    stopped: number;
    inFlight: number;
    pending: number;
    completed: number;
    subagentStatuses: { subagentId: string; taskId: string; status: string; assigned: boolean }[];
  };
}