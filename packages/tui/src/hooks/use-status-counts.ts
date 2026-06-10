import { useMemo } from 'react';

/** Todo buckets exposed on the status bar. */
export interface TodoCounts {
  pending: number;
  inProgress: number;
  completed: number;
}

/** Fleet buckets exposed on the status bar. */
export interface FleetCounts {
  running: number;
  idle: number;
  pending: number;
  completed: number;
}

export interface UseStatusCountsOptions {
  /** Live todo list (typically < 20 items). Re-read on each render. */
  todos: ReadonlyArray<{ status: string }>;
  /** Live fleet map keyed by subagent id. */
  fleet: Readonly<Record<string, { status: string }>>;
  /** Tick that doubles as a poll for ctx-side state not in React state. */
  nowTick: number;
}

/**
 * Computes the per-status-bar count buckets (todo + fleet).
 *
 * - `todos`: derived from `agent.ctx.todos` (mutated by the `todo` tool —
 *   not React state, so we tick on `nowTick` to pick up external mutations).
 * - `fleetCounts`: derived from `state.fleet`, which the FleetBus event
 *   listeners already maintain. Re-bucketed into running / idle / completed
 *   for the status-bar chip. `pending` is reserved (always 0 here — fleet
 *   entries go from 'running' directly to a terminal state).
 */
export function useStatusCounts({
  todos: liveTodos,
  fleet,
  nowTick,
}: UseStatusCountsOptions): { todos: TodoCounts; fleetCounts: FleetCounts | undefined } {
  // biome-ignore lint/correctness/useExhaustiveDependencies: nowTick intentionally triggers re-render; ctx.todos is not React state
  const todos = useMemo<TodoCounts>(() => {
    const counts: TodoCounts = { pending: 0, inProgress: 0, completed: 0 };
    for (const t of liveTodos) {
      if (t.status === 'pending') counts.pending++;
      else if (t.status === 'in_progress') counts.inProgress++;
      else if (t.status === 'completed') counts.completed++;
    }
    return counts;
  }, [nowTick, liveTodos]);

  const fleetCounts = useMemo<FleetCounts | undefined>(() => {
    const entries = Object.values(fleet);
    if (entries.length === 0) return undefined;
    let running = 0;
    let idle = 0;
    let completed = 0;
    for (const e of entries) {
      if (e.status === 'running') running += 1;
      else if (e.status === 'idle') idle += 1;
      else completed += 1; // success/failed/timeout/stopped all count as "done"
    }
    return { running, idle, pending: 0, completed };
  }, [fleet]);

  return { todos, fleetCounts };
}
