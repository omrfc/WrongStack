import { useCallback, useEffect, useState } from 'react';
import { useWebSocket } from '@/hooks/useWebSocket';
import { useWorktreeStore } from '@/stores';
import { PhasePanel } from './PhasePanel';
import { TaskBoard } from './TaskBoard';
import { WorktreeLanes } from './WorktreeLanes';
import { WorktreeGraph } from './WorktreeGraph';
import type { PhaseItem } from './PhasePanel';
import type { TaskItem } from './TaskBoard';
import type { WSServerMessage } from '@/types';

interface AutoPhaseState {
  phases: PhaseItem[];
  tasks: TaskItem[];
  activePhaseId: string;
  overallPercent: number;
  autonomous: boolean;
  title: string;
}

/**
 * AutoPhaseView — Solda faz paneli, sağda görev listesi olan ana AutoPhase ekranı.
 *
 * WebSocket üzerinden gerçek zamanlı güncelleme alır.
 */
export function AutoPhaseView(): React.ReactElement {
  const { client, selectAutoPhase } = useWebSocket();
  const [state, setState] = useState<AutoPhaseState>({
    phases: [],
    tasks: [],
    activePhaseId: '',
    overallPercent: 0,
    autonomous: true,
    title: '',
  });

  // WebSocket'ten AutoPhase state güncellemelerini dinle
  useEffect(() => {
    const handleMessage = (msg: WSServerMessage) => {
      if (msg.type === 'autophase.state' && msg.payload) {
        setState(msg.payload as unknown as AutoPhaseState);
      }
    };

    client.on('autophase.state', handleMessage);
    return () => client.off('autophase.state', handleMessage);
  }, [client]);

  const handlePhaseClick = useCallback(
    (phaseId: string) => selectAutoPhase(phaseId),
    [selectAutoPhase],
  );

  const handleToggleAutonomous = useCallback(() => {
    client.send({ type: 'autophase.toggleAutonomous', payload: {} });
  }, [client]);

  const handleTaskStatusChange = useCallback(
    (taskId: string, status: string) => {
      client.send({ type: 'autophase.taskStatus', payload: { taskId, status } });
    },
    [client],
  );

  const activePhase = state.phases.find((p) => p.id === state.activePhaseId);
  const worktrees = useWorktreeStore((s) => s.worktrees);
  const baseBranch = useWorktreeStore((s) => s.baseBranch);
  const [showGraph, setShowGraph] = useState(false);

  return (
    <div className="flex h-full w-full flex-col">
      <div className="flex min-h-0 flex-1">
        {/* Sol Panel — Fazlar */}
        <PhasePanel
          phases={state.phases}
          activePhaseId={state.activePhaseId}
          onPhaseClick={handlePhaseClick}
          overallPercent={state.overallPercent}
          autonomous={state.autonomous}
          onToggleAutonomous={handleToggleAutonomous}
        />

        {/* Sağ Panel — Görevler */}
        <div className="flex min-w-0 flex-1 flex-col">
          {activePhase ? (
            <TaskBoard
              phaseName={activePhase.name}
              phaseStatus={activePhase.status}
              tasks={state.tasks}
              onTaskStatusChange={handleTaskStatusChange}
            />
          ) : (
            <div className="flex h-full items-center justify-center text-muted-foreground">
              <p>Bir faz seçin</p>
            </div>
          )}
        </div>
      </div>

      {/* Alt bant — git worktree izolasyon kulvarları / DAG */}
      {worktrees.length > 0 ? (
        <div>
          <div className="flex items-center justify-end gap-2 px-4 pt-2 text-xs">
            <button
              type="button"
              onClick={() => setShowGraph(false)}
              className={`rounded px-2 py-0.5 ${!showGraph ? 'bg-[--color-primary]/20 text-[--color-primary]' : 'text-[--color-text-dark-secondary]'}`}
            >
              Lanes
            </button>
            <button
              type="button"
              onClick={() => setShowGraph(true)}
              className={`rounded px-2 py-0.5 ${showGraph ? 'bg-[--color-primary]/20 text-[--color-primary]' : 'text-[--color-text-dark-secondary]'}`}
            >
              Graph
            </button>
          </div>
          {showGraph ? (
            <div className="px-4 pb-3">
              <WorktreeGraph worktrees={worktrees} baseBranch={baseBranch} />
            </div>
          ) : (
            <WorktreeLanes worktrees={worktrees} baseBranch={baseBranch} />
          )}
        </div>
      ) : null}
    </div>
  );
}