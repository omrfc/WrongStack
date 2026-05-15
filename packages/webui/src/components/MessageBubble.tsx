import { summarizeToolInput } from '@/lib/tool-summary';
import { cn } from '@/lib/utils';
import { getWSClient } from '@/lib/ws-client';
import type { ChatMessage } from '@/stores';
import { useChatStore, useSessionStore, useUIStore } from '@/stores';
import { useConfigStore } from '@/stores';
import {
  Bot,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock,
  Copy,
  Download,
  FileCode2,
  Pencil,
  Pin,
  PinOff,
  RotateCcw,
  Terminal,
  User,
  XCircle,
} from 'lucide-react';
import type React from 'react';
import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { DiffView, diffFromToolInput } from './DiffView';
import { ToolResult } from './ToolResult';

/**
 * Tiny copy-to-clipboard helper used by the in-bubble copy buttons. Falls
 * back to the legacy `document.execCommand('copy')` path on insecure
 * (non-HTTPS, non-localhost) contexts where `navigator.clipboard` is
 * blocked — the WebUI is usually loaded from 127.0.0.1 over plain http so
 * we hit this fallback regularly.
 */
async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through */
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

/**
 * ReactMarkdown component overrides. Fenced code blocks render with a
 * header strip (language label + copy button) and an internally scrollable
 * body so a 200-line snippet doesn't blow up the chat. Inline `code` stays
 * styled simply. Kept at module scope so the components object reference is
 * stable across renders.
 */
const markdownComponents = {
  code({
    inline,
    className,
    children,
    ...props
  }: {
    inline?: boolean;
    className?: string;
    children?: React.ReactNode;
  }) {
    const match = /language-(\w+)/.exec(className ?? '');
    const codeText = String(children ?? '').replace(/\n$/, '');
    if (inline || !match) {
      return (
        <code
          className={cn('rounded bg-muted/60 px-1.5 py-0.5 text-[0.85em] font-mono', className)}
          {...props}
        >
          {children}
        </code>
      );
    }
    return (
      <div className="not-prose relative my-3 rounded-lg border bg-muted/30 overflow-hidden">
        <div className="flex items-center justify-between px-3 py-1.5 border-b bg-muted/40 text-xs">
          <span className="font-mono text-muted-foreground">{match[1]}</span>
          <CopyButton text={codeText} label="" />
        </div>
        <pre className="overflow-x-auto p-3 text-xs leading-relaxed font-mono max-h-[40rem]">
          <code>{codeText}</code>
        </pre>
      </div>
    );
  },
};

function CopyButton({
  text,
  className,
  label = 'Copy',
}: {
  text: string;
  className?: string;
  label?: string;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={async (ev) => {
        ev.stopPropagation();
        const ok = await copyToClipboard(text);
        if (ok) {
          setCopied(true);
          setTimeout(() => setCopied(false), 1400);
        }
      }}
      className={cn(
        'inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors',
        className,
      )}
      title={label}
    >
      {copied ? (
        <>
          <Check className="h-3 w-3 text-green-500" />
          <span>Copied</span>
        </>
      ) : (
        <>
          <Copy className="h-3 w-3" />
          <span>{label}</span>
        </>
      )}
    </button>
  );
}

/**
 * Spawn a browser download for the given text content. Uses a transient
 * Blob URL so the disk hit is browser-managed and we don't have to pump
 * the bytes through a backend route. Best-effort: no-op in non-browser
 * test environments.
 */
function downloadTextFile(filename: string, text: string): void {
  if (typeof document === 'undefined') return;
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Pick a reasonable file extension for a tool output dump based on the
 * tool name. JSON-shaped tools get `.json`, Read gets `.txt` (line numbers
 * baked in mean it isn't valid source anymore), bash gets `.log`,
 * everything else falls back to `.txt`.
 */
function fileExtensionFor(toolName: string | undefined): string {
  const t = (toolName ?? '').toLowerCase();
  if (/bash|shell|exec|run/.test(t)) return 'log';
  if (/grep|search|find/.test(t)) return 'txt';
  return 'txt';
}

/**
 * Heuristic for "the assistant just dumped a stack trace at me". Returns
 * the index where the stack begins or -1 if none. We're tolerant of the
 * three common shapes: Node V8 (`    at fn (file:line:col)`), Python
 * (`File "x", line N`), and Java (`at pkg.Class.method(File.java:N)`).
 * False positives are cheap (user just hits "Show stack" anyway).
 */
function detectStackBoundary(text: string): number {
  // Look for the first line that matches a stack-frame pattern.
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i]!;
    if (/^\s*at\s+\S+.*\(.*:\d+:\d+\)\s*$/.test(ln)) return i;
    if (/^\s*at\s+\S+\.\S+\(\S+\.java:\d+\)\s*$/.test(ln)) return i;
    if (/^\s+File "[^"]+", line \d+/.test(ln)) return i;
  }
  return -1;
}

/**
 * Wraps an error-flavoured assistant body and offers a "Show/hide stack"
 * toggle when a stack-trace boundary is detected. The lead message
 * (everything before the first frame) stays visible; the frames go
 * behind a click. Reduces the visual weight of a long traceback that
 * the user usually only needs once.
 */
function ErrorBodyWithStack({ text }: { text: string }) {
  const idx = detectStackBoundary(text);
  const [open, setOpen] = useState(false);
  if (idx === -1) {
    return (
      <pre className="whitespace-pre-wrap break-words font-mono text-xs leading-relaxed">
        {text}
      </pre>
    );
  }
  const lines = text.split('\n');
  const head = lines.slice(0, idx).join('\n').trim();
  const stack = lines.slice(idx).join('\n');
  const frameCount = stack.split('\n').filter((l) => l.trim().length > 0).length;
  return (
    <div className="space-y-2">
      {head && (
        <pre className="whitespace-pre-wrap break-words font-mono text-xs leading-relaxed">
          {head}
        </pre>
      )}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1 text-xs text-destructive hover:text-destructive/80 font-medium"
      >
        {open ? '▾' : '▸'} {open ? 'Hide' : 'Show'} stack trace ({frameCount} frame
        {frameCount === 1 ? '' : 's'})
      </button>
      {open && (
        <pre className="whitespace-pre-wrap break-words font-mono text-[11px] leading-snug bg-destructive/5 border border-destructive/20 rounded p-2 max-h-80 overflow-auto">
          {stack}
        </pre>
      )}
    </div>
  );
}

/**
 * Render a tool-call's input as a structured key/value table instead of a
 * raw JSON dump. Shallow scalars land on one row each; nested values land
 * as a collapsible row that expands into pretty-printed JSON. Falls back
 * to a single JSON block when the input is not an object (e.g. a number
 * or a string), which keeps the layout sensible for tools whose schema
 * isn't `Record<string, unknown>`.
 */
function ToolInputView({ input }: { input: unknown }) {
  const [openKeys, setOpenKeys] = useState<Record<string, boolean>>({});
  if (input === null || input === undefined || typeof input !== 'object' || Array.isArray(input)) {
    return (
      <pre className="whitespace-pre-wrap break-all text-xs font-mono">
        {JSON.stringify(input, null, 2)}
      </pre>
    );
  }
  const entries = Object.entries(input as Record<string, unknown>);
  if (entries.length === 0) {
    return <span className="text-xs text-muted-foreground italic">(no params)</span>;
  }
  return (
    <div className="text-xs font-mono">
      {entries.map(([k, v]) => {
        const isPrimitive =
          v === null ||
          v === undefined ||
          typeof v === 'string' ||
          typeof v === 'number' ||
          typeof v === 'boolean';
        if (isPrimitive) {
          const display =
            v === null
              ? 'null'
              : v === undefined
                ? 'undefined'
                : typeof v === 'string'
                  ? v
                  : String(v);
          // Long string values get their own line so the row stays usable.
          const isLong = typeof v === 'string' && (display.length > 80 || display.includes('\n'));
          return (
            <div
              key={k}
              className={cn(
                'py-0.5',
                isLong ? 'flex flex-col gap-0.5' : 'flex items-baseline gap-2',
              )}
            >
              <span className="text-muted-foreground shrink-0">{k}:</span>
              <span
                className={cn(
                  'text-foreground',
                  isLong
                    ? 'whitespace-pre-wrap break-all bg-muted/40 rounded px-1.5 py-1'
                    : 'truncate',
                  typeof v === 'string' ? '' : 'text-amber-600 dark:text-amber-400',
                )}
                title={typeof v === 'string' && !isLong ? display : undefined}
              >
                {display}
              </span>
            </div>
          );
        }
        const open = !!openKeys[k];
        const summary = Array.isArray(v)
          ? `[${v.length} item${v.length === 1 ? '' : 's'}]`
          : `{${Object.keys(v as object).length} key${Object.keys(v as object).length === 1 ? '' : 's'}}`;
        return (
          <div key={k} className="py-0.5">
            <button
              type="button"
              onClick={() => setOpenKeys((p) => ({ ...p, [k]: !p[k] }))}
              className="flex items-baseline gap-2 hover:bg-muted/30 rounded px-1 -mx-1"
            >
              <span className="text-muted-foreground/60 text-[10px]">{open ? '▾' : '▸'}</span>
              <span className="text-muted-foreground">{k}:</span>
              <span className="text-violet-600 dark:text-violet-400">{summary}</span>
            </button>
            {open && (
              <pre className="ml-3 mt-1 whitespace-pre-wrap break-all text-[11px] bg-muted/40 rounded px-2 py-1.5">
                {JSON.stringify(v, null, 2)}
              </pre>
            )}
          </div>
        );
      })}
    </div>
  );
}

interface MessageBubbleProps {
  message: ChatMessage;
  isFirst?: boolean;
  /** Render as a continuation of the previous item in the same agent turn.
   *  Hides the avatar (replaces it with a transparent spacer so content
   *  stays aligned) and the role label, and tightens the top margin — used
   *  by ChatView's turn-bundling so text→tool→text reads as one flow
   *  instead of three detached bubbles each with its own avatar column. */
  isContinuation?: boolean;
}

function formatToolDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  return `${m}m ${s}s`;
}

export function MessageBubble({
  message,
  isFirst = false,
  isContinuation = false,
}: MessageBubbleProps) {
  const [expandedTools, setExpandedTools] = useState<Record<string, boolean>>({});
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState('');
  /** Per-bubble "show raw markdown" toggle for assistant messages. Useful
   *  when the model emits weird-looking markdown and you want to verify
   *  what it actually wrote (escape sequences, table cells, etc.) versus
   *  how ReactMarkdown is rendering it. Hover-revealed toggle in the
   *  footer; off by default so the chat stays pleasant to read. */
  const [showRaw, setShowRaw] = useState(false);
  const isUser = message.role === 'user';
  const isTool = message.role === 'tool';
  // (kept for symmetry — isAssistant referenced indirectly via !isUser && !isTool)
  void message.role;

  const truncateAfter = useChatStore((s) => s.truncateAfter);
  const addMessage = useChatStore((s) => s.addMessage);
  const setLoading = useChatStore((s) => s.setLoading);
  const isLoading = useChatStore((s) => s.isLoading);
  const wsUrl = useConfigStore((s) => s.wsUrl);
  const pinnedIds = useUIStore((s) => s.pinnedIds);
  const togglePin = useUIStore((s) => s.togglePin);
  const compactMode = useUIStore((s) => s.compactMode);
  const isPinned = pinnedIds.includes(message.id);
  /** Per-token cost rates for the active provider/model, from setEnv on
   *  session.start. We multiply against this message's usage to render a
   *  USD figure beside the token counts — answers the "what did this turn
   *  cost?" question without making the user open Settings. */
  const inputCost = useSessionStore((s) => s.inputCost);
  const outputCost = useSessionStore((s) => s.outputCost);
  const cacheReadCost = useSessionStore((s) => s.cacheReadCost);

  /** True when this is the most recent assistant message and we're not
   *  in the middle of a run — eligible for the regenerate action. We
   *  derive this from the store so the button only renders on one bubble
   *  at a time without prop drilling. */
  const isLatestAssistant = (() => {
    if (message.role !== 'assistant' || isLoading) return false;
    const all = useChatStore.getState().messages;
    for (let i = all.length - 1; i >= 0; i--) {
      const m = all[i]!;
      if (m.role === 'assistant') return m.id === message.id;
    }
    return false;
  })();

  const regenerate = () => {
    // Find the user message that prompted this reply by walking backward.
    // Truncate to that user message (exclusive), then re-send its content.
    const all = useChatStore.getState().messages;
    const idx = all.findIndex((m) => m.id === message.id);
    if (idx === -1) return;
    let userIdx = -1;
    for (let i = idx - 1; i >= 0; i--) {
      if (all[i]!.role === 'user') {
        userIdx = i;
        break;
      }
    }
    if (userIdx === -1) return;
    const userMsg = all[userIdx]!;
    truncateAfter(userMsg.id);
    addMessage({ role: 'user', content: userMsg.content });
    setLoading(true);
    const client = getWSClient(wsUrl);
    client.sendMessage(userMsg.content);
  };

  const toggleTool = (id: string) => {
    setExpandedTools((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  const startEdit = () => {
    setEditValue(message.content);
    setEditing(true);
  };
  const cancelEdit = () => {
    setEditing(false);
    setEditValue('');
  };
  const saveEdit = () => {
    const next = editValue.trim();
    if (!next) {
      cancelEdit();
      return;
    }
    // Wipe everything from this message forward, then send the corrected
    // prompt as a fresh user turn. The backend still has the original in
    // its server-side context.messages — that's an acceptable tradeoff for
    // a no-backend-change implementation; the user gets the rewind UX they
    // expect locally, and the model just sees a "rephrased follow-up".
    truncateAfter(message.id);
    addMessage({ role: 'user', content: next });
    setLoading(true);
    const client = getWSClient(wsUrl);
    client.sendMessage(next);
    setEditing(false);
    setEditValue('');
  };

  return (
    <div
      data-message-id={message.id}
      data-pinned={isPinned ? '1' : undefined}
      className={cn(
        'group flex animate-message rounded-lg transition-shadow',
        compactMode ? 'gap-2' : 'gap-3',
        isUser ? 'flex-row-reverse' : 'flex-row',
        isPinned && 'ring-1 ring-amber-500/30 bg-amber-500/[0.02] px-1 -mx-1',
      )}
    >
      {/* Avatar — replaced by an invisible spacer in continuation mode so
          subsequent items in the same agent turn align under the first
          item's avatar without redrawing it. */}
      {isContinuation ? (
        <div className="flex-shrink-0 w-8 h-8" aria-hidden />
      ) : (
        <div
          className={cn(
            'flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center',
            'ring-2 ring-offset-2 ring-offset-background',
            isUser
              ? 'bg-primary text-primary-foreground ring-primary/20'
              : isTool
                ? 'bg-secondary text-secondary-foreground ring-secondary/20'
                : 'bg-accent text-accent-foreground ring-accent/20',
          )}
        >
          {isUser ? (
            <User className="h-4 w-4" />
          ) : isTool ? (
            <Terminal className="h-4 w-4" />
          ) : (
            <Bot className="h-4 w-4" />
          )}
        </div>
      )}

      {/* Content */}
      <div className={cn('flex flex-col gap-1.5 max-w-[85%]', isUser && 'items-end')}>
        {/* Role indicator for first message in a group. Suppressed for
            continuation items so the same label doesn't repeat for every
            text→tool→text segment of one agent turn. */}
        {isFirst && !isContinuation && (
          <span
            className={cn(
              'text-xs font-medium px-1',
              isUser ? 'text-primary' : isTool ? 'text-secondary' : 'text-muted-foreground',
            )}
          >
            {isUser ? 'You' : isTool ? 'Tool' : 'Assistant'}
          </span>
        )}

        {/* Tool header */}
        {isTool && message.toolName && (
          <button
            type="button"
            onClick={() => toggleTool(message.id)}
            className={cn(
              'flex items-center gap-2 text-sm font-medium cursor-pointer select-none',
              'hover:bg-muted/50 rounded-lg px-2 py-1 -mx-2 transition-colors',
              message.isError ? 'text-destructive' : 'text-foreground',
            )}
          >
            <span className="text-muted-foreground/50">
              {expandedTools[message.id] ? (
                <ChevronDown className="h-3 w-3" />
              ) : (
                <ChevronRight className="h-3 w-3" />
              )}
            </span>
            <Terminal className="h-3 w-3" />
            <span className="font-mono">{message.toolName}</span>
            {message.toolResult === undefined ? (
              // Pulsing dot while still running (matches the inline indicator below).
              <span className="h-1.5 w-1.5 rounded-full bg-amber-500 animate-pulse" aria-hidden />
            ) : message.isError ? (
              <XCircle className="h-3 w-3 text-destructive" />
            ) : (
              <CheckCircle2 className="h-3 w-3 text-green-500" />
            )}
            {typeof message.toolDurationMs === 'number' && (
              <span className="text-xs text-muted-foreground tabular-nums font-normal">
                {formatToolDuration(message.toolDurationMs)}
              </span>
            )}
          </button>
        )}

        {/* Message content */}
        <div
          className={cn(
            'rounded-2xl',
            compactMode ? 'px-3 py-1.5' : 'px-4 py-3',
            isUser
              ? 'bg-primary text-primary-foreground rounded-br-md'
              : isTool
                ? message.isError
                  ? 'bg-destructive/5 border border-destructive/20 text-destructive'
                  : 'bg-muted/80 text-foreground'
                : 'bg-card border text-foreground',
            message.isError && !isTool && 'border-destructive/20',
          )}
        >
          {isTool ? (
            (() => {
              const expanded = !!expandedTools[message.id];
              const inputSummary =
                message.toolInput !== undefined
                  ? summarizeToolInput(message.toolName, message.toolInput)
                  : '';
              const lines = message.toolResult ? message.toolResult.split('\n').length : 0;
              return (
                <div className="space-y-1">
                  {/* Collapsed: just a one-line input summary so parallel calls
                      stay distinguishable. The output is hidden entirely —
                      click the header (or "Show details" link) to expand. */}
                  {inputSummary && !expanded && (
                    <div className="text-xs text-muted-foreground font-mono truncate">
                      {inputSummary}
                    </div>
                  )}
                  {/* Live progress feed while the tool is still running.
                      Shown both collapsed and expanded so the user can see
                      what's happening — the final result replaces this when
                      tool.executed lands. */}
                  {message.toolResult === undefined &&
                    message.progressLines &&
                    message.progressLines.length > 0 && (
                      <div className="mt-1 rounded-md border border-amber-500/20 bg-amber-500/5 p-1.5 text-[11px] font-mono leading-snug max-h-32 overflow-auto">
                        {message.progressLines.slice(-6).map((line, i) => (
                          <div
                            // biome-ignore lint/suspicious/noArrayIndexKey: static progress lines
                            key={i}
                            className="truncate text-muted-foreground"
                          >
                            {line}
                          </div>
                        ))}
                      </div>
                    )}
                  {/* Expanded view. For the edit/write family of tools we
                      replace the raw JSON dump with a real diff — the
                      old_string/new_string pair (or just the new content
                      for write) is the whole point of the call. Falls
                      back to JSON for everything else. */}
                  {expanded &&
                    message.toolInput !== undefined &&
                    (() => {
                      const diffArgs = diffFromToolInput(message.toolName, message.toolInput);
                      if (diffArgs) {
                        return (
                          <DiffView
                            oldText={diffArgs.oldText}
                            newText={diffArgs.newText}
                            caption={diffArgs.caption}
                          />
                        );
                      }
                      return (
                        <div className="p-3 bg-muted/50 rounded-lg overflow-x-auto">
                          <div className="flex items-center gap-1 text-muted-foreground mb-2 text-xs">
                            <Clock className="h-3 w-3" />
                            <span>Input</span>
                          </div>
                          <ToolInputView input={message.toolInput} />
                        </div>
                      );
                    })()}
                  {expanded &&
                    message.toolResult !== undefined &&
                    message.toolResult.length > 0 && (
                      <div className="relative group/tool">
                        <ToolResult
                          toolName={message.toolName}
                          result={message.toolResult}
                          isError={message.isError}
                        />
                        <div className="absolute top-1.5 right-1.5 flex items-center gap-1 opacity-0 group-hover/tool:opacity-100 transition-opacity">
                          <CopyButton
                            text={message.toolResult}
                            label=""
                            className="bg-background/80 border rounded px-1.5 py-0.5"
                          />
                          {/* Download — only worth showing when the dump is
                            big enough to actually save (>5 lines).
                            Small grep hits are easier to just copy. */}
                          {message.toolResult.split('\n').length > 5 && (
                            <button
                              type="button"
                              onClick={(ev) => {
                                ev.stopPropagation();
                                const ext = fileExtensionFor(message.toolName);
                                const base = (message.toolName ?? 'output')
                                  .replace(/[^a-z0-9_-]+/gi, '-')
                                  .toLowerCase();
                                downloadTextFile(
                                  `${base}-${new Date().toISOString().replace(/[:.]/g, '-')}.${ext}`,
                                  message.toolResult ?? '',
                                );
                              }}
                              className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground bg-background/80 border rounded px-1.5 py-0.5"
                              title="Download as file"
                            >
                              <Download className="h-3 w-3" />
                            </button>
                          )}
                        </div>
                      </div>
                    )}
                  {expanded &&
                    message.toolResult !== undefined &&
                    message.toolResult.length === 0 && (
                      <span className="text-xs text-muted-foreground italic">(empty)</span>
                    )}
                  {/* Error case: keep the message inline even when collapsed,
                      since silently hiding a failure is worse than the noise. */}
                  {!expanded && message.isError && message.toolResult && (
                    <div className="text-xs font-mono text-destructive truncate">
                      {message.toolResult.split('\n')[0]}
                    </div>
                  )}
                  {/* "Show details" toggle — only when there's anything to reveal. */}
                  {((message.toolResult !== undefined && message.toolResult.length > 0) ||
                    (message.toolInput !== undefined &&
                      Object.keys((message.toolInput as object) ?? {}).length > 0)) && (
                    <button
                      type="button"
                      onClick={() => toggleTool(message.id)}
                      className="text-xs text-muted-foreground hover:text-foreground transition-colors"
                    >
                      {expanded
                        ? 'Hide details'
                        : `Show details${lines > 0 ? ` (${lines} line${lines === 1 ? '' : 's'})` : ''}`}
                    </button>
                  )}
                </div>
              );
            })()
          ) : editing && isUser ? (
            <div className="flex flex-col gap-2 min-w-[280px]">
              <textarea
                value={editValue}
                onChange={(e) => setEditValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    e.preventDefault();
                    cancelEdit();
                  } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault();
                    saveEdit();
                  }
                }}
                rows={Math.min(8, Math.max(2, editValue.split('\n').length))}
                className="w-full resize-none rounded-md border bg-background text-foreground px-2 py-1.5 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-ring"
              />
              <div className="flex items-center justify-between gap-2">
                <span className="text-[10px] text-primary-foreground/60">
                  ⌘/Ctrl+Enter to save · Esc to cancel
                </span>
                <div className="flex gap-1">
                  <button
                    type="button"
                    onClick={cancelEdit}
                    className="text-xs px-2 py-0.5 rounded border border-primary-foreground/30 hover:bg-primary-foreground/10"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={saveEdit}
                    disabled={!editValue.trim()}
                    className="text-xs px-2 py-0.5 rounded bg-primary-foreground text-primary disabled:opacity-50"
                  >
                    Save &amp; resend
                  </button>
                </div>
              </div>
            </div>
          ) : (
            <div className="text-sm leading-relaxed markdown-content">
              {message.content ? (
                showRaw && message.role === 'assistant' ? (
                  <pre className="whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-foreground/90 max-h-[40rem] overflow-auto">
                    {message.content}
                  </pre>
                ) : message.role === 'assistant' && message.isError ? (
                  <ErrorBodyWithStack text={message.content} />
                ) : (
                  <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
                    {message.content}
                  </ReactMarkdown>
                )
              ) : message.streaming ? (
                <span className="inline-block animate-pulse text-muted-foreground">Typing...</span>
              ) : (
                <span className="text-muted-foreground italic">No content</span>
              )}
            </div>
          )}
        </div>

        {/* Footer: timestamp + copy. Copy is hover-revealed so the chat
            stays clean by default. Tool bubbles get their own copy button
            on the output box, so we skip it here for them. */}
        <div
          className={cn('flex items-center gap-2 px-1', isUser ? 'flex-row-reverse' : 'flex-row')}
        >
          <span className="text-xs text-muted-foreground/50">
            {new Date(message.timestamp).toLocaleTimeString([], {
              hour: '2-digit',
              minute: '2-digit',
            })}
          </span>
          {/* Per-message token attribution. Lands on the assistant bubble
              after provider.response with the input/output counts. Cache
              reads show up too when present — useful to see when prompt
              caching is actually saving cost. USD figure appears only when
              we know the per-token rates for the active model. */}
          {/* Run summary — attached by the run.result handler to the last
              assistant bubble of each turn. Renders as a single quiet line:
              iterations / tools / elapsed / $ delta. Hidden when nothing
              meaningful happened (e.g. plain-text reply with no tools). */}
          {message.runSummary && (
            <span
              className="text-[10px] text-muted-foreground/60 font-mono tabular-nums"
              title={[
                `Iterations: ${message.runSummary.iterations}`,
                `Tool calls: ${message.runSummary.tools}`,
                `Elapsed: ${(message.runSummary.durationMs / 1000).toFixed(2)}s`,
                message.runSummary.costDelta > 0
                  ? `Cost: $${message.runSummary.costDelta.toFixed(4)}`
                  : '',
              ]
                .filter(Boolean)
                .join('  ·  ')}
            >
              {message.runSummary.iterations} iter
              {message.runSummary.tools > 0
                ? ` · ${message.runSummary.tools} tool${message.runSummary.tools === 1 ? '' : 's'}`
                : ''}
              {' · '}
              {message.runSummary.durationMs < 60_000
                ? `${(message.runSummary.durationMs / 1000).toFixed(1)}s`
                : `${Math.floor(message.runSummary.durationMs / 60_000)}m ${Math.floor((message.runSummary.durationMs % 60_000) / 1000)}s`}
              {message.runSummary.costDelta > 0
                ? ` · $${message.runSummary.costDelta >= 0.01 ? message.runSummary.costDelta.toFixed(4) : message.runSummary.costDelta.toFixed(6).replace(/0+$/, '').replace(/\.$/, '')}`
                : ''}
            </span>
          )}
          {message.usage &&
            (message.usage.input > 0 || message.usage.output > 0) &&
            (() => {
              const u = message.usage;
              const dollars =
                (u.input * inputCost + u.output * outputCost + (u.cacheRead ?? 0) * cacheReadCost) /
                1_000_000;
              const haveCost = inputCost > 0 || outputCost > 0;
              const dollarStr =
                dollars >= 0.01
                  ? `$${dollars.toFixed(4)}`
                  : dollars > 0
                    ? `$${dollars.toFixed(6).replace(/0+$/, '').replace(/\.$/, '')}`
                    : '';
              return (
                <span
                  className="text-[10px] text-muted-foreground/60 font-mono tabular-nums"
                  title={[
                    `Input: ${u.input.toLocaleString()}`,
                    `Output: ${u.output.toLocaleString()}`,
                    u.cacheRead ? `Cache read: ${u.cacheRead.toLocaleString()}` : '',
                    haveCost ? `Cost: ${dollarStr}` : '',
                  ]
                    .filter(Boolean)
                    .join('  ·  ')}
                >
                  {u.input.toLocaleString()}→{u.output.toLocaleString()}
                  {u.cacheRead ? ` · ${u.cacheRead.toLocaleString()} ↺` : ''}
                  {haveCost && dollarStr ? ` · ${dollarStr}` : ''}
                </span>
              );
            })()}
          {!isTool && message.content && !message.streaming && (
            <CopyButton
              text={message.content}
              label=""
              className="opacity-0 group-hover:opacity-100 transition-opacity"
            />
          )}
          {/* Raw markdown toggle — assistant bubbles only. When the model
              emits literal markdown the user wants to inspect (escaped
              backticks, weird table formatting, raw HTML…), this flips the
              body from rendered → raw without leaving the chat. */}
          {message.role === 'assistant' && message.content && !message.streaming && (
            <button
              type="button"
              onClick={() => setShowRaw((v) => !v)}
              title={showRaw ? 'Show rendered markdown' : 'Show raw markdown source'}
              className={cn(
                'text-xs inline-flex items-center gap-1 transition-opacity',
                showRaw
                  ? 'text-primary hover:text-primary/80 opacity-100'
                  : 'opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-foreground',
              )}
            >
              <FileCode2 className="h-3 w-3" />
              <span>{showRaw ? 'Rendered' : 'Raw'}</span>
            </button>
          )}
          {/* Edit + regenerate — user messages only. Hidden while a run is
              in flight to avoid the textarea-vs-streaming-bubble race. */}
          {isUser && !editing && !isLoading && message.content && (
            <button
              type="button"
              onClick={startEdit}
              title="Edit & resend this prompt"
              className="opacity-0 group-hover:opacity-100 transition-opacity text-xs text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
            >
              <Pencil className="h-3 w-3" />
              <span>Edit</span>
            </button>
          )}
          {/* Pin/unpin — assistant messages with real content. A pinned bubble
              gets a subtle amber ring + lands in the sidebar's Pinned panel
              so the user can jump back to it. Always visible once pinned so
              the user can tell at a glance it's bookmarked. */}
          {message.role === 'assistant' && message.content && !message.streaming && (
            <button
              type="button"
              onClick={() => togglePin(message.id)}
              title={isPinned ? 'Unpin' : 'Pin this answer'}
              className={cn(
                'text-xs inline-flex items-center gap-1 transition-opacity',
                isPinned
                  ? 'text-amber-500 hover:text-amber-600 opacity-100'
                  : 'opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-foreground',
              )}
            >
              {isPinned ? <PinOff className="h-3 w-3" /> : <Pin className="h-3 w-3" />}
              <span>{isPinned ? 'Pinned' : 'Pin'}</span>
            </button>
          )}
          {/* Regenerate — only the most recent assistant reply, when the run
              has settled. Rewinds local state to the prompting user message
              and resends it, giving the user a one-click "try again". */}
          {isLatestAssistant && message.content && !message.streaming && (
            <button
              type="button"
              onClick={regenerate}
              title="Regenerate this response"
              className="opacity-0 group-hover:opacity-100 transition-opacity text-xs text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
            >
              <RotateCcw className="h-3 w-3" />
              <span>Retry</span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
