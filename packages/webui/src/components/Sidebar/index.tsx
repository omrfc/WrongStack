import { useWebSocket } from '@/hooks/useWebSocket';
import { cn } from '@/lib/utils';
import { useConfigStore, useFleetStore, useHistoryStore, useSessionStore, useUIStore } from '@/stores';
import type { SubagentView } from '@/stores';
import {
  Bot,
  ChevronDown,
  ChevronRight,
  Clock,
  Cpu,
  History,
  Layers,
  MessageSquare,
  PanelLeftClose,
  Settings as SettingsIcon,
  Wrench,
  Zap,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Button } from '../ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../ui/tabs';
import { AgentDetail } from '../FleetPanel';
import { ConfigSection } from './ConfigSection.js';
import { SessionActions } from './SessionActions.js';
import { SessionList } from './SessionList.js';

// ── Agent row for sidebar list ────────────────────────────────────────

const STATUS_META_SM: Record<
  SubagentView['status'],
  { led: string; label: string; pulse: boolean }
> = {
  running: { led: 'text-[hsl(var(--success))]', label: 'running', pulse: true },
  completed: { led: 'text-[hsl(var(--success))]', label: 'done', pulse: false },
  failed: { led: 'text-destructive', label: 'failed', pulse: false },
  timeout: { led: 'text-[hsl(var(--warning))]', label: 'timeout', pulse: false },
  stopped: { led: 'text-muted-foreground', label: 'stopped', pulse: false },
};

function fmtCostSm(v: number): string {
  if (v <= 0) return '$0';
  if (v >= 0.01) return `${v.toFixed(3)}`;
  return `${v.toFixed(4)}`;
}

function AgentRow({
  agent,
  onClick,
}: {
  agent: SubagentView;
  onClick: () => void;
}): React.ReactElement {
  const meta = STATUS_META_SM[agent.status];
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
          {fmtCostSm(agent.costUsd)}
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

// ── Sidebar ────────────────────────────────────────────────────────────

export function Sidebar() {
  const { toggleSidebar, currentView, setCurrentView } = useUIStore();
  const sidebarWidth = useUIStore((s) => s.sidebarWidth);
  const setSidebarWidth = useUIStore((s) => s.setSidebarWidth);
  const { wsConnected, wsUrl } = useConfigStore();
  const { entries: historyEntries, loading: historyLoading, error: historyError } = useHistoryStore();
  const { listSessions, deleteSession, resumeSession, client } = useWebSocket();
  const session = useSessionStore((s) => s.session);
  const projectName = useSessionStore((s) => s.projectName);

  // ── Fleet state for Agents tab ──
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

  const selectedAgent = selectedAgentId
    ? fleetList.find((a) => a.id === selectedAgentId) ?? null
    : null;

  const fleetRunning = fleetList.filter((a) => a.status === 'running').length;
  const fleetTotal = fleetList.length;

  const [historyQuery, setHistoryQuery] = useState('');
  const activeSessionId = session?.id;

  useEffect(() => {
    if (wsConnected) client?.getTodos?.();
  }, [wsConnected, client]);

  useEffect(() => {
    void activeSessionId;
    if (currentView === 'history' && wsConnected) listSessions(50);
  }, [currentView, wsConnected, activeSessionId, listSessions]);

  // Auto-refresh session list when session changes (new, resume, clear)
  useEffect(() => {
    if (wsConnected) listSessions(50);
  }, [wsConnected, activeSessionId, listSessions]);

  const formatDuration = (start: number | null) => {
    if (!start) return '--';
    const seconds = Math.floor((Date.now() - start) / 1000);
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    return `${minutes}m`;
  };

  // Drag handle
  const startDrag = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = sidebarWidth;
    const onMove = (ev: MouseEvent) => { setSidebarWidth(startWidth + (ev.clientX - startX)); };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  };

  return (
    <aside style={{ width: `${sidebarWidth}px` }} className="relative border-r bg-card flex flex-col shrink-0">
      {/* Drag handle */}
      <div
        onMouseDown={startDrag}
        onDoubleClick={() => setSidebarWidth(288)}
        className="group/handle absolute top-0 right-0 h-full w-2 cursor-col-resize z-10 flex items-center justify-end"
        title="Drag to resize · double-click to reset"
      >
        <div className="h-full w-px bg-border group-hover/handle:bg-primary/60 group-hover/handle:w-0.5 transition-all" />
        <div className="absolute right-0 top-1/2 -translate-y-1/2 flex flex-col gap-0.5 opacity-0 group-hover/handle:opacity-100 transition-opacity pr-0.5">
          <span className="h-1 w-1 rounded-full bg-primary/70" />
          <span className="h-1 w-1 rounded-full bg-primary/70" />
          <span className="h-1 w-1 rounded-full bg-primary/70" />
        </div>
      </div>

      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b">
        <div className="flex items-center gap-2.5">
          <div className="relative w-7 h-7 rounded-md bg-primary flex items-center justify-center shadow-[0_0_0_1px_hsl(var(--primary)/0.4),0_2px_8px_-2px_hsl(var(--primary)/0.5)]">
            <Zap className="h-4 w-4 text-primary-foreground" strokeWidth={2.4} />
          </div>
          <div className="flex flex-col leading-none">
            <span className="text-sm font-semibold tracking-tight">{projectName || 'Agent'}</span>
            <span className="flex items-center gap-1 text-[10px] text-muted-foreground mt-0.5">
              <span className={cn('led', wsConnected ? 'text-[hsl(var(--success))] led-pulse' : 'text-[hsl(var(--warning))]')} />
              <span className="tabular font-medium uppercase tracking-wider">{wsConnected ? 'online' : 'offline'}</span>
            </span>
          </div>
        </div>
        <Button variant="ghost" size="icon" onClick={toggleSidebar} title="Collapse sidebar (Ctrl+\\)">
          <PanelLeftClose className="h-4 w-4" />
        </Button>
      </div>

      <Tabs value={currentView === 'chat' || currentView === 'history' || currentView === 'agents' ? currentView : '__none__'} onValueChange={(v) => setCurrentView(v as 'chat' | 'history' | 'agents')} className="flex-1 flex flex-col">
        <TabsList className="w-full rounded-none bg-transparent p-2 h-auto grid grid-cols-3">
          <TabsTrigger value="chat" className="flex-col gap-1.5 py-2 data-[state=active]:bg-primary/10">
            <MessageSquare className="h-4 w-4" /><span className="text-xs">Chat</span>
          </TabsTrigger>
          <TabsTrigger value="agents" className="flex-col gap-1.5 py-2 data-[state=active]:bg-primary/10">
            <Bot className="h-4 w-4" />
            <span className="text-xs">Agents{fleetTotal > 0 ? ` · ${fleetTotal}` : ''}</span>
          </TabsTrigger>
          <TabsTrigger value="history" className="flex-col gap-1.5 py-2 data-[state=active]:bg-primary/10">
            <History className="h-4 w-4" /><span className="text-xs">History</span>
          </TabsTrigger>
        </TabsList>

        <TabsContent value="chat" className="flex-1 flex flex-col m-0 overflow-hidden">
          <ConfigSection formatDuration={formatDuration} />
          <SessionActions wsConnected={wsConnected} />
          <div className="flex-1" />
          <div className="px-3 py-3 border-t space-y-1">
            <Button variant="ghost" size="sm" className="w-full justify-start" onClick={() => setCurrentView('settings')}>
              <SettingsIcon className="h-4 w-4 mr-2" />Settings
            </Button>
            <Button variant="ghost" size="sm" className="w-full justify-start" onClick={() => setCurrentView('autophase')}>
              <Layers className="h-4 w-4 mr-2" />Phases
            </Button>
          </div>
        </TabsContent>

        <TabsContent value="history" className="flex-1 m-0 flex flex-col overflow-hidden">
          <SessionList
            historyQuery={historyQuery}
            setHistoryQuery={setHistoryQuery}
            historyEntries={historyEntries}
            historyLoading={historyLoading}
            historyError={historyError}
            wsConnected={wsConnected}
            listSessions={listSessions}
            resumeSession={resumeSession}
            deleteSession={deleteSession}
          />
        </TabsContent>

        <TabsContent value="agents" className="flex-1 m-0 flex flex-col overflow-hidden">
          {fleetTotal === 0 ? (
            <div className="flex-1 flex items-center justify-center p-4">
              <p className="text-xs text-muted-foreground text-center">
                No agents running.
                <br />
                Agents appear here when the fleet is active.
              </p>
            </div>
          ) : (
            <div className="flex-1 overflow-y-auto p-2 space-y-1.5">
              {fleetList.map((a) => (
                <AgentRow
                  key={a.id}
                  agent={a}
                  onClick={() => setSelectedAgentId(a.id)}
                />
              ))}
            </div>
          )}
        </TabsContent>
      </Tabs>

      {/* Agent detail overlay */}
      {selectedAgent && (
        <AgentDetail agent={selectedAgent} onClose={() => setSelectedAgentId(null)} />
      )}
    </aside>
  );
}
