/**
 * SidePanel — the secondary panel next to the ActivityBar.
 *
 * One activity icon = one full panel (VS Code model). The panel content is
 * routed off `activeActivity` so clicking a different icon actually switches
 * what you see — no shared accordion.
 */

import { PanelLeftClose } from 'lucide-react';
import { useEffect } from 'react';
import { useWebSocket } from '@/hooks/useWebSocket';
import { cn } from '@/lib/utils';
import {
  type Activity,
  SIDEBAR_DEFAULT_WIDTH,
  useConfigStore,
  useFileStore,
  useSessionStore,
  useUIStore,
} from '@/stores';
import { FileExplorer } from '../FileExplorer';
import { MailboxPanel } from '../MailboxPanel';
import { Button } from '../ui/button';
import { AgentsPanel } from './AgentsPanel';
import { ChangesPanel } from './ChangesPanel';
import { HistoryPanel } from './HistoryPanel';
import { SessionPanel } from './SessionPanel';
import { SkillsList } from './SkillsList';
import { DesignStudioPanel } from './DesignStudioPanel';
import { WorktreesPanel } from './WorktreesPanel';
import { OfficeMapSettingsPanel } from '../OfficeMapSettingsPanel';

const PANEL_TITLE: Record<Activity, string> = {
  chat: 'Session',
  agents: 'Agents',
  history: 'History',
  files: 'Files',
  changes: 'Changes',
  mailbox: 'Mailbox',
  skills: 'Skills',
  design: 'Design Studio',
  worktrees: 'Worktrees',
  officemap: 'Office Map',
};

export function SidePanel({ desktopShell = false }: { desktopShell?: boolean | undefined }) {
  const activeActivity = useUIStore((s) => s.activeActivity);
  const setSidebarOpen = useUIStore((s) => s.setSidebarOpen);
  const sidebarWidth = useUIStore((s) => s.sidebarWidth);
  const setSidebarWidth = useUIStore((s) => s.setSidebarWidth);
  const wsConnected = useConfigStore((s) => s.wsConnected);
  const { client } = useWebSocket();
  const effectiveWidth = desktopShell ? Math.min(sidebarWidth, 280) : sidebarWidth;

  // Load the file tree when the Files panel is shown.
  useEffect(() => {
    if (activeActivity !== 'files' || !wsConnected) return;
    useFileStore.getState().setTreeLoading(true);
    const cwd = useSessionStore.getState().cwd;
    client?.send({ type: 'files.tree', payload: cwd ? { path: cwd } : {} });
  }, [activeActivity, wsConnected, client]);

  // Drag-to-resize. The store owns the clamp — no local bounds here.
  const startDrag = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = sidebarWidth;
    const onMove = (ev: MouseEvent) => setSidebarWidth(startWidth + (ev.clientX - startX));
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
    <>
      <div
        className={cn(
          'fixed inset-y-0 right-0 z-30 bg-black/20 md:hidden',
          desktopShell ? 'left-10' : 'left-12',
        )}
        onClick={() => setSidebarOpen(false)}
        aria-hidden="true"
      />
      <aside
        style={{
          width: `${effectiveWidth}px`,
          maxWidth: desktopShell ? 'min(300px, calc(100vw - 2.5rem))' : 'calc(100vw - 3rem)',
        }}
        className={cn(
          'fixed inset-y-0 z-40 flex min-h-0 min-w-0 shrink-0 flex-col overflow-hidden border-r bg-card shadow-2xl animate-slide-in md:relative md:inset-auto md:z-auto md:shadow-none',
          desktopShell ? 'left-10' : 'left-12',
        )}
      >
      {/* Drag handle */}
      <div
        onMouseDown={startDrag}
        onDoubleClick={() => setSidebarWidth(SIDEBAR_DEFAULT_WIDTH)}
        className="group/handle absolute top-0 right-0 h-full w-2 cursor-col-resize z-10 flex items-center justify-end"
        title="Drag to resize · double-click to reset"
      >
        <div className="h-full w-px bg-border group-hover/handle:bg-primary/60 group-hover/handle:w-0.5 transition-all" />
      </div>

      {/* Panel header — names the active panel */}
      <div
        className={cn(
          'flex items-center justify-between border-b shrink-0',
          desktopShell ? 'px-2.5 py-2' : 'px-3 py-2.5',
        )}
      >
        <span className="text-xs font-semibold tracking-tight text-muted-foreground uppercase">
          {PANEL_TITLE[activeActivity]}
        </span>
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6"
          onClick={() => setSidebarOpen(false)}
          title="Collapse panel (Ctrl+\)"
        >
          <PanelLeftClose className="h-3.5 w-3.5" />
        </Button>
      </div>

      {/* Panel body — routed by activity */}
      <div className="flex-1 min-h-0 min-w-0 flex flex-col overflow-hidden">
        {activeActivity === 'chat' && <SessionPanel />}
        {activeActivity === 'agents' && <AgentsPanel />}
        {activeActivity === 'history' && <HistoryPanel />}
        {activeActivity === 'files' && (
          <div className="flex-1 min-h-0 min-w-0 overflow-y-auto">
            <FileExplorer />
          </div>
        )}
        {activeActivity === 'changes' && <ChangesPanel />}
        {activeActivity === 'mailbox' && (
          <div className="flex-1 min-h-0 min-w-0 overflow-y-auto p-3">
            <MailboxPanel />
          </div>
        )}
        {activeActivity === 'skills' && (
          <div className="flex-1 min-h-0 min-w-0 overflow-hidden">
            <SkillsList className="h-full" />
          </div>
        )}
        {activeActivity === 'design' && (
          <div className="flex-1 min-h-0 min-w-0 overflow-hidden">
            <DesignStudioPanel className="h-full" />
          </div>
        )}
        {activeActivity === 'worktrees' && (
          <div className="flex-1 min-h-0 min-w-0 overflow-hidden">
            <WorktreesPanel />
          </div>
        )}
        {activeActivity === 'officemap' && (
          <div className="flex-1 min-h-0 min-w-0 overflow-hidden">
            <OfficeMapSettingsPanel />
          </div>
        )}
      </div>
      </aside>
    </>
  );
}
