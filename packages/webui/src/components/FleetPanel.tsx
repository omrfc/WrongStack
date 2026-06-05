import { cn } from '@/lib/utils';
import { type SubagentView, useFleetStore } from '@/stores';
import { Bot, ChevronDown, ChevronRight, Cpu, Wrench, Zap } from 'lucide-react';
import { useMemo, useState } from 'react';

/** Status → LED color + label. Running pulses; terminal states are steady. */
const STATUS_META: Record<
  SubagentView['status'],
  { tone: string; led: string; label: string; pulse: boolean }
> = {
  running: {
    tone: 'text-[hsl(var(--success))]',
    led: 'text-[hsl(var(--success))]',
    label: 'running',
    pulse: true,
  },
  completed: {
    tone: 'text-muted-foreground',
    led: 'text-[hsl(var(--success))]',
    label: 'done',
    pulse: false,
  },
  failed: {
    tone: 'text-destructive',
    led: 'text-destructive',
    label: 'failed',
    pulse: false,
  },
  timeout: {
    tone: 'text-[hsl(var(--warning))]',
    led: 'text-[hsl(var(--warning))]',
    label: 'timeout',
    pulse: false,
  },
  stopped: {
    tone: 'text-muted-foreground',
    led: 'text-muted-foreground',
    label: 'stopped',
    pulse: false,
  },
};

function fmtCost(v: number): string {
  if (v <= 0) return '$0';
  if (v >= 0.01) return `$${v.toFixed(3)}`;
  return `$${v.toFixed(5).replace(/0+$/, '').replace(/\.$/, '')}`;
}

function AgentCard({ a }: { a: SubagentView }): React.ReactElement {
  const meta = STATUS_META[a.status];
  const active = a.status === 'running';
  const tool = a.currentTool ?? a.lastTool;
  return (
    <div
      className={cn(
        'flex min-w-[15rem] max-w-[18rem] flex-col gap-1.5 rounded-lg border p-2.5 transition-colors',
        active ? 'border-primary/30 bg-primary/[0.04]' : 'border-border bg-card opacity-90',
      )}
    >
      {/* Identity row */}
      <div className="flex items-center gap-2 min-w-0">
        <span className={cn('led shrink-0', meta.led, meta.pulse && 'led-pulse')} />
        <span className="truncate text-xs font-semibold text-foreground" title={a.name}>
          {a.name}
        </span>
        <span className={cn('ml-auto shrink-0 text-[10px] uppercase tracking-wider', meta.tone)}>
          {meta.label}
        </span>
      </div>

      {/* Model */}
      {a.model && (
        <div className="flex items-center gap-1 text-[10px] text-muted-foreground min-w-0">
          <Cpu className="h-3 w-3 shrink-0" />
          <span className="truncate font-mono" title={`${a.provider ?? ''}/${a.model}`}>
            {a.model}
          </span>
        </div>
      )}

      {/* Live counters */}
      <div className="tabular flex items-center gap-2 text-[11px] text-muted-foreground">
        <span title="iteration">L{a.iteration}</span>
        <span className="text-border">·</span>
        <span title="tool calls">{a.toolCalls} tools</span>
        <span className="text-border">·</span>
        <span className="text-foreground/80" title="cost so far">
          {fmtCost(a.costUsd)}
        </span>
        {a.extensions > 0 && (
          <span
            className="ml-auto inline-flex items-center gap-0.5 rounded bg-primary/15 px-1 text-[10px] text-primary"
            title={`Self-extended budget ${a.extensions}×`}
          >
            <Zap className="h-2.5 w-2.5" />
            {a.extensions}
          </span>
        )}
      </div>

      {/* Current/last tool */}
      {tool && (
        <div
          className={cn(
            'flex items-center gap-1 text-[10px] truncate',
            active ? 'text-primary' : 'text-muted-foreground',
          )}
          title={a.currentTool ? `running ${tool}` : `last ran ${tool}`}
        >
          <Wrench className={cn('h-3 w-3 shrink-0', active && 'animate-pulse')} />
          <span className="truncate font-mono">{tool}</span>
        </div>
      )}

      {/* Context fill bar */}
      {a.maxContext > 0 && (
        <div className="flex items-center gap-1.5" title={`Context ${a.ctxPct}%`}>
          <div className="h-1 flex-1 overflow-hidden rounded-full bg-muted">
            <div
              className={cn(
                'h-full rounded-full transition-all duration-500',
                a.ctxPct >= 85
                  ? 'bg-destructive'
                  : a.ctxPct >= 70
                    ? 'bg-[hsl(var(--warning))]'
                    : 'bg-primary',
              )}
              style={{ width: `${Math.max(2, a.ctxPct)}%` }}
            />
          </div>
          <span className="tabular text-[9px] text-muted-foreground">{a.ctxPct}%</span>
        </div>
      )}

      {/* Failure reason */}
      {a.error && (
        <div
          className="truncate rounded bg-destructive/10 px-1.5 py-0.5 text-[10px] text-destructive"
          title={a.error.message}
        >
          {a.error.kind}: {a.error.message}
        </div>
      )}
    </div>
  );
}

/**
 * FleetPanel — live roster of subagents spawned during a multi-agent run.
 *
 * Driven entirely by the `subagent.event` WS stream (reduced in useFleetStore).
 * Renders nothing when the fleet is empty, so a solo session is unaffected.
 * Collapsible so a large fleet doesn't dominate the chat column.
 */
export function FleetPanel({ className }: { className?: string }): React.ReactElement | null {
  const agents = useFleetStore((s) => s.agents);
  const [collapsed, setCollapsed] = useState(false);

  // Stable order: running first, then by start time. Recompute only when the
  // map identity changes (the store always sets a fresh Map on update).
  const list = useMemo(() => {
    const arr = Array.from(agents.values());
    arr.sort((x, y) => {
      const xa = x.status === 'running' ? 0 : 1;
      const ya = y.status === 'running' ? 0 : 1;
      if (xa !== ya) return xa - ya;
      return x.startedAt - y.startedAt;
    });
    return arr;
  }, [agents]);

  if (list.length === 0) return null;
  const activeCount = list.filter((a) => a.status === 'running').length;

  return (
    <div className={cn('rounded-lg border border-border bg-card/50 backdrop-blur-sm', className)}>
      <button
        type="button"
        onClick={() => setCollapsed((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left"
      >
        <Bot className="h-4 w-4 text-primary" />
        <span className="text-xs font-semibold text-foreground">Fleet</span>
        <span className="tabular text-[10px] text-muted-foreground">
          {list.length} agent{list.length === 1 ? '' : 's'}
          {activeCount > 0 && (
            <span className="text-[hsl(var(--success))]"> · {activeCount} active</span>
          )}
        </span>
        {activeCount > 0 && (
          <span className="led led-pulse text-[hsl(var(--success))]" aria-hidden />
        )}
        {collapsed ? (
          <ChevronRight className="ml-auto h-4 w-4 text-muted-foreground" />
        ) : (
          <ChevronDown className="ml-auto h-4 w-4 text-muted-foreground" />
        )}
      </button>
      {!collapsed && (
        <div className="flex gap-2 overflow-x-auto px-3 pb-3 pt-0.5">
          {list.map((a) => (
            <AgentCard key={a.id} a={a} />
          ))}
        </div>
      )}
    </div>
  );
}
