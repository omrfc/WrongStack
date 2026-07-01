import { beforeEach, describe, expect, it } from 'vitest';
import {
  ACTIVITY_SHORTCUT_BY_KEY,
  ACTIVITY_SHORTCUT_LABEL_BY_ACTIVITY,
  calculateDesktopActivityCapacity,
  navigateToView,
  openMainView,
  openPanel,
  PANEL_ORDER,
  pairedViewForActivity,
  showPanel,
  splitDesktopActivityBarItems,
} from '@/components/ActivityBar';
import { PANEL_VIEW_BY_ACTIVITY } from '@/lib/view-navigation';
import { useUIStore } from '@/stores';

beforeEach(() => {
  const ui = useUIStore.getState();
  ui.selectActivity('chat');
  ui.setSidebarOpen(false);
  ui.setCurrentView('chat');
});

describe('ActivityBar desktop responsive overflow', () => {
  it('keeps core project workflow icons visible on very short desktop shells', () => {
    const split = splitDesktopActivityBarItems(calculateDesktopActivityCapacity(320));

    expect(split.visiblePanelIds).toEqual(['chat', 'agents', 'files', 'changes', 'mailbox']);
    expect(split.overflowPanelIds).toContain('history');
    expect(split.overflowViewIds).toContain('settings');
  });

  it('shows registered panels directly before hiding secondary views', () => {
    const split = splitDesktopActivityBarItems(calculateDesktopActivityCapacity(520));

    expect(split.overflowPanelIds).toEqual([]);
    expect(split.overflowViewIds).toContain('settings');
  });

  it('promotes hidden panels and views when the desktop shell is tall enough', () => {
    const split = splitDesktopActivityBarItems(calculateDesktopActivityCapacity(760));

    expect(split.overflowPanelIds).toEqual([]);
    expect(split.visibleViewIds).toContain('settings');
  });

  it('caps capacity at the total number of activity bar items', () => {
    expect(calculateDesktopActivityCapacity(5000)).toBe(15);
  });
});

describe('ActivityBar navigation coupling', () => {
  it('keeps visible panels in sync with the navigation map', () => {
    expect(PANEL_ORDER).toEqual(Object.keys(PANEL_VIEW_BY_ACTIVITY));
  });

  it('keeps panel shortcut labels and key routing in sync', () => {
    expect(ACTIVITY_SHORTCUT_BY_KEY).toEqual({
      '0': 'design',
      '1': 'chat',
      '2': 'agents',
      '3': 'history',
      '4': 'files',
      '5': 'changes',
      '6': 'mailbox',
      '7': 'skills',
      '8': 'officemap',
    });
    for (const activity of PANEL_ORDER) {
      expect(ACTIVITY_SHORTCUT_LABEL_BY_ACTIVITY[activity]).toBeTruthy();
    }
  });

  it.each([
    ['chat', 'chat'],
    ['agents', 'chat'],
    ['history', 'sessions'],
    ['files', 'files'],
    ['changes', 'changes'],
    ['mailbox', 'mailbox'],
    ['skills', 'skill'],
    ['worktrees', 'chat'],
    ['design', 'design-gallery'],
    ['officemap', 'officemap'],
  ] as const)('pairs %s panel with %s main view', (activity, expectedView) => {
    expect(pairedViewForActivity(activity)).toBe(expectedView);
  });

  it('opens the matching main view when a panel is shown', () => {
    const ui = useUIStore.getState();
    ui.setCurrentView('settings');

    showPanel('history');

    expect(useUIStore.getState().activeActivity).toBe('history');
    expect(useUIStore.getState().sidebarOpen).toBe(true);
    expect(useUIStore.getState().currentView).toBe('sessions');
  });

  it('returns no-wide-view panels to chat instead of leaving stale content open', () => {
    const ui = useUIStore.getState();
    ui.setCurrentView('skill');

    openPanel('agents');

    expect(useUIStore.getState().activeActivity).toBe('agents');
    expect(useUIStore.getState().sidebarOpen).toBe(true);
    expect(useUIStore.getState().currentView).toBe('chat');
  });

  it('collapses stale side-panel content while opening standalone views', () => {
    showPanel('files');

    openMainView('settings');

    expect(useUIStore.getState().sidebarOpen).toBe(false);
    expect(useUIStore.getState().currentView).toBe('settings');
  });

  it('returns from a standalone view to the chat panel on repeat click', () => {
    openMainView('settings');

    openMainView('settings');

    expect(useUIStore.getState().activeActivity).toBe('chat');
    expect(useUIStore.getState().sidebarOpen).toBe(true);
    expect(useUIStore.getState().currentView).toBe('chat');
  });

  it('routes paired main views through their owning panel', () => {
    navigateToView('mailbox');

    expect(useUIStore.getState().activeActivity).toBe('mailbox');
    expect(useUIStore.getState().sidebarOpen).toBe(true);
    expect(useUIStore.getState().currentView).toBe('mailbox');
  });

  it('closes the side-panel for unpaired utility views', () => {
    showPanel('files');

    navigateToView('debug');

    expect(useUIStore.getState().activeActivity).toBe('files');
    expect(useUIStore.getState().sidebarOpen).toBe(false);
    expect(useUIStore.getState().currentView).toBe('debug');
  });
});
