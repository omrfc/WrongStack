import { Check, GitBranch, Loader2, RotateCcw, X } from 'lucide-react';
import { useMemo } from 'react';
import { agentInitials, priorityStyle } from '@/lib/sdd-theme';
import { cn } from '@/lib/utils';
import type { BoardTaskItem, BoardTaskStatus } from '@/stores';

/** Kanban columns, in workflow order. `displayStatus` drives placement. */
const COLUMNS: Array<{ key: BoardTaskStatus; label: string; accent: string; head: string }> = [
  {
    key: 'pending',
    label: 'Backlog',
    accent: 'border-slate-600/40',
    head: 'text-muted-foreground',
  },
  {
    key: 'queued',
    label: 'Ready',
    accent: 'border-cyan-500/40',
    head: 'text-cyan-600 dark:text-cyan-300',
  },
  {
    key: 'in_progress',
    label: 'Running',
    accent: 'border-amber-400/50',
    head: 'text-amber-600 dark:text-amber-300',
  },
  {
    key: 'review',
    label: 'Review',
    accent: 'border-sky-500/40',
    head: 'text-sky-600 dark:text-sky-300',
  },
  {
    key: 'failed',
    label: 'Failed',
    accent: 'border-red-500/40',
    head: 'text-red-600 dark:text-red-300',
  },
  {
    key: 'completed',
    label: 'Done',
    accent: 'border-emerald-500/40',
    head: 'text-emerald-600 dark:text-emerald-300',
  },
];

/**
 * SddKanbanView — the same run as a status kanban: cards flow Backlog → Ready →
 * Running → Review → Done as agents pick them up and finish. Complements the
 * dependency-graph view (which groups by phase). Click a card → detail drawer.
 */
export function SddKanbanView({
  tasks,
  selectedId,
  onTaskClick,
}: {
  tasks: BoardTaskItem[];
  selectedId: string | null;
  onTaskClick: (id: string) => void;
}): React.ReactElement {
  const byCol = useMemo(() => {
    const m = new Map<BoardTaskStatus, BoardTaskItem[]>();
    for (const c of COLUMNS) m.set(c.key, []);
    // 'blocked' folds into Backlog; 'cancelled' folds into Failed — so every
    // task lands in exactly one column.
    for (const t of tasks) {
      const key: BoardTaskStatus =
        t.displayStatus === 'blocked'
          ? 'pending'
          : t.displayStatus === 'cancelled'
            ? 'failed'
            : t.displayStatus;
      (m.get(key) ?? m.get('pending'))?.push(t);
    }
    return m;
  }, [tasks]);

  return (
    <div className="flex h-full min-h-0 min-w-0 gap-3 overflow-x-auto p-4">
      {COLUMNS.map((col) => {
        const items = byCol.get(col.key) ?? [];
        return (
          <div key={col.key} className="flex min-h-0 w-64 shrink-0 flex-col">
            <div className={cn('mb-2 flex items-center gap-2 border-b-2 pb-1.5', col.accent)}>
              <span className={cn('text-xs font-bold uppercase tracking-wide', col.head)}>
                {col.label}
              </span>
              <span className="rounded-full bg-muted px-1.5 text-[10px] text-muted-foreground">
                {items.length}
              </span>
            </div>
            <div className="min-h-0 flex-1 space-y-2 overflow-y-auto pr-1">
              {items.map((t) => (
                <KanbanCard
                  key={t.id}
                  task={t}
                  selected={t.id === selectedId}
                  onClick={() => onTaskClick(t.id)}
                />
              ))}
              {items.length === 0 && (
                <div className="rounded-md border border-dashed border-border py-6 text-center text-[10px] text-muted-foreground">
                  empty
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function KanbanCard({
  task,
  selected,
  onClick,
}: {
  task: BoardTaskItem;
  selected: boolean;
  onClick: () => void;
}) {
  const running = task.displayStatus === 'in_progress';
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'sdd-node-enter w-full rounded-lg border bg-card p-2 text-left transition hover:brightness-125',
        selected ? 'border-violet-400/70 ring-1 ring-violet-400/40' : 'border-border',
        running && 'sdd-node-running',
        task.displayStatus === 'completed' && 'sdd-node-complete',
        task.displayStatus === 'failed' && 'sdd-node-failed',
      )}
    >
      <div className="flex items-center gap-1.5">
        {running && <Loader2 className="h-3 w-3 animate-spin text-amber-400" />}
        {task.displayStatus === 'completed' && <Check className="h-3 w-3 text-emerald-400" />}
        {task.displayStatus === 'failed' && <X className="h-3 w-3 text-red-400" />}
        <span className="font-mono text-[10px] text-muted-foreground">{task.shortId}</span>
        <span
          className={cn(
            'ml-auto rounded px-1.5 text-[9px] font-bold uppercase',
            priorityStyle(task.priority).chip,
          )}
        >
          {task.priority}
        </span>
      </div>
      <p className="mt-1 line-clamp-2 text-[11px] leading-snug text-foreground">{task.title}</p>
      {(task.agentName || task.worktreeBranch || task.retries) && (
        <div className="mt-1.5 flex items-center gap-1.5">
          {task.agentName && (
            <span className="flex items-center gap-1">
              <span
                className={cn(
                  'flex h-4 w-4 items-center justify-center rounded-full text-[8px] font-bold text-white',
                  running ? 'bg-amber-500 sdd-agent-live' : 'bg-slate-600',
                )}
              >
                {agentInitials(task.agentName)}
              </span>
              <span className="max-w-[80px] truncate text-[10px] text-muted-foreground">
                {task.agentName}
              </span>
            </span>
          )}
          {task.retries ? (
            <span className="flex items-center gap-0.5 text-[9px] text-red-400">
              <RotateCcw className="h-2.5 w-2.5" />
              {task.retries}
            </span>
          ) : null}
          {task.worktreeBranch && (
            <GitBranch className="ml-auto h-2.5 w-2.5 text-muted-foreground" />
          )}
        </div>
      )}
    </button>
  );
}
