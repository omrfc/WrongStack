import type { Action } from './app-reducer.js';
import type { StatuslineItem } from './components/statusline-picker.js';

export type FKeyPanelAction =
  | 'projectPickerOpen'
  | 'toggleMonitor'
  | 'toggleAgentsMonitor'
  | 'toggleWorktreeMonitor'
  | 'togglePlanPanel'
  | 'toggleTodosMonitor'
  | 'toggleQueuePanel'
  | 'toggleProcessList'
  | 'toggleGoalPanel'
  | 'toggleSessionsPanel'
  | 'toggleCoordinatorMonitor'
  | 'statuslineOpen';

/** A single F-key panel entry shared by the picker, help overlay, and tests. */
export interface FKeyPanelEntry {
  key: number;
  label: string;
  action: FKeyPanelAction;
  /** Shortcut label for user-facing help, including Ctrl aliases when available. */
  helpKeys: string;
  /** Short user-facing description for the help overlay. */
  helpDescription: string;
}

/** All 12 F-key panels in order. */
export const F_KEY_PANEL_ENTRIES: readonly FKeyPanelEntry[] = [
  {
    key: 1,
    label: 'Project switcher',
    action: 'projectPickerOpen',
    helpKeys: 'F1',
    helpDescription: 'project switcher (also /project)',
  },
  {
    key: 2,
    label: 'Fleet orchestration monitor',
    action: 'toggleMonitor',
    helpKeys: 'Ctrl+F / F2',
    helpDescription: 'fleet orchestration monitor',
  },
  {
    key: 3,
    label: 'Agents live monitor',
    action: 'toggleAgentsMonitor',
    helpKeys: 'Ctrl+G / F3',
    helpDescription: 'agents live monitor',
  },
  {
    key: 4,
    label: 'Worktree monitor',
    action: 'toggleWorktreeMonitor',
    helpKeys: 'Ctrl+T / F4',
    helpDescription: 'worktree monitor',
  },
  {
    key: 5,
    label: 'Plan panel',
    action: 'togglePlanPanel',
    helpKeys: 'F5',
    helpDescription: 'plan panel',
  },
  {
    key: 6,
    label: 'Todos monitor overlay',
    action: 'toggleTodosMonitor',
    helpKeys: 'F6',
    helpDescription: 'todos monitor overlay',
  },
  {
    key: 7,
    label: 'Queue panel',
    action: 'toggleQueuePanel',
    helpKeys: 'F7',
    helpDescription: 'queue panel',
  },
  {
    key: 8,
    label: 'Process list overlay',
    action: 'toggleProcessList',
    helpKeys: 'F8',
    helpDescription: 'process list overlay',
  },
  {
    key: 9,
    label: 'Goal panel',
    action: 'toggleGoalPanel',
    helpKeys: 'F9',
    helpDescription: 'goal panel',
  },
  {
    key: 10,
    label: 'Live sessions panel',
    action: 'toggleSessionsPanel',
    helpKeys: 'F10',
    helpDescription: 'live sessions panel',
  },
  {
    key: 11,
    label: 'Coordinator monitor',
    action: 'toggleCoordinatorMonitor',
    helpKeys: 'F11',
    helpDescription: 'coordinator monitor',
  },
  {
    key: 12,
    label: 'Status line picker',
    action: 'statuslineOpen',
    helpKeys: 'F12',
    helpDescription: 'status line picker',
  },
];

type FKeyDispatchAction = Extract<
  Action,
  | { type: 'toggleMonitor' }
  | { type: 'toggleAgentsMonitor' }
  | { type: 'toggleWorktreeMonitor' }
  | { type: 'togglePlanPanel' }
  | { type: 'toggleTodosMonitor' }
  | { type: 'toggleQueuePanel' }
  | { type: 'toggleProcessList' }
  | { type: 'toggleGoalPanel' }
  | { type: 'toggleSessionsPanel' }
  | { type: 'toggleCoordinatorMonitor' }
  | { type: 'statuslineOpen' }
>;

const PAYLOAD_FREE_ACTIONS = new Set<FKeyPanelAction>([
  'toggleMonitor',
  'toggleAgentsMonitor',
  'toggleWorktreeMonitor',
  'togglePlanPanel',
  'toggleTodosMonitor',
  'toggleQueuePanel',
  'toggleProcessList',
  'toggleGoalPanel',
  'toggleSessionsPanel',
  'toggleCoordinatorMonitor',
]);

/**
 * Convert a picker entry into the reducer action it can dispatch directly.
 * Returns null for entries that need host-side work before dispatching, such as
 * F1/projectPickerOpen, which must load project items before opening.
 */
export function actionForFKeyPanel(
  entry: FKeyPanelEntry,
  hiddenItems: readonly StatuslineItem[] = [],
): FKeyDispatchAction | null {
  if (entry.action === 'projectPickerOpen') return null;
  if (entry.action === 'statuslineOpen') {
    return { type: 'statuslineOpen', hiddenItems: [...hiddenItems] };
  }
  if (PAYLOAD_FREE_ACTIONS.has(entry.action)) {
    return { type: entry.action } as FKeyDispatchAction;
  }
  return null;
}
