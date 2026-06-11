import { expectDefined } from '@wrongstack/core';
import { cn } from '@/lib/utils';
import { getWSClient } from '@/lib/ws-client';
import { useChatStore, useFleetStore, useGoalStore, useHistoryStore, useSessionStore, useUIStore, useWorktreeStore } from '@/stores';
import { useLocalPrefs } from '@/stores/local-prefs';
import type { ChatMessage } from '@/stores';
import { useConfigStore } from '@/stores';
import {
  Activity,
  ArrowDown,
  ArrowUp,
  Bot,
  CheckCircle2,
  ChevronDown,
  Clock,
  Command,
  Cpu,
  FolderOpen,
  GitBranch,
  History,
  PanelLeftOpen,
  Pencil,
  Settings,
  Shrink,
  Terminal,
  Users,
  Zap,
} from 'lucide-react';
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { AutonomyPicker } from '../AutonomyPicker';
import { ChatInput } from '../ChatInput';
import { CheckpointTimeline } from '../CheckpointTimeline';
import { ConnectionChip } from '../ConnectionChip';
import { ContextModePicker } from '../ContextModePicker';
import { ContextFillBar } from '../ContextBar';
import { ContextBreakdownModal } from '../ContextBreakdownModal';
import { CostChip } from '../CostChip';
import { MessageBubble } from '../MessageBubble';
import { ModePicker } from '../ModePicker';
import { ProcessMonitor } from '../ProcessMonitor';
import { SearchOverlay } from '../SearchOverlay';
import { ThemeToggle } from '../ThemeToggle';
import { ToolGroup } from '../ToolGroup';
import { WelcomeScreen } from '../WelcomeScreen';
import { WorkingDirChip } from '../WorkingDirChip';
import { Button } from '../ui/button';
import { ScrollArea } from '../ui/scroll-area';
import { fmtTok } from './utils.js';
import { ThinkingBubble } from './ThinkingBubble.js';
export function ChatView() {
  const { messages, isLoading } = useChatStore();
  const setPaletteOpen = useUIStore((s) => s.setPaletteOpen);
  const setShortcutsOpen = useUIStore((s) => s.setShortcutsOpen);
  const sidebarOpen = useUIStore((s) => s.sidebarOpen);
  const toggleSidebar = useUIStore((s) => s.toggleSidebar);
  const compactMode = useUIStore((s) => s.compactMode);
  const { totalTokens, startTime, lastInputTokens, maxContext, projectName, cwd, iteration, todos, mode } =
    useSessionStore();
  const session = useSessionStore((s) => s.session);
  const sessionId = session?.id;
  const nickname = useUIStore((s) => (sessionId ? s.sessionNicknames[sessionId] : undefined));
  const setSessionNickname = useUIStore((s) => s.setSessionNickname);
  const sessionTitle = session?.title;
  const [renamingTitle, setRenamingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState('');

  // Session switcher state
  const historyEntries = useHistoryStore((s) => s.entries);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const switcherRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!switcherOpen) return;
    const onClick = (e: MouseEvent) => {
      if (!switcherRef.current?.contains(e.target as Node)) setSwitcherOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setSwitcherOpen(false); };
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onClick); document.removeEventListener('keydown', onKey); };
  }, [switcherOpen]);

  const { wsConnected, wsStatus, provider, model } = useConfigStore();
  const { setCurrentView } = useUIStore();
  const scrollRef = useRef<HTMLDivElement>(null);

  // Fleet counts for header chip
  const fleetAgents = useFleetStore((s) => s.agents);
  const fleetRunning = Object.values(fleetAgents).filter((a) => a.status === 'running').length;
  const fleetTotal = Object.values(fleetAgents).length;

  // Goal state
  const goal = useGoalStore((s) => s.goal);

  // Worktree state
  const worktrees = useWorktreeStore((s) => s.worktrees);
  const baseBranch = useWorktreeStore((s) => s.baseBranch);

  // Todo breakdown
  const pendingCount = todos.filter((t) => t.status === 'pending').length;
  const inProgressCount = todos.filter((t) => t.status === 'in_progress').length;
  const completedCount = todos.filter((t) => t.status === 'completed').length;

  // Autonomy mode — read from the shared local-prefs store (seeded from the
  // server's config-backed snapshot on connect), NOT component-local state.
  // A local useState here always rendered "off" regardless of the real mode.
  const autonomy = useLocalPrefs((s) => s.autonomy);

  const handleAutonomyChange = useCallback((mode: 'off' | 'suggest' | 'auto' | 'eternal' | 'eternal-parallel') => {
    useLocalPrefs.getState().set({ autonomy: mode });
    const ws = getWSClient();
    ws?.send?.({ type: 'autonomy.switch', payload: { mode } });
  }, []);

  // Overlay toggles — triggered by header buttons
  const [processOpen, setProcessOpen] = useState(false);
  const [checkpointOpen, setCheckpointOpen] = useState(false);

  // Context breakdown modal
  const [breakdownOpen, setBreakdownOpen] = useState(false);

  // Context window usage
  const ctxPct =
    maxContext > 0 && lastInputTokens > 0
      ? Math.min(100, Math.round((lastInputTokens / maxContext) * 100))
      : 0;
  const ctxTone =
    ctxPct >= 85
      ? 'bg-red-500/15 text-red-600 dark:text-red-400'
      : ctxPct >= 70
        ? 'bg-amber-500/15 text-amber-600 dark:text-amber-400'
        : 'bg-muted text-muted-foreground';

  // Auto-scroll with "user is reading older messages" lock
  const [pinnedToBottom, setPinnedToBottom] = useState(true);
  const [unreadCount, setUnreadCount] = useState(0);
  const [scrolledDeep, setScrolledDeep] = useState(false);
  const lastSeenCount = useRef(messages.length);

  const getViewport = useCallback((): HTMLElement | null => {
    return scrollRef.current?.querySelector('[data-radix-scroll-area-viewport]') ?? null;
  }, []);

  useEffect(() => {
    const viewport = getViewport();
    if (!viewport) return;
    const onScroll = () => {
      const dist = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
      const nowPinned = dist < 120;
      setPinnedToBottom(nowPinned);
      if (nowPinned) {
        setUnreadCount(0);
        lastSeenCount.current = messages.length;
      }
      const deep =
        viewport.scrollTop > viewport.clientHeight &&
        viewport.scrollHeight > viewport.clientHeight * 2.5;
      setScrolledDeep(deep);
    };
    viewport.addEventListener('scroll', onScroll, { passive: true });
    return () => viewport.removeEventListener('scroll', onScroll);
  }, [getViewport, messages.length]);

  useEffect(() => {
    const viewport = getViewport();
    if (!viewport) return;
    if (pinnedToBottom) {
      viewport.scrollTop = viewport.scrollHeight;
      lastSeenCount.current = messages.length;
    } else {
      const delta = messages.length - lastSeenCount.current;
      if (delta > 0) setUnreadCount(delta);
    }
  }, [messages, pinnedToBottom, getViewport]);

  const scrollToBottom = useCallback(() => {
    const viewport = getViewport();
    if (!viewport) return;
    viewport.scrollTo({ top: viewport.scrollHeight, behavior: 'smooth' });
    setPinnedToBottom(true);
    setUnreadCount(0);
    lastSeenCount.current = messages.length;
  }, [getViewport, messages.length]);

  const scrollToTop = useCallback(() => {
    const viewport = getViewport();
    if (!viewport) return;
    viewport.scrollTo({ top: 0, behavior: 'smooth' });
  }, [getViewport]);

  // Live "agent is busy" indicator
  const [runStartedAt, setRunStartedAt] = useState<number | null>(null);
  const [nowTick, setNowTick] = useState<number>(() => Date.now());
  const streamAnchor = useRef<{ id: string; at: number; len: number } | null>(null);
  useEffect(() => {
    if (isLoading && runStartedAt === null) setRunStartedAt(Date.now());
    if (!isLoading && runStartedAt !== null) setRunStartedAt(null);
  }, [isLoading, runStartedAt]);
  useEffect(() => {
    if (!isLoading) return;
    const t = setInterval(() => setNowTick(Date.now()), 500);
    return () => clearInterval(t);
  }, [isLoading]);

  const formatDuration = (start: number | null) => {
    if (!start) return '--';
    const seconds = Math.floor((Date.now() - start) / 1000);
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${minutes}m ${secs}s`;
  };

  const agentState = (() => {
    if (!isLoading) return 'idle' as const;
    const last = messages[messages.length - 1];
    const isStreaming = last?.role === 'assistant' && !!last.content && last.streaming;
    return isStreaming ? ('streaming' as const) : ('thinking' as const);
  })();
  const stateTone =
    agentState === 'idle'
      ? 'bg-muted text-muted-foreground'
      : agentState === 'streaming'
        ? 'bg-blue-500/10 text-blue-600 dark:text-blue-400'
        : 'bg-amber-500/10 text-amber-600 dark:text-amber-400';

  const hasStatusContent =
    (maxContext > 0 && lastInputTokens > 0) || totalTokens.input > 0 || !!startTime;

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {/* Header */}
      <header className="flex flex-col border-b bg-card/95 backdrop-blur-sm supports-[backdrop-filter]:bg-card/80 shrink-0 sticky top-0 z-20">
        <div className="flex items-center justify-between gap-2 px-3 py-2">
          <div className="flex items-center gap-1.5 min-w-0 flex-1">
            {!sidebarOpen && (
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 shrink-0"
                onClick={toggleSidebar}
                title="Open sidebar (Ctrl+\\)"
              >
                <PanelLeftOpen className="h-4 w-4" />
              </Button>
            )}
            {!sidebarOpen && (
              <div className="flex items-center gap-1.5 shrink-0 mr-1">
                <div className="w-5 h-5 rounded bg-primary flex items-center justify-center">
                  <Zap className="h-3 w-3 text-primary-foreground" />
                </div>
              </div>
            )}
            <ConnectionChip wsStatus={wsStatus} wsConnected={wsConnected} />
            <span
              className={cn(
                'flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[11px] font-medium shrink-0 tabular-nums',
                stateTone,
              )}
              title={`Agent state: ${agentState}`}
            >
              {agentState !== 'idle' && (
                <span className="h-1.5 w-1.5 rounded-full bg-current animate-pulse" />
              )}
              <span>{agentState}</span>
            </span>
            {projectName && (
              <>
                <span
                  className="flex items-center gap-1 text-[11px] text-muted-foreground shrink-0 min-w-0"
                  title={cwd || `Project: ${projectName}`}
                >
                  <FolderOpen className="h-3 w-3 shrink-0" />
                  <span className="truncate max-w-[8rem]">{projectName}</span>
                </span>
                <WorkingDirChip />
              </>
            )}
            {/* Session title — click to rename, shows nickname if set */}
            {sessionId && (
              renamingTitle ? (
                <input
                  value={titleDraft}
                  onChange={(e) => setTitleDraft(e.target.value)}
                  onBlur={() => { if (titleDraft.trim()) setSessionNickname(sessionId, titleDraft); setRenamingTitle(false); }}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); if (titleDraft.trim()) setSessionNickname(sessionId, titleDraft); setRenamingTitle(false); } else if (e.key === 'Escape') { e.preventDefault(); setRenamingTitle(false); } }}
                  placeholder="Session name…"
                  className="h-5 px-1.5 text-[11px] bg-background border border-primary/40 rounded focus:outline-none focus:ring-1 focus:ring-ring shrink-0 w-32"
                  autoFocus
                />
              ) : (
                <button
                  type="button"
                  onClick={() => { setTitleDraft(nickname || sessionTitle || ''); setRenamingTitle(true); }}
                  className="flex items-center gap-1 text-[11px] font-medium text-foreground/80 hover:text-foreground truncate max-w-[12rem] shrink-0 px-1 -mx-1 rounded hover:bg-muted/50 transition-colors"
                  title="Click to rename session"
                >
                  <Pencil className="h-2.5 w-2.5 text-muted-foreground shrink-0" />
                  <span className="truncate">{nickname || sessionTitle || 'Untitled'}</span>
                </button>
              )
            )}
            {/* Session switcher — quick dropdown to jump between recent sessions */}
            {historyEntries.length > 1 && (
              <div ref={switcherRef} className="relative shrink-0">
                <button
                  type="button"
                  onClick={() => setSwitcherOpen((v) => !v)}
                  className="flex items-center gap-0.5 px-1 py-0.5 rounded text-[10px] text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
                  title="Switch session"
                >
                  <History className="h-3 w-3" />
                  <ChevronDown className="h-2.5 w-2.5" />
                </button>
                {switcherOpen && (
                  <div className="absolute left-0 top-full mt-1 z-40 w-64 rounded-md border bg-popover shadow-lg p-1 max-h-60 overflow-y-auto">
                    {historyEntries.slice(0, 15).map((e) => (
                      <button
                        key={e.id}
                        type="button"
                        onClick={() => {
                          const ws = getWSClient();
                          ws?.resumeSession?.(e.id);
                          setSwitcherOpen(false);
                        }}
                        className={cn(
                          'w-full text-left px-2 py-1.5 rounded text-xs hover:bg-accent transition-colors',
                          e.isCurrent && 'bg-primary/10',
                        )}
                      >
                        <div className="font-medium truncate">{e.title || '(empty)'}</div>
                        <div className="text-[10px] text-muted-foreground font-mono truncate">{e.provider}/{e.model} · {e.tokenTotal.toLocaleString()} tok</div>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
            <button
              type="button"
              onClick={() => useUIStore.getState().setModelSwitcherOpen(true)}
              className="group flex items-center gap-1 px-2 py-0.5 rounded-md border bg-background/50 hover:bg-accent hover:border-primary/40 transition-colors text-[11px] min-w-0 shrink-0"
              title="Change provider / model (Ctrl+M)"
            >
              <Cpu className="h-3 w-3 text-muted-foreground group-hover:text-foreground shrink-0" />
              <span className="font-mono truncate max-w-[16rem]">
                <span className="text-muted-foreground">{provider || 'no-provider'}</span>
                <span className="text-muted-foreground/40 mx-0.5">/</span>
                <span className="font-medium">{model || 'no-model'}</span>
              </span>
            </button>
            <ModePicker />
            <ContextModePicker />
            {iteration && (
              <button
                type="button"
                className="flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[11px] font-medium bg-primary/10 text-primary shrink-0 hover:bg-primary/20 transition-colors cursor-pointer"
                title="Agent iteration — click to jump to live activity"
                onClick={() => document.getElementById('chat-activity')?.scrollIntoView({ behavior: 'smooth', block: 'center' })}
              >
                <Activity className="h-3 w-3 animate-pulse" />
                iter {iteration.index}
                {iteration.max > 0 ? `/${iteration.max}` : ''}
              </button>
            )}
            {/* Todo chip */}
            {(pendingCount > 0 || inProgressCount > 0) && (
              <button
                type="button"
                className="flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[11px] font-medium bg-amber-500/10 text-amber-600 dark:text-amber-400 shrink-0 hover:bg-amber-500/20 transition-colors cursor-pointer"
                title={`Todos: ${completedCount}/${todos.length} done — click to jump`}
                onClick={() => document.getElementById('panel-todos')?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
              >
                <CheckCircle2 className="h-3 w-3" />
                {completedCount}/{todos.length}
              </button>
            )}
            {/* Fleet chip */}
            {fleetTotal > 0 && (
              <button
                type="button"
                className={cn(
                  'flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[11px] font-medium shrink-0 cursor-pointer transition-colors',
                  fleetRunning > 0
                    ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 hover:bg-emerald-500/20'
                    : 'bg-muted text-muted-foreground hover:bg-muted/80',
                )}
                title={`Fleet: ${fleetRunning}/${fleetTotal} running — click to jump`}
                onClick={() => document.getElementById('panel-fleet')?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
              >
                <Users className="h-3 w-3" />
                {fleetRunning}/{fleetTotal}
              </button>
            )}
            {/* Goal chip */}
            {goal && (
              <button
                type="button"
                className={cn(
                  'flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[11px] font-medium shrink-0 cursor-pointer transition-colors',
                  goal.goalState === 'active'
                    ? 'bg-rose-500/10 text-rose-600 dark:text-rose-400 hover:bg-rose-500/20'
                    : 'bg-muted text-muted-foreground hover:bg-muted/80',
                )}
                title={`Goal: ${goal.progress}% — ${goal.goal.slice(0, 60)} — click to jump`}
                onClick={() => document.getElementById('panel-goal')?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
              >
                <Activity className="h-3 w-3" />
                {goal.progress}%
              </button>
            )}
            {/* Worktree chip */}
            {baseBranch && (
              <button
                type="button"
                className="flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[11px] font-medium bg-violet-500/10 text-violet-600 dark:text-violet-400 shrink-0 hover:bg-violet-500/20 transition-colors cursor-pointer"
                title={`Branch: ${baseBranch}${worktrees.length > 0 ? ` · ${worktrees.length} worktree${worktrees.length === 1 ? '' : 's'}` : ''} — click to jump`}
                onClick={() => document.getElementById('panel-worktree')?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
              >
                <GitBranch className="h-3 w-3" />
                {baseBranch}
              </button>
            )}
            <AutonomyPicker value={autonomy} onChange={handleAutonomyChange} compact />
          </div>

          <div className="flex items-center gap-0.5 shrink-0">
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={() => useUIStore.getState().toggleCompactMode()}
              title="Toggle compact mode (Ctrl+Shift+D)"
            >
              <Shrink className="h-4 w-4" />
            </Button>
            <Button
              variant={processOpen ? 'secondary' : 'ghost'}
              size="icon"
              className={cn('h-7 w-7 relative', processOpen && 'bg-amber-500/10 text-amber-600 dark:text-amber-400')}
              onClick={() => setProcessOpen((v) => !v)}
              title="Running processes"
            >
              <Terminal className="h-4 w-4" />
              {processOpen && (
                <span className="absolute -bottom-0.5 left-1/2 -translate-x-1/2 w-1 h-1 rounded-full bg-amber-500" />
              )}
            </Button>
            <Button
              variant={checkpointOpen ? 'secondary' : 'ghost'}
              size="icon"
              className={cn('h-7 w-7 relative', checkpointOpen && 'bg-violet-500/10 text-violet-600 dark:text-violet-400')}
              onClick={() => setCheckpointOpen((v) => !v)}
              title="Session checkpoints — rewind"
            >
              <History className="h-4 w-4" />
              {checkpointOpen && (
                <span className="absolute -bottom-0.5 left-1/2 -translate-x-1/2 w-1 h-1 rounded-full bg-violet-500" />
              )}
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={() => setPaletteOpen(true)}
              title="Command palette (Ctrl+K)"
            >
              <Command className="h-4 w-4" />
            </Button>
            <ThemeToggle className="mx-0.5" />
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 font-mono text-xs"
              onClick={() => setShortcutsOpen(true)}
              title="Keyboard shortcuts (?)"
            >
              ?
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={() => setCurrentView('settings')}
              title="Settings"
            >
              <Settings className="h-4 w-4" />
            </Button>
          </div>
        </div>

        {hasStatusContent && (
          <div className="flex items-center justify-between gap-3 px-3 py-1 border-t bg-muted/20 text-[11px] text-muted-foreground">
            <div className="flex items-center gap-3 min-w-0 flex-1 tabular-nums">
              {maxContext > 0 && lastInputTokens > 0 && (
                <ContextFillBar
                  pct={ctxPct}
                  tokens={lastInputTokens}
                  maxTokens={maxContext}
                  onClick={() => setBreakdownOpen(true)}
                />
              )}
              {totalTokens.input > 0 && (
                <>
                  <span className="flex items-center gap-1">
                    <span className="font-medium text-foreground">{fmtTok(totalTokens.input)}</span>
                    <span>in</span>
                  </span>
                  <span className="flex items-center gap-1">
                    <span className="font-medium text-foreground">
                      {fmtTok(totalTokens.output)}
                    </span>
                    <span>out</span>
                  </span>
                  {totalTokens.cacheRead &&
                    totalTokens.cacheRead > 0 &&
                    (() => {
                      const denom = (totalTokens.cacheRead ?? 0) + totalTokens.input;
                      const pct =
                        denom > 0 ? Math.round(((totalTokens.cacheRead ?? 0) / denom) * 100) : 0;
                      return (
                        <span
                          className="flex items-center gap-1"
                          title={`Cache hit ratio: ${pct}%`}
                        >
                          <span className="font-medium text-foreground">
                            {fmtTok(totalTokens.cacheRead)}
                          </span>
                          <span>cache ({pct}%)</span>
                        </span>
                      );
                    })()}
                  <CostChip />
                </>
              )}
            </div>
            {startTime && (
              <span className="text-muted-foreground/70 tabular-nums shrink-0">
                {formatDuration(startTime)}
              </span>
            )}
          </div>
        )}
      </header>

      {/* Messages */}
      <div className="flex-1 relative overflow-hidden">
        <SearchOverlay />
        {!pinnedToBottom && (
          <button
            type="button"
            onClick={scrollToBottom}
            className={cn(
              'absolute bottom-4 left-1/2 -translate-x-1/2 z-10 jump-bottom',
              'flex items-center gap-2 px-4 py-2 rounded-full shadow-lg',
              'bg-primary text-primary-foreground text-xs font-medium',
              'hover:bg-primary/90 transition-colors animate-message',
            )}
          >
            <ArrowDown className="h-3.5 w-3.5" />
            {unreadCount > 0
              ? `${unreadCount} new message${unreadCount === 1 ? '' : 's'}`
              : 'Jump to latest'}
          </button>
        )}
        {scrolledDeep && (
          <button
            type="button"
            onClick={scrollToTop}
            title="Scroll to top (oldest)"
            className={cn(
              'absolute top-3 right-3 z-10',
              'flex items-center gap-1 px-2.5 py-1 rounded-full shadow-md border',
              'bg-background/90 backdrop-blur-sm text-[11px] text-muted-foreground',
              'hover:text-foreground hover:bg-background transition-colors animate-message',
            )}
          >
            <ArrowUp className="h-3 w-3" />
            <span>Top</span>
          </button>
        )}
        <ScrollArea className="h-full" ref={scrollRef}>
          <div
            className={cn(
              'mx-auto pb-8',
              compactMode ? 'max-w-5xl p-3 space-y-3' : 'max-w-5xl p-4 space-y-6',
            )}
          >
            {messages.length === 0 && !isLoading && <WelcomeScreen />}

            {/* Two-pass grouping */}
            {(() => {
              type Group =
                | { kind: 'msg'; message: ChatMessage; isFirst: boolean }
                | { kind: 'tools'; tools: ChatMessage[]; key: string };
              const groups: Group[] = [];
              for (let i = 0; i < messages.length; i++) {
                const m = expectDefined(messages[i]);
                if (m.role === 'tool') {
                  const last = groups[groups.length - 1];
                  if (last && last.kind === 'tools') {
                    last.tools.push(m);
                  } else {
                    groups.push({ kind: 'tools', tools: [m], key: m.id });
                  }
                } else {
                  const prev = messages[i - 1];
                  groups.push({
                    kind: 'msg',
                    message: m,
                    isFirst: !prev || prev.role !== m.role,
                  });
                }
              }
              type Turn =
                | { kind: 'user'; message: ChatMessage; key: string }
                | { kind: 'agent'; items: Group[]; key: string };
              const turns: Turn[] = [];
              for (const g of groups) {
                if (g.kind === 'msg' && g.message.role === 'user') {
                  turns.push({ kind: 'user', message: g.message, key: g.message.id });
                  continue;
                }
                const last = turns[turns.length - 1];
                if (last && last.kind === 'agent') {
                  last.items.push(g);
                } else {
                  const key = g.kind === 'msg' ? g.message.id : g.key;
                  turns.push({ kind: 'agent', items: [g], key });
                }
              }
              let prevDay: string | null = null;
              const dayKey = (ts: number) => {
                const d = new Date(ts);
                return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
              };
              const dayLabel = (ts: number) => {
                const d = new Date(ts);
                const today = new Date();
                const yest = new Date(Date.now() - 86_400_000);
                if (dayKey(ts) === dayKey(today.getTime())) return 'Today';
                if (dayKey(ts) === dayKey(yest.getTime())) return 'Yesterday';
                return d.toLocaleDateString(undefined, {
                  weekday: 'short',
                  month: 'short',
                  day: 'numeric',
                  year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric',
                });
              };
              const turnTs = (t: Turn): number => {
                if (t.kind === 'user') return t.message.timestamp;
                const first = expectDefined(t.items[0]);
                return first.kind === 'msg' ? first.message.timestamp : first.tools[0]?.timestamp;
              };
              const out: ReactNode[] = [];
              for (let idx = 0; idx < turns.length; idx++) {
                const t = expectDefined(turns[idx]);
                const ts = turnTs(t);
                const day = dayKey(ts);
                if (day !== prevDay) {
                  out.push(
                    <div
                      key={`day-${day}-${idx}`}
                      className="flex items-center gap-3 py-1 text-[11px] text-muted-foreground/70 uppercase tracking-wider font-medium"
                    >
                      <div className="flex-1 h-px bg-border/50" />
                      <span>{dayLabel(ts)}</span>
                      <div className="flex-1 h-px bg-border/50" />
                    </div>,
                  );
                  prevDay = day;
                }
                if (t.kind === 'user') {
                  out.push(<MessageBubble key={t.key} message={t.message} isFirst />);
                  continue;
                }
                const isLastTurn = idx === turns.length - 1;
                out.push(
                  <div key={t.key} className={cn('chat-turn', compactMode ? 'space-y-1' : 'space-y-1.5')}>
                    {t.items.map((g, gi) => {
                      const continuation = gi > 0;
                      if (g.kind === 'msg') {
                        return (
                          <MessageBubble
                            key={g.message.id}
                            message={g.message}
                            isFirst={!continuation && g.isFirst}
                            isContinuation={continuation}
                          />
                        );
                      }
                      const isLatestRunning =
                        isLastTurn &&
                        gi === t.items.length - 1 &&
                        isLoading &&
                        g.tools.some((tt) => tt.toolResult === undefined);
                      return (
                        <ToolGroup
                          key={g.key}
                          tools={g.tools}
                          defaultOpen={isLatestRunning}
                          isContinuation={continuation}
                        />
                      );
                    })}
                  </div>,
                );
              }
              return out;
            })()}

            <div id="chat-activity">
            <ThinkingBubble />

            {/* Running status bubble */}
            {isLoading &&
              (() => {
                const last = messages[messages.length - 1];
                const runningTools = messages.filter(
                  (m) => m.role === 'tool' && m.toolResult === undefined,
                );
                let label = 'Thinking…';
                if (runningTools.length > 0) {
                  const names = Array.from(
                    new Set(runningTools.map((t) => t.toolName).filter(Boolean) as string[]),
                  );
                  const preview = names.slice(0, 2).join(', ');
                  const more = names.length > 2 ? ` +${names.length - 2}` : '';
                  label =
                    runningTools.length === 1
                      ? `Running ${preview || 'tool'}…`
                      : `Running ${runningTools.length} tools (${preview}${more})…`;
                } else if (last?.role === 'assistant' && last.content) {
                  label = 'Writing reply…';
                } else if (last?.role === 'tool' && last.toolResult !== undefined) {
                  label = 'Thinking about the next step…';
                }
                const elapsedSec = runStartedAt
                  ? Math.max(0, Math.floor((nowTick - runStartedAt) / 1000))
                  : 0;
                const elapsed =
                  elapsedSec < 60
                    ? `${elapsedSec}s`
                    : `${Math.floor(elapsedSec / 60)}m ${elapsedSec % 60}s`;
                let speedLabel = '';
                const streamingBubble =
                  last?.role === 'assistant' && last.streaming && last.content ? last : null;
                if (streamingBubble) {
                  const anchor = streamAnchor.current;
                  if (!anchor || anchor.id !== streamingBubble.id) {
                    streamAnchor.current = {
                      id: streamingBubble.id,
                      at: Date.now(),
                      len: streamingBubble.content.length,
                    };
                  } else {
                    const dt = Math.max(1, nowTick - anchor.at);
                    const dl = Math.max(0, streamingBubble.content.length - anchor.len);
                    if (dt > 500 && dl > 0) {
                      const cps = (dl * 1000) / dt;
                      speedLabel =
                        cps >= 1000
                          ? `${(cps / 1000).toFixed(1)}k ch/s`
                          : `${Math.round(cps)} ch/s`;
                    }
                  }
                } else if (streamAnchor.current) {
                  streamAnchor.current = null;
                }
                return (
                  <div className="flex gap-3 animate-message">
                    <div className="flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center bg-accent text-accent-foreground ring-2 ring-offset-2 ring-offset-background ring-accent/20">
                      <Bot className="h-4 w-4" />
                    </div>
                    <div className="flex flex-col gap-1.5">
                      <div className="rounded-2xl px-4 py-3 bg-card border text-foreground">
                        <div className="flex items-center gap-3 text-sm">
                          <span className="flex gap-1">
                            <span className="h-1.5 w-1.5 rounded-full bg-primary/70 animate-bounce [animation-delay:-0.3s]" />
                            <span className="h-1.5 w-1.5 rounded-full bg-primary/70 animate-bounce [animation-delay:-0.15s]" />
                            <span className="h-1.5 w-1.5 rounded-full bg-primary/70 animate-bounce" />
                          </span>
                          <span className="text-foreground/90">{label}</span>
                          <span className="text-xs text-muted-foreground tabular-nums">
                            {elapsed}
                          </span>
                          {iteration && (
                            <span className="text-xs text-muted-foreground tabular-nums">
                              · iter {iteration.index}
                              {iteration.max > 0 ? `/${iteration.max}` : ''}
                            </span>
                          )}
                          {speedLabel && (
                            <span className="text-xs text-muted-foreground/80 tabular-nums">
                              · {speedLabel}
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })()}
            </div>
          </div>
        </ScrollArea>
      </div>

      {/* Input */}
      <div className="border-t bg-card/50 backdrop-blur supports-[backdrop-filter]:bg-card/50 shrink-0">
        {/* Keyboard shortcut hints — subtle, always visible */}
        <div className="max-w-5xl mx-auto px-4 pt-1.5 flex items-center gap-3 text-[10px] text-muted-foreground/50 select-none overflow-x-auto">
          <span title="Enter" className="inline-flex items-center gap-1">
            <kbd>Enter</kbd> send
          </span>
          <span className="opacity-30">·</span>
          <span title="Shift+Enter" className="inline-flex items-center gap-1">
            <kbd>Shift</kbd>+<kbd>↵</kbd> newline
          </span>
          <span className="opacity-30">·</span>
          <span title="Ctrl+\\" className="inline-flex items-center gap-1">
            <kbd>Ctrl+\</kbd> sidebar
          </span>
          <span className="opacity-30">·</span>
          <span title="Ctrl+F" className="inline-flex items-center gap-1">
            <kbd>Ctrl+F</kbd> search
          </span>
          <span className="opacity-30">·</span>
          <span title="Ctrl+K" className="inline-flex items-center gap-1">
            <kbd>Ctrl+K</kbd> palette
          </span>
          <span className="opacity-30">·</span>
          <span title="Ctrl+L / Ctrl+N" className="inline-flex items-center gap-1">
            <kbd>Ctrl+L</kbd> clear
          </span>
          <span className="opacity-30">·</span>
          <span title="j/k to navigate" className="inline-flex items-center gap-1">
            <kbd>j</kbd><kbd>k</kbd> navigate
          </span>
          <span className="opacity-30">·</span>
          <span title="Ctrl+M" className="inline-flex items-center gap-1">
            <kbd>Ctrl+M</kbd> model
          </span>
          <span className="opacity-30">·</span>
          <span title="Ctrl+Shift+D" className="inline-flex items-center gap-1">
            <kbd>Ctrl+⇧D</kbd> density
          </span>
        </div>
        <div className="p-4">
          <div className="max-w-5xl mx-auto">
            <ChatInput onOpenBreakdown={() => setBreakdownOpen(true)} />
          </div>
        </div>
      </div>

      {/* Overlays — triggered by header buttons */}
      <ProcessMonitor open={processOpen} onClose={() => setProcessOpen(false)} />
      <CheckpointTimeline open={checkpointOpen} onClose={() => setCheckpointOpen(false)} />
      <ContextBreakdownModal open={breakdownOpen} onClose={() => setBreakdownOpen(false)} />
    </div>
  );
}
