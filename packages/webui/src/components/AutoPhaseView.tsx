import { useCallback, useState } from 'react';
import { useWebSocket } from '@/hooks/useWebSocket';
import { useAutoPhaseStore, useWorktreeStore } from '@/stores';
import { cn } from '@/lib/utils';
import { PhasePanel } from './PhasePanel';
import { TaskBoard } from './TaskBoard';
import { WorktreeGraph } from './WorktreeGraph';
import { WorktreeLanes } from './WorktreeLanes';
import { Layers, Play, Rocket, X } from 'lucide-react';
import { Button } from './ui/button';

/**
 * AutoPhaseView — Full-screen phase planning view.
 * Left: phase list with progress. Right: task board for selected phase.
 * Bottom: worktree visualization when worktrees are active.
 *
 * Uses the shared useAutoPhaseStore (synced via autophase.state WS events)
 * so phase data stays consistent between this view and the chat-area PhasePanel.
 */
export function AutoPhaseView({ onClose }: { onClose: () => void }): React.ReactElement {
  const { client } = useWebSocket();
  const phases = useAutoPhaseStore((s) => s.phases);
  const activePhaseId = useAutoPhaseStore((s) => s.activePhaseId);
  const overallPercent = useAutoPhaseStore((s) => s.overallPercent);
  const autonomous = useAutoPhaseStore((s) => s.autonomous);
  const title = useAutoPhaseStore((s) => s.title);

  const worktrees = useWorktreeStore((s) => s.worktrees);
  const baseBranch = useWorktreeStore((s) => s.baseBranch);

  // Start flow state
  const [goal, setGoal] = useState('');
  const [starting, setStarting] = useState(false);

  // Tasks from autophase state — extracted from phases
  const [showGraph, setShowGraph] = useState(false);

  const hasPhases = phases.length > 0;

  const handleStart = useCallback(async () => {
    const g = goal.trim();
    if (!g || starting) return;
    setStarting(true);
    // Brief delay so the button state shows visually before the long WS roundtrip
    await new Promise((r) => setTimeout(r, 100));
    client?.send?.({ type: 'autophase.start', payload: { title: g, autonomous: true } });
    setStarting(false);
  }, [goal, starting, client]);

  const handlePhaseClick = useCallback(
    (phaseId: string) => {
      client?.send?.({ type: 'autophase.selectPhase', payload: { phaseId } });
    },
    [client],
  );

  const handleToggleAutonomous = useCallback(() => {
    client?.send?.({ type: 'autophase.toggleAutonomous', payload: {} });
  }, [client]);

  const handleTaskStatusChange = useCallback(
    (taskId: string, status: string) => {
      client?.send?.({ type: 'autophase.taskStatus', payload: { taskId, status } });
    },
    [client],
  );

  const activePhase = phases.find((p) => p.id === activePhaseId);

  // Extract tasks from the active phase or all phases
  const tasks = activePhase
    ? (activePhase as never as { tasks?: Array<{ id: string; title: string; description: string; status: string; priority: string; type: string; estimateHours?: number; assignee?: string; tags?: string[] }> }).tasks ?? []
    : [];

  return (
    <div className="flex flex-col h-full bg-background">
      {/* Header */}
      <header className="flex items-center justify-between px-4 py-2 border-b bg-card shrink-0">
        <div className="flex items-center gap-2">
          <Layers className="h-5 w-5 text-muted-foreground" />
          <div>
            <h1 className="text-lg font-semibold">
              {hasPhases ? (title || 'AutoPhase') : 'AutoPhase'}
            </h1>
            {hasPhases && (
              <p className="text-xs text-muted-foreground">
                {phases.length} phase{phases.length === 1 ? '' : 's'} · {overallPercent}% complete
              </p>
            )}
          </div>
        </div>
        <Button variant="ghost" size="icon" onClick={onClose}>
          <X className="h-4 w-4" />
        </Button>
      </header>

      {!hasPhases ? (
        /* ── Start screen — shown when no phases exist ── */
        <div className="flex-1 flex items-center justify-center p-8">
          <div className="max-w-lg w-full space-y-6">
            <div className="text-center space-y-2">
              <Rocket className="h-10 w-10 mx-auto text-primary/60" />
              <h2 className="text-xl font-semibold">Start a Phase Plan</h2>
              <p className="text-sm text-muted-foreground">
                Describe what you want to build. WrongStack will plan phases and tasks,
                then execute them autonomously.
              </p>
            </div>

            <textarea
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
              placeholder="e.g. Build a REST API for user management with Express and SQLite..."
              rows={5}
              className="w-full rounded-lg border border-border bg-card px-4 py-3 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-primary/30 placeholder:text-muted-foreground/50"
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                  e.preventDefault();
                  handleStart();
                }
              }}
            />

            <div className="flex items-center gap-3">
              <Button
                onClick={handleStart}
                disabled={!goal.trim() || starting}
                className="flex-1 gap-2"
              >
                <Play className="h-4 w-4" />
                {starting ? 'Starting…' : 'Start AutoPhase'}
              </Button>
            </div>

            <p className="text-xs text-muted-foreground text-center">
              Ctrl+Enter to start · Phases execute sequentially with full agent tool access
            </p>
          </div>
        </div>
      ) : (
        /* ── Active phase monitoring ── */
        <div className="flex min-h-0 flex-1">
          {/* Left: Phase list */}
          <PhasePanel
            phases={phases}
            activePhaseId={activePhaseId ?? undefined}
            onPhaseClick={handlePhaseClick}
            overallPercent={overallPercent}
            autonomous={autonomous}
            onToggleAutonomous={handleToggleAutonomous}
            className="w-72 shrink-0"
          />

          {/* Right: Task board for selected phase */}
          <div className="flex min-w-0 flex-1 flex-col">
            {activePhase ? (
              <TaskBoard
                phaseName={activePhase.name}
                phaseStatus={activePhase.status}
                tasks={tasks.map((t) => ({
                  id: t.id,
                  title: t.title,
                  description: t.description,
                  status: t.status as TaskBoardProps['tasks'][0]['status'],
                  priority: (t.priority as TaskBoardProps['tasks'][0]['priority']) || 'medium',
                  type: (t.type as TaskBoardProps['tasks'][0]['type']) || 'feature',
                  estimateHours: t.estimateHours,
                  assignee: t.assignee,
                  tags: t.tags ?? [],
                }))}
                onTaskStatusChange={handleTaskStatusChange}
              />
            ) : (
              <div className="flex h-full items-center justify-center text-muted-foreground">
                <p className="text-sm">Select a phase from the left panel to view its tasks.</p>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Bottom: Worktree visualization */}
      {worktrees.length > 0 && (
        <div className="border-t bg-card/50 shrink-0">
          <div className="flex items-center justify-end gap-2 px-4 pt-2 text-xs">
            <button
              type="button"
              onClick={() => setShowGraph(false)}
              className={cn(
                'rounded px-2 py-0.5 border transition-colors',
                !showGraph
                  ? 'bg-primary/10 border-primary/30 text-primary'
                  : 'border-border text-muted-foreground hover:text-foreground',
              )}
            >
              Lanes
            </button>
            <button
              type="button"
              onClick={() => setShowGraph(true)}
              className={cn(
                'rounded px-2 py-0.5 border transition-colors',
                showGraph
                  ? 'bg-primary/10 border-primary/30 text-primary'
                  : 'border-border text-muted-foreground hover:text-foreground',
              )}
            >
              Graph
            </button>
          </div>
          <div className="px-4 pb-3">
            {showGraph ? (
              <WorktreeGraph worktrees={worktrees} baseBranch={baseBranch} />
            ) : (
              <WorktreeLanes worktrees={worktrees} baseBranch={baseBranch} />
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// Re-import needed types from TaskBoard
import type { TaskBoardProps } from './TaskBoard';
