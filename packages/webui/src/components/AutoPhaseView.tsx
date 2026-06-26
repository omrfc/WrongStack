import { useCallback, useEffect, useState } from 'react';
import { useWebSocket } from '@/hooks/useWebSocket';
import { useAutoPhaseStore, useChatStore, useWorktreeStore } from '@/stores';
import { cn } from '@/lib/utils';
import { BoardView } from './BoardView';
import { WorktreeGraph } from './WorktreeGraph';
import { WorktreeLanes } from './WorktreeLanes';
import { Layers, Loader2, Pause, Play, Plus, Rocket, Square, Undo2, X, Zap } from 'lucide-react';
import { Button } from './ui/button';

/**
 * AutoPhaseView — Full-screen phase view.
 *
 * Start screen (no phases) → goal form. Once phases exist, the interactive
 * kanban BoardView fills the area (phase columns / status swimlanes, drag-drop,
 * manual assignment, live worker per task). Worktree visualization docks at the
 * bottom while worktrees are active.
 *
 * Uses the shared useAutoPhaseStore (synced via autophase.state WS events) so
 * board data stays consistent with the chat-area PhasePanel.
 */
export function AutoPhaseView({ onClose }: { onClose: () => void }): React.ReactElement {
  const { client } = useWebSocket();
  const phases = useAutoPhaseStore((s) => s.phases);
  const overallPercent = useAutoPhaseStore((s) => s.overallPercent);
  const autonomous = useAutoPhaseStore((s) => s.autonomous);
  const title = useAutoPhaseStore((s) => s.title);
  const goalText = useAutoPhaseStore((s) => s.goal);
  const status = useAutoPhaseStore((s) => s.status);
  const lastError = useAutoPhaseStore((s) => s.lastError);
  const graphs = useAutoPhaseStore((s) => s.graphs);

  // Pull the list of persisted boards for this project on mount.
  useEffect(() => {
    client?.send?.({ type: 'autophase.list' });
  }, [client]);

  const worktrees = useWorktreeStore((s) => s.worktrees);
  const baseBranch = useWorktreeStore((s) => s.baseBranch);

  const [goal, setGoal] = useState('');
  // The goal we submitted, kept until the first phase state arrives so the
  // start screen can show a persistent "planning…" state instead of silently
  // resetting the form (which read as "nothing happened").
  const [planningGoal, setPlanningGoal] = useState<string | null>(null);
  const [showGraph, setShowGraph] = useState(false);

  const hasPhases = phases.length > 0;
  const planning = planningGoal != null && !hasPhases;

  // Phases arrived (or the run was cleared) → planning is over.
  useEffect(() => {
    if (hasPhases) setPlanningGoal(null);
  }, [hasPhases]);

  const handleStart = useCallback(() => {
    const g = goal.trim();
    if (!g || planningGoal != null) return;
    // Echo the goal into the chat transcript and acknowledge it, so the run is
    // traceable in chat history and the submit gives clear feedback.
    const chat = useChatStore.getState();
    chat.addMessage({ role: 'user', content: g });
    chat.addMessage({
      role: 'assistant',
      content: `🚀 **AutoPhase** — got it. Planning phases for your goal now…`,
    });
    setPlanningGoal(g);
    setGoal('');
    client?.send?.({ type: 'autophase.start', payload: { title: g, autonomous: true } });
  }, [goal, planningGoal, client]);

  const handleCancelPlanning = useCallback(() => {
    client?.send?.({ type: 'autophase.stop', payload: {} });
    setPlanningGoal(null);
  }, [client]);

  const handleToggleAutonomous = useCallback(() => {
    client?.send?.({ type: 'autophase.toggleAutonomous', payload: {} });
  }, [client]);

  const handlePauseResume = useCallback(() => {
    client?.send?.(
      status === 'paused' ? { type: 'autophase.resume', payload: {} } : { type: 'autophase.pause', payload: {} },
    );
  }, [client, status]);

  const handleStop = useCallback(() => {
    client?.send?.({ type: 'autophase.stop', payload: {} });
  }, [client]);

  // Reset to an empty board and start fresh. Clears locally too so the start
  // screen shows immediately, even before the server's cleared state arrives.
  const handleNew = useCallback(() => {
    client?.send?.({ type: 'autophase.clear', payload: {} });
    useAutoPhaseStore.getState().clear();
    setPlanningGoal(null);
    setGoal('');
  }, [client]);

  const [confirmRevert, setConfirmRevert] = useState(false);
  const handleRevert = useCallback(() => {
    client?.send?.({ type: 'autophase.revert', payload: {} });
    setConfirmRevert(false);
  }, [client]);

  const isLive = status === 'running' || status === 'paused';
  // A finished/halted run: offer New (reset) and Revert (undo the run's commits).
  const isDone = status === 'stopped' || status === 'completed' || status === 'failed';

  const handleSelectBoard = useCallback(
    (graphId: string) => {
      if (graphId) client?.send?.({ type: 'autophase.load', payload: { graphId } });
    },
    [client],
  );

  return (
    <div className="flex flex-col h-full bg-background">
      {/* Header */}
      <header className="flex items-center justify-between px-4 py-2 border-b bg-card shrink-0">
        <div className="flex items-center gap-2">
          <Layers className="h-5 w-5 text-muted-foreground" />
          <div>
            <h1 className="text-lg font-semibold">{hasPhases ? title || 'AutoPhase' : 'AutoPhase'}</h1>
            {hasPhases && (
              <p className="text-xs text-muted-foreground">
                {phases.length} phase{phases.length === 1 ? '' : 's'} · {overallPercent}% complete
              </p>
            )}
          </div>
          {hasPhases && (
            <span
              className={cn(
                'rounded border px-2 py-0.5 text-[11px] font-medium capitalize',
                status === 'failed'
                  ? 'border-destructive/40 bg-destructive/10 text-destructive'
                  : status === 'paused' || status === 'stopped'
                    ? 'border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300'
                    : status === 'completed'
                      ? 'border-green-500/40 bg-green-500/10 text-green-700 dark:text-green-300'
                      : 'border-primary/30 bg-primary/10 text-primary',
              )}
              title={lastError ?? undefined}
            >
              {status}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {/* Board selector — every AutoPhase run is a persisted board (JSON on
              disk); switch between all boards saved for this project. */}
          {graphs.length > 0 && (
            <select
              value={hasPhases ? (graphs.find((g) => g.title === title)?.id ?? '') : ''}
              onChange={(e) => handleSelectBoard(e.target.value)}
              title="Switch board"
              className="rounded border border-border bg-card px-2 py-1 text-xs text-foreground"
            >
              <option value="" disabled>
                {graphs.length} board{graphs.length === 1 ? '' : 's'}…
              </option>
              {graphs.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.title} · {g.status}
                </option>
              ))}
            </select>
          )}
          {hasPhases && (
            <button
              type="button"
              onClick={handleToggleAutonomous}
              title="Toggle autonomous mode"
              className={cn(
                'inline-flex items-center gap-1 rounded border px-2 py-1 text-xs transition-colors',
                autonomous
                  ? 'border-primary/30 bg-primary/10 text-primary'
                  : 'border-border text-muted-foreground hover:text-foreground',
              )}
            >
              <Zap className="h-3.5 w-3.5" /> {autonomous ? 'Autonomous' : 'Manual'}
            </button>
          )}
          {isLive && (
            <>
              <button
                type="button"
                onClick={handlePauseResume}
                title={status === 'paused' ? 'Resume the run' : 'Pause the run'}
                className="inline-flex items-center gap-1 rounded border border-border px-2 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
              >
                {status === 'paused' ? <Play className="h-3.5 w-3.5" /> : <Pause className="h-3.5 w-3.5" />}
                {status === 'paused' ? 'Resume' : 'Pause'}
              </button>
              <button
                type="button"
                onClick={handleStop}
                title="Stop the run — aborts in-flight agents immediately"
                className="inline-flex items-center gap-1 rounded border border-destructive/40 bg-destructive/10 px-2 py-1 text-xs font-medium text-destructive transition-colors hover:bg-destructive/20"
              >
                <Square className="h-3.5 w-3.5 fill-current" /> Stop
              </button>
            </>
          )}
          {hasPhases && isDone && (
            <>
              <button
                type="button"
                onClick={handleNew}
                title="Clear this board and start a new AutoPhase run"
                className="inline-flex items-center gap-1 rounded border border-primary/30 bg-primary/10 px-2 py-1 text-xs font-medium text-primary transition-colors hover:bg-primary/20"
              >
                <Plus className="h-3.5 w-3.5" /> New
              </button>
              {confirmRevert ? (
                <span className="inline-flex items-center gap-1 rounded border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-xs">
                  <span className="text-amber-700 dark:text-amber-300">Revert run's commits?</span>
                  <button
                    type="button"
                    onClick={handleRevert}
                    className="rounded bg-destructive/15 px-1.5 py-0.5 font-medium text-destructive hover:bg-destructive/25"
                  >
                    Yes
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmRevert(false)}
                    className="rounded px-1.5 py-0.5 text-muted-foreground hover:text-foreground"
                  >
                    No
                  </button>
                </span>
              ) : (
                <button
                  type="button"
                  onClick={() => setConfirmRevert(true)}
                  title="Undo this run — git-revert the commits it landed and remove its worktrees"
                  className="inline-flex items-center gap-1 rounded border border-border px-2 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
                >
                  <Undo2 className="h-3.5 w-3.5" /> Revert
                </button>
              )}
            </>
          )}
          <Button variant="ghost" size="icon" onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
        </div>
      </header>

      {/* Goal block — the operator's full prompt, shown verbatim and separate
          from the short title heading (not a dropdown / not a card tile). */}
      {hasPhases && goalText && (
        <div className="shrink-0 border-b border-border/60 bg-muted/20 px-4 py-2.5">
          <div className="mb-1 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            <Rocket className="h-3 w-3" /> Goal
          </div>
          <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground/90">{goalText}</p>
        </div>
      )}

      {hasPhases ? (
        /* ── Interactive kanban board ── */
        <div className="flex min-h-0 flex-1">
          <BoardView />
        </div>
      ) : planning ? (
        /* ── Planning state — goal accepted, phases not built yet ── */
        <div className="flex-1 flex items-center justify-center p-8">
          <div className="max-w-lg w-full space-y-5 text-center">
            <Loader2 className="h-10 w-10 mx-auto animate-spin text-primary/70" />
            <div className="space-y-1">
              <h2 className="text-xl font-semibold">Planning phases…</h2>
              <p className="text-sm text-muted-foreground">
                Your goal was received. WrongStack is breaking it into phases and tasks — the board
                appears here the moment the plan is ready.
              </p>
            </div>
            <div className="rounded-lg border border-border bg-card px-4 py-3 text-left">
              <div className="mb-1 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                <Rocket className="h-3 w-3" /> Goal
              </div>
              <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground/90">{planningGoal}</p>
            </div>
            <Button variant="outline" onClick={handleCancelPlanning} className="gap-2">
              <Square className="h-4 w-4 fill-current" /> Cancel
            </Button>
          </div>
        </div>
      ) : (
        /* ── Start screen ── */
        <div className="flex-1 flex items-center justify-center p-8">
          <div className="max-w-lg w-full space-y-6">
            <div className="text-center space-y-2">
              <Rocket className="h-10 w-10 mx-auto text-primary/60" />
              <h2 className="text-xl font-semibold">Start a Phase Plan</h2>
              <p className="text-sm text-muted-foreground">
                Describe what you want to build. WrongStack will plan phases and tasks, then execute
                them — watch and steer the run on the board.
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
              <Button onClick={handleStart} disabled={!goal.trim()} className="flex-1 gap-2">
                <Play className="h-4 w-4" />
                Start AutoPhase
              </Button>
            </div>

            <p className="text-xs text-muted-foreground text-center">
              Ctrl+Enter to start · phases run in isolated worktrees with agents picking up tasks
            </p>
          </div>
        </div>
      )}

      {/* Worktree visualization */}
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
