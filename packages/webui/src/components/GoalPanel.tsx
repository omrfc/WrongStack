import { cn } from '@/lib/utils';
import {
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Circle,
  Clock,
  Target,
  TrendingDown,
  TrendingUp,
  Minus,
} from 'lucide-react';
import { type ReactNode, useCallback, useEffect, useState } from 'react';
import { type GoalState } from '@/lib/goal';
import { getWSClient } from '@/lib/ws-client';

// ── Helpers ────────────────────────────────────────────────────────────────

const TREND_ICON: Record<string, ReactNode> = {
  up: <TrendingUp className="h-3.5 w-3.5 text-emerald-500" />,
  down: <TrendingDown className="h-3.5 w-3.5 text-red-500" />,
  stable: <Minus className="h-3.5 w-3.5 text-amber-500" />,
};

const STATE_CONFIG: Record<GoalState['goalState'], { color: string; bg: string; label: string }> = {
  active: {
    color: 'text-emerald-600 dark:text-emerald-400',
    bg: 'bg-emerald-100 dark:bg-emerald-900/40',
    label: 'Active',
  },
  paused: {
    color: 'text-amber-600 dark:text-amber-400',
    bg: 'bg-amber-100 dark:bg-amber-900/40',
    label: 'Paused',
  },
  completed: {
    color: 'text-blue-600 dark:text-blue-400',
    bg: 'bg-blue-100 dark:bg-blue-900/40',
    label: 'Done',
  },
  failed: {
    color: 'text-red-600 dark:text-red-400',
    bg: 'bg-red-100 dark:bg-red-900/40',
    label: 'Failed',
  },
};

// ── Component ──────────────────────────────────────────────────────────────

export interface GoalPanelProps {
  goal: GoalState | null;
  className?: string | undefined;
}

export function GoalPanel({ goal, className }: GoalPanelProps): React.ReactElement | null {
  const [collapsed, setCollapsed] = useState(false);

  // Request goal data on mount and poll every 10s so the panel stays
  // in sync with the disk (goal.json is written by the agent / CLI).
  useEffect(() => {
    const ws = getWSClient();
    ws?.send?.({ type: 'goal.get' });
    const timer = setInterval(() => {
      ws?.send?.({ type: 'goal.get' });
    }, 10_000);
    return () => clearInterval(timer);
  }, []);

  // Hide the panel when there's no goal, or when the goal is terminal
  // (completed / failed) — it's served its purpose and shouldn't linger.
  if (!goal) return null;
  if (goal.goalState === 'completed' || goal.goalState === 'failed') return null;

  // Auto-collapse when goal state changes (e.g. completed → null)
  useEffect(() => {
    if (!goal || goal.goalState === 'completed' || goal.goalState === 'failed') {
      setCollapsed(true);
    }
  }, [goal]);

  const stateCfg = STATE_CONFIG[goal.goalState];
  const completedDeliverables =
    goal.deliverables?.filter((d) => d.status === 'done').length ?? 0;
  const totalDeliverables = goal.deliverables?.length ?? 0;
  const recentJournal = goal.journal?.slice(-5).reverse() ?? [];
  const trendIcon = goal.progressTrend ? TREND_ICON[goal.progressTrend] : null;

  return (
    <div className={cn('rounded-lg border border-border bg-card/60 backdrop-blur-sm', className)}>
      {/* Header */}
      <button
        type="button"
        onClick={() => setCollapsed((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2.5 text-left hover:bg-accent/40 rounded-t-lg transition-colors"
      >
        <Target className="h-4 w-4 text-rose-500" />
        <span className="text-xs font-semibold text-foreground flex-1 min-w-0 truncate">
          Goal
        </span>
        <span
          className={cn(
            'inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px] font-medium shrink-0',
            stateCfg.bg,
            stateCfg.color,
          )}
        >
          {stateCfg.label}
        </span>
        {collapsed ? (
          <ChevronRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
        ) : (
          <ChevronDown className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
        )}
      </button>

      {!collapsed && (
        <div className="px-3 pb-3 space-y-3 border-t pt-2">
          {/* Goal text */}
          <div>
            <p className="text-xs text-foreground leading-relaxed whitespace-pre-wrap break-words">
              {goal.goal}
            </p>
            {goal.refinedGoal && goal.refinedGoal !== goal.goal && (
              <div className="mt-1.5 p-2 rounded bg-accent/40 border border-border/50">
                <p className="text-[10px] text-muted-foreground mb-0.5 uppercase tracking-wider font-medium">
                  Refined
                </p>
                <p className="text-xs leading-relaxed whitespace-pre-wrap break-words">
                  {goal.refinedGoal}
                </p>
              </div>
            )}
          </div>

          {/* Progress bar */}
          <div className="space-y-1">
            <div className="flex items-center justify-between text-[10px]">
              <span className="text-muted-foreground uppercase tracking-wider font-medium">
                Progress
              </span>
              <span className="flex items-center gap-1 tabular-nums">
                {trendIcon}
                <span className="font-medium text-foreground">{goal.progress}%</span>
              </span>
            </div>
            <div className="h-1.5 bg-muted rounded-full overflow-hidden">
              <div
                className={cn(
                  'h-full transition-all duration-700 rounded-full',
                  goal.progress >= 80
                    ? 'bg-emerald-500'
                    : goal.progress >= 50
                      ? 'bg-amber-500'
                      : 'bg-primary',
                )}
                style={{ width: `${Math.max(2, goal.progress)}%` }}
              />
            </div>
            {goal.progressNote && (
              <p className="text-[10px] text-muted-foreground italic">{goal.progressNote}</p>
            )}
          </div>

          {/* Iteration count */}
          <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
            <Clock className="h-3 w-3" />
            <span className="tabular-nums font-medium">{goal.iterations}</span>
            <span>iterations</span>
            {goal.lastStatus && <span className="text-border">·</span>}
            {goal.lastStatus && <span className="truncate">{goal.lastStatus}</span>}
          </div>

          {/* Deliverables */}
          {totalDeliverables > 0 && (
            <div className="space-y-1">
              <div className="flex items-center justify-between text-[10px] text-muted-foreground uppercase tracking-wider font-medium">
                <span>Deliverables</span>
                <span className="tabular-nums">
                  {completedDeliverables}/{totalDeliverables}
                </span>
              </div>
              <ul className="space-y-0.5">
                {goal.deliverables!.map((d) => (
                  <li key={d.id} className="flex items-start gap-1.5 text-[11px]">
                    {d.status === 'done' ? (
                      <CheckCircle2 className="h-3 w-3 text-emerald-500 mt-0.5 shrink-0" />
                    ) : (
                      <Circle className="h-3 w-3 text-muted-foreground/50 mt-0.5 shrink-0" />
                    )}
                    <span
                      className={cn(
                        'leading-snug',
                        d.status === 'done'
                          ? 'text-muted-foreground line-through'
                          : 'text-foreground',
                      )}
                    >
                      {d.text}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Recent journal */}
          {recentJournal.length > 0 && (
            <div className="space-y-1">
              <p className="text-[10px] text-muted-foreground uppercase tracking-wider font-medium">
                Recent Activity
              </p>
              <div className="space-y-1">
                {recentJournal.map((entry, i) => (
                  <div
                    key={`${entry.iteration}-${i}`}
                    className="flex items-start gap-1.5 text-[10px] text-muted-foreground"
                  >
                    <span className="font-mono tabular-nums shrink-0 text-foreground/60">
                      #{entry.iteration}
                    </span>
                    <span className="truncate">
                      {entry.task || entry.status || entry.progressNote || '…'}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
