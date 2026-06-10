import { create } from 'zustand';
import { persist } from 'zustand/middleware';

// ============================================
// UI Store
// ============================================

// Activity types shown in the ActivityBar (secondary panel content).
export type Activity = 'chat' | 'agents' | 'context' | 'history' | 'files' | 'projects' | 'sessions' | 'mailbox';

interface UIState {
  sidebarOpen: boolean;
  /** Which activity icon is selected in the ActivityBar — controls secondary panel content. */
  activeActivity: Activity;
  settingsOpen: boolean;
  currentView: 'chat' | 'history' | 'settings' | 'autophase' | 'agents' | 'files' | 'context' | 'projects' | 'sessions' | 'setup' | 'agentflow';
  showConfirmDialog: boolean;
  confirmInfo: {
    id: string;
    toolName: string;
    input: unknown;
    suggestedPattern: string;
  } | null;
  paletteOpen: boolean;
  shortcutsOpen: boolean;
  searchOpen: boolean;
  searchQuery: string;
  promptHistory: string[];
  sidebarWidth: number;
  pinnedIds: string[];
  compactMode: boolean;
  modelSwitcherOpen: boolean;
  favoriteSessionIds: string[];
  sessionNicknames: Record<string, string>;
  fileExplorerWidth: number;
  /** When true, free-text prompts are run through the prompt refiner before sending. */
  refineEnabled: boolean;

  /** Active prompt-refinement panel. Set while RefinePanel is shown. Null when no refinement is pending. */
  refinePanel: {
    original: string;
    refined: string;
    english: string;
    resolve: (decision: 'refined' | 'english' | 'original' | 'edit') => void;
  } | null;

  /** Select an activity. If clicking the already-active icon, closes the sidebar. */
  selectActivity: (activity: Activity) => void;
  toggleSidebar: () => void;
  setSidebarOpen: (open: boolean) => void;
  setSettingsOpen: (open: boolean) => void;
  setCurrentView: (view: UIState['currentView']) => void;
  showConfirm: (info: UIState['confirmInfo']) => void;
  hideConfirm: () => void;
  setPaletteOpen: (open: boolean) => void;
  setShortcutsOpen: (open: boolean) => void;
  setSearchOpen: (open: boolean) => void;
  setSearchQuery: (q: string) => void;
  pushPrompt: (text: string) => void;
  setSidebarWidth: (px: number) => void;
  togglePin: (id: string) => void;
  unpinAll: () => void;
  toggleCompactMode: () => void;
  setModelSwitcherOpen: (open: boolean) => void;
  toggleFavoriteSession: (id: string) => void;
  setSessionNickname: (id: string, nickname: string) => void;
  setFileExplorerWidth: (px: number) => void;
  toggleRefineEnabled: () => void;
  setRefinePanel: (panel: UIState['refinePanel']) => void;
}

export const useUIStore = create<UIState>()(
  persist(
    (set) => ({
      sidebarOpen: true,
      activeActivity: 'chat',
      settingsOpen: false,
      currentView: 'chat',
      showConfirmDialog: false,
      confirmInfo: null,
      paletteOpen: false,
      shortcutsOpen: false,
      searchOpen: false,
      searchQuery: '',
      promptHistory: [],
      sidebarWidth: 288,
      pinnedIds: [],
      compactMode: false,
      modelSwitcherOpen: false,
      favoriteSessionIds: [],
      sessionNicknames: {},
      fileExplorerWidth: 220,
      refineEnabled: true,
      refinePanel: null,

      selectActivity: (activity) => set({ activeActivity: activity }),
      toggleSidebar: () => set((state) => ({ sidebarOpen: !state.sidebarOpen })),
      setSidebarOpen: (open) => set({ sidebarOpen: open }),
      setSettingsOpen: (open) => set({ settingsOpen: open }),
      setCurrentView: (view) => set({ currentView: view }),
      showConfirm: (info) => set({ showConfirmDialog: true, confirmInfo: info }),
      hideConfirm: () => set({ showConfirmDialog: false, confirmInfo: null }),
      setPaletteOpen: (open) => set({ paletteOpen: open }),
      setShortcutsOpen: (open) => set({ shortcutsOpen: open }),
      setSearchOpen: (open) => set({ searchOpen: open, searchQuery: open ? '' : '' }),
      setSearchQuery: (q) => set({ searchQuery: q }),
      pushPrompt: (text) =>
        set((state) => {
          const trimmed = text.trim();
          if (!trimmed) return state;
          const filtered = state.promptHistory.filter((p) => p !== trimmed);
          return { promptHistory: [trimmed, ...filtered].slice(0, 50) };
        }),
      setSidebarWidth: (px) => set({ sidebarWidth: Math.max(200, Math.min(480, Math.round(px))) }),
      togglePin: (id) =>
        set((state) => {
          const has = state.pinnedIds.includes(id);
          return {
            pinnedIds: has ? state.pinnedIds.filter((p) => p !== id) : [...state.pinnedIds, id],
          };
        }),
      unpinAll: () => set({ pinnedIds: [] }),
      toggleCompactMode: () => set((s) => ({ compactMode: !s.compactMode })),
      setModelSwitcherOpen: (open) => set({ modelSwitcherOpen: open }),
      toggleFavoriteSession: (id) =>
        set((state) => {
          const has = state.favoriteSessionIds.includes(id);
          return {
            favoriteSessionIds: has
              ? state.favoriteSessionIds.filter((s) => s !== id)
              : [...state.favoriteSessionIds, id],
          };
        }),
      setSessionNickname: (id, nickname) =>
        set((state) => {
          const trimmed = nickname.trim();
          const next = { ...state.sessionNicknames };
          if (trimmed) next[id] = trimmed;
          else delete next[id];
          return { sessionNicknames: next };
        }),
      setFileExplorerWidth: (px) =>
        set({ fileExplorerWidth: Math.max(160, Math.min(400, Math.round(px))) }),
      toggleRefineEnabled: () => set((s) => ({ refineEnabled: !s.refineEnabled })),
      setRefinePanel: (panel) => set({ refinePanel: panel }),
    }),
    {
      name: 'wrongstack-ui',
      partialize: (s) => ({
        sidebarOpen: s.sidebarOpen,
        activeActivity: s.activeActivity,
        sidebarWidth: s.sidebarWidth,
        promptHistory: s.promptHistory,
        pinnedIds: s.pinnedIds,
        compactMode: s.compactMode,
        favoriteSessionIds: s.favoriteSessionIds,
        sessionNicknames: s.sessionNicknames,
        fileExplorerWidth: s.fileExplorerWidth,
        refineEnabled: s.refineEnabled,
      }),
    },
  ),
);
