import {
  ArrowLeft,
  Check,
  Clock,
  GitBranch,
  RotateCcw,
  Split,
  Square,
  Trash2,
  UserCog,
  X,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import type { ModelCandidate } from '@/hooks/useProviderModels';
import { agentInitials, fmtDuration, priorityStyle, statusStyle } from '@/lib/sdd-theme';
import { cn } from '@/lib/utils';
import type { BoardTaskItem, SddBoardFeedEntry } from '@/stores';
import { ModelPicker } from './ModelPicker';

/**
 * SddTaskDrawer — the per-task "show": full detail of a clicked task. Status,
 * the worker on it, worktree, timing, description, dependency chain (clickable),
 * and run controls (retry / reassign).
 */
export function SddTaskDrawer({
  task,
  allTasks,
  feed,
  now,
  modelCandidates,
  defaultModel,
  onClose,
  onRetry,
  onReassign,
  onSetModel,
  onSetVerification,
  onCancel,
  onDelete,
  onSplit,
  onSelectTask,
}: {
  task: BoardTaskItem;
  allTasks: BoardTaskItem[];
  feed: SddBoardFeedEntry[];
  now: number;
  modelCandidates: ModelCandidate[];
  defaultModel?: string | undefined;
  onClose: () => void;
  onRetry: (id: string) => void;
  onReassign: (id: string, agentName: string) => void;
  onSetModel: (id: string, model: string | undefined, provider?: string | undefined) => void;
  onSetVerification: (id: string, verificationCommand: string | undefined) => void;
  onCancel: (id: string) => void;
  onDelete: (id: string) => void;
  onSplit: (id: string, subtasks: Array<{ title: string; description: string }>) => void;
  onSelectTask: (id: string) => void;
}): React.ReactElement {
  const s = statusStyle(task.displayStatus);
  const StatusIcon = s.icon;
  const running = task.displayStatus === 'in_progress';
  const deletable =
    task.displayStatus === 'pending' ||
    task.displayStatus === 'blocked' ||
    task.displayStatus === 'queued';
  const [reassigning, setReassigning] = useState(false);
  const [reassignName, setReassignName] = useState('');
  // Inline confirm gate for the destructive controls (no native confirm()).
  const [confirm, setConfirm] = useState<null | 'stop' | 'delete'>(null);
  const [splitting, setSplitting] = useState(false);
  const [splitText, setSplitText] = useState('');
  // Per-task verification command editor (completion gate).
  const [verifyEditing, setVerifyEditing] = useState(false);
  const [verifyText, setVerifyText] = useState(task.verificationCommand ?? '');

  const submitReassign = () => {
    if (reassignName.trim()) {
      onReassign(task.id, reassignName.trim());
      setReassigning(false);
      setReassignName('');
    }
  };

  // Parse the split textarea: one sub-task per line, `Title :: description`
  // (description optional → falls back to the title).
  const submitSplit = () => {
    const subtasks = splitText
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((line) => {
        const [title, ...rest] = line.split('::');
        const t = (title ?? '').trim();
        const desc = rest.join('::').trim();
        return { title: t, description: desc || t };
      })
      .filter((s) => s.title);
    if (subtasks.length) {
      onSplit(task.id, subtasks);
      setSplitting(false);
      setSplitText('');
    }
  };

  const byShort = useMemo(() => new Map(allTasks.map((t) => [t.shortId, t])), [allTasks]);
  const dependents = useMemo(
    () => allTasks.filter((t) => t.deps.includes(task.shortId)),
    [allTasks, task.shortId],
  );
  const taskEvents = useMemo(
    () => feed.filter((e) => e.taskShortId === task.shortId),
    [feed, task.shortId],
  );

  const elapsed =
    task.startedAt && !task.completedAt
      ? fmtDuration(now - task.startedAt)
      : task.startedAt && task.completedAt
        ? fmtDuration(task.completedAt - task.startedAt)
        : null;

  return (
    <div className="sdd-rise flex h-full flex-col">
      {/* header */}
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <button
          type="button"
          onClick={onClose}
          className="text-muted-foreground hover:text-foreground"
          title="Back to activity"
        >
          <ArrowLeft className="h-4 w-4" />
        </button>
        <span className="font-mono text-xs text-muted-foreground">{task.shortId}</span>
        <span
          className={cn(
            'ml-auto flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px]',
            s.ring,
            s.text,
          )}
        >
          <StatusIcon className={cn('h-3 w-3', running && 'animate-spin')} />
          {s.label}
        </span>
      </div>

      <div className="flex-1 space-y-3 overflow-auto p-3">
        <h3 className="text-sm font-semibold leading-snug text-foreground">{task.title}</h3>

        {/* worker */}
        {task.agentName && (
          <div className="flex items-center gap-2 rounded-md border border-border bg-muted p-2">
            <span
              className={cn(
                'flex h-7 w-7 items-center justify-center rounded-full text-[10px] font-bold text-white',
                running ? 'bg-amber-500 sdd-agent-live' : 'bg-slate-600',
              )}
            >
              {agentInitials(task.agentName)}
            </span>
            <div className="leading-tight">
              <div className="text-xs font-medium text-foreground">{task.agentName}</div>
              <div className="text-[10px] text-muted-foreground">
                {running ? 'working on this task' : 'assigned'}
              </div>
            </div>
          </div>
        )}

        {/* meta grid */}
        <div className="grid grid-cols-2 gap-1.5 text-[11px]">
          <Meta label="Priority">
            <span className={cn('font-medium uppercase', priorityStyle(task.priority).text)}>
              {task.priority}
            </span>
          </Meta>
          <Meta label="Type">{task.type}</Meta>
          {elapsed && (
            <Meta label={task.completedAt ? 'Duration' : 'Elapsed'}>
              <span className="flex items-center gap-1">
                <Clock className="h-3 w-3 text-muted-foreground" />
                {elapsed}
              </span>
            </Meta>
          )}
          {task.retries ? (
            <Meta label="Retries">
              <span className="flex items-center gap-1 text-red-400">
                <RotateCcw className="h-3 w-3" />
                {task.retries}
              </span>
            </Meta>
          ) : null}
          {task.worktreeBranch && (
            <Meta label="Worktree" full>
              <span
                className="flex items-center gap-1 font-mono text-foreground"
                title={task.worktreeBranch}
              >
                <GitBranch className="h-3 w-3 text-muted-foreground" />
                <span className="truncate">{task.worktreeBranch}</span>
              </span>
            </Meta>
          )}
        </div>

        {/* per-task model assignment (overrides the run default) */}
        <div>
          <div className="mb-1 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            Worker model
            {!task.model && defaultModel && (
              <span className="font-normal normal-case text-muted-foreground">
                · run default: {defaultModel}
              </span>
            )}
          </div>
          <ModelPicker
            value={task.model}
            provider={task.provider}
            candidates={modelCandidates}
            placeholder={defaultModel ? `Run default (${defaultModel})` : 'Run default'}
            onPick={(model, provider) => onSetModel(task.id, model, provider)}
            onReset={task.model ? () => onSetModel(task.id, undefined, undefined) : undefined}
          />
          {task.fallbackModels && task.fallbackModels.length > 0 && (
            <div className="mt-1 flex flex-wrap gap-1">
              {task.fallbackModels.map((f, i) => (
                <span
                  key={i}
                  className="rounded bg-muted px-1.5 py-0.5 font-mono text-[9px] text-muted-foreground"
                >
                  ↳ {f}
                </span>
              ))}
            </div>
          )}
        </div>

        {/* per-task verification command (completion gate) */}
        <div>
          <div className="mb-1 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            Verification command
            <span className="font-normal normal-case text-muted-foreground">
              · gates completion (exit 0)
            </span>
          </div>
          {verifyEditing ? (
            <div className="flex flex-col gap-1">
              <input
                autoFocus
                value={verifyText}
                onChange={(e) => setVerifyText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    onSetVerification(task.id, verifyText.trim() || undefined);
                    setVerifyEditing(false);
                  } else if (e.key === 'Escape') {
                    setVerifyText(task.verificationCommand ?? '');
                    setVerifyEditing(false);
                  }
                }}
                placeholder="e.g. pnpm vitest run path/to/file"
                className="w-full rounded border border-border bg-background px-2 py-1 font-mono text-[11px] text-foreground"
              />
              <div className="flex gap-1">
                <button
                  type="button"
                  onClick={() => {
                    onSetVerification(task.id, verifyText.trim() || undefined);
                    setVerifyEditing(false);
                  }}
                  className="rounded bg-primary px-2 py-0.5 text-[10px] text-primary-foreground hover:opacity-90"
                >
                  Save
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setVerifyText(task.verificationCommand ?? '');
                    setVerifyEditing(false);
                  }}
                  className="rounded bg-muted px-2 py-0.5 text-[10px] text-muted-foreground hover:bg-muted/80"
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : task.verificationCommand ? (
            <div className="flex items-center gap-1">
              <code className="flex-1 truncate rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-foreground">
                {task.verificationCommand}
              </code>
              <button
                type="button"
                onClick={() => setVerifyEditing(true)}
                className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-muted/80"
              >
                Edit
              </button>
              <button
                type="button"
                onClick={() => onSetVerification(task.id, undefined)}
                className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-muted/80"
              >
                Clear
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setVerifyEditing(true)}
              className="rounded border border-dashed border-border px-2 py-1 text-[10px] text-muted-foreground hover:bg-muted"
            >
              + Add verification command
            </button>
          )}
        </div>

        {/* description */}
        {task.description && (
          <div>
            <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              Description
            </div>
            <p className="whitespace-pre-wrap rounded-md bg-muted p-2 text-[11px] leading-relaxed text-foreground">
              {task.description}
            </p>
          </div>
        )}

        {/* per-task timeline (its own slice of the activity feed) */}
        {taskEvents.length > 0 && (
          <div>
            <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              Timeline
            </div>
            <div className="space-y-1 border-l border-border pl-2.5">
              {taskEvents.map((e, i) => (
                <div
                  key={`${e.ts}-${i}`}
                  className="relative text-[11px] leading-snug text-foreground"
                >
                  <span
                    className={cn(
                      'absolute -left-[14px] top-1 h-1.5 w-1.5 rounded-full',
                      e.kind === 'completed'
                        ? 'bg-emerald-400'
                        : e.kind === 'failed'
                          ? 'bg-red-400'
                          : e.kind === 'retrying'
                            ? 'bg-orange-400'
                            : 'bg-amber-400',
                    )}
                  />
                  {e.text}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* dependency chain */}
        {task.deps.length > 0 && (
          <DepList
            title="Depends on"
            shortIds={task.deps}
            byShort={byShort}
            onSelectTask={onSelectTask}
          />
        )}
        {dependents.length > 0 && (
          <DepList
            title="Blocks"
            shortIds={dependents.map((d) => d.shortId)}
            byShort={byShort}
            onSelectTask={onSelectTask}
          />
        )}
      </div>

      {/* actions — inline, no native alert/confirm/prompt */}
      <div className="border-t border-border p-2">
        {reassigning ? (
          <div className="sdd-rise flex items-center gap-1.5">
            <input
              autoFocus
              value={reassignName}
              onChange={(e) => setReassignName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submitReassign();
                if (e.key === 'Escape') setReassigning(false);
              }}
              placeholder="New worker name…"
              className="min-w-0 flex-1 rounded-md border border-border bg-background px-2 py-1.5 text-xs outline-none focus:border-violet-500"
            />
            <button
              type="button"
              onClick={submitReassign}
              disabled={!reassignName.trim()}
              className="rounded-md bg-violet-500/20 px-2 py-1.5 text-xs font-medium text-violet-700 dark:text-violet-200 hover:bg-violet-500/30 disabled:opacity-40"
            >
              <Check className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={() => setReassigning(false)}
              className="rounded-md bg-muted px-2 py-1.5 text-xs text-muted-foreground hover:bg-muted"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        ) : confirm ? (
          <div className="sdd-rise flex items-center gap-2">
            <span className="flex-1 text-xs text-foreground">
              {confirm === 'stop' ? 'Stop this running task?' : 'Delete this task from the run?'}
            </span>
            <button
              type="button"
              onClick={() => {
                if (confirm === 'stop') onCancel(task.id);
                else onDelete(task.id);
                setConfirm(null);
              }}
              className="inline-flex items-center gap-1 rounded-md bg-red-500/20 px-2.5 py-1.5 text-xs font-medium text-red-700 dark:text-red-200 hover:bg-red-500/30"
            >
              <Check className="h-3.5 w-3.5" /> {confirm === 'stop' ? 'Stop' : 'Delete'}
            </button>
            <button
              type="button"
              onClick={() => setConfirm(null)}
              className="rounded-md bg-muted px-2 py-1.5 text-xs text-muted-foreground hover:bg-muted"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        ) : (
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => onRetry(task.id)}
              title="Requeue this task to pending"
              className="inline-flex flex-1 items-center justify-center gap-1 rounded-md bg-orange-500/15 py-1.5 text-xs font-medium text-orange-600 dark:text-orange-300 hover:bg-orange-500/25"
            >
              <RotateCcw className="h-3.5 w-3.5" /> Retry
            </button>
            <button
              type="button"
              onClick={() => setReassigning(true)}
              className="inline-flex flex-1 items-center justify-center gap-1 rounded-md bg-violet-500/15 py-1.5 text-xs font-medium text-violet-600 dark:text-violet-300 hover:bg-violet-500/25"
            >
              <UserCog className="h-3.5 w-3.5" /> Reassign
            </button>
            {running && (
              <button
                type="button"
                onClick={() => setConfirm('stop')}
                title="Abort the worker on this task"
                className="inline-flex flex-1 items-center justify-center gap-1 rounded-md bg-red-500/15 py-1.5 text-xs font-medium text-red-600 dark:text-red-300 hover:bg-red-500/25"
              >
                <Square className="h-3.5 w-3.5" /> Stop
              </button>
            )}
            {!running && (
              <button
                type="button"
                onClick={() => setSplitting(true)}
                title="Split this task into sub-tasks delegated to separate workers"
                className="inline-flex flex-1 items-center justify-center gap-1 rounded-md bg-sky-500/15 py-1.5 text-xs font-medium text-sky-600 dark:text-sky-300 hover:bg-sky-500/25"
              >
                <Split className="h-3.5 w-3.5" /> Split
              </button>
            )}
            {deletable && (
              <button
                type="button"
                onClick={() => setConfirm('delete')}
                title="Remove this not-started task from the run"
                className="inline-flex flex-1 items-center justify-center gap-1 rounded-md bg-red-500/10 py-1.5 text-xs font-medium text-red-600 dark:text-red-300/90 hover:bg-red-500/20"
              >
                <Trash2 className="h-3.5 w-3.5" /> Delete
              </button>
            )}
          </div>
        )}
        {splitting && (
          <div className="mt-2 flex flex-col gap-2">
            <label className="text-[11px] text-muted-foreground" htmlFor="sdd-split-input">
              One sub-task per line — <code>Title :: description</code> (description optional)
            </label>
            <textarea
              id="sdd-split-input"
              autoFocus
              rows={3}
              value={splitText}
              onChange={(e) => setSplitText(e.target.value)}
              placeholder={'Write the data layer :: add the repository\nWire the UI'}
              className="w-full resize-y rounded-md border border-border bg-background px-2 py-1.5 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-sky-500"
            />
            <div className="flex gap-2">
              <button
                type="button"
                onClick={submitSplit}
                className="inline-flex flex-1 items-center justify-center gap-1 rounded-md bg-sky-500/20 py-1.5 text-xs font-medium text-sky-700 dark:text-sky-200 hover:bg-sky-500/30"
              >
                <Split className="h-3.5 w-3.5" /> Split into sub-tasks
              </button>
              <button
                type="button"
                onClick={() => {
                  setSplitting(false);
                  setSplitText('');
                }}
                className="rounded-md bg-muted px-2 py-1.5 text-xs text-muted-foreground hover:bg-muted"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function Meta({
  label,
  children,
  full,
}: {
  label: string;
  children: React.ReactNode;
  full?: boolean;
}) {
  return (
    <div
      className={cn('rounded-md border border-border bg-muted/50 px-2 py-1', full && 'col-span-2')}
    >
      <div className="text-[9px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="text-foreground">{children}</div>
    </div>
  );
}

function DepList({
  title,
  shortIds,
  byShort,
  onSelectTask,
}: {
  title: string;
  shortIds: string[];
  byShort: Map<string, BoardTaskItem>;
  onSelectTask: (id: string) => void;
}) {
  return (
    <div>
      <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </div>
      <div className="flex flex-wrap gap-1">
        {shortIds.map((sid) => {
          const dep = byShort.get(sid);
          return (
            <button
              key={sid}
              type="button"
              disabled={!dep}
              onClick={() => dep && onSelectTask(dep.id)}
              className="flex items-center gap-1 rounded-full border border-border bg-muted px-2 py-0.5 text-[10px] text-foreground hover:bg-muted disabled:opacity-50"
              title={dep?.title}
            >
              <span
                className={cn(
                  'h-1.5 w-1.5 rounded-full',
                  statusStyle(dep?.displayStatus ?? 'pending').dot,
                )}
              />
              <span className="font-mono">{sid}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
