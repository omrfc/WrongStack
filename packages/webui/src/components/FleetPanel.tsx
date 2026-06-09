import { cn } from '@/lib/utils';
import { type SubagentView, useFleetStore } from '@/stores';
import { Bot, ChevronDown, ChevronRight, Clock, Cpu, Wrench, X } from 'lucide-react';
import { useMemo, useState } from 'react';

/** Status → LED color + label. */
const STATUS_META: Record<
  SubagentView['status'],
  { led: string; label: string; pulse: boolean }
> = {
  running: { led: 'text-[hsl(var(--success))]', label: 'running', pulse: true },
  completed: { led: 'text-[hsl(var(--success))]', label: 'done', pulse: false },
  failed: { led: 'text-destructive', label: 'failed', pulse: false },
  timeout: { led: 'text-[hsl(var(--warning))]', label: 'timeout', pulse: false },
  stopped: { led: 'text-muted-foreground', label: 'stopped', pulse: false },
};

function fmtCost(v: number): string {
  if (v <= 0) return '$0';
  if (v >= 0.01) return `$${v.toFixed(3)}`;
  return `$${v.toFixed(5)}`.replace(/0+$/, '').replace(/\.$/, '');
}

function fmtTok(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function fmtDuration(ms: number): string {
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  return `${min}m ${sec % 60}s`;
}

// ── Agent detail overlay ──────────────────────────────────────────────

function AgentDetail({
  agent,
  onClose,
}: {
  agent: SubagentView;
  onClose: () => void;
}): React.ReactElement {
  const meta = STATUS_META[agent.status];
  const active = agent.status === 'running';
  const tool = agent.currentTool ?? agent.lastTool;
  const elapsed = Date.now() - agent.startedAt;
  const ctxTone =
    agent.ctxPct >= 85
      ? 'bg-red-500/15 text-red-600 dark:text-red-400'
      : agent.ctxPct >= 70
        ? 'bg-amber-500/15 text-amber-600 dark:text-amber-400'
        : 'bg-muted text-muted-foreground';

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[10vh] bg-black/40 backdrop-blur-sm">
      <div className="w-full max-w-xl max-h-[80vh] overflow-y-auto rounded-xl border bg-card shadow-2xl">
        {/* Header */}
        <div
          className={cn(
            'flex items-center justify-between px-4 py-3 border-b',
            active ? 'border-primary/20' : 'border-border',
          )}
        >
          <div className="flex items-center gap-2">
            <span className={cn('led', meta.led, meta.pulse && 'led-pulse')} />
            <h3 className="text-sm font-semibold">{agent.name}</h3>
            <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
              {meta.label}
            </span>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1 rounded-md hover:bg-muted transition-colors"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Body */}
        <div className="p-4 space-y-4">
          {/* Description / Task */}
          {agent.description && (
            <div className="text-xs text-muted-foreground leading-relaxed">
              {agent.description}
            </div>
          )}

          {/* Stats grid */}
          <div className="grid grid-cols-2 gap-2">
            <div className="rounded-lg border bg-muted/30 px-3 py-2">
              <span className="text-[10px] text-muted-foreground">Provider / Model</span>
              <div className="flex items-center gap-1 mt-0.5">
                <Cpu className="h-3 w-3 text-muted-foreground" />
                <span className="text-xs font-mono font-medium">
                  {agent.provider ?? '?'}/{agent.model ?? '?'}
                </span>
              </div>
            </div>
            <div className="rounded-lg border bg-muted/30 px-3 py-2">
              <span className="text-[10px] text-muted-foreground">Elapsed</span>
              <div className="flex items-center gap-1 mt-0.5">
                <Clock className="h-3 w-3 text-muted-foreground" />
                <span className="text-xs font-mono tabular">{fmtDuration(elapsed)}</span>
                {active && (
                  <span className="text-[10px] text-[hsl(var(--success))]">· running</span>
                )}
              </div>
            </div>
            <div className="rounded-lg border bg-muted/30 px-3 py-2">
              <span className="text-[10px] text-muted-foreground">Iterations</span>
              <span className="block text-xs font-mono font-medium mt-0.5 tabular">
                {agent.iteration}
              </span>
            </div>
            <div className="rounded-lg border bg-muted/30 px-3 py-2">
              <span className="text-[10px] text-muted-foreground">Tool Calls</span>
              <span className="block text-xs font-mono font-medium mt-0.5 tabular">
                {agent.toolCalls}
              </span>
            </div>
            <div className="rounded-lg border bg-muted/30 px-3 py-2">
              <span className="text-[10px] text-muted-foreground">Cost</span>
              <span className="block text-xs font-mono font-medium mt-0.5 tabular">
                {fmtCost(agent.costUsd)}
              </span>
            </div>
            {agent.extensions > 0 && (
              <div className="rounded-lg border bg-muted/30 px-3 py-2">
                <span className="text-[10px] text-muted-foreground">Budget Extensions</span>
                <span className="block text-xs font-mono font-medium mt-0.5 tabular">
                  {agent.extensions}
                </span>
              </div>
            )}
          </div>

          {/* Context bar */}
          {agent.maxContext > 0 && (
            <div className="space-y-1">
              <div className="flex items-center justify-between text-[10px]">
                <span className="text-muted-foreground">Context window</span>
                <span className={cn('tabular font-medium', ctxTone.replace(/bg-\S+\s*/g, ''))}>
                  {agent.ctxPct}%
                </span>
              </div>
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                <div
                  className={cn(
                    'h-full rounded-full transition-all',
                    agent.ctxPct >= 85
                      ? 'bg-destructive'
                      : agent.ctxPct >= 70
                        ? 'bg-[hsl(var(--warning))]'
                        : 'bg-primary',
                  )}
                  style={{ width: `${Math.max(2, agent.ctxPct)}%` }}
                />
              </div>
              <div className="text-[10px] text-muted-foreground tabular text-right">
                {fmtTok(agent.ctxTokens)} / {fmtTok(agent.maxContext)} tokens
              </div>
            </div>
          )}

          {/* Current tool */}
          {tool && (
            <div
              className={cn(
                'flex items-center gap-2 rounded-lg border px-3 py-2',
                active ? 'border-primary/30 bg-primary/[0.04]' : 'border-border bg-muted/30',
              )}
            >
              <Wrench className={cn('h-3.5 w-3.5', active ? 'text-primary animate-pulse' : 'text-muted-foreground')} />
              <span className="text-xs font-mono">{tool}</span>
              <span className="text-[10px] text-muted-foreground ml-auto">
                {agent.currentTool ? 'running…' : 'last tool'}
              </span>
            </div>
          )}

          {/* Error */}
          {agent.error && (
            <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3">
              <span className="text-[10px] font-semibold text-destructive uppercase tracking-wider">
                Error
              </span>
              <p className="text-xs text-destructive/90 mt-1 leading-relaxed">
                {agent.error.message}
              </p>
            </div>
          )}

          {/* Output placeholder */}
          <div className="rounded-lg border border-dashed border-border p-4 text-center space-y-1">
            <span className="text-xs text-muted-foreground">
              Agent output stream coming soon
            </span>
            <p className="text-[10px] text-muted-foreground/60">
              Real-time text deltas and tool results will appear here once the backend
              forwards subagent message content to the WebUI.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Agent card (clickable) ────────────────────────────────────────────

function AgentCard({
  a,
  onClick,
}: {
  a: SubagentView;
  onClick: () => void;
}): React.ReactElement {
  const meta = STATUS_META[a.status];
  const active = a.status === 'running';
  const tool = a.currentTool ?? a.lastTool;
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex min-w-[12rem] max-w-[15rem] flex-col gap-1 rounded-lg border p-2 transition-colors text-left cursor-pointer',
        'hover:border-primary/40 hover:bg-primary/[0.06]',
        active ? 'border-primary/30 bg-primary/[0.04]' : 'border-border bg-card opacity-85',
      )}
    >
      {/* Identity row */}
      <div className="flex items-center gap-1.5 min-w-0">
        <span className={cn('led shrink-0', meta.led, meta.pulse && 'led-pulse')} />
        <span className="truncate text-[11px] font-semibold text-foreground" title={a.name}>
          {a.name}
        </span>
        <span className="tabular ml-auto shrink-0 text-[10px] text-muted-foreground">
          {a.iteration}it · {a.toolCalls}t
        </span>
      </div>

      {/* Model + cost */}
      <div className="flex items-center gap-1.5 min-w-0">
        {a.model && (
          <span
            className="flex items-center gap-0.5 text-[10px] text-muted-foreground truncate"
            title={`${a.provider ?? ''}/${a.model}`}
          >
            <Cpu className="h-2.5 w-2.5 shrink-0" />
            <span className="truncate font-mono">{a.model}</span>
          </span>
        )}
        <span className="tabular text-[10px] text-foreground/75 ml-auto">
          {fmtCost(a.costUsd)}
        </span>
      </div>

      {/* Current/last tool */}
      {tool && (
        <div
          className={cn(
            'flex items-center gap-1 text-[10px] truncate',
            active ? 'text-primary' : 'text-muted-foreground',
          )}
          title={a.currentTool ? `running ${tool}` : `last: ${tool}`}
        >
          <Wrench className={cn('h-2.5 w-2.5 shrink-0', active && 'animate-pulse')} />
          <span className="truncate font-mono">{tool}</span>
        </div>
      )}

      {/* Context bar — only when running */}
      {active && a.maxContext > 0 && (
        <div className="flex items-center gap-1" title={`Context ${a.ctxPct}%`}>
          <div className="h-1 flex-1 overflow-hidden rounded-full bg-muted">
            <div
              className={cn(
                'h-full rounded-full transition-all',
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

      {/* Error */}
      {a.error && (
        <div
          className="truncate rounded bg-destructive/10 px-1 py-0.5 text-[9px] text-destructive"
          title={a.error.message}
        >
          {a.error.message}
        </div>
      )}
    </button>
  );
}

// ── FleetPanel ─────────────────────────────────────────────────────────

/**
 * FleetPanel — compact live roster of subagents.
 *
 * Auto-collapses when there are 3+ agents to keep the chat column
 * clean. Shows a summary pill with running/done counts. Click any
 * agent card to open a detail overlay with full stats and (soon) the
 * live output stream.
 */
export function FleetPanel({
  className,
}: {
  className?: string | undefined;
}): React.ReactElement | null {
  const agents = useFleetStore((s) => s.agents);
  const [collapsed, setCollapsed] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);

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

  const selected = selectedId ? list.find((a) => a.id === selectedId) : null;

  if (list.length === 0) return null;

  const running = list.filter((a) => a.status === 'running');
  const done = list.filter((a) => a.status === 'completed');
  const failed = list.filter((a) => a.status === 'failed' || a.status === 'timeout');
  const totalCost = list.reduce((sum, a) => sum + (a.costUsd ?? 0), 0);

  // Auto-expand when small fleet; collapse when large
  const effectiveCollapsed = collapsed && list.length >= 3;

  return (
    <>
      <div
        className={cn(
          'rounded-lg border border-border bg-card/50 backdrop-blur-sm overflow-hidden',
          className,
        )}
      >
        <button
          type="button"
          onClick={() => setCollapsed((v) => !v)}
          className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-muted/30 transition-colors"
        >
          <Bot className="h-3.5 w-3.5 text-primary" />
          <span className="text-[11px] font-semibold text-foreground">Fleet</span>

          {/* Compact summary pills */}
          <span className="flex items-center gap-1.5 ml-auto text-[10px]">
            {running.length > 0 && (
              <span className="flex items-center gap-1 text-[hsl(var(--success))]">
                <span className="led led-pulse text-[hsl(var(--success))]" />
                {running.length}
              </span>
            )}
            {done.length > 0 && (
              <span className="text-muted-foreground">{done.length} done</span>
            )}
            {failed.length > 0 && (
              <span className="text-destructive">{failed.length} err</span>
            )}
            {totalCost > 0 && (
              <span className="tabular text-foreground/70">{fmtCost(totalCost)}</span>
            )}
          </span>

          {effectiveCollapsed ? (
            <ChevronRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
          ) : (
            <ChevronDown className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
          )}
        </button>

        {!effectiveCollapsed && (
          <div className="flex gap-2 overflow-x-auto px-2 pb-2">
            {list.map((a) => (
              <AgentCard key={a.id} a={a} onClick={() => setSelectedId(a.id)} />
            ))}
          </div>
        )}
      </div>

      {/* Agent detail overlay */}
      {selected && <AgentDetail agent={selected} onClose={() => setSelectedId(null)} />}
    </>
  );
}
