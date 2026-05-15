import { cn } from '@/lib/utils';
import { useChatStore, useSessionStore, useUIStore } from '@/stores';
import type { ChatMessage } from '@/stores';
import { useConfigStore } from '@/stores';
import {
  Activity,
  ArrowDown,
  ArrowUp,
  Bot,
  Brain,
  Command,
  Cpu,
  FolderOpen,
  Monitor,
  Moon,
  PanelLeftOpen,
  Settings,
  Sun,
  Wifi,
  WifiOff,
  Zap,
} from 'lucide-react';
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { ChatInput } from './ChatInput';
import { ConnectionChip } from './ConnectionChip';
import { CostChip } from './CostChip';
import { MessageBubble } from './MessageBubble';
import { ModePicker } from './ModePicker';
import { SearchOverlay } from './SearchOverlay';
import { ToolGroup } from './ToolGroup';
import { WelcomeScreen } from './WelcomeScreen';
import { Button } from './ui/button';
import { ScrollArea } from './ui/scroll-area';

function fmtTok(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return String(n);
}

/**
 * Soft, ephemeral chip rendered while the model is mid-reasoning. Reads the
 * thinking buffer straight from the chat store so it stays in sync with the
 * stream without re-rendering the full message list. Mounted only while the
 * buffer is non-empty — the WS handler clears it on text/tool/response/run
 * boundaries, so this naturally appears at the start of a turn and
 * disappears the moment the model commits to user-visible output.
 */
function ThinkingBubble() {
  const buf = useChatStore((s) => s.thinkingBuffer);
  if (!buf) return null;
  // Show only the last ~6 lines so the chip stays bounded while the model
  // rambles. Whole buffer is in the store if we ever want a "show all"
  // affordance, but for the ephemeral chip the tail is what feels live.
  const tailLines = buf.split('\n').slice(-6);
  const tail = tailLines.join('\n').trim();
  return (
    <div className="flex gap-3 animate-message">
      <div className="flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center bg-violet-500/10 text-violet-600 dark:text-violet-400 ring-2 ring-offset-2 ring-offset-background ring-violet-500/20">
        <Brain className="h-4 w-4 animate-pulse" />
      </div>
      <div className="flex flex-col gap-1 max-w-[85%] min-w-0">
        <span className="text-xs font-medium text-violet-600 dark:text-violet-400 px-1">
          Thinking…
        </span>
        <div className="rounded-2xl rounded-bl-md px-3 py-2 bg-violet-500/[0.04] border border-violet-500/20 text-foreground/80">
          <pre className="whitespace-pre-wrap break-words font-sans text-xs leading-relaxed italic max-h-32 overflow-hidden">
            {tail || '…'}
          </pre>
        </div>
      </div>
    </div>
  );
}

export function ChatView() {
  const { messages, isLoading } = useChatStore();
  const setPaletteOpen = useUIStore((s) => s.setPaletteOpen);
  const setShortcutsOpen = useUIStore((s) => s.setShortcutsOpen);
  const sidebarOpen = useUIStore((s) => s.sidebarOpen);
  const toggleSidebar = useUIStore((s) => s.toggleSidebar);
  const compactMode = useUIStore((s) => s.compactMode);
  const setTheme = useConfigStore((s) => s.setTheme);
  const theme = useConfigStore((s) => s.theme);
  const { totalTokens, cost, startTime, lastInputTokens, maxContext, projectName, iteration } =
    useSessionStore();
  const { wsConnected, wsStatus, provider, model } = useConfigStore();
  const { setCurrentView } = useUIStore();
  const scrollRef = useRef<HTMLDivElement>(null);

  // Context window usage (mirrors TUI's ContextChip semantics: lastInputTokens
  // is the most recent provider call's input size — the de-facto live context).
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

  // Auto-scroll with "user is reading older messages" lock. We watch the
  // Radix ScrollArea viewport's scroll position; if the user is within
  // ~120px of the bottom we keep pinning new messages to the bottom. The
  // moment they scroll up, we let go — new content appends invisibly and a
  // floating "↓ new messages" button shows up so they can rejoin the live
  // tail when they're ready.
  const [pinnedToBottom, setPinnedToBottom] = useState(true);
  const [unreadCount, setUnreadCount] = useState(0);
  /** True when the user has scrolled past ~1 viewport-height from the top
   *  AND isn't anchored at the bottom — i.e. they're deep in mid-history.
   *  Used to surface a "back to top" pill so navigating a 200-message
   *  transcript doesn't require thumb-flicking. */
  const [scrolledDeep, setScrolledDeep] = useState(false);
  const lastSeenCount = useRef(messages.length);

  // Resolve the actual scrollable viewport that Radix renders inside the
  // ScrollArea root. We re-resolve every render because the ref points at
  // the root, not the viewport.
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
      // Show "back to top" only when there's actually a lot of content
      // ABOVE the user (so it doesn't pop up on tiny chats) AND they're
      // not already near the top.
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

  // Live "agent is busy" indicator. We track when the current run started
  // (rising edge of isLoading) and tick a second-resolution clock so the
  // running-status bubble shows a live elapsed timer. Reset on idle.
  const [runStartedAt, setRunStartedAt] = useState<number | null>(null);
  const [nowTick, setNowTick] = useState<number>(() => Date.now());
  /** Anchor for streaming-speed computation. We capture the assistant
   *  message id, the wall-clock time, and the content length at the moment
   *  streaming starts; chars-per-second is derived from the delta between
   *  then and `nowTick`. Reset when the streaming bubble changes (new turn)
   *  or when streaming flips off (idle). */
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

  // Agent state derived once — used by both the chip and the indicator
  // bubble at the bottom of the chat. `streaming` while an assistant
  // bubble is mid-text, else `thinking` between turns, else `idle`.
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

  // We show the status row (ctx / tokens / cost / elapsed) only when there's
  // *something* worth reporting — otherwise the second line is just dead
  // pixels on a brand-new empty session.
  const hasStatusContent =
    (maxContext > 0 && lastInputTokens > 0) || totalTokens.input > 0 || !!startTime;

  return (
    <div className="flex flex-col h-full">
      {/* Header — two compact rows.
          Row 1: identity + actions (sidebar reopen, connection, project,
                 model, mode, state, iteration, palette/theme/?/settings).
          Row 2 (when present): live numbers (ctx %, tokens, cache %, cost,
                 elapsed) — kept off-row 1 so the action cluster never
                 wraps when a session warms up. */}
      <header className="flex flex-col border-b bg-card shrink-0">
        <div className="flex items-center justify-between gap-2 px-3 py-2">
          <div className="flex items-center gap-1.5 min-w-0 flex-1">
            {/* Sidebar reopen — only visible when the sidebar is hidden.
                Otherwise the sidebar's own toggle handles it. */}
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
            {/* When the sidebar is hidden we surface a tiny WrongStack mark
                so the user can still see they're in WrongStack — but inline,
                no big header text. */}
            {!sidebarOpen && (
              <div className="flex items-center gap-1.5 shrink-0 mr-1">
                <div className="w-5 h-5 rounded bg-primary flex items-center justify-center">
                  <Zap className="h-3 w-3 text-primary-foreground" />
                </div>
              </div>
            )}
            {/* Connection pill — granular status with retry button. Lives
                next to the sidebar toggle so it's always visible. Hover
                shows the last error (if any). */}
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
              <span
                className="flex items-center gap-1 text-[11px] text-muted-foreground shrink-0 min-w-0"
                title={`Project: ${projectName}`}
              >
                <FolderOpen className="h-3 w-3 shrink-0" />
                <span className="truncate max-w-[12rem]">{projectName}</span>
              </span>
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
            {iteration && (
              <span
                className="flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[11px] font-medium bg-primary/10 text-primary shrink-0"
                title="Agent iteration"
              >
                <Activity className="h-3 w-3 animate-pulse" />
                iter {iteration.index}
                {iteration.max > 0 ? `/${iteration.max}` : ''}
              </span>
            )}
          </div>

          <div className="flex items-center gap-0.5 shrink-0">
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={() => setPaletteOpen(true)}
              title="Command palette (Ctrl+K)"
            >
              <Command className="h-4 w-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={() => {
                const next = theme === 'light' ? 'dark' : theme === 'dark' ? 'system' : 'light';
                setTheme(next);
              }}
              title={`Theme: ${theme} (click to cycle)`}
            >
              {theme === 'light' ? (
                <Sun className="h-4 w-4" />
              ) : theme === 'dark' ? (
                <Moon className="h-4 w-4" />
              ) : (
                <Monitor className="h-4 w-4" />
              )}
            </Button>
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
                <span
                  className={cn(
                    'flex items-center gap-1 px-1.5 py-0.5 rounded-full font-medium shrink-0',
                    ctxTone,
                  )}
                  title={`Last input: ${lastInputTokens.toLocaleString()} / ${maxContext.toLocaleString()} tokens`}
                >
                  ctx {ctxPct}% · {fmtTok(lastInputTokens)}/{fmtTok(maxContext)}
                </span>
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
        {/* Chat-local Ctrl+F overlay — pinned top-right, scrolls hits into
            view and highlights the active row in MessageBubble. */}
        <SearchOverlay />
        {/* Jump-to-latest pill — only when the user scrolled away from the
            live tail. Shows the unread count so they know how much they're
            behind without having to scroll down first. */}
        {!pinnedToBottom && (
          <button
            type="button"
            onClick={scrollToBottom}
            className={cn(
              'absolute bottom-4 left-1/2 -translate-x-1/2 z-10',
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
        {/* Back-to-top — only when the chat is genuinely long AND the user
            scrolled past one viewport. Floats top-right so it doesn't compete
            with the jump-to-latest pill at the bottom. */}
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

            {/* Two-pass grouping.
              Pass 1 — collapse consecutive tool messages into one ToolGroup
                chip (so 8 parallel reads don't eat the viewport).
              Pass 2 — bundle every run of non-user groups (assistant text +
                tool chips) into a single "agent turn". Inside a turn, items
                render with tight spacing and only the first item shows the
                avatar; this stitches the text-tool-text-tool stream into one
                continuous flow instead of stacking each message as its own
                detached bubble. */}
            {(() => {
              type Group =
                | { kind: 'msg'; message: ChatMessage; isFirst: boolean }
                | { kind: 'tools'; tools: ChatMessage[]; key: string };
              const groups: Group[] = [];
              for (let i = 0; i < messages.length; i++) {
                const m = messages[i]!;
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
              // Bundle consecutive non-user groups into agent turns. User
              // messages stay as their own standalone turn so the bubble
              // alignment switches sides naturally.
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
              // Track which date (local YYYY-MM-DD) the previous turn was
              // stamped with, so we can emit a soft divider between days. This
              // matters most after `session.resume` rehydrates a transcript
              // that spans yesterday → today; without dividers the user can't
              // tell where the gap is.
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
                const first = t.items[0]!;
                return first.kind === 'msg' ? first.message.timestamp : first.tools[0]!.timestamp;
              };
              const out: ReactNode[] = [];
              for (let idx = 0; idx < turns.length; idx++) {
                const t = turns[idx]!;
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
                  <div key={t.key} className={cn(compactMode ? 'space-y-1' : 'space-y-1.5')}>
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

            {/* Transient extended-thinking bubble. Driven by
              provider.thinking_delta events; cleared by the first text_delta /
              tool.started / provider.response / run.result of the turn, so it
              "appears and disappears" alongside the model's internal reasoning
              and never persists into the transcript. */}
            <ThinkingBubble />

            {/* Running status bubble — always present as the last message
              while the agent is not idle. Picks a label based on what the
              agent is currently doing (composing reply / running tools /
              thinking between steps) and ticks a live elapsed timer so the
              user has visible proof of life even mid-iteration. */}
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
                // Streaming speed: derive chars/s for the currently-streaming
                // assistant bubble. Anchor on first sight of a streaming bubble;
                // tear down once it's no longer streaming so the next turn
                // starts from zero.
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
                    // Only show after 0.5s of streaming so the first reading
                    // isn't wildly inflated by the latency-to-first-chunk.
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
        </ScrollArea>
      </div>

      {/* Input */}
      <div className="border-t bg-card/50 backdrop-blur supports-[backdrop-filter]:bg-card/50 p-4 shrink-0">
        <div className="max-w-5xl mx-auto">
          <ChatInput />
          <p className="text-xs text-center text-muted-foreground/50 mt-2">
            Press Enter to send, Shift+Enter for new line
          </p>
        </div>
      </div>
    </div>
  );
}
