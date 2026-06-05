import { cn } from '@/lib/utils';
import { CheckCircle2, Circle, Clock, Pause, RotateCcw, XCircle } from 'lucide-react';
import type React from 'react';

export interface TaskItem {
  id: string;
  title: string;
  description: string;
  status: 'pending' | 'in_progress' | 'blocked' | 'failed' | 'review' | 'completed';
  priority: 'critical' | 'high' | 'medium' | 'low';
  type: 'feature' | 'bugfix' | 'refactor' | 'docs' | 'test' | 'chore';
  estimateHours?: number;
  actualHours?: number;
  assignee?: string;
  tags: string[];
  startedAt?: number;
  completedAt?: number;
}

export interface TaskBoardProps {
  phaseName: string;
  phaseStatus: string;
  tasks: TaskItem[];
  /** Task tıklandığında */
  onTaskClick?: (taskId: string) => void;
  /** Task durumunu değiştir */
  onTaskStatusChange?: (taskId: string, status: TaskItem['status']) => void;
  className?: string;
}

// Token-driven so every state reads correctly in both light and dark. Status
// colors lean on the shared semantic vars (--success / --warning / --info /
// primary); badges use translucent tints that sit on either background.
const TASK_STATUS_CONFIG: Record<
  TaskItem['status'],
  { icon: React.ReactNode; color: string; label: string }
> = {
  pending: { icon: <Circle className="w-4 h-4" />, color: 'text-muted-foreground', label: 'Bekliyor' },
  in_progress: { icon: <Clock className="w-4 h-4 animate-spin" />, color: 'text-primary', label: 'Çalışıyor' },
  blocked: { icon: <Pause className="w-4 h-4" />, color: 'text-[hsl(var(--warning))]', label: 'Bloklu' },
  failed: { icon: <XCircle className="w-4 h-4" />, color: 'text-destructive', label: 'Başarısız' },
  review: { icon: <RotateCcw className="w-4 h-4" />, color: 'text-[hsl(var(--info))]', label: 'İncelemede' },
  completed: { icon: <CheckCircle2 className="w-4 h-4" />, color: 'text-[hsl(var(--success))]', label: 'Tamamlandı' },
};

const PRIORITY_BADGE: Record<TaskItem['priority'], string> = {
  critical: 'bg-destructive/15 text-destructive',
  high: 'bg-orange-500/15 text-orange-600 dark:text-orange-400',
  medium: 'bg-[hsl(var(--info)/0.15)] text-[hsl(var(--info))]',
  low: 'bg-muted text-muted-foreground',
};

const TYPE_BADGE: Record<TaskItem['type'], string> = {
  feature: 'bg-[hsl(var(--success)/0.15)] text-[hsl(var(--success))]',
  bugfix: 'bg-destructive/15 text-destructive',
  refactor: 'bg-violet-500/15 text-violet-600 dark:text-violet-400',
  docs: 'bg-sky-500/15 text-sky-600 dark:text-sky-400',
  test: 'bg-primary/15 text-primary',
  chore: 'bg-muted text-muted-foreground',
};

function formatTime(ms?: number): string {
  if (!ms) return '';
  const m = Math.floor(ms / 60000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return rem > 0 ? `${h}h ${rem}m` : `${h}h`;
}

/**
 * TaskBoard — Sağda duran görev listesi.
 *
 * Seçili fazın tüm görevlerini kartlar halinde gösterir.
 * Her görevde: durum, öncelik, tip, tahmini süre, agent atanması.
 */
export function TaskBoard({
  phaseName,
  phaseStatus,
  tasks,
  onTaskClick,
  onTaskStatusChange,
  className,
}: TaskBoardProps): React.ReactElement {
  // Task'ları duruma göre grupla
  const grouped = {
    in_progress: tasks.filter((t) => t.status === 'in_progress'),
    pending: tasks.filter((t) => t.status === 'pending' || t.status === 'blocked'),
    completed: tasks.filter((t) => t.status === 'completed'),
    failed: tasks.filter((t) => t.status === 'failed'),
    review: tasks.filter((t) => t.status === 'review'),
  };

  const statusOrder = ['in_progress', 'pending', 'review', 'failed', 'completed'] as const;

  return (
    <div className={cn('flex flex-col h-full bg-background', className)}>
      {/* Header */}
      <div className="p-4 border-b border-border">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold text-foreground">{phaseName}</h2>
            <p className="text-sm text-muted-foreground mt-0.5">
              {tasks.length} görev • {tasks.filter((t) => t.status === 'completed').length} tamamlandı
            </p>
          </div>
          <div className={cn(
            'px-3 py-1 rounded-full text-xs font-medium',
            phaseStatus === 'running' ? 'bg-primary/15 text-primary' :
            phaseStatus === 'completed' ? 'bg-[hsl(var(--success)/0.15)] text-[hsl(var(--success))]' :
            phaseStatus === 'failed' ? 'bg-destructive/15 text-destructive' :
            'bg-muted text-muted-foreground',
          )}>
            {phaseStatus === 'running' ? 'Çalışıyor' :
             phaseStatus === 'completed' ? 'Tamamlandı' :
             phaseStatus === 'failed' ? 'Başarısız' :
             phaseStatus === 'paused' ? 'Duraklatıldı' :
             phaseStatus === 'ready' ? 'Hazır' : 'Bekliyor'}
          </div>
        </div>
      </div>

      {/* Task Groups */}
      <div className="flex-1 overflow-y-auto p-4 space-y-6">
        {statusOrder.map((groupKey) => {
          const groupTasks = grouped[groupKey];
          if (groupTasks.length === 0) return null;

          const groupLabel = {
            in_progress: 'Çalışıyor',
            pending: 'Bekliyor',
            review: 'İncelemede',
            failed: 'Başarısız',
            completed: 'Tamamlandı',
          }[groupKey];

          return (
            <div key={groupKey}>
              <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">
                {groupLabel} ({groupTasks.length})
              </h3>
              <div className="space-y-2">
                {groupTasks.map((task) => {
                  const status = TASK_STATUS_CONFIG[task.status];

                  return (
                    <button
                      type="button"
                      key={task.id}
                      onClick={() => onTaskClick?.(task.id)}
                      className={cn(
                        'w-full text-left rounded-lg border p-3 transition-all hover:shadow-sm hover:border-primary/40 cursor-pointer',
                        task.status === 'in_progress'
                          ? 'border-primary/40 bg-primary/5'
                          : task.status === 'completed'
                            ? 'border-[hsl(var(--success)/0.35)] bg-[hsl(var(--success)/0.06)]'
                            : task.status === 'failed'
                              ? 'border-destructive/40 bg-destructive/5'
                              : 'border-border bg-card',
                      )}
                    >
                      {/* Task Header */}
                      <div className="flex items-start gap-2">
                        <span className={cn('mt-0.5', status.color)}>{status.icon}</span>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="text-sm font-medium">{task.title}</span>
                            <span className={cn('px-1.5 py-0.5 rounded text-[10px] font-medium', PRIORITY_BADGE[task.priority])}>
                              {task.priority}
                            </span>
                            <span className={cn('px-1.5 py-0.5 rounded text-[10px] font-medium', TYPE_BADGE[task.type])}>
                              {task.type}
                            </span>
                          </div>
                          <p className="text-xs text-muted-foreground mt-1 line-clamp-2">
                            {task.description}
                          </p>
                        </div>
                      </div>

                      {/* Task Meta */}
                      <div className="flex items-center gap-3 mt-2 text-xs text-muted-foreground">
                        {task.estimateHours && (
                          <span>~{task.estimateHours}h</span>
                        )}
                        {task.actualHours && (
                          <span>• {task.actualHours}h</span>
                        )}
                        {task.assignee && (
                          <span>• {task.assignee}</span>
                        )}
                        {task.startedAt && (
                          <span>• {formatTime(Date.now() - task.startedAt)}</span>
                        )}
                      </div>

                      {/* Tags */}
                      {task.tags.length > 0 && (
                        <div className="flex flex-wrap gap-1 mt-2">
                          {task.tags.map((tag) => (
                            <span
                              key={tag}
                              className="px-1.5 py-0.5 rounded text-[10px] bg-muted text-muted-foreground"
                            >
                              {tag}
                            </span>
                          ))}
                        </div>
                      )}

                      {/* Quick Actions */}
                      {onTaskStatusChange && task.status !== 'completed' && (
                        <div className="flex gap-1 mt-2">
                          {task.status !== 'in_progress' && (
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                onTaskStatusChange(task.id, 'in_progress');
                              }}
                              className="px-2 py-0.5 text-[10px] rounded bg-primary/15 text-primary hover:bg-primary/25 transition-colors"
                            >
                              Başlat
                            </button>
                          )}
                          {task.status === 'in_progress' && (
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                onTaskStatusChange(task.id, 'completed');
                              }}
                              className="px-2 py-0.5 text-[10px] rounded bg-[hsl(var(--success)/0.15)] text-[hsl(var(--success))] hover:bg-[hsl(var(--success)/0.25)] transition-colors"
                            >
                              Tamamla
                            </button>
                          )}
                          {task.status !== 'failed' && (
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                onTaskStatusChange(task.id, 'failed');
                              }}
                              className="px-2 py-0.5 text-[10px] rounded bg-destructive/15 text-destructive hover:bg-destructive/25 transition-colors"
                            >
                              Başarısız
                            </button>
                          )}
                        </div>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
