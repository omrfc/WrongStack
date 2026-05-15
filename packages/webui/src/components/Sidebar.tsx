import { useEffect, useState } from 'react';
import { useUIStore, useChatStore, useSessionStore, useConfigStore, useHistoryStore } from '@/stores';
import { useWebSocket } from '@/hooks/useWebSocket';
import { cn } from '@/lib/utils';
import {
  MessageSquare,
  History,
  Settings as SettingsIcon,
  PanelLeftClose,
  Trash2,
  RotateCcw,
  Zap,
  Database,
  Wifi,
  WifiOff,
  RefreshCw,
  Loader2,
  CheckCircle2,
  Circle,
  CircleDot,
  ListTodo,
  Pin,
  Search,
  X,
  Star,
} from 'lucide-react';
import { Button } from './ui/button';
import { Tabs, TabsList, TabsTrigger, TabsContent } from './ui/tabs';
import { ScrollArea } from './ui/scroll-area';

/**
 * Sidebar: navigation + at-a-glance session info. Settings live in the main
 * `SettingsPanel` (open via the gear in ChatView's header or the button at
 * the bottom of this sidebar) — keeping settings in two places confused
 * users who clicked the sidebar "Settings" tab expecting a model picker
 * and only found a theme switcher.
 */
export function Sidebar() {
  const { toggleSidebar, currentView, setCurrentView } = useUIStore();
  const sidebarWidth = useUIStore((s) => s.sidebarWidth);
  const setSidebarWidth = useUIStore((s) => s.setSidebarWidth);
  const { totalTokens, cost, session, todos } = useSessionStore();
  const { messages, clearMessages } = useChatStore();
  const pinnedIds = useUIStore((s) => s.pinnedIds);
  const unpinAll = useUIStore((s) => s.unpinAll);
  /** Local-only filter for the History tab. Case-insensitive substring
   *  match against title, model, provider, and session id — covers the
   *  ways users actually try to find a past session ("the one where I
   *  used sonnet…"). Live as you type; clears with the X button. */
  const [historyQuery, setHistoryQuery] = useState('');
  const favoriteSessionIds = useUIStore((s) => s.favoriteSessionIds);
  const toggleFavoriteSession = useUIStore((s) => s.toggleFavoriteSession);
  const sessionNicknames = useUIStore((s) => s.sessionNicknames);
  const setSessionNickname = useUIStore((s) => s.setSessionNickname);
  /** Inline rename target — null when nothing is being edited, otherwise
   *  the session id whose title is currently in edit mode. The draft text
   *  is local state so Esc can cancel cleanly. */
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  /** Pinned bubbles that still exist in the current message list. We prune
   *  here (rather than auto-trimming pinnedIds in the store) so the user
   *  doesn't lose pins just because we cleared and reloaded a transcript.
   *  Shows a single-line preview + jumps to the bubble on click. */
  const pinnedRows = pinnedIds
    .map((id) => messages.find((m) => m.id === id))
    .filter((m): m is NonNullable<typeof m> => !!m && m.content.length > 0);
  const { wsConnected, wsUrl, provider, model } = useConfigStore();
  const { entries: historyEntries, loading: historyLoading, error: historyError } = useHistoryStore();
  const { listSessions, deleteSession, resumeSession, client } = useWebSocket();
  // Pull the current todo snapshot once on connect so a freshly-opened
  // tab doesn't sit todo-less until the next tool runs.
  useEffect(() => {
    if (wsConnected) client?.getTodos?.();
  }, [wsConnected, client]);
  const activeSessionId = session?.id;

  // Refresh the history list on tab open + whenever the active session id
  // changes (a /new would push the previous session into history).
  useEffect(() => {
    void activeSessionId;
    if (currentView === 'history' && wsConnected) {
      listSessions(50);
    }
  }, [currentView, wsConnected, activeSessionId, listSessions]);

  const formatDuration = (start: number | null) => {
    if (!start) return '--';
    const seconds = Math.floor((Date.now() - start) / 1000);
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    return `${minutes}m`;
  };

  const formatRelative = (iso: string): string => {
    const ts = Date.parse(iso);
    if (Number.isNaN(ts)) return '';
    const diff = Date.now() - ts;
    if (diff < 60_000) return 'just now';
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
    if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
    const days = Math.floor(diff / 86_400_000);
    if (days < 7) return `${days}d ago`;
    return new Date(ts).toLocaleDateString();
  };

  /** Bucket history rows into Today / Yesterday / This week / Earlier so the
   *  list reads like a journal instead of one long undifferentiated stream.
   *  Boundaries are local midnight. Entries with unparseable timestamps
   *  fall into "Earlier" so they're not silently dropped. */
  const groupedHistory = ((): Array<{ label: string; rows: typeof historyEntries; star?: boolean }> => {
    const q = historyQuery.trim().toLowerCase();
    const filtered = q
      ? historyEntries.filter(
          (e) =>
            e.title.toLowerCase().includes(q) ||
            e.model.toLowerCase().includes(q) ||
            e.provider.toLowerCase().includes(q) ||
            e.id.toLowerCase().includes(q),
        )
      : historyEntries;
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const todayStart = startOfDay.getTime();
    const yesterdayStart = todayStart - 86_400_000;
    const weekStart = todayStart - 6 * 86_400_000;
    const buckets: { today: typeof historyEntries; yesterday: typeof historyEntries; week: typeof historyEntries; older: typeof historyEntries } = {
      today: [], yesterday: [], week: [], older: [],
    };
    for (const e of filtered) {
      const ts = Date.parse(e.startedAt);
      if (Number.isNaN(ts)) { buckets.older.push(e); continue; }
      if (ts >= todayStart) buckets.today.push(e);
      else if (ts >= yesterdayStart) buckets.yesterday.push(e);
      else if (ts >= weekStart) buckets.week.push(e);
      else buckets.older.push(e);
    }
    // Favorites form their own bucket at the very top, regardless of when
    // they were started — that's the whole point of starring a session.
    const favSet = new Set(favoriteSessionIds);
    const favorites = filtered.filter((e) => favSet.has(e.id));
    const out: Array<{ label: string; rows: typeof historyEntries; star?: boolean }> = [];
    if (favorites.length) out.push({ label: 'Favorites', rows: favorites, star: true });
    // Strip favorites from the date buckets so they don't appear twice.
    const dedupe = (arr: typeof historyEntries) => arr.filter((e) => !favSet.has(e.id));
    const today = dedupe(buckets.today);
    const yesterday = dedupe(buckets.yesterday);
    const week = dedupe(buckets.week);
    const older = dedupe(buckets.older);
    if (today.length) out.push({ label: 'Today', rows: today });
    if (yesterday.length) out.push({ label: 'Yesterday', rows: yesterday });
    if (week.length) out.push({ label: 'This week', rows: week });
    if (older.length) out.push({ label: 'Earlier', rows: older });
    return out;
  })();

  // Drag handle: track pointer movement on a sibling element. We start the
  // drag on mousedown, update width on mousemove, drop on mouseup. Bound on
  // window so the user can drag past the handle without losing focus.
  const startDrag = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = sidebarWidth;
    const onMove = (ev: MouseEvent) => {
      setSidebarWidth(startWidth + (ev.clientX - startX));
    };
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
    <aside
      style={{ width: `${sidebarWidth}px` }}
      className="relative border-r bg-card flex flex-col shrink-0"
    >
      {/* Drag handle. Hit area is wider than the visible rail so users
          don't have to be pixel-perfect; the rail itself gets a clear
          highlight + a centered grip indicator on hover so the affordance
          isn't invisible until you try. Double-click resets to default. */}
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
        <div className="flex items-center gap-2">
          <div className="w-6 h-6 rounded bg-primary flex items-center justify-center">
            <Zap className="h-4 w-4 text-primary-foreground" />
          </div>
          <span className="text-sm font-semibold tracking-tight">WrongStack</span>
        </div>
        <Button variant="ghost" size="icon" onClick={toggleSidebar}>
          <PanelLeftClose className="h-4 w-4" />
        </Button>
      </div>

      {/* Navigation — Chat | History only. Settings opens the full panel. */}
      <Tabs
        value={currentView === 'settings' ? 'chat' : currentView}
        onValueChange={(v) => setCurrentView(v as 'chat' | 'history')}
        className="flex-1 flex flex-col"
      >
        <TabsList className="w-full rounded-none bg-transparent p-2 h-auto grid grid-cols-2">
          <TabsTrigger
            value="chat"
            className="flex-col gap-1.5 py-2 data-[state=active]:bg-primary/10"
          >
            <MessageSquare className="h-4 w-4" />
            <span className="text-xs">Chat</span>
          </TabsTrigger>
          <TabsTrigger
            value="history"
            className="flex-col gap-1.5 py-2 data-[state=active]:bg-primary/10"
          >
            <History className="h-4 w-4" />
            <span className="text-xs">History</span>
          </TabsTrigger>
        </TabsList>

        <TabsContent value="chat" className="flex-1 flex flex-col m-0 overflow-hidden">
          {/* Connection status */}
          <div className="px-4 py-3 border-b">
            <div
              className={cn(
                'flex items-center gap-2 px-3 py-2 rounded-lg text-sm',
                wsConnected
                  ? 'bg-green-500/10 text-green-600 dark:text-green-400'
                  : 'bg-yellow-500/10 text-yellow-600 dark:text-yellow-400'
              )}
            >
              {wsConnected ? (
                <Wifi className="h-4 w-4" />
              ) : (
                <WifiOff className="h-4 w-4" />
              )}
              <span className="font-medium">
                {wsConnected ? 'Connected' : 'Disconnected'}
              </span>
            </div>
            <div className="text-xs text-muted-foreground mt-2 px-1 font-mono">
              {wsUrl}
            </div>
          </div>

          {/* Active model — clickable shortcut to settings */}
          <button
            type="button"
            onClick={() => setCurrentView('settings')}
            className="px-4 py-3 border-b text-left hover:bg-muted/40 transition-colors"
          >
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">
              Active model
            </div>
            <div className="font-mono text-xs truncate">
              <span className="text-muted-foreground">{provider || '—'}</span>
              <span className="text-muted-foreground/40 mx-1">/</span>
              <span className="font-medium">{model || '—'}</span>
            </div>
          </button>

          {/* Session Stats */}
          <div className="px-4 py-3 border-b space-y-3">
            <h3 className="text-sm font-medium flex items-center gap-2">
              <Database className="h-4 w-4 text-muted-foreground" />
              Session
            </h3>
            <div className="grid grid-cols-2 gap-2 text-xs">
              <div className="flex flex-col p-2 rounded-lg bg-muted/50">
                <span className="text-muted-foreground">Messages</span>
                <span className="text-lg font-semibold">{messages.length}</span>
              </div>
              <div className="flex flex-col p-2 rounded-lg bg-muted/50">
                <span className="text-muted-foreground">Duration</span>
                <span className="text-lg font-semibold">{formatDuration(session?.startedAt ?? null)}</span>
              </div>
              <div className="flex flex-col p-2 rounded-lg bg-muted/50">
                <span className="text-muted-foreground">Input</span>
                <span className="text-lg font-semibold">{totalTokens.input.toLocaleString()}</span>
              </div>
              <div className="flex flex-col p-2 rounded-lg bg-muted/50">
                <span className="text-muted-foreground">Output</span>
                <span className="text-lg font-semibold">{totalTokens.output.toLocaleString()}</span>
              </div>
            </div>
            {cost > 0 && (
              <div className="flex justify-between items-center p-2 rounded-lg bg-green-500/10">
                <span className="text-sm text-muted-foreground">Cost</span>
                <span className="text-lg font-semibold text-green-600 dark:text-green-400">
                  ${cost.toFixed(4)}
                </span>
              </div>
            )}
          </div>

          {/* Live TODO list — populated by the backend's todos.updated
              broadcast after every tool.executed. Empty array → hide the
              section entirely so a vanilla session keeps its existing
              vertical rhythm. */}
          {todos.length > 0 && (
            <div className="px-4 py-3 border-b space-y-2">
              <h3 className="text-sm font-medium flex items-center justify-between">
                <span className="flex items-center gap-2">
                  <ListTodo className="h-4 w-4 text-muted-foreground" />
                  Todos
                </span>
                <span className="text-[10px] text-muted-foreground tabular-nums">
                  {todos.filter((t) => t.status === 'completed').length}/{todos.length}
                </span>
              </h3>
              <ul className="space-y-1 max-h-48 overflow-y-auto pr-1">
                {todos.map((t) => {
                  const Icon =
                    t.status === 'completed'
                      ? CheckCircle2
                      : t.status === 'in_progress'
                        ? CircleDot
                        : Circle;
                  const tone =
                    t.status === 'completed'
                      ? 'text-green-600 dark:text-green-400 line-through opacity-70'
                      : t.status === 'in_progress'
                        ? 'text-amber-600 dark:text-amber-400'
                        : 'text-muted-foreground';
                  return (
                    <li
                      key={t.id}
                      className={cn('flex items-start gap-2 text-xs leading-snug', tone)}
                    >
                      <Icon className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                      <span className="break-words">
                        {t.status === 'in_progress' && t.activeForm
                          ? t.activeForm
                          : t.content}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}

          {/* Pinned answers — click to scroll the chat to the bubble. We
              briefly highlight the target via a CSS class on data-message-id
              so the user can tell which one we just snapped to. */}
          {pinnedRows.length > 0 && (
            <div className="px-4 py-3 border-b space-y-2">
              <h3 className="text-sm font-medium flex items-center justify-between">
                <span className="flex items-center gap-2">
                  <Pin className="h-4 w-4 text-amber-500" />
                  Pinned
                </span>
                <button
                  type="button"
                  onClick={unpinAll}
                  className="text-[10px] text-muted-foreground hover:text-destructive"
                >
                  Clear
                </button>
              </h3>
              <ul className="space-y-1 max-h-48 overflow-y-auto pr-1">
                {pinnedRows.map((m) => {
                  const preview = m.content.replace(/\s+/g, ' ').slice(0, 80);
                  return (
                    <li key={m.id}>
                      <button
                        type="button"
                        onClick={() => {
                          const el = document.querySelector(
                            `[data-message-id="${m.id}"]`,
                          );
                          if (!el) return;
                          el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                          el.classList.add('ring-2', 'ring-amber-500/60');
                          setTimeout(() => {
                            el.classList.remove('ring-2', 'ring-amber-500/60');
                          }, 1600);
                        }}
                        className="w-full text-left text-xs px-2 py-1.5 rounded bg-muted/40 hover:bg-muted/70 border border-amber-500/20 leading-snug"
                        title={m.content.slice(0, 400)}
                      >
                        {preview}
                        {m.content.length > 80 ? '…' : ''}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}

          {/* Quick Actions */}
          <div className="px-4 py-3 border-b space-y-2">
            <Button
              variant="outline"
              size="sm"
              className="w-full justify-start text-destructive hover:text-destructive"
              onClick={() => {
                // Match /clear: drop UI + backend context together so the
                // model doesn't keep replying with knowledge from messages
                // the user just told us to forget.
                clearMessages();
                client?.clearContext?.();
              }}
            >
              <Trash2 className="h-4 w-4 mr-2" />
              Clear context
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="w-full justify-start"
              onClick={() => client?.newSession?.()}
              disabled={!wsConnected}
            >
              <RotateCcw className="h-4 w-4 mr-2" />
              New session
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="w-full justify-start"
              onClick={() => client?.compactContext?.()}
              disabled={!wsConnected}
            >
              <Database className="h-4 w-4 mr-2" />
              Compact context
            </Button>
          </div>

          <div className="flex-1" />

          {/* Footer: settings entry point */}
          <div className="px-3 py-3 border-t">
            <Button
              variant="ghost"
              size="sm"
              className="w-full justify-start"
              onClick={() => setCurrentView('settings')}
            >
              <SettingsIcon className="h-4 w-4 mr-2" />
              Settings
            </Button>
          </div>
        </TabsContent>

        <TabsContent value="history" className="flex-1 m-0 flex flex-col overflow-hidden">
          <div className="flex items-center justify-between px-4 py-2 border-b">
            <span className="text-xs uppercase tracking-wider text-muted-foreground">
              Recent sessions
            </span>
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6"
              onClick={() => listSessions(50)}
              disabled={!wsConnected}
              title="Refresh"
            >
              {historyLoading ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <RefreshCw className="h-3.5 w-3.5" />
              )}
            </Button>
          </div>
          {/* History search — only renders once we have something to filter,
              otherwise it's just empty UI clutter on a fresh install. */}
          {historyEntries.length > 3 && (
            <div className="px-3 py-2 border-b">
              <div className="relative">
                <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground/60" />
                <input
                  type="text"
                  value={historyQuery}
                  onChange={(e) => setHistoryQuery(e.target.value)}
                  placeholder="Filter title, model, provider…"
                  className="w-full pl-7 pr-7 py-1 text-xs rounded-md bg-muted/40 border border-transparent focus:bg-background focus:border-input focus:outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/50"
                />
                {historyQuery && (
                  <button
                    type="button"
                    onClick={() => setHistoryQuery('')}
                    className="absolute right-1 top-1/2 -translate-y-1/2 text-muted-foreground/60 hover:text-foreground p-0.5"
                    title="Clear filter"
                  >
                    <X className="h-3 w-3" />
                  </button>
                )}
              </div>
            </div>
          )}

          {historyError && (
            <div className="px-4 py-2 text-xs text-destructive bg-destructive/5 border-b">
              {historyError}
            </div>
          )}

          <ScrollArea className="flex-1">
            {historyEntries.length === 0 && !historyLoading ? (
              <div className="text-center text-muted-foreground py-8 px-4">
                <History className="h-8 w-8 mx-auto mb-3 opacity-20" />
                <p className="text-sm font-medium">No history yet</p>
                <p className="text-xs mt-1">Your conversations will appear here</p>
              </div>
            ) : groupedHistory.length === 0 ? (
              <div className="text-center text-muted-foreground py-8 px-4">
                <Search className="h-8 w-8 mx-auto mb-3 opacity-20" />
                <p className="text-sm font-medium">No matches</p>
                <p className="text-xs mt-1">Try a different filter</p>
              </div>
            ) : (
              <div className="p-2 space-y-3">
                {groupedHistory.map((group) => (
                  <div key={group.label} className="space-y-1">
                    <div className={cn(
                      'sticky top-0 z-[1] px-1 pb-1 text-[10px] uppercase tracking-wider font-semibold bg-card/90 backdrop-blur-sm flex items-center gap-1',
                      group.star ? 'text-amber-500' : 'text-muted-foreground/80',
                    )}>
                      {group.star && <Star className="h-3 w-3 fill-current" />}
                      {group.label} <span className="text-muted-foreground/50 font-normal normal-case ml-1">({group.rows.length})</span>
                    </div>
                    {group.rows.map((entry) => (
                  <div
                    key={entry.id}
                    className={cn(
                      'group relative rounded-md border text-sm transition-colors',
                      entry.isCurrent
                        ? 'bg-primary/5 border-primary/40'
                        : 'bg-card border-border/60 hover:bg-muted/40 hover:border-primary/40',
                    )}
                  >
                    <button
                      type="button"
                      disabled={entry.isCurrent || renamingId === entry.id}
                      onClick={() => resumeSession(entry.id)}
                      onDoubleClick={(e) => {
                        // Double-click anywhere on the row enters rename mode.
                        // We stop propagation so it doesn't also fire the
                        // single-click resume handler.
                        e.stopPropagation();
                        setRenamingId(entry.id);
                        setRenameDraft(sessionNicknames[entry.id] ?? entry.title ?? '');
                      }}
                      className="block w-full rounded-md px-3 py-2 pr-16 text-left disabled:cursor-default focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <div className="min-w-0 flex-1">
                        {renamingId === entry.id ? (
                          <input
                            autoFocus
                            value={renameDraft}
                            onChange={(e) => setRenameDraft(e.target.value)}
                            onClick={(e) => e.stopPropagation()}
                            onBlur={() => {
                              setSessionNickname(entry.id, renameDraft);
                              setRenamingId(null);
                            }}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') {
                                e.preventDefault();
                                setSessionNickname(entry.id, renameDraft);
                                setRenamingId(null);
                              } else if (e.key === 'Escape') {
                                e.preventDefault();
                                setRenamingId(null);
                              }
                            }}
                            placeholder={entry.title || 'Nickname'}
                            className="w-full text-sm bg-background border border-input rounded px-1.5 py-0.5 focus:outline-none focus:ring-1 focus:ring-ring"
                          />
                        ) : (
                          <div
                            className="font-medium truncate text-foreground"
                            title={
                              sessionNicknames[entry.id]
                                ? `${sessionNicknames[entry.id]} — original: ${entry.title}`
                                : `${entry.title}\n\nDouble-click to rename`
                            }
                          >
                            {sessionNicknames[entry.id] || entry.title || '(empty)'}
                          </div>
                        )}
                        <div className="text-[10px] text-muted-foreground font-mono truncate mt-0.5">
                          {entry.provider}/{entry.model}
                        </div>
                        <div className="flex items-center gap-2 text-[10px] text-muted-foreground/80 mt-0.5">
                          <span>{formatRelative(entry.startedAt)}</span>
                          {entry.tokenTotal > 0 && (
                            <>
                              <span>·</span>
                              <span className="tabular-nums">
                                {entry.tokenTotal.toLocaleString()} tok
                              </span>
                            </>
                          )}
                          {entry.isCurrent && (
                            <>
                              <span>·</span>
                              <span className="text-primary font-medium">active</span>
                            </>
                          )}
                        </div>
                      </div>
                    </button>
                    {/* Star toggle — always rendered (not hidden behind hover)
                        when already favorited, so the user can tell at a
                        glance which rows are starred without hovering each
                        one. The Trash sits beside it but only on hover. */}
                    <div className="absolute right-2 top-2 flex items-center gap-1">
                      <button
                        type="button"
                        onClick={() => toggleFavoriteSession(entry.id)}
                        className={cn(
                          'transition-opacity hover:text-amber-500',
                          favoriteSessionIds.includes(entry.id)
                            ? 'opacity-100 text-amber-500'
                            : 'opacity-0 group-hover:opacity-100 text-muted-foreground',
                        )}
                        title={favoriteSessionIds.includes(entry.id) ? 'Unfavorite' : 'Mark as favorite'}
                      >
                        <Star
                          className={cn(
                            'h-3.5 w-3.5',
                            favoriteSessionIds.includes(entry.id) && 'fill-current',
                          )}
                        />
                      </button>
                      {!entry.isCurrent && (
                        <button
                          type="button"
                          onClick={() => {
                            if (window.confirm(`Delete session "${entry.title}"?`)) {
                              deleteSession(entry.id);
                            }
                          }}
                          className="opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-destructive"
                          title="Delete session"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </div>
                  </div>
                    ))}
                  </div>
                ))}
              </div>
            )}
          </ScrollArea>
        </TabsContent>
      </Tabs>
    </aside>
  );
}
