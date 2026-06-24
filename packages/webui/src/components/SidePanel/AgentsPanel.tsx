/**
 * AgentsPanel — live fleet roster for the side panel.
 *
 * Running agents sort first; clicking a row opens the full AgentDetail
 * overlay (the old FlowSidebar wired the overlay but never the click).
 */

import { Bot, LayoutGrid, Wrench } from 'lucide-react';
import { useMemo, useState } from 'react';
import { cn } from '@/lib/utils';
import type { SubagentView } from '@/stores';
import { useFleetStore, useUIStore } from '@/stores';
import { AgentDetail } from '../FleetPanel';

const STATUS_META: Record<SubagentView['status'], { led: string; label: string; pulse: boolean }> =
  {
    running: { led: 'text-[hsl(var(--success))]', label: 'running', pulse: true },
    completed: { led: 'text-[hsl(var(--success))]', label: 'done', pulse: false },
    failed: { led: 'text-destructive', label: 'failed', pulse: false },
    timeout: { led: 'text-[hsl(var(--warning))]', label: 'timeout', pulse: false },
    stopped: { led: 'text-muted-foreground', label: 'stopped', pulse: false },
  };

function fmtCost(v: number): string {
  if (v <= 0) return '$0';
  if (v >= 0.01) return `$${v.toFixed(3)}`;
  return `$${v.toFixed(4)}`;
}

function AgentRow({ agent, onClick }: { agent: SubagentView; onClick: () => void }) {
  const meta = STATUS_META[agent.status];
  const active = agent.status === 'running';
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'w-full text-left rounded-lg border px-2.5 py-2 transition-colors',
        'hover:border-primary/40 hover:bg-primary/[0.04]',
        active ? 'border-primary/30 bg-primary/[0.03]' : 'border-border/60 bg-card/40',
      )}
    >
      <div className="flex items-center gap-1.5 min-w-0">
        <span className={cn('led shrink-0', meta.led, meta.pulse && 'led-pulse')} />
        <span className="truncate text-[11px] font-semibold" title={agent.name}>
          {agent.name}
        </span>
        <span className="tabular ml-auto shrink-0 text-[10px] text-muted-foreground">
          {agent.iteration}it
        </span>
      </div>
      <div className="flex items-center gap-1.5 mt-0.5 min-w-0">
        {agent.model ? (
          <span className="text-[10px] text-muted-foreground truncate font-mono">
            {agent.model}
          </span>
        ) : (
          <span className="text-[10px] text-muted-foreground italic">pending…</span>
        )}
        <span className="tabular ml-auto text-[10px] text-foreground/70">
          {fmtCost(agent.costUsd)}
        </span>
      </div>
      {(agent.currentTool || agent.lastTool) && (
        <div className="flex items-center gap-1 mt-1 text-[10px] text-muted-foreground truncate">
          <Wrench className={cn('h-2.5 w-2.5 shrink-0', active && 'animate-pulse text-primary')} />
          <span className="truncate font-mono">{agent.currentTool ?? agent.lastTool}</span>
        </div>
      )}
    </button>
  );
}

export function AgentsPanel() {
  const fleetAgents = useFleetStore((s) => s.agents);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);

  const fleetList = useMemo(() => {
    const arr = Array.from(fleetAgents.values());
    arr.sort((x, y) => {
      const xa = x.status === 'running' ? 0 : 1;
      const ya = y.status === 'running' ? 0 : 1;
      if (xa !== ya) return xa - ya;
      return x.startedAt - y.startedAt;
    });
    return arr;
  }, [fleetAgents]);

  const running = fleetList.filter((a) => a.status === 'running').length;
  const selectedAgent = selectedAgentId
    ? (fleetList.find((a) => a.id === selectedAgentId) ?? null)
    : null;

  if (fleetList.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center p-4">
        <div className="text-center text-muted-foreground">
          <Bot className="h-8 w-8 mx-auto mb-3 opacity-20" />
          <p className="text-sm font-medium">No agents yet</p>
          <p className="text-xs mt-1">Subagents appear here when the fleet is active.</p>
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="px-3 py-2 border-b text-[10px] text-muted-foreground flex items-center gap-2">
        <span className="font-semibold uppercase tracking-wider">Fleet</span>
        <span className="ml-auto tabular-nums">
          {running > 0 ? `${running} running · ` : ''}
          {fleetList.length} total
        </span>
      </div>
      <div className="flex-1 overflow-y-auto p-2 space-y-1.5">
        {fleetList.map((a) => (
          <AgentRow key={a.id} agent={a} onClick={() => setSelectedAgentId(a.id)} />
        ))}
      </div>
      <div className="border-t px-3 py-2 shrink-0">
        <button
          type="button"
          onClick={() => useUIStore.getState().setAgentsMonitorOpen(true)}
          className="w-full flex items-center justify-center gap-1.5 h-7 rounded-md border border-border text-[11px] text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
        >
          <LayoutGrid className="h-3 w-3" />
          Open full agents view
        </button>
      </div>
      {selectedAgent && (
        <AgentDetail agent={selectedAgent} onClose={() => setSelectedAgentId(null)} />
      )}
    </>
  );
}
