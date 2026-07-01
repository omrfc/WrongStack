import { cn } from '@/lib/utils';
import type React from 'react';
import { TaskCard, type TaskItem } from './TaskCard';

// Re-exported so existing importers (`PhasePanel`, `AutoPhaseView`) keep working
// after the card was extracted into its own reusable component.
export type { TaskItem } from './TaskCard';

export interface TaskBoardProps {
  phaseName: string;
  phaseStatus: string;
  tasks: TaskItem[];
  /** Change task status */
  onTaskStatusChange?: (taskId: string, status: TaskItem['status']) => void;
  className?: string | undefined;
}

/**
 * TaskBoard — chat-area task list for a single selected phase.
 *
 * Groups the phase's tasks by status into stacked sections. The full kanban
 * (phase columns / status swimlanes, drag-drop, manual assignment) lives in
 * BoardView; this stays the compact in-context list.
 */
export function TaskBoard({
  phaseName,
  phaseStatus,
  tasks,
  onTaskStatusChange,
  className,
}: TaskBoardProps): React.ReactElement {
  const grouped = {
    in_progress: tasks.filter((t) => t.status === 'in_progress'),
    pending: tasks.filter((t) => t.status === 'pending' || t.status === 'blocked'),
    review: tasks.filter((t) => t.status === 'review'),
    failed: tasks.filter((t) => t.status === 'failed'),
    completed: tasks.filter((t) => t.status === 'completed'),
  };

  const statusOrder = ['in_progress', 'pending', 'review', 'failed', 'completed'] as const;
  const groupLabels: Record<(typeof statusOrder)[number], string> = {
    in_progress: 'In Progress',
    pending: 'Pending',
    review: 'Review',
    failed: 'Failed',
    completed: 'Completed',
  };

  return (
    <div className={cn('flex h-full min-h-0 min-w-0 flex-col bg-background', className)}>
      {/* Header */}
      <div className="p-4 border-b border-border">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold text-foreground">{phaseName}</h2>
            <p className="text-sm text-muted-foreground mt-0.5">
              {tasks.length} tasks · {tasks.filter((t) => t.status === 'completed').length} completed
            </p>
          </div>
          <div
            className={cn(
              'px-3 py-1 rounded-full text-xs font-medium',
              phaseStatus === 'running'
                ? 'bg-primary/15 text-primary'
                : phaseStatus === 'completed'
                  ? 'bg-[hsl(var(--success)/0.15)] text-[hsl(var(--success))]'
                  : phaseStatus === 'failed'
                    ? 'bg-destructive/15 text-destructive'
                    : 'bg-muted text-muted-foreground',
            )}
          >
            {phaseStatus === 'running'
              ? 'Running'
              : phaseStatus === 'completed'
                ? 'Completed'
                : phaseStatus === 'failed'
                  ? 'Failed'
                  : phaseStatus === 'paused'
                    ? 'Paused'
                    : phaseStatus === 'ready'
                      ? 'Ready'
                      : 'Pending'}
          </div>
        </div>
      </div>

      {/* Task Groups */}
      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto p-4 space-y-6">
        {statusOrder.map((groupKey) => {
          const groupTasks = grouped[groupKey];
          if (groupTasks.length === 0) return null;
          return (
            <div key={groupKey}>
              <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">
                {groupLabels[groupKey]} ({groupTasks.length})
              </h3>
              <div className="space-y-2">
                {groupTasks.map((task) => (
                  <TaskCard key={task.id} task={task} onStatusChange={onTaskStatusChange} />
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
