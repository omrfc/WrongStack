import { expectDefined } from '@wrongstack/core';
import { useEffect } from 'react';
import { useWebSocketBootstrap } from '@/hooks/useWebSocket';
import { isDesktopShell } from '@/lib/desktop-shell';
import { streamCoalescer } from '@/lib/stream-coalescer';
import { cn } from '@/lib/utils';
import { getWSClient } from '@/lib/ws-client';
import { useLocalPrefs } from '@/stores/local-prefs';
import {
  type DockSection,
  resetUiNavigationToHome,
  useChatStore,
  useConfigStore,
  useFileStore,
  useSessionStore,
  useUIStore,
} from '@/stores';
import {
  ACTIVITY_SHORTCUT_BY_KEY,
  ActivityBar,
  navigateToView,
  openMainView,
  openPanel,
  pairedViewForActivity,
  PANEL_ORDER,
  showPanel,
} from './components/ActivityBar';
import { AgentsMonitor } from './components/AgentsMonitor';
import { AnalyticsDashboard } from './components/AnalyticsDashboard';
import { AutoPhaseView } from './components/AutoPhaseView';
import { ChangesView } from './components/ChangesView';
import { ChatView } from './components/ChatView';
import { CodeEditor } from './components/CodeEditor';
import { CommandPalette, downloadChatAsMarkdown } from './components/CommandPalette';
import { ConfirmDialog } from './components/ConfirmDialog';
import { ConfirmModalHost, PromptModalHost } from './components/ConfirmModal';
import { ConnectionBanner } from './components/ConnectionBanner';
import { DebugDashboard } from './components/DebugDashboard';
import { DesignGalleryView } from './components/DesignGalleryView';
import { ErrorBoundary } from './components/ErrorBoundary';
import { FleetMonitor } from './components/FleetMonitor';
import { InspectorPanel } from './components/InspectorPanel';
import { MailboxDetailView } from './components/MailboxDetailView';
import { OfficeMapPanel } from './components/OfficeMapPanel';
import { ProcessMonitor } from './components/ProcessMonitor';
import { QueuePanel } from './components/QueuePanel';
import { QuickModelSwitcher } from './components/QuickModelSwitcher';
import { RefreshDebugView } from './components/RefreshDebugView';
import { SddBoardView } from './components/SddBoardView';
import { SddWizard } from './components/SddWizard';
import { SessionsDashboard } from './components/SessionsDashboard';
import { SettingsPanel } from './components/SettingsPanel';
import { SetupScreen } from './components/SetupScreen';
import { ShortcutsOverlay } from './components/ShortcutsOverlay';
import { SidePanel } from './components/SidePanel';
import { SkillDetailView } from './components/SkillDetailView';
import { SpecsView } from './components/SpecsView';
import { TerminalPanel } from './components/TerminalPanel';
import { ThemeProvider, useTheme } from './components/ThemeProvider';
import { toast, Toaster } from './components/Toaster';
import { WorkspaceDock } from './components/WorkspaceDock';

const DESKTOP_COMMAND_VIEWS = new Set([
  'chat',
  'settings',
  'autophase',
  'specs',
  'sddboard',
  'sddwizard',
  'files',
  'changes',
  'sessions',
  'setup',
  'skill',
  'officemap',
  'mailbox',
  'debug',
  'design-gallery',
  'refresh-debug',
  'analytics',
]);

const DESKTOP_COMMAND_DOCKS = new Set([
  'autophase',
  'goal',
  'fleet',
  'work',
  'worktrees',
  'collab',
]);

const DESKTOP_COMMAND_WORK_TABS = new Set(['todos', 'tasks', 'plan']);

function publishDesktopPrefsSnapshot(): void {
  if (typeof window === 'undefined') return;
  const host = (window as unknown as {
    wrongstackDesktopHost?: {
      setReady?: (ready: boolean) => void;
      setPrefs?: (prefs: {
        yolo: boolean;
        nextPrediction: boolean;
        contextAutoCompact: boolean;
      }) => void;
      ackCommand?: (requestId: string, handled: boolean, message?: string | undefined) => void;
    };
  }).wrongstackDesktopHost;
  if (!host?.setPrefs) return;
  const prefs = useLocalPrefs.getState();
  host.setPrefs({
    yolo: prefs.yolo,
    nextPrediction: prefs.nextPrediction,
    contextAutoCompact: prefs.contextAutoCompact,
  });
}

function publishDesktopReady(ready: boolean): void {
  if (typeof window === 'undefined') return;
  const host = (window as unknown as {
    wrongstackDesktopHost?: {
      setReady?: (ready: boolean) => void;
    };
  }).wrongstackDesktopHost;
  host?.setReady?.(ready);
}

function publishDesktopCommandAck(
  requestId: unknown,
  handled: boolean,
  message?: string | undefined,
): void {
  if (typeof window === 'undefined' || typeof requestId !== 'string') return;
  const host = (window as unknown as {
    wrongstackDesktopHost?: {
      ackCommand?: (id: string, handled: boolean, message?: string | undefined) => void;
    };
  }).wrongstackDesktopHost;
  host?.ackCommand?.(requestId, handled, message);
}

function AppInner() {
  const { theme } = useTheme();
  const desktopShell = isDesktopShell();
  const {
    currentView,
    sidebarOpen,
    toggleSidebar,
    setSearchOpen,
    setSidebarOpen,
    setInspectorTab,
    setPaletteOpen,
    setShortcutsOpen,
    setModelSwitcherOpen,
    setPromptLibraryOpen,
    toggleInspector,
    fleetMonitorOpen,
    agentsMonitorOpen,
    setFleetMonitorOpen,
    setAgentsMonitorOpen,
    processMonitorOpen,
    setProcessMonitorOpen,
    queuePanelOpen,
    setQueuePanelOpen,
    terminalOpen,
    setTerminalOpen,
  } = useUIStore();
  const isLoading = useChatStore((s) => s.isLoading);
  const iteration = useSessionStore((s) => s.iteration);
  const projectName = useSessionStore((s) => s.projectName);
  const sessionTitle = useSessionStore((s) => s.session?.title);
  const sessionId = useSessionStore((s) => s.session?.id);
  const nickname = useUIStore((s) => (sessionId ? s.sessionNicknames[sessionId] : undefined));

  useEffect(() => {
    if (!desktopShell) return;
    resetUiNavigationToHome({ sidebarOpen: false });
  }, [desktopShell]);

  // Detect /debug, /analytics, /refresh-debug URL paths and switch views.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (window.location.pathname === '/debug') {
      navigateToView('debug');
    } else if (window.location.pathname === '/analytics') {
      navigateToView('analytics');
    } else if (window.location.pathname === '/refresh-debug') {
      navigateToView('refresh-debug');
    }
  }, []);

  // Handle file open requests from FileExplorer (dispatches custom events on window)
  useEffect(() => {
    const onOpenFile = (e: Event) => {
      const { filePath } = (e as CustomEvent<{ filePath: string }>).detail;
      const ws = getWSClient(useConfigStore.getState().wsUrl);
      if (ws) {
        ws.send({ type: 'files.read', payload: { filePath } });
      }
    };
    window.addEventListener('wrongstack:open-file', onOpenFile);
    return () => window.removeEventListener('wrongstack:open-file', onOpenFile);
  }, []);

  // Handle file save requests from CodeEditor (Ctrl+S)
  useEffect(() => {
    const onSaveFile = (e: Event) => {
      const { filePath } = (e as CustomEvent<{ filePath: string }>).detail;
      const file = useFileStore.getState().openFiles.find((f) => f.path === filePath);
      if (!file) return;
      const ws = getWSClient(useConfigStore.getState().wsUrl);
      if (ws) {
        ws.send({
          type: 'files.write',
          payload: { filePath, content: file.content },
        });
      }
    };
    window.addEventListener('wrongstack:save-file', onSaveFile);
    return () => window.removeEventListener('wrongstack:save-file', onSaveFile);
  }, []);

  // Mobile-friendly: collapse the sidebar automatically below the md
  // breakpoint (768px). Tracks viewport changes so a window resize behaves
  // the same as a fresh load. We only AUTO-close — re-opening (or keeping
  // it open) on small screens stays a user decision, so we never call
  // setSidebarOpen(true) here.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const mq = window.matchMedia('(max-width: 768px)');
    const apply = () => {
      if (mq.matches && useUIStore.getState().sidebarOpen) {
        setSidebarOpen(false);
      }
    };
    apply();
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, [setSidebarOpen]);
  // Install WS handlers exactly once for the whole app. Every other consumer
  // (ChatInput, ConfirmDialog, SettingsPanel) uses the cheap `useWebSocket()`
  // hook which returns action methods only — see hooks/useWebSocket.ts for
  // the duplicate-handler trap this avoids.
  useWebSocketBootstrap();

  useEffect(() => {
    publishDesktopPrefsSnapshot();
    return useLocalPrefs.subscribe((next, prev) => {
      if (
        next.yolo === prev.yolo &&
        next.nextPrediction === prev.nextPrediction &&
        next.contextAutoCompact === prev.contextAutoCompact
      ) {
        return;
      }
      publishDesktopPrefsSnapshot();
    });
  }, []);

  // Desktop shell integration. Electron hosts the real WebUI in a
  // WebContentsView and sends this event when the native sidebar asks to open a
  // WebUI surface. Browser users never see this path.
  useEffect(() => {
    const applyDesktopCommand = (rawDetail: unknown): boolean => {
      const detail =
        rawDetail && typeof rawDetail === 'object' && !Array.isArray(rawDetail)
          ? (rawDetail as Record<string, unknown>)
          : {};
      const ui = useUIStore.getState();
      const ws = getWSClient(useConfigStore.getState().wsUrl);
      let handled = false;

      const openDesktopView = (view: string): void => {
        navigateToView(view as never);
        if (view === 'sessions') {
          ws?.listSessions?.(50);
        }
      };

      const activity = detail['activity'];
      if (typeof activity === 'string' && (PANEL_ORDER as readonly string[]).includes(activity)) {
        const nextActivity = activity as (typeof PANEL_ORDER)[number];
        showPanel(nextActivity);
        handled = true;
        if (detail['view'] === undefined) {
          const fallbackView = pairedViewForActivity(nextActivity);
          if (fallbackView === 'sessions') {
            ws?.listSessions?.(50);
          }
        }
      }

      const view = detail['view'];
      if (typeof view === 'string' && DESKTOP_COMMAND_VIEWS.has(view)) {
        openDesktopView(view);
        handled = true;
      }

      const action = detail['action'];
      if (action === 'new-session') {
        ws?.newSession?.();
        showPanel('chat');
        handled = true;
      } else if (action === 'clear-context') {
        streamCoalescer.dropAll();
        useChatStore.getState().clearMessages();
        ws?.clearContext?.();
        showPanel('chat');
        handled = true;
      } else if (action === 'compact-context') {
        ws?.compactContext?.();
        showPanel('chat');
        handled = true;
      } else if (action === 'repair-context') {
        ws?.repairContext?.();
        showPanel('chat');
        handled = true;
      } else if (action === 'download-chat') {
        downloadChatAsMarkdown();
        handled = true;
      } else if (action === 'focus-chat') {
        showPanel('chat');
        window.requestAnimationFrame(() => document.querySelector('textarea')?.focus());
        handled = true;
      } else if (action === 'open-command-palette') {
        setPaletteOpen(true);
        handled = true;
      } else if (action === 'open-shortcuts') {
        setShortcutsOpen(true);
        handled = true;
      } else if (action === 'search-chat') {
        setSearchOpen(true);
        handled = true;
      } else if (action === 'open-model-switcher') {
        setModelSwitcherOpen(true);
        handled = true;
      } else if (action === 'open-prompt-library') {
        setPromptLibraryOpen(true);
        handled = true;
      }

      const dockSection = detail['dockSection'];
      if (typeof dockSection === 'string' && DESKTOP_COMMAND_DOCKS.has(dockSection)) {
        const section = dockSection as DockSection;
        ui.showDockChip(section);
        ui.setDockCustomizeOpen(false);
        handled = true;
        if (dockSection === 'autophase') {
          openMainView('autophase');
          ui.setDockSection(null);
          return handled;
        }
        showPanel('chat');
        ui.setDockSection(section);
        if (dockSection === 'goal') {
          ws?.send?.({ type: 'goal.get' });
        }
      }

      const workTab = detail['workTab'];
      if (typeof workTab === 'string' && DESKTOP_COMMAND_WORK_TABS.has(workTab)) {
        ui.showDockChip('work');
        ui.setDockCustomizeOpen(false);
        showPanel('chat');
        ui.setDockSection('work');
        ui.setWorkDashboardTab(workTab as never);
        handled = true;
        if (workTab === 'plan') {
          ws?.getPlan?.();
        }
      }

      const overlay = detail['overlay'];
      if (overlay === 'fleet') {
        setFleetMonitorOpen(true);
        handled = true;
      } else if (overlay === 'agents-monitor') {
        setAgentsMonitorOpen(true);
        handled = true;
      } else if (overlay === 'processes') {
        setProcessMonitorOpen(true);
        handled = true;
      } else if (overlay === 'queue') {
        setQueuePanelOpen(true);
        handled = true;
      }

      if (detail['terminal'] === 'toggle') {
        ui.toggleTerminal();
        handled = true;
      } else if (detail['terminal'] === 'new') {
        if (ui.terminalOpen) {
          ui.requestTerminalCreate();
        } else {
          setTerminalOpen(true);
        }
        handled = true;
      } else if (detail['terminal'] === true) {
        setTerminalOpen(true);
        handled = true;
      } else if (detail['terminal'] === false) {
        setTerminalOpen(false);
        handled = true;
      }

      const pref = detail['pref'];
      if (pref && typeof pref === 'object' && !Array.isArray(pref)) {
        const command = pref as Record<string, unknown>;
        const key = command['key'];
        if (
          key === 'yolo' ||
          key === 'nextPrediction' ||
          key === 'contextAutoCompact'
        ) {
          const prefs = useLocalPrefs.getState();
          const value =
            command['toggle'] === true ? !prefs[key] : command['value'];
          if (typeof value === 'boolean') {
            const patch = { [key]: value };
            prefs.set(patch);
            ws?.updatePrefs?.(patch);
            if (key === 'yolo') {
              toast.info(`YOLO ${value ? 'enabled' : 'disabled'}`);
            }
            handled = true;
          }
        }
      }

      return handled;
    };

    const handledDesktopCommandIds = new Set<string>();
    const handledDesktopCommandOrder: string[] = [];
    const rememberHandledDesktopCommand = (requestId: string): void => {
      handledDesktopCommandIds.add(requestId);
      handledDesktopCommandOrder.push(requestId);
      while (handledDesktopCommandOrder.length > 120) {
        const stale = handledDesktopCommandOrder.shift();
        if (stale) handledDesktopCommandIds.delete(stale);
      }
    };

    const handleDesktopCommand = (rawDetail: unknown): void => {
      const detail =
        rawDetail && typeof rawDetail === 'object' && !Array.isArray(rawDetail)
          ? (rawDetail as Record<string, unknown>)
          : {};
      const requestId = detail['requestId'];
      if (typeof requestId === 'string' && handledDesktopCommandIds.has(requestId)) {
        publishDesktopCommandAck(requestId, true);
        return;
      }
      try {
        const handled = applyDesktopCommand(rawDetail);
        if (handled && typeof requestId === 'string') {
          rememberHandledDesktopCommand(requestId);
        }
        publishDesktopCommandAck(requestId, handled);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        publishDesktopCommandAck(requestId, false, message);
        console.error('Failed to handle desktop command:', err);
      }
    };

    const bridge = (window as unknown as {
      wrongstackDesktopCommands?: {
        subscribe?: (cb: (command: Record<string, unknown>) => void) => () => void;
      };
    }).wrongstackDesktopCommands;
    const unsubscribe =
      bridge?.subscribe?.((command) => {
        handleDesktopCommand(command);
      }) ?? null;
    const onDesktopCommand = (event: Event): void => {
      handleDesktopCommand((event as CustomEvent<Record<string, unknown>>).detail);
    };
    window.addEventListener('wrongstack:desktop-command', onDesktopCommand);
    (window as unknown as { __wrongstackDesktopReady?: boolean }).__wrongstackDesktopReady = true;
    publishDesktopReady(true);
    return () => {
      (window as unknown as { __wrongstackDesktopReady?: boolean }).__wrongstackDesktopReady = false;
      publishDesktopReady(false);
      if (unsubscribe) unsubscribe();
      window.removeEventListener('wrongstack:desktop-command', onDesktopCommand);
    };
  }, [
    setAgentsMonitorOpen,
    setFleetMonitorOpen,
    setModelSwitcherOpen,
    setPaletteOpen,
    setPromptLibraryOpen,
    setProcessMonitorOpen,
    setQueuePanelOpen,
    setSearchOpen,
    setShortcutsOpen,
    setTerminalOpen,
  ]);

  // F5-resilience: the zustand persist middleware writes asynchronously
  // after every mutation. When the page tears down via F5 / tab close /
  // navigation, in-flight writes can be lost. We hook `pagehide` (the
  // recommended event for bfcache + unload coverage) to force a flush so
  // the next visit finds the latest state. The flush is silent — we
  // don't want a user-visible error if localStorage is full.
  useEffect(() => {
    const flush = (): void => {
      try {
        const stores = [useSessionStore, useChatStore, useUIStore, useConfigStore];
        for (const s of stores) {
          const persistApi = (
            s as unknown as {
              persist?: { flush?: () => void; getOptions?: () => { storage?: unknown } };
            }
          ).persist;
          if (persistApi && typeof persistApi.flush === 'function') {
            persistApi.flush();
          }
        }
      } catch {
        // ignore — best-effort flush.
      }
    };
    window.addEventListener('pagehide', flush);
    window.addEventListener('beforeunload', flush);
    return () => {
      window.removeEventListener('pagehide', flush);
      window.removeEventListener('beforeunload', flush);
    };
  }, []);

  // F5-resilience: if the persisted view was something exotic (a debug
  // overlay, an inspector-only tab), fall back to chat on first mount.
  // The persisted view is intended for "user landed back on the chat
  // surface during normal work" — debug overlays should not auto-restore.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (window.location.pathname === '/refresh-debug') return;
    const persistedView = useUIStore.getState().currentView;
    if (
      persistedView === 'debug' ||
      persistedView === 'analytics' ||
      persistedView === 'design-gallery' ||
      persistedView === 'setup'
    ) {
      showPanel('chat');
    }
  }, []);

  // Reflect the agent's run state + session identity in the browser tab
  // title. Pinned/grouped tab strips become readable at a glance — the
  // project name surfaces first so multiple WrongStack windows on the same
  // bar can still be distinguished, then the session title (if any), then
  // the running indicator. Falls back gracefully when fields are missing.
  useEffect(() => {
    const parts: string[] = [];
    if (isLoading) {
      const it = iteration
        ? ` iter ${iteration.index}${iteration.max ? `/${iteration.max}` : ''}`
        : '';
      parts.push(`●${it}`);
    }
    const sessionLabel = nickname?.trim() || sessionTitle?.trim();
    const projectLabel = projectName?.trim();
    if (sessionLabel) parts.push(sessionLabel);
    if (projectLabel) parts.push(projectLabel);
    if (parts.length === 0) parts.push(projectLabel || 'AI Agent');
    const title = parts.filter(Boolean).join(' · ');
    document.title = title;
    return () => {
      document.title = projectName || 'AI Agent';
    };
  }, [isLoading, iteration, projectName, sessionTitle, nickname]);

  // Global keyboard shortcuts for the actions that don't have a dedicated
  // owner (palette/shortcuts handle their own). Bound here so they fire
  // anywhere except inside text inputs (where Ctrl+F should still search
  // the chat, but Ctrl+L would otherwise be a browser address-bar focus).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const tag = t?.tagName?.toLowerCase();
      const inField = tag === 'input' || tag === 'textarea' || t?.isContentEditable;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key === '\\') {
        e.preventDefault();
        toggleSidebar();
        return;
      }
      // Ctrl+` — toggle the integrated terminal bottom-dock (VS Code parity).
      if (mod && e.key === '`') {
        e.preventDefault();
        useUIStore.getState().toggleTerminal();
        return;
      }
      // Ctrl+1..9/0 — jump straight to a side panel (same logic as clicking
      // its ActivityBar icon, including close-on-repeat). Use an explicit
      // map instead of numeric PANEL_ORDER indexing because some panels use
      // non-sequential shortcuts (Design is Ctrl+0; Worktrees is Ctrl+Shift+W).
      if (mod && !e.shiftKey && !e.altKey && Object.hasOwn(ACTIVITY_SHORTCUT_BY_KEY, e.key)) {
        const activity = ACTIVITY_SHORTCUT_BY_KEY[e.key];
        if (activity) {
          e.preventDefault();
          openPanel(activity);
          return;
        }
      }
      if (mod && e.shiftKey && !e.altKey && e.key.toLowerCase() === 'w') {
        e.preventDefault();
        openPanel('worktrees');
        return;
      }
      // F1..F12 — browser equivalents of the TUI function-key panels.
      // These are skipped while typing so editor/text-input conventions keep
      // working inside the chat box and code editor.
      if (!inField && !mod && !e.altKey && /^F([1-9]|1[0-2])$/.test(e.key)) {
        e.preventDefault();
        const ui = useUIStore.getState();
        const ws = getWSClient(useConfigStore.getState().wsUrl);
        const n = Number(e.key.slice(1));
        ui.setDockCustomizeOpen(false);
        switch (n) {
          case 1:
            openPanel('chat');
            return;
          case 2:
            ui.setFleetMonitorOpen(true);
            return;
          case 3:
            ui.setAgentsMonitorOpen(true);
            return;
          case 4:
            showPanel('worktrees');
            ui.setDockSection('worktrees');
            return;
          case 5:
            ws?.getPlan?.();
            showPanel('chat');
            ui.setDockSection('work');
            ui.setWorkDashboardTab('plan');
            return;
          case 6:
            showPanel('chat');
            ui.setDockSection('work');
            ui.setWorkDashboardTab('todos');
            return;
          case 7:
            ui.setQueuePanelOpen(true);
            return;
          case 8:
            ui.setProcessMonitorOpen(true);
            return;
          case 9:
            ws?.send?.({ type: 'goal.get' });
            showPanel('chat');
            ui.setDockSection('goal');
            return;
          case 10:
            ws?.listSessions?.(50);
            showPanel('history');
            return;
          case 11:
            showPanel('officemap');
            return;
          case 12:
            showPanel('chat');
            ui.setDockSection('work');
            ui.setDockCustomizeOpen(true);
            return;
        }
      }
      if (mod && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        setSearchOpen(true);
        return;
      }
      if (mod && e.key.toLowerCase() === '/') {
        // Focus the chat textarea so the user can start typing without
        // hunting for it. Useful after closing palette/settings.
        e.preventDefault();
        const ta = document.querySelector('textarea');
        ta?.focus();
        return;
      }
      // The Ctrl-letter shortcuts skip when the user is typing in any
      // input — otherwise Ctrl+L wipes the chat while they're composing.
      // Access the WS client via the Zustand store instead of the `ws`
      // hook return value so we don't re-register this effect on every
      // render (useWebSocket() returns a fresh object each time).
      if (mod && !inField) {
        if (e.key.toLowerCase() === 'l') {
          e.preventDefault();
          streamCoalescer.dropAll();
          useChatStore.getState().clearMessages();
          getWSClient(useConfigStore.getState().wsUrl)?.clearContext?.();
        } else if (e.key.toLowerCase() === 'n') {
          e.preventDefault();
          getWSClient(useConfigStore.getState().wsUrl)?.newSession?.();
          showPanel('chat');
        } else if (e.key.toLowerCase() === 'e') {
          e.preventDefault();
          downloadChatAsMarkdown();
        }
      }
      // Ctrl+Shift+D toggles compact UI density. Distinct from Ctrl+D
      // (which is reserved as the browser bookmark accelerator).
      if (mod && e.shiftKey && e.key.toLowerCase() === 'd') {
        e.preventDefault();
        useUIStore.getState().toggleCompactMode();
      }
      // Ctrl+Shift+M — open inspector on Fleet tab (or toggle if already open)
      if (mod && e.shiftKey && e.key.toLowerCase() === 'm') {
        e.preventDefault();
        const s = useUIStore.getState();
        if (s.inspectorOpen && s.inspectorTab === 'fleet') {
          toggleInspector();
        } else {
          setInspectorTab('fleet');
          if (!s.inspectorOpen) toggleInspector();
        }
      }
      // Ctrl+Shift+A — open inspector on Agents tab (or toggle if already open)
      if (mod && e.shiftKey && e.key.toLowerCase() === 'a') {
        e.preventDefault();
        const s = useUIStore.getState();
        if (s.inspectorOpen && s.inspectorTab === 'agents') {
          toggleInspector();
        } else {
          setInspectorTab('agents');
          if (!s.inspectorOpen) toggleInspector();
        }
      }
      // Ctrl+Shift+G — open Debug Dashboard
      if (mod && e.shiftKey && e.key.toLowerCase() === 'g') {
        e.preventDefault();
        navigateToView('debug');
      }
      // Escape — collapse the inspector panel when it's open (DevTools
      // habit). Runs only when the inspector is visible so it doesn't steal
      // Esc from search / palette / bubble-focus dismissal.
      if (e.key === 'Escape' && !mod && useUIStore.getState().inspectorOpen) {
        useUIStore.getState().setInspectorOpen(false);
      }
      // Vim-style chat navigation: j/k step between bubbles, g goes to the
      // first message and G to the last. Skipped while typing so j/k inside
      // the textarea still inserts those letters. No modifier required —
      // this is the chat surface's primary input mode for keyboard users.
      if (!inField && !mod && !e.altKey) {
        const bubbles = Array.from(document.querySelectorAll<HTMLElement>('[data-message-id]'));
        if (bubbles.length === 0) return;
        const current = document.querySelector<HTMLElement>(
          '[data-message-id][data-focused="true"]',
        );
        const idx = current ? bubbles.indexOf(current) : -1;
        const focusBubble = (target: HTMLElement) => {
          for (const b of bubbles) b.removeAttribute('data-focused');
          target.setAttribute('data-focused', 'true');
          target.scrollIntoView({ behavior: 'smooth', block: 'center' });
        };
        if (e.key === 'j' || e.key === 'ArrowDown') {
          // ArrowDown only intercepts when nothing else has focus AND the
          // user is not in a scrollable list context — the textarea check
          // above covers the only place arrows have meaningful default
          // behaviour for this app.
          const next = bubbles[Math.min(bubbles.length - 1, Math.max(0, idx + 1))];
          if (next) {
            e.preventDefault();
            focusBubble(next);
          }
          return;
        }
        if (e.key === 'k' || e.key === 'ArrowUp') {
          const prev = bubbles[Math.max(0, idx <= 0 ? 0 : idx - 1)];
          if (prev) {
            e.preventDefault();
            focusBubble(prev);
          }
          return;
        }
        if (e.key === 'g' && !e.shiftKey) {
          e.preventDefault();
          focusBubble(expectDefined(bubbles[0]));
          return;
        }
        if (e.key === 'G' || (e.key === 'g' && e.shiftKey)) {
          e.preventDefault();
          focusBubble(expectDefined(bubbles[bubbles.length - 1]));
          return;
        }
        if (e.key === 'Escape' && current) {
          e.preventDefault();
          current.removeAttribute('data-focused');
          return;
        }
        // `c` while a bubble is focused: copy its visible text. Useful
        // pairing with the j/k flow so power users can step + copy without
        // hunting for the in-bubble copy button.
        if (e.key === 'c' && current) {
          const text =
            current.querySelector<HTMLElement>('.markdown-content')?.innerText ?? current.innerText;
          if (text) {
            void navigator.clipboard?.writeText(text).catch(() => {});
            e.preventDefault();
          }
          return;
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toggleSidebar, setSearchOpen]);

  return (
    <div
      data-shell={desktopShell ? 'desktop' : 'browser'}
      className={cn(
        'ws-app-root flex min-h-0 min-w-0 overflow-hidden',
        desktopShell && 'ws-desktop-shell',
        theme,
      )}
    >
      {/* ── Activity Bar — hidden during setup ── */}
      {currentView !== 'setup' && <ActivityBar desktopShell={desktopShell} />}

      {/* ── Secondary Panel — collapsible, context-sensitive ── */}
      {sidebarOpen && currentView !== 'setup' && <SidePanel desktopShell={desktopShell} />}

      {/* ── Main area ── */}
      <main className="flex-1 min-w-0 min-h-0 flex flex-col overflow-hidden">
        {currentView !== 'setup' && <ConnectionBanner />}
        {currentView === 'chat' && (
          <>
            {/* WorkspaceDock — one slim chip strip (AutoPhase, Goal, Fleet,
                Work, Worktrees, Collab); at most one panel expands below it
                instead of the old always-on vertical pile. */}
            {/* shrink-0 + capped height + own scroll: an expanded dock section
                (Work tasks, Fleet, AutoPhase board, …) must never grow tall
                enough to push the chat transcript off-screen and kill its
                scroll. The dock scrolls internally past the cap; ChatView keeps
                the remaining height as its own scroll region. */}
            {sessionId && (
              <div
                className={cn(
                  'ws-workspace-dock-wrap px-4 pt-2 shrink-0 overflow-y-auto overscroll-contain',
                  terminalOpen ? 'max-h-[28dvh]' : 'max-h-[45dvh]',
                )}
              >
                <WorkspaceDock sessionId={sessionId} />
              </div>
            )}
            <ChatView />
            {/* Bottom inspector panel — DevTools-style dock that slides
                up/down. Replaces the fixed BottomDock (which blocked the
                chat input) and the modal Fleet/Agents drawers. Lives in
                the chat view so it doesn't clutter settings/sessions. */}
            <InspectorPanel />
          </>
        )}
        {currentView === 'settings' && (
          <div className="flex-1 min-h-0 min-w-0 overflow-hidden">
            <SettingsPanel />
          </div>
        )}
        {currentView === 'setup' && (
          <div className="flex-1 min-h-0 min-w-0 overflow-hidden">
            <SetupScreen />
          </div>
        )}
        {currentView === 'autophase' && (
          <div className="flex-1 min-h-0 min-w-0 overflow-hidden">
            <AutoPhaseView onClose={() => showPanel('chat')} />
          </div>
        )}
        {currentView === 'specs' && (
          <div className="flex-1 min-h-0 min-w-0 overflow-hidden">
            <SpecsView onClose={() => showPanel('chat')} />
          </div>
        )}
        {currentView === 'sddboard' && (
          <div className="flex-1 min-h-0 min-w-0 overflow-hidden">
            <SddBoardView onClose={() => showPanel('chat')} />
          </div>
        )}
        {currentView === 'sddwizard' && (
          <div className="flex-1 min-h-0 min-w-0 overflow-hidden">
            <SddWizard onClose={() => showPanel('chat')} />
          </div>
        )}
        {currentView === 'sessions' && (
          <div className="flex-1 min-h-0 min-w-0 overflow-y-auto">
            <SessionsDashboard />
          </div>
        )}
        {/* ── Debug Dashboard — accessed via /debug URL ── */}
        {currentView === 'debug' && (
          <div className="flex-1 min-h-0 min-w-0 overflow-hidden">
            <DebugDashboard />
          </div>
        )}

        {/* ── Refresh-resilience verifier — accessed via /refresh-debug URL. ──
         *  Lets the user confirm in-app that the latest active session
         *  pointer, transcript, and UI state survived an F5. Without a
         *  visible surface there's no way for the user to verify the
         *  contract from the WebUI itself, which was a stated requirement. */}
        {currentView === 'refresh-debug' && (
          <div className="flex-1 min-h-0 min-w-0 overflow-hidden">
            <RefreshDebugView />
          </div>
        )}

        {/* ── IDE Code Editor (only in Files view) ── */}
        {currentView === 'files' && (
          <div className="flex-1 min-h-0 min-w-0 overflow-hidden">
            <CodeEditor />
          </div>
        )}

        {/* ── Source-control diff — file list lives in the SidePanel ── */}
        {currentView === 'changes' && (
          <div className="flex-1 min-h-0 min-w-0 overflow-hidden">
            <ChangesView className="h-full min-h-0" />
          </div>
        )}

        {/* ── Mailbox detail — wide main area; list lives in the SidePanel ── */}
        {currentView === 'mailbox' && (
          <div className="flex-1 min-h-0 min-w-0 overflow-hidden">
            <MailboxDetailView className="h-full min-h-0" />
          </div>
        )}

        {/* ── Design Studio gallery — live kit previews ── */}
        {currentView === 'design-gallery' && (
          <div className="flex-1 min-h-0 min-w-0 overflow-hidden">
            <DesignGalleryView className="h-full" />
          </div>
        )}

        {/* ── Skill detail — wide main area; list lives in the SidePanel ── */}
        {currentView === 'skill' && (
          <div className="flex-1 min-h-0 min-w-0 overflow-hidden">
            <SkillDetailView className="h-full" />
          </div>
        )}

        {/* ── Office Map (Fleet HQ) — wide main area; settings in the SidePanel ── */}
        {currentView === 'officemap' && (
          <div className="flex-1 min-h-0 min-w-0 overflow-hidden">
            <OfficeMapPanel />
          </div>
        )}

        {/* ── Analytics Dashboard — event stats, session metrics, usage ── */}
        {currentView === 'analytics' && (
          <div className="flex-1 min-h-0 min-w-0 overflow-hidden">
            <AnalyticsDashboard />
          </div>
        )}

        {/* Integrated terminal bottom dock. It lives inside main's flex column
            so every view above it gets a smaller, scrollable height instead of
            being covered by a fixed overlay. */}
        {terminalOpen && (
          <TerminalPanel desktopShell={desktopShell} onClose={() => setTerminalOpen(false)} />
        )}
      </main>

      {/* Fleet Monitor sidebar overlay */}
      {fleetMonitorOpen && <FleetMonitor onClose={() => setFleetMonitorOpen(false)} />}

      {/* Agents Monitor sidebar overlay */}
      {agentsMonitorOpen && <AgentsMonitor onClose={() => setAgentsMonitorOpen(false)} />}

      {/* Process Monitor overlay — triggered by /kill */}
      {processMonitorOpen && (
        <ProcessMonitor open={processMonitorOpen} onClose={() => setProcessMonitorOpen(false)} />
      )}

      {/* Queue Panel overlay — triggered by /queue */}
      {queuePanelOpen && (
        <QueuePanel open={queuePanelOpen} onClose={() => setQueuePanelOpen(false)} />
      )}

      {/* Global overlays */}
      <ConfirmDialog />
      <ConfirmModalHost />
      <PromptModalHost />
      <CommandPalette />
      <ShortcutsOverlay />
      <QuickModelSwitcher />
      <Toaster />
    </div>
  );
}

export function App() {
  return (
    <ErrorBoundary>
      <ThemeProvider defaultTheme="system">
        <AppInner />
      </ThemeProvider>
    </ErrorBoundary>
  );
}
