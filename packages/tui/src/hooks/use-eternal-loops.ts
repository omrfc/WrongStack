import { useCallback, useRef } from 'react';
import type { Action } from '../app-reducer.js';

/** Minimal contract the eternal/parallel loop drivers need from App. */
export interface UseEternalLoopsOptions {
  /** Reducer dispatch (used to set status + append error entries). */
  dispatch: React.Dispatch<Action>;
  /** Live autonomy mode getter — re-read every iteration so /autonomy stop,
   *  SIGINT, or /goal clear can flip the loop off mid-flight. */
  getAutonomy: (() => 'off' | 'suggest' | 'auto' | 'eternal' | 'eternal-parallel') | undefined;
  /** Mirrored autonomy state for the status bar. */
  autonomyLive: 'off' | 'suggest' | 'auto' | 'eternal' | 'eternal-parallel';
  /** Setter for the mirrored autonomy state. */
  setAutonomyLive: (mode: 'off' | 'suggest' | 'auto' | 'eternal' | 'eternal-parallel') => void;
  /** Resolver for the eternal engine instance. */
  getEternalEngine: (() => { runOneIteration(): Promise<boolean>; currentState: string } | null) | undefined;
  /** Resolver for the parallel-eternal engine instance. */
  getParallelEngine: (() => { runOneIteration(): Promise<boolean>; currentState: string } | null) | undefined;
}

/** Shape returned by the hook — the loop starters, with stable refs. */
export interface UseEternalLoopsResult {
  /** Idempotent starter for the eternal loop. */
  startEternalLoop: () => Promise<void>;
  /** Idempotent starter for the parallel-eternal loop. */
  startParallelLoop: () => Promise<void>;
  /** True when an eternal iteration is currently driving the agent. */
  isEternalRunning: () => boolean;
  /** True when a parallel iteration is currently driving the agent. */
  isParallelRunning: () => boolean;
}

const YIELD_MS = 200; // yield so /autonomy stop lands between iterations

/**
 * Owns the eternal-mode and parallel-eternal-mode driver loops.
 *
 * Each loop polls its engine's `runOneIteration()` until either:
 * - the live autonomy flag flips off (e.g. `/autonomy stop`)
 * - the engine reports `currentState === 'stopped'`
 *
 * Errors are surfaced as `kind: 'error'` history entries; status flips
 * `running`↔`idle` per iteration. The 200ms yield between iterations lets
 * slash commands submitted mid-loop (e.g. `/autonomy stop`) actually land.
 *
 * The hook is the single source of truth for the "is the loop currently
 * driving the agent?" boolean — App's status-bar / key handler can ask
 * `isEternalRunning()` / `isParallelRunning()` for it.
 */
export function useEternalLoops({
  dispatch,
  getAutonomy,
  autonomyLive,
  setAutonomyLive,
  getEternalEngine,
  getParallelEngine,
}: UseEternalLoopsOptions): UseEternalLoopsResult {
  const eternalLoopRunningRef = useRef(false);
  const parallelLoopRunningRef = useRef(false);

  /** Eternal-mode driver. Single sequential consumer of `agent.run` —
   *  no race with user submissions because user input is gated by
   *  `state.status` (a running iteration keeps status at 'running' until
   *  the agent.run inside the engine returns). */
  const runEternalLoop = useCallback(async (): Promise<void> => {
    const engine = getEternalEngine?.();
    if (!engine) return;
    if (eternalLoopRunningRef.current) return;
    eternalLoopRunningRef.current = true;
    try {
      while (true) {
        const liveMode = getAutonomy?.() ?? 'off';
        if (liveMode !== 'eternal') break;
        if (engine.currentState === 'stopped') break;
        dispatch({ type: 'status', status: 'running' });
        try {
          // Per-iteration entries land via subscribeEternalIteration —
          // we don't need to log here. Only surface *errors* the engine
          // catches but doesn't journal.
          await engine.runOneIteration();
        } catch (err) {
          dispatch({
            type: 'addEntry',
            entry: {
              kind: 'error',
              text: `[eternal] ${err instanceof Error ? err.message : String(err)}`,
            },
          });
        }
        dispatch({ type: 'status', status: 'idle' });
        await new Promise((r) => setTimeout(r, YIELD_MS));
      }
    } finally {
      eternalLoopRunningRef.current = false;
      // Sync the displayed autonomy state with reality.
      if (getAutonomy) {
        const finalMode = getAutonomy();
        if (finalMode !== autonomyLive) setAutonomyLive(finalMode);
      }
    }
  }, [getEternalEngine, getAutonomy, autonomyLive, setAutonomyLive, dispatch]);

  /** Parallel-eternal driver — fan-out loop for the ParallelEternalEngine. */
  const runParallelLoop = useCallback(async (): Promise<void> => {
    const engine = getParallelEngine?.();
    if (!engine) return;
    if (parallelLoopRunningRef.current) return;
    parallelLoopRunningRef.current = true;
    try {
      while (true) {
        const liveMode = getAutonomy?.() ?? 'off';
        if (liveMode !== 'eternal-parallel') break;
        if (engine.currentState === 'stopped') break;
        dispatch({ type: 'status', status: 'running' });
        try {
          await engine.runOneIteration();
        } catch (err) {
          dispatch({
            type: 'addEntry',
            entry: {
              kind: 'error',
              text: `[parallel] ${err instanceof Error ? err.message : String(err)}`,
            },
          });
        }
        dispatch({ type: 'status', status: 'idle' });
        await new Promise((r) => setTimeout(r, YIELD_MS));
      }
    } finally {
      parallelLoopRunningRef.current = false;
      if (getAutonomy) {
        const finalMode = getAutonomy();
        if (finalMode !== autonomyLive) setAutonomyLive(finalMode);
      }
    }
  }, [getParallelEngine, getAutonomy, autonomyLive, setAutonomyLive, dispatch]);

  return {
    startEternalLoop: runEternalLoop,
    startParallelLoop: runParallelLoop,
    isEternalRunning: () => eternalLoopRunningRef.current,
    isParallelRunning: () => parallelLoopRunningRef.current,
  };
}
