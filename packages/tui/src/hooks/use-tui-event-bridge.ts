import type { EventBus } from '@wrongstack/core';
import { useEffect } from 'react';
import type { Action, State } from '../app-reducer.js';
import { useBrainEvents } from './use-brain-events.js';
import { useSubagentEvents } from './use-subagent-events.js';

type ClearHistoryDispatch = React.Dispatch<
  | { type: 'clearHistory' }
  | { type: 'resetContextChip' }
  | { type: 'streamReset' }
  | { type: 'toolStreamClear' }
>;

export interface UseTuiEventBridgeOptions {
  events: EventBus;
  dispatch: React.Dispatch<Action>;
  stateRef: React.MutableRefObject<State>;
  setActiveMaxContext: (value: number | undefined) => void;
  subscribeAutoPhase?:
    | ((handler: (event: string, payload: unknown) => void) => () => void)
    | undefined;
  onClearHistory?: ((dispatch: ClearHistoryDispatch) => void) | undefined;
}

/**
 * EventBus and host-event subscriptions that mutate TUI state.
 *
 * Keeping this bridge outside App preserves the reducer as the single state
 * writer while taking long-lived subscription wiring out of the render surface.
 */
export function useTuiEventBridge({
  events,
  dispatch,
  stateRef,
  setActiveMaxContext,
  subscribeAutoPhase,
  onClearHistory,
}: UseTuiEventBridgeOptions): void {
  useSubagentEvents(events, dispatch, setActiveMaxContext);
  useSessionEvents(events, dispatch, onClearHistory);
  useBrainEvents(events, dispatch);
  useAutoPhaseEvents(subscribeAutoPhase, dispatch, stateRef);
}

function useSessionEvents(
  events: EventBus,
  dispatch: React.Dispatch<Action>,
  onClearHistory?: ((dispatch: ClearHistoryDispatch) => void) | undefined,
): void {
  useEffect(() => {
    const offCheckpoint = events.on('checkpoint.written', (e) => {
      dispatch({
        type: 'checkpointReceived',
        cp: {
          promptIndex: e.promptIndex,
          promptPreview: e.promptPreview,
          ts: e.ts,
          fileCount: e.fileCount,
        },
      });
    });
    const offRewound = events.on('session.rewound', () => {
      dispatch({ type: 'sessionRewound', toPromptIndex: 0 });
      dispatch({ type: 'clearHistory' });
      dispatch({ type: 'resetContextChip' });
      onClearHistory?.(dispatch);
    });
    return () => {
      offCheckpoint();
      offRewound();
    };
  }, [events, dispatch, onClearHistory]);
}

function useAutoPhaseEvents(
  subscribeAutoPhase:
    | ((handler: (event: string, payload: unknown) => void) => () => void)
    | undefined,
  dispatch: React.Dispatch<Action>,
  stateRef: React.MutableRefObject<State>,
): void {
  useEffect(() => {
    if (!subscribeAutoPhase) return;

    const handler = (event: string, payload: unknown) => {
      switch (event) {
        case 'phase.started': {
          const p = payload as { phaseId: string; name: string };
          dispatch({
            type: 'autoPhasePhaseUpdate',
            phaseId: p.phaseId,
            name: p.name,
            status: 'running',
            completedTasks: 0,
            totalTasks: 0,
            startedAt: Date.now(),
          });
          break;
        }
        case 'phase.completed': {
          const p = payload as { phaseId: string; name: string };
          dispatch({
            type: 'autoPhasePhaseUpdate',
            phaseId: p.phaseId,
            name: p.name,
            status: 'completed',
            completedTasks: 0,
            totalTasks: 0,
          });
          break;
        }
        case 'phase.failed': {
          const p = payload as { phaseId: string; name: string };
          dispatch({
            type: 'autoPhasePhaseUpdate',
            phaseId: p.phaseId,
            name: p.name,
            status: 'failed',
            completedTasks: 0,
            totalTasks: 0,
          });
          break;
        }
        case 'phase.statusChange': {
          const p = payload as { phaseId: string; name: string; to: string };
          const status = p.to === 'running' ? 'running' : p.to;
          dispatch({
            type: 'autoPhasePhaseUpdate',
            phaseId: p.phaseId,
            name: p.name,
            status,
            completedTasks: 0,
            totalTasks: 0,
          });
          break;
        }
        case 'phase.taskCompleted': {
          const p = payload as { phaseId: string };
          const existing = stateRef.current.autoPhase?.phases[p.phaseId];
          if (existing) {
            dispatch({
              type: 'autoPhasePhaseUpdate',
              phaseId: p.phaseId,
              name: existing.name,
              status: existing.status,
              completedTasks: existing.completedTasks + 1,
              totalTasks: existing.totalTasks,
            });
          }
          break;
        }
        case 'autonomous.tick': {
          const p = payload as {
            activePhases: Array<{ id: string }>;
          };
          dispatch({ type: 'autoPhaseRunningPhases', phaseIds: p.activePhases.map((ph) => ph.id) });
          const autoPhase = stateRef.current.autoPhase;
          if (autoPhase) {
            const firstPhase = autoPhase.phases[Object.keys(autoPhase.phases)[0] ?? ''];
            const elapsed =
              autoPhase.elapsedMs > 0
                ? autoPhase.elapsedMs + 1000
                : Date.now() - (firstPhase?.startedAt ?? Date.now());
            dispatch({ type: 'autoPhaseElapsed', ms: elapsed });
          }
          break;
        }
        case 'graph.completed':
        case 'graph.failed': {
          dispatch({ type: 'autoPhaseReset' });
          break;
        }
        case 'worktree.allocated': {
          const p = payload as {
            handleId: string;
            ownerLabel: string;
            branch: string;
            baseBranch: string;
          };
          dispatch({
            type: 'worktreeUpsert',
            handleId: p.handleId,
            baseBranch: p.baseBranch,
            row: {
              branch: p.branch,
              ownerLabel: p.ownerLabel,
              baseBranch: p.baseBranch,
              status: 'active',
              allocatedAt: Date.now(),
            },
          });
          break;
        }
        case 'worktree.committed': {
          const p = payload as {
            handleId: string;
            insertions: number;
            deletions: number;
            files: number;
          };
          dispatch({
            type: 'worktreeUpsert',
            handleId: p.handleId,
            row: {
              insertions: p.insertions,
              deletions: p.deletions,
              files: p.files,
              status: 'committing',
            },
          });
          break;
        }
        case 'worktree.merged': {
          const p = payload as { handleId: string };
          dispatch({ type: 'worktreeUpsert', handleId: p.handleId, row: { status: 'merged' } });
          break;
        }
        case 'worktree.conflict': {
          const p = payload as { handleId: string; conflictFiles: string[] };
          dispatch({
            type: 'worktreeUpsert',
            handleId: p.handleId,
            row: { status: 'needs-review', conflictFiles: p.conflictFiles },
          });
          break;
        }
        case 'worktree.failed': {
          const p = payload as { handleId: string };
          dispatch({ type: 'worktreeUpsert', handleId: p.handleId, row: { status: 'failed' } });
          break;
        }
        case 'worktree.released': {
          const p = payload as { handleId: string; kept: boolean };
          if (!p.kept) dispatch({ type: 'worktreeRemove', handleId: p.handleId });
          break;
        }
        case 'countdown.tick': {
          dispatch({ type: 'countdownTick', remainingSeconds: (payload as { remaining: number }).remaining });
          break;
        }
      }
    };

    return subscribeAutoPhase(handler);
  }, [subscribeAutoPhase, dispatch, stateRef]);
}
