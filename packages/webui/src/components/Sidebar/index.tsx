import { useWebSocket } from '@/hooks/useWebSocket';
import { cn } from '@/lib/utils';
import { type Activity, useConfigStore, useFileStore, useFleetStore, useHistoryStore, useSessionStore, useUIStore } from '@/stores';
import type { SubagentView } from '@/stores';
import {
  PanelLeftClose,
  Wrench,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Button } from '../ui/button';
import { AgentDetail } from '../FleetPanel';
import { ContextSidebar } from '../ContextSidebar';
import { FileExplorer } from '../FileExplorer';
import { MailboxPanel } from '../MailboxPanel';
import { ProjectsPanel } from '../ProjectsPanel';
import { ConfigSection } from './ConfigSection.js';
import { SessionActions } from './SessionActions.js';
import { SessionList } from './SessionList.js';

// ── Activity label map ────────────────────────────────────────────────

const ACTIVITY_LABEL: Record<Activity, string> = {
  chat: 'Chat',
  agents: 'Agents',
  context: 'Context',
  history: 'History',
  files: 'Files',
  projects: 'Projects',
  mailbox: 'Mailbox',
};

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

// ── Secondary Panel ────────────────────────────────────────────────────

export function Sidebar() {
  const activeActivity = useUIStore((s) => s.activeActivity);
  const setSidebarOpen = useUIStore((s) => s.setSidebarOpen);
  const sidebarWidth = useUIStore((s) => s.sidebarWidth);
  const setSidebarWidth = useUIStore((s) => s.setSidebarWidth);
  const { wsConnected } = useConfigStore();
  const { entries: historyEntries, loading: historyLoading, error: historyError } = useHistoryStore();
  const { listSessions, deleteSession, resumeSession, client } = useWebSocket();
  const session = useSessionStore((s) => s.session);

  // ── Fleet state for Agents view ──
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

  const fleetTotal = fleetList.length;

  const [historyQuery, setHistoryQuery] = useState('');
  const activeSessionId = session?.id;

  useEffect(() => {
    if (wsConnected) client?.getTodos?.();
  }, [wsConnected, client]);

  useEffect(() => {
    void activeSessionId;
    if (activeActivity === 'history' && wsConnected) listSessions(50);
  }, [activeActivity, wsConnected, activeSessionId, listSessions]);

  // Auto-refresh session list when session changes
  useEffect(() => {
    if (wsConnected) listSessions(50);
  }, [wsConnected, activeSessionId, listSessions]);

  // Load file tree when Files activity is selected
  useEffect(() => {
    if (activeActivity !== 'files' || !wsConnected) return;
    useFileStore.getState().setTreeLoading(true);
    const cwd = useSessionStore.getState().cwd;
    client?.send({ type: 'files.tree', payload: cwd ? { path: cwd } : {} });
  }, [activeActivity, wsConnected, client]);

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
    <aside style={{ width: `${sidebarWidth}px` }} className="relative border-r bg-card flex flex-col shrink-0 animate-slide-in">
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

      {/* ── Panel header ── */}
      <div className="flex items-center justify-between px-3 py-2.5 border-b shrink-0">
        <span className="text-xs font-semibold tracking-tight text-muted-foreground uppercase">
          {ACTIVITY_LABEL[activeActivity]}
        </span>
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6"
          onClick={() => setSidebarOpen(false)}
          title="Collapse panel"
        >
          <PanelLeftClose className="h-3.5 w-3.5" />
        </Button>
      </div>

      {/* ── Panel body ── */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {activeActivity === 'chat' && (
          <>
            <ConfigSection formatDuration={formatDuration} />
            <SessionActions wsConnected={wsConnected} />
          </>
        )}

        {activeActivity === 'history' && (
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
        )}

        {activeActivity === 'agents' && (
          fleetTotal === 0 ? (
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
          )
        )}

        {activeActivity === 'context' && (
          <div className="flex-1 overflow-y-auto p-3">
            <ContextSidebar />
          </div>
        )}

        {activeActivity === 'files' && (
          <div className="flex-1 overflow-y-auto">
            <FileExplorer />
          </div>
        )}

        {activeActivity === 'mailbox' && (
          <div className="flex-1 overflow-y-auto">
            <MailboxPanel />
          </div>
        )}

        {activeActivity === 'projects' && (
          <div className="flex-1 overflow-y-auto p-3">
            <ProjectsPanel />
          </div>
        )}

        {activeActivity === 'sessions' && (
          <div className="flex-1 overflow-y-auto p-3">
            <p className="text-[11px] font-medium text-muted-foreground mb-2 uppercase tracking-wider">
              Sessions
            </p>
            <SessionList
              historyQuery=""
              setHistoryQuery={() => {}}
              historyEntries={historyEntries}
              historyLoading={historyLoading}
              historyError={historyError}
              wsConnected={wsConnected}
              listSessions={listSessions}
              resumeSession={resumeSession}
              deleteSession={deleteSession}
            />
          </div>
        )}
      </div>

      {/* Agent detail overlay */}
      {selectedAgent && (
        <AgentDetail agent={selectedAgent} onClose={() => setSelectedAgentId(null)} />
      )}
    </aside>
  );
}
