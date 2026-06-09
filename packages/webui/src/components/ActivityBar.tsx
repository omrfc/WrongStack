import { cn } from '@/lib/utils';
import { type Activity, useConfigStore, useFleetStore, useSessionStore, useUIStore } from '@/stores';
import {
  Bot,
  Clock,
  FolderOpen,
  Gauge,
  Layers,
  MessageSquare,
  Settings as SettingsIcon,
  Zap,
} from 'lucide-react';
import { type ReactElement } from 'react';

// ── Activity definition ───────────────────────────────────────────────

type MainView = 'chat' | 'files' | 'settings' | 'autophase';

interface ActivityDef {
  id: Activity | 'settings' | 'autophase';
  icon: ReactElement;
  label: string;
  /** If true, this icon is in the bottom group. */
  bottom?: boolean;
  /** What the main content area shows when this activity is selected. */
  mainView: MainView;
  /** Optional badge count rendered as a pill on the icon. */
  badge?: number;
}

const TOP_ACTIVITIES: ActivityDef[] = [
  { id: 'chat', icon: <MessageSquare />, label: 'Chat', mainView: 'chat' },
  { id: 'agents', icon: <Bot />, label: 'Agents', mainView: 'chat' },
  { id: 'context', icon: <Gauge />, label: 'Context', mainView: 'chat' },
  { id: 'history', icon: <Clock />, label: 'History', mainView: 'chat' },
  { id: 'files', icon: <FolderOpen />, label: 'Files', mainView: 'files' },
];

const BOTTOM_ACTIVITIES: ActivityDef[] = [
  { id: 'autophase', icon: <Layers />, label: 'Phases', bottom: true, mainView: 'autophase' },
  { id: 'settings', icon: <SettingsIcon />, label: 'Settings', bottom: true, mainView: 'settings' },
];

// ── Component ──────────────────────────────────────────────────────────

export function ActivityBar() {
  const activeActivity = useUIStore((s) => s.activeActivity);
  const sidebarOpen = useUIStore((s) => s.sidebarOpen);
  const currentView = useUIStore((s) => s.currentView);
  const selectActivity = useUIStore((s) => s.selectActivity);
  const setCurrentView = useUIStore((s) => s.setCurrentView);
  const setSidebarOpen = useUIStore((s) => s.setSidebarOpen);
  const projectName = useSessionStore((s) => s.projectName);
  const wsConnected = useConfigStore((s) => s.wsConnected);
  const fleetTotal = useFleetStore((s) => s.agents.size);

  // Attach dynamic badge counts to activity definitions
  const topActivities: ActivityDef[] = TOP_ACTIVITIES.map((def) => {
    if (def.id === 'agents') return { ...def, badge: fleetTotal || undefined };
    return def;
  });

  const handleClick = (def: ActivityDef) => {
    const isSidebarActivity = TOP_ACTIVITIES.some((a) => a.id === def.id);

    if (isSidebarActivity) {
      // Sidebar activity: open/switch/close the secondary panel
      if (!sidebarOpen) {
        // Closed → open it
        setSidebarOpen(true);
        selectActivity(def.id as Activity);
        setCurrentView(def.mainView);
      } else if (activeActivity === def.id) {
        // Same icon → close it
        setSidebarOpen(false);
      } else {
        // Different icon → switch
        selectActivity(def.id as Activity);
        setCurrentView(def.mainView);
      }
    } else {
      // Bottom activity (Settings / Phases): toggle main view
      if (currentView === def.mainView) {
        setCurrentView('chat');
      } else {
        setCurrentView(def.mainView);
      }
    }
  };

  const isActive = (def: ActivityDef): boolean => {
    // Top activities: active when sidebar is open and matches
    if (!def.bottom) {
      return sidebarOpen && activeActivity === def.id;
    }
    // Bottom activities: active when main view matches
    return currentView === def.mainView;
  };

  return (
    <div className="flex flex-col h-full w-12 shrink-0 border-r bg-card/60">
      {/* ── Branding — logo + project name ── */}
      <div className="flex flex-col items-center pt-2.5 pb-2 border-b border-border/50">
        <button
          type="button"
          onClick={() => {
            // "Home" — open sidebar to chat, reset main view
            setSidebarOpen(true);
            selectActivity('chat');
            setCurrentView('chat');
          }}
          title={projectName ? `${projectName} — return to chat` : 'WrongStack — return to chat'}
          className="relative w-8 h-8 rounded-md bg-primary flex items-center justify-center shadow-[0_0_0_1px_hsl(var(--primary)/0.4),0_2px_8px_-2px_hsl(var(--primary)/0.5)] hover:shadow-[0_0_0_1px_hsl(var(--primary)/0.6),0_3px_12px_-2px_hsl(var(--primary)/0.6)] transition-shadow"
        >
          <Zap className="h-4 w-4 text-primary-foreground" strokeWidth={2.4} />
        </button>
        {/* Project name — truncated to fit the 48px bar */}
        <span
          className="mt-1.5 text-[8px] font-semibold tracking-tight text-muted-foreground text-center leading-tight w-10 truncate"
          title={projectName || 'WrongStack'}
        >
          {projectName || 'WS'}
        </span>
        {/* Connection status dot */}
        <span
          className={cn(
            'mt-1 inline-block w-1.5 h-1.5 rounded-full',
            wsConnected ? 'bg-[hsl(var(--success))] shadow-[0_0_4px_hsl(var(--success)/0.6)]' : 'bg-[hsl(var(--warning))]',
          )}
          title={wsConnected ? 'Connected' : 'Disconnected'}
        />
      </div>

      {/* ── Top activities ── */}
      <div className="flex flex-col items-center gap-0.5 pt-2">
        {topActivities.map((def) => (
          <ActivityIcon
            key={def.id}
            def={def}
            active={isActive(def)}
            badge={def.badge}
            onClick={() => handleClick(def)}
          />
        ))}
      </div>

      {/* ── Spacer ── */}
      <div className="flex-1" />

      {/* ── Bottom activities ── */}
      <div className="flex flex-col items-center gap-0.5 pb-2">
        {BOTTOM_ACTIVITIES.map((def) => (
          <ActivityIcon
            key={def.id}
            def={def}
            active={isActive(def)}
            onClick={() => handleClick(def)}
          />
        ))}
      </div>
    </div>
  );
}

// ── Icon button ────────────────────────────────────────────────────────

function ActivityIcon({
  def,
  active,
  badge,
  onClick,
}: {
  def: ActivityDef;
  active: boolean;
  badge?: number;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={def.label}
      className={cn(
        'relative flex items-center justify-center w-10 h-10 rounded-lg transition-colors',
        'text-muted-foreground hover:text-foreground hover:bg-muted/70',
        active && 'text-primary bg-primary/10',
      )}
    >
      {/* Active indicator — left accent bar */}
      {active && (
        <span className="absolute left-0 top-1/2 -translate-y-1/2 w-0.5 h-6 rounded-r-full bg-primary" />
      )}
      <span className="h-5 w-5">{def.icon}</span>
      {/* Badge count — top-right pill */}
      {badge !== undefined && badge > 0 && (
        <span className="absolute -top-0.5 -right-0.5 min-w-[15px] h-[15px] flex items-center justify-center rounded-full bg-primary text-[8px] font-bold text-primary-foreground leading-none px-1 tabular">
          {badge > 99 ? '99+' : badge}
        </span>
      )}
    </button>
  );
}
