/**
 * FleetDrawer — bottom slide-up drawer (80% width) showing fleet monitor content.
 */

import { Bot, X } from 'lucide-react';
import { useFleetStore } from '@/stores';
import { FleetAgentRow } from './FleetMonitor';
import { ConcurrencyGauge, EventTimeline } from '@/components/ui';
import { SparklineChart } from '@/components/ui/sparkline';
import { cn } from '@/lib/utils';
import type { SubagentView } from '@/stores';
import {
  ArrowRight,
  Clock,
  Users,
} from 'lucide-react';

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

const STATUS_META: Record<SubagentView['status'], { led: string; label: string; pulse: boolean; color: string }> = {
  running: { led: 'bg-emerald-500', label: 'running', pulse: true, color: 'text-emerald-500' },
  completed: { led: 'bg-emerald-500', label: 'done', pulse: false, color: 'text-emerald-500' },
  failed: { led: 'bg-destructive', label: 'failed', pulse: false, color: 'text-destructive' },
  timeout: { led: 'bg-amber-500', label: 'timeout', pulse: false, color: 'text-amber-500' },
  stopped: { led: 'bg-muted-foreground', label: 'stopped', pulse: false, color: 'text-muted-foreground' },
};

interface FleetDrawerProps {
  onClose: () => void;
  onSelectAgent?: (agent: SubagentView) => void;
}

export function FleetDrawer({ onClose, onSelectAgent }: FleetDrawerProps) {
  const fleetAgents = useFleetStore((s) => s.agents);
  const leaderId = useFleetStore((s) => s.leaderId);
  const fleetTokensIn = useFleetStore((s) => s.fleetTokensIn);
  const fleetTokensOut = useFleetStore((s) => s.fleetTokensOut);
  const fleetConcurrency = useFleetStore((s) => s.fleetConcurrency);
  const fleetConcurrencyMax = useFleetStore((s) => s.fleetConcurrencyMax);
  const eventTimeline = useFleetStore((s) => s.eventTimeline);

  const fleetList = Array.from(fleetAgents.values()).sort((x, y) => {
    if (x.id === leaderId) return -1;
    if (y.id === leaderId) return 1;
    const xa = x.status === 'running' ? 0 : 1;
    const ya = y.status === 'running' ? 0 : 1;
    if (xa !== ya) return xa - ya;
    return x.startedAt - y.startedAt;
  });

  const totalCost = Array.from(fleetAgents.values()).reduce((sum, a) => sum + a.costUsd, 0);
  const runningCount = fleetList.filter((a) => a.status === 'running').length;

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center" onClick={onClose}>
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" />

      {/* Drawer panel */}
      <div
        className="relative w-[80vw] max-w-5xl bg-card border-t border-l border-r rounded-t-2xl shadow-2xl flex flex-col max-h-[85vh] animate-drawer-up"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b bg-card/80 backdrop-blur shrink-0 rounded-t-2xl">
          <div className="flex items-center gap-3">
            <Bot className="h-5 w-5 text-primary" />
            <h2 className="text-sm font-semibold flex items-center gap-2">
              Fleet Monitor
              {runningCount > 0 && (
                <span className="flex items-center gap-1 text-[11px] text-emerald-500 font-normal">
                  <span className="led led-pulse bg-emerald-500" />
                  {runningCount} running
                </span>
              )}
            </h2>
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <span>{fleetList.length} total</span>
              <ConcurrencyGauge current={fleetConcurrency} max={fleetConcurrencyMax} showLabel />
            </div>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-xs text-muted-foreground tabular-nums font-mono">
              ↓{fmtTok(fleetTokensIn)} ↑{fmtTok(fleetTokensOut)} · {fmtCost(totalCost)}
            </span>
            <button
              type="button"
              onClick={onClose}
              className="p-1.5 rounded-md hover:bg-muted transition-colors"
              aria-label="Close fleet drawer"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* Agent list */}
        <div className="flex-1 overflow-y-auto">
          {fleetList.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
              <Users className="h-12 w-12 mb-3 opacity-20" />
              <p className="text-sm font-medium">No agents active</p>
              <p className="text-xs mt-1">Agents appear here when the fleet is active.</p>
            </div>
          ) : (
            <div className="p-3 space-y-0.5">
              {/* Column headers */}
              <div className="grid grid-cols-[140px_60px_1fr_60px_60px_60px_60px_50px] gap-x-2 text-[9px] uppercase tracking-wider text-muted-foreground font-medium px-3 pb-2">
                <span>Name</span>
                <span>Status</span>
                <span>Activity</span>
                <span>Iters</span>
                <span>Tools</span>
                <span>Cost</span>
                <span>CTX</span>
                <span>Reason</span>
              </div>
              {fleetList.map((agent) => {
                const meta = STATUS_META[agent.status];
                const active = agent.status === 'running';
                return (
                  <button
                    key={agent.id}
                    type="button"
                    onClick={() => onSelectAgent?.(agent)}
                    className={cn(
                      'w-full text-left grid grid-cols-[140px_60px_1fr_60px_60px_60px_60px_50px] items-center gap-x-2 px-3 py-2 rounded-lg text-xs transition-colors hover:bg-accent/50',
                      active && 'bg-muted/30',
                    )}
                  >
                    <div className="flex items-center gap-1 min-w-0">
                      <span className={cn('led shrink-0', meta.led, meta.pulse && 'led-pulse')} />
                      <span className="truncate font-medium">{agent.name}</span>
                    </div>
                    <span className={cn('text-[10px] tabular-nums', active ? 'text-emerald-500' : 'text-muted-foreground')}>
                      {meta.label}
                    </span>
                    <div className="flex items-center gap-1 min-w-0">
                      <SparklineChart bins={agent.sparklineBins} className="font-mono text-[9px]" />
                    </div>
                    <span className="tabular-nums text-muted-foreground text-[10px]">{agent.iteration}it</span>
                    <span className="tabular-nums text-muted-foreground text-[10px]">{agent.toolCalls}tc</span>
                    <span className="tabular-nums font-mono text-[10px]">{fmtCost(agent.costUsd)}</span>
                    <div className="flex flex-col gap-0.5 min-w-0">
                      <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
                        <div
                          className={cn(
                            'h-full rounded-full transition-all',
                            agent.ctxPct >= 85 ? 'bg-destructive' : agent.ctxPct >= 70 ? 'bg-amber-500' : 'bg-emerald-500',
                          )}
                          style={{ width: `${Math.min(200, agent.ctxPct)}%` }}
                        />
                      </div>
                      <span className="text-[9px] tabular-nums text-muted-foreground font-mono leading-none">
                        {agent.maxContext > 0 ? `${agent.ctxPct}%` : '—'}
                      </span>
                    </div>
                    <span className="text-[9px] text-destructive truncate" title={agent.failureReason ?? ''}>
                      {agent.failureReason ?? ''}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* Event timeline footer */}
        {eventTimeline.length > 0 && (
          <div className="border-t bg-card/80 shrink-0 px-4 py-2">
            <div className="flex items-center gap-2 mb-1">
              <Clock className="h-3 w-3 text-muted-foreground" />
              <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">Event Timeline</span>
            </div>
            <EventTimeline events={eventTimeline} max={5} />
          </div>
        )}
      </div>
    </div>
  );
}
