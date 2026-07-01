import { type Activity, useUIStore } from '@/stores/ui-store';

export type PanelMainView =
  | 'chat'
  | 'files'
  | 'skill'
  | 'officemap'
  | 'changes'
  | 'mailbox'
  | 'sessions'
  | 'design-gallery';

export type MainView = 'autophase' | 'specs' | 'sddboard' | 'sddwizard' | 'settings';

export type AppView =
  | PanelMainView
  | MainView
  | 'setup'
  | 'debug'
  | 'refresh-debug'
  | 'analytics';

export const PANEL_VIEW_BY_ACTIVITY: Record<Activity, PanelMainView> = {
  chat: 'chat',
  agents: 'chat',
  history: 'sessions',
  files: 'files',
  changes: 'changes',
  mailbox: 'mailbox',
  skills: 'skill',
  worktrees: 'chat',
  design: 'design-gallery',
  officemap: 'officemap',
};

export const VIEW_ACTIVITY: Partial<Record<AppView, Activity>> = {
  chat: 'chat',
  files: 'files',
  changes: 'changes',
  sessions: 'history',
  mailbox: 'mailbox',
  skill: 'skills',
  officemap: 'officemap',
  'design-gallery': 'design',
};

export const ACTIVITY_SHORTCUT_BY_KEY: Readonly<Record<string, Activity>> = {
  '1': 'chat',
  '2': 'agents',
  '3': 'history',
  '4': 'files',
  '5': 'changes',
  '6': 'mailbox',
  '7': 'skills',
  '8': 'officemap',
  '0': 'design',
};

export const ACTIVITY_SHORTCUT_LABEL_BY_ACTIVITY: Readonly<Record<Activity, string>> = {
  chat: 'Ctrl+1',
  agents: 'Ctrl+2',
  history: 'Ctrl+3',
  files: 'Ctrl+4',
  changes: 'Ctrl+5',
  mailbox: 'Ctrl+6',
  skills: 'Ctrl+7',
  worktrees: 'Ctrl+Shift+W',
  design: 'Ctrl+0',
  officemap: 'Ctrl+8',
};

export function pairedViewForActivity(activity: Activity): PanelMainView {
  return PANEL_VIEW_BY_ACTIVITY[activity] ?? 'chat';
}

export function shortcutLabelForActivity(activity: Activity): string {
  return ACTIVITY_SHORTCUT_LABEL_BY_ACTIVITY[activity] ?? '';
}

function setView(view: AppView): void {
  const ui = useUIStore.getState();
  if (ui.currentView !== view) ui.setCurrentView(view);
}

export function showPanel(activity: Activity): void {
  const ui = useUIStore.getState();
  ui.setSidebarOpen(true);
  ui.selectActivity(activity);
  setView(pairedViewForActivity(activity));
}

export function openPanel(activity: Activity): void {
  const ui = useUIStore.getState();
  if (!ui.sidebarOpen) {
    ui.setSidebarOpen(true);
    ui.selectActivity(activity);
  } else if (ui.activeActivity === activity) {
    ui.setSidebarOpen(false);
    return;
  } else {
    ui.selectActivity(activity);
  }
  setView(pairedViewForActivity(activity));
}

export function openMainView(view: MainView): void {
  const ui = useUIStore.getState();
  if (ui.currentView === view) {
    showPanel('chat');
    return;
  }
  ui.setSidebarOpen(false);
  setView(view);
}

export function navigateToView(view: AppView): void {
  const activity = VIEW_ACTIVITY[view];
  if (activity) {
    showPanel(activity);
    return;
  }
  const ui = useUIStore.getState();
  ui.setSidebarOpen(false);
  setView(view);
}
