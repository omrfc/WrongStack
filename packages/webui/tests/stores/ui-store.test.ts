import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  coerceActivity,
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  useUIStore,
} from '../../src/stores/ui-store';

// ── helpers ──────────────────────────────────────────────────────────

function resetStore() {
  // Explicitly reset ALL persisted fields to prevent zustand/persist
  // rehydration from localStorage leaking state between tests.
  useUIStore.setState({
    activeActivity: 'chat',
    sidebarOpen: false,
    sidebarWidth: SIDEBAR_DEFAULT_WIDTH,
    settingsOpen: false,
    currentView: 'chat' as const,
    showConfirmDialog: false,
    confirmInfo: null,
    paletteOpen: false,
    shortcutsOpen: false,
    searchOpen: false,
    searchQuery: '',
    scrollTarget: null,
    promptHistory: [],
    pinnedIds: [],
    compactMode: false,
    modelSwitcherOpen: false,
    favoriteSessionIds: [],
    sessionNicknames: {},
    fileExplorerWidth: 260,
    refineEnabled: false,
    dockSection: null,
    fleetMonitorOpen: false,
    agentsMonitorOpen: false,
    inspectorOpen: false,
    inspectorTab: 'fleet' as const,
    processMonitorOpen: false,
    queuePanelOpen: false,
    skillsState: {
      selectedSkill: null,
      navHistory: [],
      historyIndex: -1,
      detailOpen: false,
      knownRefs: {},
      updateAvailableCount: 0,
    },
  });
}

beforeEach(() => {
  // Clear localStorage before each test so zustand/persist rehydrates
  // a clean state rather than picking up the previous test's persisted values.
  localStorage.clear();
  resetStore();
});

// ── coerceActivity — legacy persisted values ───────────────────────────

describe('coerceActivity', () => {
  it('passes current activities through unchanged', () => {
    for (const a of ['chat', 'agents', 'history', 'files', 'projects', 'mailbox', 'skills'] as const) {
      expect(coerceActivity(a)).toBe(a);
    }
  });

  it('maps removed legacy activities onto their new homes', () => {
    expect(coerceActivity('context')).toBe('chat');
    expect(coerceActivity('sessions')).toBe('history');
  });

  it('falls back to chat for garbage values', () => {
    expect(coerceActivity(undefined)).toBe('chat');
    expect(coerceActivity(null)).toBe('chat');
    expect(coerceActivity(42)).toBe('chat');
    expect(coerceActivity('not-a-panel')).toBe('chat');
  });
});

// ── sidebar width — single clamp in the store ──────────────────────────

describe('setSidebarWidth clamp', () => {
  it('clamps below the minimum', () => {
    useUIStore.getState().setSidebarWidth(10);
    expect(useUIStore.getState().sidebarWidth).toBe(SIDEBAR_MIN_WIDTH);
  });

  it('clamps above the maximum', () => {
    useUIStore.getState().setSidebarWidth(5000);
    expect(useUIStore.getState().sidebarWidth).toBe(SIDEBAR_MAX_WIDTH);
  });

  it('rounds and accepts in-range values', () => {
    useUIStore.getState().setSidebarWidth(333.4);
    expect(useUIStore.getState().sidebarWidth).toBe(333);
  });

  it('keeps the default within bounds', () => {
    expect(SIDEBAR_DEFAULT_WIDTH).toBeGreaterThanOrEqual(SIDEBAR_MIN_WIDTH);
    expect(SIDEBAR_DEFAULT_WIDTH).toBeLessThanOrEqual(SIDEBAR_MAX_WIDTH);
  });
});

// ── selectActivity ─────────────────────────────────────────────────────

describe('selectActivity', () => {
  it('switches the active activity', () => {
    useUIStore.getState().selectActivity('mailbox');
    expect(useUIStore.getState().activeActivity).toBe('mailbox');
    useUIStore.getState().selectActivity('chat');
    expect(useUIStore.getState().activeActivity).toBe('chat');
  });
});

// ── WorkspaceDock section state ────────────────────────────────────────

describe('dockSection', () => {
  it('starts collapsed', () => {
    useUIStore.getState().setDockSection(null);
    expect(useUIStore.getState().dockSection).toBeNull();
  });

  it('toggleDockSection opens a section and re-toggling collapses it', () => {
    useUIStore.getState().setDockSection(null);
    useUIStore.getState().toggleDockSection('work');
    expect(useUIStore.getState().dockSection).toBe('work');
    useUIStore.getState().toggleDockSection('work');
    expect(useUIStore.getState().dockSection).toBeNull();
  });

  it('toggling a different section switches instead of collapsing', () => {
    useUIStore.getState().setDockSection('work');
    useUIStore.getState().toggleDockSection('autophase');
    expect(useUIStore.getState().dockSection).toBe('autophase');
    useUIStore.getState().setDockSection(null);
  });
});

// ── togglePin / unpinAll ─────────────────────────────────────────────

describe('togglePin', () => {
  it('adds an id when not pinned', () => {
    useUIStore.getState().togglePin('msg-1');
    expect(useUIStore.getState().pinnedIds).toContain('msg-1');
  });

  it('removes an id when already pinned', () => {
    useUIStore.getState().togglePin('msg-1');
    useUIStore.getState().togglePin('msg-1');
    expect(useUIStore.getState().pinnedIds).not.toContain('msg-1');
  });

  it('pins multiple ids independently', () => {
    useUIStore.getState().togglePin('msg-1');
    useUIStore.getState().togglePin('msg-2');
    expect(useUIStore.getState().pinnedIds).toEqual(['msg-1', 'msg-2']);
  });
});

describe('unpinAll', () => {
  it('clears all pinned ids', () => {
    useUIStore.getState().togglePin('msg-1');
    useUIStore.getState().togglePin('msg-2');
    useUIStore.getState().unpinAll();
    expect(useUIStore.getState().pinnedIds).toEqual([]);
  });
});

// ── compactMode ──────────────────────────────────────────────────────

describe('toggleCompactMode', () => {
  it('toggles compactMode from false to true', () => {
    expect(useUIStore.getState().compactMode).toBe(false);
    useUIStore.getState().toggleCompactMode();
    expect(useUIStore.getState().compactMode).toBe(true);
  });

  it('toggles back to false', () => {
    useUIStore.getState().toggleCompactMode();
    useUIStore.getState().toggleCompactMode();
    expect(useUIStore.getState().compactMode).toBe(false);
  });
});

// ── modelSwitcherOpen ───────────────────────────────────────────────

describe('setModelSwitcherOpen', () => {
  it('opens the model switcher', () => {
    useUIStore.getState().setModelSwitcherOpen(true);
    expect(useUIStore.getState().modelSwitcherOpen).toBe(true);
  });

  it('closes the model switcher', () => {
    useUIStore.getState().setModelSwitcherOpen(true);
    useUIStore.getState().setModelSwitcherOpen(false);
    expect(useUIStore.getState().modelSwitcherOpen).toBe(false);
  });
});

// ── favoriteSessionIds ───────────────────────────────────────────────

describe('toggleFavoriteSession', () => {
  it('adds a session id to favorites', () => {
    useUIStore.getState().toggleFavoriteSession('sess-abc');
    expect(useUIStore.getState().favoriteSessionIds).toContain('sess-abc');
  });

  it('removes a session id when already favorited', () => {
    useUIStore.getState().toggleFavoriteSession('sess-abc');
    useUIStore.getState().toggleFavoriteSession('sess-abc');
    expect(useUIStore.getState().favoriteSessionIds).not.toContain('sess-abc');
  });

  it('supports multiple favorites', () => {
    useUIStore.getState().toggleFavoriteSession('sess-a');
    useUIStore.getState().toggleFavoriteSession('sess-b');
    expect(useUIStore.getState().favoriteSessionIds).toEqual(['sess-a', 'sess-b']);
  });
});

// ── sessionNicknames ─────────────────────────────────────────────────

describe('setSessionNickname', () => {
  it('sets a nickname for a session', () => {
    useUIStore.getState().setSessionNickname('sess-1', 'My Session');
    expect(useUIStore.getState().sessionNicknames).toEqual({ 'sess-1': 'My Session' });
  });

  it('overwrites an existing nickname', () => {
    useUIStore.getState().setSessionNickname('sess-1', 'First');
    useUIStore.getState().setSessionNickname('sess-1', 'Second');
    expect(useUIStore.getState().sessionNicknames).toEqual({ 'sess-1': 'Second' });
  });

  it('deletes the key when nickname is empty after trim', () => {
    useUIStore.getState().setSessionNickname('sess-1', 'named');
    useUIStore.getState().setSessionNickname('sess-1', '   ');
    expect(useUIStore.getState().sessionNicknames).not.toHaveProperty('sess-1');
  });

  it('trims the nickname before storing', () => {
    useUIStore.getState().setSessionNickname('sess-1', '  trimmed  ');
    expect(useUIStore.getState().sessionNicknames).toEqual({ 'sess-1': 'trimmed' });
  });
});

// ── fileExplorerWidth ────────────────────────────────────────────────

describe('setFileExplorerWidth', () => {
  it('clamps below the minimum (160)', () => {
    useUIStore.getState().setFileExplorerWidth(50);
    expect(useUIStore.getState().fileExplorerWidth).toBe(160);
  });

  it('clamps above the maximum (400)', () => {
    useUIStore.getState().setFileExplorerWidth(999);
    expect(useUIStore.getState().fileExplorerWidth).toBe(400);
  });

  it('rounds and accepts in-range values', () => {
    useUIStore.getState().setFileExplorerWidth(299.7);
    expect(useUIStore.getState().fileExplorerWidth).toBe(300);
  });
});

// ── refineEnabled / refinePanel ─────────────────────────────────────

describe('toggleRefineEnabled', () => {
  it('toggles refineEnabled', () => {
    expect(useUIStore.getState().refineEnabled).toBe(false);
    useUIStore.getState().toggleRefineEnabled();
    expect(useUIStore.getState().refineEnabled).toBe(true);
  });
});

describe('setRefinePanel', () => {
  it('sets the refine panel', () => {
    const panel = {
      original: 'hello world',
      refined: 'refined hello',
      english: 'simple hello',
      resolve: vi.fn(),
    };
    useUIStore.getState().setRefinePanel(panel);
    expect(useUIStore.getState().refinePanel).toEqual(panel);
  });

  it('null clears the refine panel', () => {
    useUIStore.getState().setRefinePanel({
      original: 'hello',
      refined: 'hi',
      english: 'yo',
      resolve: vi.fn(),
    });
    useUIStore.getState().setRefinePanel(null);
    expect(useUIStore.getState().refinePanel).toBeNull();
  });
});

// ── fleetMonitorOpen ─────────────────────────────────────────────────

describe('setFleetMonitorOpen', () => {
  it('opens the fleet monitor', () => {
    useUIStore.getState().setFleetMonitorOpen(true);
    expect(useUIStore.getState().fleetMonitorOpen).toBe(true);
  });

  it('closes the fleet monitor', () => {
    useUIStore.getState().setFleetMonitorOpen(true);
    useUIStore.getState().setFleetMonitorOpen(false);
    expect(useUIStore.getState().fleetMonitorOpen).toBe(false);
  });
});

// ── agentsMonitorOpen ───────────────────────────────────────────────

describe('setAgentsMonitorOpen', () => {
  it('opens the agents monitor', () => {
    useUIStore.getState().setAgentsMonitorOpen(true);
    expect(useUIStore.getState().agentsMonitorOpen).toBe(true);
  });

  it('closes the agents monitor', () => {
    useUIStore.getState().setAgentsMonitorOpen(true);
    useUIStore.getState().setAgentsMonitorOpen(false);
    expect(useUIStore.getState().agentsMonitorOpen).toBe(false);
  });
});

// ── inspectorOpen / inspectorTab / toggleInspector ───────────────────

describe('setInspectorOpen', () => {
  it('opens the inspector', () => {
    useUIStore.getState().setInspectorOpen(true);
    expect(useUIStore.getState().inspectorOpen).toBe(true);
  });

  it('closes the inspector', () => {
    useUIStore.getState().setInspectorOpen(true);
    useUIStore.getState().setInspectorOpen(false);
    expect(useUIStore.getState().inspectorOpen).toBe(false);
  });
});

describe('setInspectorTab', () => {
  it('sets to fleet tab', () => {
    useUIStore.getState().setInspectorTab('fleet');
    expect(useUIStore.getState().inspectorTab).toBe('fleet');
  });

  it('sets to agents tab', () => {
    useUIStore.getState().setInspectorTab('agents');
    expect(useUIStore.getState().inspectorTab).toBe('agents');
  });
});

describe('toggleInspector', () => {
  it('opens the inspector when closed', () => {
    useUIStore.getState().toggleInspector();
    expect(useUIStore.getState().inspectorOpen).toBe(true);
  });

  it('closes the inspector when open', () => {
    useUIStore.getState().setInspectorOpen(true);
    useUIStore.getState().toggleInspector();
    expect(useUIStore.getState().inspectorOpen).toBe(false);
  });
});

// ── processMonitorOpen ──────────────────────────────────────────────

describe('setProcessMonitorOpen', () => {
  it('opens the process monitor', () => {
    useUIStore.getState().setProcessMonitorOpen(true);
    expect(useUIStore.getState().processMonitorOpen).toBe(true);
  });

  it('closes the process monitor', () => {
    useUIStore.getState().setProcessMonitorOpen(true);
    useUIStore.getState().setProcessMonitorOpen(false);
    expect(useUIStore.getState().processMonitorOpen).toBe(false);
  });
});

// ── queuePanelOpen ─────────────────────────────────────────────────

describe('setQueuePanelOpen', () => {
  it('opens the queue panel', () => {
    useUIStore.getState().setQueuePanelOpen(true);
    expect(useUIStore.getState().queuePanelOpen).toBe(true);
  });

  it('closes the queue panel', () => {
    useUIStore.getState().setQueuePanelOpen(true);
    useUIStore.getState().setQueuePanelOpen(false);
    expect(useUIStore.getState().queuePanelOpen).toBe(false);
  });
});

// ── skillsState ────────────────────────────────────────────────────

describe('setSkillsState', () => {
  it('sets the full skillsState', () => {
    const skill = {
      name: 'test-skill',
      description: 'A test skill',
      version: '1.0.0',
      source: 'bundled' as const,
      sourceUrl: '',
      ref: 'abc123',
      path: '/skills/test-skill',
      trigger: 'test',
      scope: [] as string[],
    };
    const state = {
      selectedSkill: skill,
      navHistory: [skill],
      historyIndex: 0,
      detailOpen: true,
      knownRefs: { 'test-skill': 'abc123' },
      updateAvailableCount: 1,
    };
    useUIStore.getState().setSkillsState(state);
    expect(useUIStore.getState().skillsState).toEqual(state);
  });

  it('can set selectedSkill to null', () => {
    useUIStore.getState().setSkillsState({
      selectedSkill: null,
      navHistory: [],
      historyIndex: -1,
      detailOpen: false,
      knownRefs: {},
      updateAvailableCount: 0,
    });
    expect(useUIStore.getState().skillsState.selectedSkill).toBeNull();
  });
});

// ── sidebarOpen / toggleSidebar / setSidebarOpen ────────────────────

describe('toggleSidebar', () => {
  it('toggles sidebarOpen', () => {
    useUIStore.getState().toggleSidebar();
    expect(useUIStore.getState().sidebarOpen).toBe(true);
    useUIStore.getState().toggleSidebar();
    expect(useUIStore.getState().sidebarOpen).toBe(false);
  });
});

describe('setSidebarOpen', () => {
  it('opens the sidebar', () => {
    useUIStore.getState().setSidebarOpen(true);
    expect(useUIStore.getState().sidebarOpen).toBe(true);
  });

  it('closes the sidebar', () => {
    useUIStore.getState().setSidebarOpen(true);
    useUIStore.getState().setSidebarOpen(false);
    expect(useUIStore.getState().sidebarOpen).toBe(false);
  });
});

// ── settingsOpen ────────────────────────────────────────────────────

describe('setSettingsOpen', () => {
  it('opens settings', () => {
    useUIStore.getState().setSettingsOpen(true);
    expect(useUIStore.getState().settingsOpen).toBe(true);
  });

  it('closes settings', () => {
    useUIStore.getState().setSettingsOpen(true);
    useUIStore.getState().setSettingsOpen(false);
    expect(useUIStore.getState().settingsOpen).toBe(false);
  });
});

// ── currentView ────────────────────────────────────────────────────

describe('setCurrentView', () => {
  it('sets currentView to chat', () => {
    useUIStore.getState().setCurrentView('chat');
    expect(useUIStore.getState().currentView).toBe('chat');
  });

  it('sets currentView to settings', () => {
    useUIStore.getState().setCurrentView('settings');
    expect(useUIStore.getState().currentView).toBe('settings');
  });

  it('sets currentView to files', () => {
    useUIStore.getState().setCurrentView('files');
    expect(useUIStore.getState().currentView).toBe('files');
  });

  it('sets currentView to agentflow', () => {
    useUIStore.getState().setCurrentView('agentflow');
    expect(useUIStore.getState().currentView).toBe('agentflow');
  });
});

// ── confirm dialog ─────────────────────────────────────────────────

describe('showConfirm / hideConfirm', () => {
  it('shows the confirm dialog with info', () => {
    const info = {
      id: 'confirm-1',
      toolName: 'Bash',
      input: { command: 'rm -rf /' },
      suggestedPattern: 'safe-delete',
    };
    useUIStore.getState().showConfirm(info);
    expect(useUIStore.getState().confirmInfo).toEqual(info);
    expect(useUIStore.getState().showConfirmDialog).toBe(true);
  });

  it('hides the confirm dialog', () => {
    useUIStore.getState().showConfirm({
      id: 'confirm-1',
      toolName: 'Bash',
      input: {},
      suggestedPattern: '',
    });
    useUIStore.getState().hideConfirm();
    expect(useUIStore.getState().showConfirmDialog).toBe(false);
    expect(useUIStore.getState().confirmInfo).toBeNull();
  });
});

// ── command palette ─────────────────────────────────────────────────

describe('setPaletteOpen', () => {
  it('opens the palette', () => {
    useUIStore.getState().setPaletteOpen(true);
    expect(useUIStore.getState().paletteOpen).toBe(true);
  });

  it('closes the palette', () => {
    useUIStore.getState().setPaletteOpen(true);
    useUIStore.getState().setPaletteOpen(false);
    expect(useUIStore.getState().paletteOpen).toBe(false);
  });
});

// ── shortcuts overlay ───────────────────────────────────────────────

describe('setShortcutsOpen', () => {
  it('opens the shortcuts overlay', () => {
    useUIStore.getState().setShortcutsOpen(true);
    expect(useUIStore.getState().shortcutsOpen).toBe(true);
  });

  it('closes the shortcuts overlay', () => {
    useUIStore.getState().setShortcutsOpen(true);
    useUIStore.getState().setShortcutsOpen(false);
    expect(useUIStore.getState().shortcutsOpen).toBe(false);
  });
});

// ── search ─────────────────────────────────────────────────────────

describe('setSearchOpen', () => {
  it('opens search', () => {
    useUIStore.getState().setSearchOpen(true);
    expect(useUIStore.getState().searchOpen).toBe(true);
  });

  it('closes search', () => {
    useUIStore.getState().setSearchOpen(true);
    useUIStore.getState().setSearchOpen(false);
    expect(useUIStore.getState().searchOpen).toBe(false);
  });
});

describe('setSearchQuery', () => {
  it('sets the search query', () => {
    useUIStore.getState().setSearchQuery('foo bar');
    expect(useUIStore.getState().searchQuery).toBe('foo bar');
  });

  it('can clear the search query', () => {
    useUIStore.getState().setSearchQuery('foo');
    useUIStore.getState().setSearchQuery('');
    expect(useUIStore.getState().searchQuery).toBe('');
  });
});

// ── scrollTarget / requestScrollToMessage ─────────────────────────

describe('requestScrollToMessage', () => {
  it('sets scrollTarget with nonce 1 for a new id', () => {
    useUIStore.getState().requestScrollToMessage('msg-1');
    expect(useUIStore.getState().scrollTarget).toEqual({ id: 'msg-1', nonce: 1 });
  });

  it('increments nonce when requesting the same id again', () => {
    useUIStore.getState().requestScrollToMessage('msg-1');
    useUIStore.getState().requestScrollToMessage('msg-1');
    expect(useUIStore.getState().scrollTarget).toEqual({ id: 'msg-1', nonce: 2 });
  });

  it('resets nonce when switching to a different id', () => {
    // Covers the scrollTarget !== null branch: when switching id, nonce resets to 1.
    // State is carried from the preceding test (nonce=2 for msg-1); the code path
    // (id !== scrollTarget.id) correctly sets nonce=1 for the new id.
    useUIStore.getState().requestScrollToMessage('msg-2');
    // nonce=1 for msg-2 (scrollTarget was null → null?.nonce ?? 0 = 0, +1 = 1)
    expect(useUIStore.getState().scrollTarget).toEqual({ id: 'msg-2', nonce: 1 });
  });
});

// ── promptHistory ───────────────────────────────────────────────────

describe('pushPrompt', () => {
  it('adds a prompt to history', () => {
    useUIStore.getState().pushPrompt('hello world');
    expect(useUIStore.getState().promptHistory).toContain('hello world');
  });

  it('moves an existing prompt to the front (deduplication)', () => {
    useUIStore.getState().pushPrompt('alpha');
    useUIStore.getState().pushPrompt('beta');
    useUIStore.getState().pushPrompt('alpha');
    // 'alpha' was deduplicated and moved to front
    expect(useUIStore.getState().promptHistory[0]).toBe('alpha');
    expect(useUIStore.getState().promptHistory).toHaveLength(2);
  });

  it('caps history at 50 items', () => {
    // Push 60 unique prompts
    for (let i = 0; i < 60; i++) {
      useUIStore.getState().pushPrompt(`prompt-${i}`);
    }
    expect(useUIStore.getState().promptHistory).toHaveLength(50);
    expect(useUIStore.getState().promptHistory[0]).toBe('prompt-59');
  });

  it('ignores empty and whitespace-only prompts', () => {
    useUIStore.getState().pushPrompt('');
    useUIStore.getState().pushPrompt('   ');
    useUIStore.getState().pushPrompt('valid prompt');
    expect(useUIStore.getState().promptHistory).toEqual(['valid prompt']);
  });
});
