import { Activity, AlertTriangle, CheckCircle2, Cpu, Eraser, Pause, Play, RotateCcw, Square, Trash2, Undo2, X, XCircle, Zap } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useProviderModels } from '@/hooks/useProviderModels';
import { useWebSocket } from '@/hooks/useWebSocket';
import { agentInitials, fmtDuration, SDD_AGENT_COLORS, SDD_RUN_STATUS } from '@/lib/sdd-theme';
import { cn } from '@/lib/utils';
import { type BoardTaskItem, type SddLifecycleResultUI, useSddBoardStore } from '@/stores';
import { SddActivityFeed } from './SddActivityFeed';
import { SddDestroyDialog } from './SddDestroyDialog';
import { type FlowTask, SddFlowGraph } from './SddFlowGraph';
import { SddKanbanView } from './SddKanbanView';
import { SddTaskDrawer } from './SddTaskDrawer';
import { Button } from './ui/button';

/** Circular progress ring. */
function ProgressRing({ pct }: { pct: number }): React.ReactElement {
  const r = 26;
  const c = 2 * Math.PI * r;
  const off = c - (Math.max(0, Math.min(100, pct)) / 100) * c;
  return (
    <div className="relative h-16 w-16 shrink-0">
      <svg viewBox="0 0 64 64" className="h-16 w-16 -rotate-90">
        <circle cx="32" cy="32" r={r} fill="none" stroke="hsl(215 28% 22%)" strokeWidth="6" />
        <circle
          cx="32"
          cy="32"
          r={r}
          fill="none"
          stroke="url(#sddgrad)"
          strokeWidth="6"
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={off}
          style={{ transition: 'stroke-dashoffset 0.6s cubic-bezier(0.16,1,0.3,1)' }}
        />
        <defs>
          <linearGradient id="sddgrad" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#a78bfa" />
            <stop offset="100%" stopColor="#22d3ee" />
          </linearGradient>
        </defs>
      </svg>
      <div className="absolute inset-0 flex items-center justify-center text-sm font-bold text-foreground">
        {Math.round(pct)}%
      </div>
    </div>
  );
}

/**
 * SddBoardView — the live multi-agent execution show. Renders the run as an
 * animated React Flow DAG (SddFlowGraph) plus a stats header with a progress
 * ring, a live agent roster, and run controls (pause / resume / stop / retry).
 */
export function SddBoardView({ onClose }: { onClose: () => void }): React.ReactElement {
  const { client } = useWebSocket();
  const snapshot = useSddBoardStore((s) => s.snapshot);
  const lifecycleResult = useSddBoardStore((s) => s.lifecycleResult);
  const destroying = useSddBoardStore((s) => s.destroying);
  const setDestroying = useSddBoardStore((s) => s.setDestroying);
  const setLifecycleResult = useSddBoardStore((s) => s.setLifecycleResult);
  const [now, setNow] = useState(() => Date.now());
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<'graph' | 'kanban'>('graph');
  const [destroyOpen, setDestroyOpen] = useState(false);

  useEffect(() => {
    client?.send?.({ type: 'sdd.board.get' });
  }, [client]);

  // Tick for the elapsed clock while a run is active.
  const active = snapshot && (snapshot.status === 'running' || snapshot.status === 'paused');
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    setNow(Date.now());
    return () => clearInterval(id);
  }, [active]);

  const send = useCallback(
    (msg: Parameters<NonNullable<typeof client>['send']>[0]) => client?.send?.(msg),
    [client],
  );

  // ── Lifecycle orchestration (stop → wait until !active → destroy) ──────────
  // The server applies cleanup/rollback/destroy from disk and refuses while a
  // run is live, so Destroy first stops the run, waits for the snapshot to
  // settle, then fires the wipe. A pending request + a deadline ref drive it.
  const pendingDestroy = useRef<{ revertMerged: boolean; deadline: number } | null>(null);

  const fireDestroy = useCallback(
    (revertMerged: boolean) => {
      pendingDestroy.current = null;
      send({ type: 'sdd.board.destroy', payload: { revertMerged } });
    },
    [send],
  );

  const handleConfirmDestroy = useCallback(
    (revertMerged: boolean) => {
      setDestroyOpen(false);
      setLifecycleResult(null);
      setDestroying(true);
      if (active) {
        send({ type: 'sdd.board.stop', payload: {} });
        pendingDestroy.current = { revertMerged, deadline: Date.now() + 20_000 };
      } else {
        fireDestroy(revertMerged);
      }
    },
    [active, send, fireDestroy, setDestroying, setLifecycleResult],
  );

  // Once a destroy is pending and the run has settled (or the deadline passed),
  // send the wipe. Re-runs whenever `active` flips after the Stop.
  useEffect(() => {
    const pending = pendingDestroy.current;
    if (!pending) return;
    if (!active || Date.now() >= pending.deadline) {
      fireDestroy(pending.revertMerged);
    }
  }, [active, snapshot, fireDestroy]);

  // Clear a stale result before a fresh lifecycle action so the banner reflects
  // the latest op only.
  const onCleanWorktrees = useCallback(() => {
    setLifecycleResult(null);
    send({ type: 'sdd.board.cleanup_worktrees', payload: {} });
  }, [send, setLifecycleResult]);
  const onRollback = useCallback(() => {
    setLifecycleResult(null);
    send({ type: 'sdd.board.rollback', payload: {} });
  }, [send, setLifecycleResult]);

  const flowTasks = useMemo<FlowTask[]>(
    () =>
      (snapshot?.tasks ?? []).map((t: BoardTaskItem) => ({
        id: t.id,
        shortId: t.shortId,
        title: t.title,
        displayStatus: t.displayStatus,
        priority: t.priority,
        deps: t.deps,
        agentName: t.agentName,
        worktreeBranch: t.worktreeBranch,
      })),
    [snapshot?.tasks],
  );

  // Live workers — distinct agents currently on an in_progress task.
  const roster = useMemo(() => {
    const m = new Map<string, { name: string; task: string }>();
    for (const t of snapshot?.tasks ?? []) {
      if (t.displayStatus === 'in_progress' && t.agentName) {
        m.set(t.agentName, { name: t.agentName, task: t.title });
      }
    }
    return [...m.values()];
  }, [snapshot?.tasks]);

  // Click a task → open its detail drawer (not an instant retry).
  const onTaskClick = useCallback((taskId: string) => setSelectedTaskId(taskId), []);
  const onRetry = useCallback(
    (taskId: string) => send({ type: 'sdd.board.retry', payload: { taskId } }),
    [send],
  );
  const onRetryAllFailed = useCallback(
    () => send({ type: 'sdd.board.retry_all_failed', payload: {} }),
    [send],
  );
  const onReassign = useCallback(
    (taskId: string, agentName: string) => {
      const name = agentName.trim();
      if (name) send({ type: 'sdd.board.reassign', payload: { taskId, agentName: name } });
    },
    [send],
  );
  const onSetModel = useCallback(
    (taskId: string, model: string | undefined, provider?: string | undefined) =>
      send({ type: 'sdd.board.set_task_model', payload: { taskId, model, provider } }),
    [send],
  );
  const onSetVerification = useCallback(
    (taskId: string, verificationCommand: string | undefined) =>
      send({ type: 'sdd.board.set_task_verification', payload: { taskId, verificationCommand } }),
    [send],
  );
  const onCancel = useCallback(
    (taskId: string) => send({ type: 'sdd.board.cancel_task', payload: { taskId } }),
    [send],
  );
  const onDelete = useCallback(
    (taskId: string) => {
      send({ type: 'sdd.board.delete_task', payload: { taskId } });
      setSelectedTaskId(null); // the task is gone — drop the drawer selection
    },
    [send],
  );
  const onSplit = useCallback(
    (taskId: string, subtasks: Array<{ title: string; description: string }>) => {
      send({ type: 'sdd.board.split_task', payload: { taskId, subtasks } });
      setSelectedTaskId(null); // parent becomes a container — close the drawer
    },
    [send],
  );

  // Model catalogue for the per-task picker — fetched only while the drawer is open.
  const modelCandidates = useProviderModels(selectedTaskId !== null);

  const selectedTask = useMemo(
    () => snapshot?.tasks.find((t) => t.id === selectedTaskId) ?? null,
    [snapshot?.tasks, selectedTaskId],
  );

  const p = snapshot?.progress;
  const chains = snapshot?.diagnostics?.deadlockChains ?? [];

  return (
    <div className="flex h-full flex-col bg-background">
      {/* ── Header ── */}
      <header className="sdd-sheen shrink-0 border-b border-border px-4 pb-3 pt-2.5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Activity className="h-5 w-5 text-orange-400" />
            <h1 className="text-lg font-semibold text-foreground">
              {snapshot?.title ?? 'Live SDD Board'}
            </h1>
            {snapshot && (
              <span
                className={cn(
                  'rounded-full border px-2 py-0.5 text-[11px] font-medium capitalize',
                  SDD_RUN_STATUS[snapshot.status] ?? SDD_RUN_STATUS.idle,
                )}
              >
                {snapshot.status}
              </span>
            )}
            {snapshot?.defaultModel && (
              <span
                className="flex items-center gap-1 rounded-full border border-border bg-muted px-2 py-0.5 text-[10px] text-muted-foreground"
                title="Run-level default worker model (per-task overrides take precedence)"
              >
                <Cpu className="h-3 w-3 text-violet-400" />
                {snapshot.defaultModel}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            {/* Graph ↔ Kanban view toggle */}
            {snapshot && (
              <div className="flex items-center rounded-md border border-border bg-muted p-0.5 text-[11px]">
                {(['graph', 'kanban'] as const).map((m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => setViewMode(m)}
                    className={cn(
                      'rounded px-2 py-0.5 capitalize transition',
                      viewMode === m
                        ? 'bg-violet-500/25 text-violet-700 dark:text-violet-200'
                        : 'text-muted-foreground hover:text-foreground',
                    )}
                  >
                    {m === 'graph' ? 'Graph' : 'Kanban'}
                  </button>
                ))}
              </div>
            )}
            {active && (p?.failed ?? 0) > 0 && (
              <button
                type="button"
                onClick={onRetryAllFailed}
                title="Requeue every failed task to pending"
                className="inline-flex items-center gap-1 rounded-md bg-orange-500/15 px-2.5 py-1 text-xs font-medium text-orange-600 dark:text-orange-300 hover:bg-orange-500/25"
              >
                <RotateCcw className="h-3.5 w-3.5" /> Retry failed ({p?.failed})
              </button>
            )}
            {active && (
              <>
                {snapshot?.status === 'paused' ? (
                  <button
                    type="button"
                    onClick={() => send({ type: 'sdd.board.resume', payload: {} })}
                    className="inline-flex items-center gap-1 rounded-md bg-sky-500/15 px-2.5 py-1 text-xs font-medium text-sky-600 dark:text-sky-300 hover:bg-sky-500/25"
                  >
                    <Play className="h-3.5 w-3.5" /> Resume
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => send({ type: 'sdd.board.pause', payload: {} })}
                    className="inline-flex items-center gap-1 rounded-md bg-amber-500/15 px-2.5 py-1 text-xs font-medium text-amber-600 dark:text-amber-300 hover:bg-amber-500/25"
                  >
                    <Pause className="h-3.5 w-3.5" /> Pause
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => send({ type: 'sdd.board.stop', payload: {} })}
                  className="inline-flex items-center gap-1 rounded-md bg-red-500/15 px-2.5 py-1 text-xs font-medium text-red-600 dark:text-red-300 hover:bg-red-500/25"
                >
                  <Square className="h-3.5 w-3.5" /> Stop
                </button>
              </>
            )}
            {/* Lifecycle controls — shown once the run is stopped/finished (they
                are refused while a run is live). Clean removes the run's git
                worktrees; Rollback reverts its merged commits (history-preserving). */}
            {snapshot && !active && (
              <>
                <button
                  type="button"
                  onClick={onCleanWorktrees}
                  title="Remove the run's git worktrees + wstack/ap branches"
                  className="inline-flex items-center gap-1 rounded-md bg-slate-500/15 px-2.5 py-1 text-xs font-medium text-slate-600 dark:text-slate-300 hover:bg-slate-500/25"
                >
                  <Eraser className="h-3.5 w-3.5" /> Clean worktrees
                </button>
                {(snapshot.mergedCommits?.length ?? 0) > 0 && (
                  <button
                    type="button"
                    onClick={onRollback}
                    title={`Revert ${snapshot.mergedCommits?.length} merged commit(s) on ${snapshot.baseBranch ?? 'the base branch'}`}
                    className="inline-flex items-center gap-1 rounded-md bg-amber-500/15 px-2.5 py-1 text-xs font-medium text-amber-600 dark:text-amber-300 hover:bg-amber-500/25"
                  >
                    <Undo2 className="h-3.5 w-3.5" /> Rollback ({snapshot.mergedCommits?.length})
                  </button>
                )}
              </>
            )}
            {/* Destroy — the one-click "give up entirely". Always available when a
                board exists; opens a confirmation that auto-stops a live run first. */}
            {snapshot &&
              (destroying ? (
                <span className="inline-flex items-center gap-1 rounded-md bg-red-500/15 px-2.5 py-1 text-xs font-medium text-red-600 dark:text-red-300">
                  <RotateCcw className="h-3.5 w-3.5 animate-spin" /> {active ? 'Stopping…' : 'Destroying…'}
                </span>
              ) : (
                <button
                  type="button"
                  onClick={() => setDestroyOpen(true)}
                  title="Stop, remove all worktrees, optionally revert merged commits, and delete the SDD project"
                  className="inline-flex items-center gap-1 rounded-md bg-red-600/90 px-2.5 py-1 text-xs font-medium text-white hover:bg-red-700"
                >
                  <Trash2 className="h-3.5 w-3.5" /> Destroy
                </button>
              ))}
            <Button variant="ghost" size="icon" onClick={onClose}>
              <X className="h-4 w-4" />
            </Button>
          </div>
        </div>

        {/* stats + roster */}
        {snapshot && p && (
          <div className="mt-2.5 flex items-center gap-5">
            <ProgressRing pct={p.percentComplete} />
            <div className="flex flex-col gap-1">
              <div className="flex items-center gap-3 text-xs">
                <Stat
                  label="done"
                  value={`${p.completed}/${p.total}`}
                  color="text-emerald-600 dark:text-emerald-300"
                />
                {p.inProgress > 0 && (
                  <Stat
                    label="running"
                    value={p.inProgress}
                    color="text-amber-600 dark:text-amber-300"
                  />
                )}
                {p.failed > 0 && (
                  <Stat label="failed" value={p.failed} color="text-red-600 dark:text-red-300" />
                )}
                <Stat
                  label="wave"
                  value={snapshot.wave + 1}
                  color="text-violet-600 dark:text-violet-300"
                />
                {active && snapshot.startedAt > 0 && (
                  <Stat
                    label="elapsed"
                    value={fmtDuration(now - snapshot.startedAt)}
                    color="text-foreground"
                  />
                )}
              </div>
              {/* Live agent roster */}
              <div className="flex min-h-[24px] items-center gap-1.5">
                {roster.length === 0 ? (
                  <span className="text-[11px] text-muted-foreground">no active workers</span>
                ) : (
                  roster.map((a, i) => (
                    <span
                      key={a.name}
                      title={`${a.name} → ${a.task}`}
                      className="flex items-center gap-1 rounded-full bg-muted py-0.5 pl-0.5 pr-2"
                    >
                      <span
                        className={cn(
                          'sdd-agent-live flex h-5 w-5 items-center justify-center rounded-full text-[9px] font-bold text-white',
                          SDD_AGENT_COLORS[i % SDD_AGENT_COLORS.length],
                        )}
                      >
                        {agentInitials(a.name)}
                      </span>
                      <span className="max-w-[90px] truncate text-[11px] text-foreground">
                        {a.name}
                      </span>
                    </span>
                  ))
                )}
              </div>
            </div>
          </div>
        )}
      </header>

      {/* lifecycle result banner — outcome of the last clean/rollback/destroy */}
      {lifecycleResult && (
        <LifecycleResultBanner result={lifecycleResult} onDismiss={() => setLifecycleResult(null)} />
      )}

      {/* deadlock banner */}
      {chains.length > 0 && (
        <div className="flex items-start gap-2 border-b border-rose-500/30 bg-rose-500/5 px-4 py-2 text-xs text-rose-600 dark:text-rose-300">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <div>
            <div className="font-semibold">Deadlock — tasks blocked by failed work:</div>
            {chains.map((c) => (
              <div key={c.blocked} className="font-mono">
                {c.blocked} ← {c.blockedBy.join(', ')}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Dashboard: animated DAG (left) + side panel (right) ── */}
      <div className="flex min-h-0 flex-1">
        <div className="relative min-w-0 flex-1">
          {!snapshot ? (
            <div className="flex h-full flex-col items-center justify-center gap-3 text-sm text-muted-foreground">
              <Zap className="h-10 w-10 text-violet-500/40" />
              <p className="text-foreground">No active SDD run.</p>
              <p className="max-w-sm text-center text-xs text-muted-foreground">
                Start one from the <span className="text-violet-400">New SDD Project</span> wizard,
                or via <code className="rounded bg-muted px-1">/sdd execute</code> in the CLI —
                agents appear here live, each working an isolated worktree.
              </p>
            </div>
          ) : viewMode === 'graph' ? (
            <>
              <SddFlowGraph
                tasks={flowTasks}
                columns={snapshot.columns}
                onTaskClick={onTaskClick}
              />
              <div className="pointer-events-none absolute bottom-2 left-1/2 -translate-x-1/2 rounded-full bg-black/40 px-2 py-0.5 text-[10px] text-muted-foreground backdrop-blur">
                click a task for details
              </div>
            </>
          ) : (
            <SddKanbanView
              tasks={snapshot.tasks}
              selectedId={selectedTaskId}
              onTaskClick={onTaskClick}
            />
          )}
        </div>

        {/* Side panel: task detail when one is selected, else the live activity feed. */}
        {snapshot && (
          <aside className="w-80 shrink-0 border-l border-border bg-card">
            {selectedTask ? (
              <SddTaskDrawer
                key={selectedTask.id}
                task={selectedTask}
                allTasks={snapshot.tasks}
                feed={snapshot.feed ?? []}
                now={now}
                modelCandidates={modelCandidates}
                defaultModel={snapshot.defaultModel}
                onClose={() => setSelectedTaskId(null)}
                onRetry={onRetry}
                onReassign={onReassign}
                onSetModel={onSetModel}
                onSetVerification={onSetVerification}
                onCancel={onCancel}
                onDelete={onDelete}
                onSplit={onSplit}
                onSelectTask={setSelectedTaskId}
              />
            ) : (
              <SddActivityFeed feed={snapshot.feed ?? []} now={now} />
            )}
          </aside>
        )}
      </div>

      <SddDestroyDialog
        open={destroyOpen}
        onOpenChange={setDestroyOpen}
        snapshot={snapshot}
        busy={destroying}
        onConfirm={handleConfirmDestroy}
      />
    </div>
  );
}

/** Human one-liner for a lifecycle outcome. */
function lifecycleMessage(r: SddLifecycleResultUI): string {
  const op = r.op === 'cleanup_worktrees' ? 'Clean' : r.op === 'rollback' ? 'Rollback' : 'Destroy';
  if (!r.ok) return `${op} failed: ${r.reason ?? 'unknown error'}`;
  const parts: string[] = [];
  if (typeof r.removed === 'number') parts.push(`${r.removed} worktree${r.removed === 1 ? '' : 's'} removed`);
  if (typeof r.reverted === 'number' && r.reverted > 0)
    parts.push(`${r.reverted} commit${r.reverted === 1 ? '' : 's'} reverted`);
  if (r.deleted?.length) parts.push(`deleted ${r.deleted.join(', ')}`);
  const body = parts.length ? parts.join(' · ') : 'nothing to do';
  // A destroy that was asked to revert but couldn't carries an ok:true + reason.
  return r.reason ? `${op}: ${body} — note: ${r.reason}` : `${op}: ${body}`;
}

function LifecycleResultBanner({
  result,
  onDismiss,
}: {
  result: SddLifecycleResultUI;
  onDismiss: () => void;
}): React.ReactElement {
  const warn = !result.ok || Boolean(result.reason);
  return (
    <div
      className={cn(
        'flex items-start gap-2 border-b px-4 py-2 text-xs',
        warn
          ? 'border-amber-500/30 bg-amber-500/5 text-amber-700 dark:text-amber-300'
          : 'border-emerald-500/30 bg-emerald-500/5 text-emerald-700 dark:text-emerald-300',
      )}
    >
      {warn ? (
        <XCircle className="mt-0.5 h-4 w-4 shrink-0" />
      ) : (
        <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
      )}
      <span className="flex-1">{lifecycleMessage(result)}</span>
      <button type="button" onClick={onDismiss} className="shrink-0 opacity-60 hover:opacity-100">
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

function Stat({ label, value, color }: { label: string; value: string | number; color: string }) {
  return (
    <span className="flex items-baseline gap-1">
      <span className={cn('font-semibold tabular-nums', color)}>{value}</span>
      <span className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</span>
    </span>
  );
}
