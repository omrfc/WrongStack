import { expectDefined } from '@wrongstack/core';
import { summarizeToolInput } from '@/lib/tool-summary';
import { cn } from '@/lib/utils';
import { getWSClient } from '@/lib/ws-client';
import type { ChatMessage } from '@/stores';
import { useChatStore, useSessionStore, useUIStore } from '@/stores';
import { useConfigStore } from '@/stores';
import { useLocalPrefs } from '@/stores/local-prefs';
import { useAutoSubmitStreak } from '@/stores/auto-submit-streak.js';
import {
  Bot,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock,
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
import { memo, useMemo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { DiffView, diffFromToolInput } from '../DiffView';
import { ToolResult } from '../ToolResult';
import { NextStepsBar, fillInput, parseNextSteps } from '../NextStepsBar';
import { CopyButton } from './CopyButton.js';
import { ErrorBodyWithStack } from './ErrorBody.js';
import { ToolInputView } from './ToolInputView.js';
import { downloadTextFile, fileExtensionFor, formatToolDuration, markdownComponents, rehypePlugins } from './utils.js';
interface MessageBubbleProps {
  message: ChatMessage;
  isFirst?: boolean | undefined;
  isContinuation?: boolean | undefined;
}

export const MessageBubble = memo(function MessageBubble({
  message,
  isFirst = false,
  isContinuation = false,
}: MessageBubbleProps) {
  const [expandedTools, setExpandedTools] = useState<Record<string, boolean>>({});
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState('');
  const [showRaw, setShowRaw] = useState(false);
  const isUser = message.role === 'user';
  const isTool = message.role === 'tool';
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
  const inputCost = useSessionStore((s) => s.inputCost);
  const outputCost = useSessionStore((s) => s.outputCost);
  const cacheReadCost = useSessionStore((s) => s.cacheReadCost);
  const localPrefs = useLocalPrefs();
  const { autonomy, yolo } = localPrefs;

  const { canAutoSubmit, recordAutoSubmit, capWarned } = useAutoSubmitStreak();
  const autoProceedMaxIterations = localPrefs.autoProceedMaxIterations;
  const canAutoSubmitNow = autoProceedMaxIterations <= 0 || canAutoSubmit();

  /** Auto-submit callback for YOLO+auto mode countdown completion */
  const handleAutoSubmit = (text: string) => {
    if (!canAutoSubmit()) {
      // Cap already hit — show a one-time warning and stop.
      if (!capWarned) {
        addMessage({
          role: 'assistant',
          content:
            '⚠️ _Auto-proceed paused — maximum consecutive automatic turns reached. Type anything to continue (autonomy stays on)._',
        });
      }
      return;
    }
    recordAutoSubmit();
    addMessage({ role: 'user', content: text });
    setLoading(true);
    const client = getWSClient(wsUrl);
    client.sendMessage(text);
    // Clear the input field after auto-submitting, matching the behaviour
    // of the normal form submission path in ChatInput.
    fillInput('');
  };

  const isLatestAssistant = (() => {
    if (message.role !== 'assistant' || isLoading) return false;
    const all = useChatStore.getState().messages;
    for (let i = all.length - 1; i >= 0; i--) {
      const m = expectDefined(all[i]);
      if (m.role === 'assistant') return m.id === message.id;
    }
    return false;
  })();

  /**
   * Parse the assistant output once and cache the result for both:
   *   - the stripped content fed to react-markdown (so raw <next_steps> tags
   *     never leak into the rendered DOM)
   *   - the steps array fed to the <NextStepsBar> below.
   * Recomputes only when message.content changes.
   */
  const nextStepsResult = useMemo(
    () => (isLatestAssistant && message.content ? parseNextSteps(message.content) : null),
    [isLatestAssistant, message.content],
  );

  const regenerate = () => {
    const all = useChatStore.getState().messages;
    const idx = all.findIndex((m) => m.id === message.id);
    if (idx === -1) return;
    let userIdx = -1;
    for (let i = idx - 1; i >= 0; i--) {
      if (all[i]?.role === 'user') {
        userIdx = i;
        break;
      }
    }
    if (userIdx === -1) return;
    const userMsg = expectDefined(all[userIdx]);
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
    if (!next) { cancelEdit(); return; }
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
        'group flex msg-bubble animate-message rounded-lg transition-shadow',
        compactMode ? 'gap-2' : 'gap-3',
        isUser ? 'flex-row-reverse' : 'flex-row',
        isPinned && 'ring-1 ring-amber-500/30 bg-amber-500/[0.02] px-1 -mx-1',
      )}
    >
      {isContinuation ? (
        <div className="flex-shrink-0 w-8 h-8" aria-hidden />
      ) : (
        <div className={cn(
          'flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center',
          'ring-2 ring-offset-2 ring-offset-background',
          isUser ? 'bg-primary text-primary-foreground ring-primary/20' : isTool ? 'bg-secondary text-secondary-foreground ring-secondary/20' : 'bg-accent text-accent-foreground ring-accent/20',
        )}>
          {isUser ? <User className="h-4 w-4" /> : isTool ? <Terminal className="h-4 w-4" /> : <Bot className="h-4 w-4" />}
        </div>
      )}

      <div className={cn('flex flex-col gap-1.5 max-w-[85%]', isUser && 'items-end')}>
        {isFirst && !isContinuation && (
          <span className={cn('text-xs font-medium px-1', isUser ? 'text-primary' : isTool ? 'text-secondary' : 'text-muted-foreground')}>
            {isUser ? 'You' : isTool ? 'Tool' : 'Assistant'}
          </span>
        )}

        {isTool && message.toolName && (
          <button type="button" onClick={() => toggleTool(message.id)}
            className={cn('flex items-center gap-2 text-sm font-medium cursor-pointer select-none', 'hover:bg-muted/50 rounded-lg px-2 py-1 -mx-2 transition-colors', message.isError ? 'text-destructive' : 'text-foreground')}>
            <span className="text-muted-foreground/50">{expandedTools[message.id] ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}</span>
            <Terminal className="h-3 w-3" />
            <span className="font-mono">{message.toolName}</span>
            {message.toolResult === undefined ? <span className="h-1.5 w-1.5 rounded-full bg-amber-500 animate-pulse" aria-hidden /> : message.isError ? <XCircle className="h-3 w-3 text-destructive" /> : <CheckCircle2 className="h-3 w-3 text-green-500" />}
            {typeof message.toolDurationMs === 'number' && <span className="text-xs text-muted-foreground tabular-nums font-normal">{formatToolDuration(message.toolDurationMs)}</span>}
          </button>
        )}

        <div className={cn('rounded-2xl', compactMode ? 'px-3 py-1.5' : 'px-4 py-3',
          isUser ? 'bg-primary text-primary-foreground rounded-br-md' : isTool ? message.isError ? 'bg-destructive/5 border border-destructive/20 text-destructive' : 'bg-muted/80 text-foreground' : 'bg-card border text-foreground',
          message.isError && !isTool && 'border-destructive/20')}>
          {isTool ? (() => {
            const expanded = !!expandedTools[message.id];
            const inputSummary = message.toolInput !== undefined ? summarizeToolInput(message.toolName, message.toolInput) : '';
            const lines = message.toolResult ? message.toolResult.split('\n').length : 0;
            return (
              <div className="space-y-1 tool-details">
                {inputSummary && !expanded && <div className="text-xs text-muted-foreground font-mono truncate">{inputSummary}</div>}
                {message.toolResult === undefined && message.progressLines && message.progressLines.length > 0 && (
                  <div className="mt-1 rounded-md border border-amber-500/20 bg-amber-500/5 p-1.5 text-[11px] font-mono leading-snug max-h-32 overflow-auto">
                    {(() => {
                      const seen = new Map<string, number>();
                      return message.progressLines.slice(-6).map((line) => {
                        const occurrence = seen.get(line) ?? 0;
                        seen.set(line, occurrence + 1);
                        return (<div key={`${line}-${occurrence}`} className="truncate text-muted-foreground">{line}</div>);
                      });
                    })()}
                  </div>
                )}
                {expanded && message.toolInput !== undefined && (() => {
                  const diffArgs = diffFromToolInput(message.toolName, message.toolInput);
                  if (diffArgs) return (<DiffView oldText={diffArgs.oldText} newText={diffArgs.newText} caption={diffArgs.caption} />);
                  return (<div className="p-3 bg-muted/50 rounded-lg overflow-x-auto"><div className="flex items-center gap-1 text-muted-foreground mb-2 text-xs"><Clock className="h-3 w-3" /><span>Input</span></div><ToolInputView input={message.toolInput} /></div>);
                })()}
                {expanded && message.toolResult !== undefined && message.toolResult.length > 0 && (
                  <div className="relative group/tool">
                    <ToolResult toolName={message.toolName} result={message.toolResult} isError={message.isError} />
                    <div className="absolute top-1.5 right-1.5 flex items-center gap-1 opacity-0 group-hover/tool:opacity-100 transition-opacity">
                      <CopyButton text={message.toolResult} label="" className="bg-background/80 border rounded px-1.5 py-0.5" />
                      {message.toolResult.split('\n').length > 5 && (
                        <button type="button" onClick={(ev) => { ev.stopPropagation(); const ext = fileExtensionFor(message.toolName); const base = (message.toolName ?? 'output').replace(/[^a-z0-9_-]+/gi, '-').toLowerCase(); downloadTextFile(`${base}-${new Date().toISOString().replace(/[:.]/g, '-')}.${ext}`, message.toolResult ?? ''); }}
                          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground bg-background/80 border rounded px-1.5 py-0.5" title="Download as file"><Download className="h-3 w-3" /></button>
                      )}
                    </div>
                  </div>
                )}
                {expanded && message.toolResult !== undefined && message.toolResult.length === 0 && <span className="text-xs text-muted-foreground italic">(empty)</span>}
                {!expanded && message.isError && message.toolResult && <div className="text-xs font-mono text-destructive truncate">{message.toolResult.split('\n')[0]}</div>}
                {((message.toolResult !== undefined && message.toolResult.length > 0) || (message.toolInput !== undefined && Object.keys((message.toolInput as object) ?? {}).length > 0)) && (
                  <button type="button" onClick={() => toggleTool(message.id)} className="text-xs text-muted-foreground hover:text-foreground transition-colors">
                    {expanded ? 'Hide details' : `Show details${lines > 0 ? ` (${lines} line${lines === 1 ? '' : 's'})` : ''}`}
                  </button>
                )}
              </div>
            );
          })() : editing && isUser ? (
            <div className="flex flex-col gap-2 min-w-[280px]">
              <textarea value={editValue} onChange={(e) => setEditValue(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); cancelEdit(); } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); saveEdit(); } }}
                rows={Math.min(8, Math.max(2, editValue.split('\n').length))}
                className="w-full resize-none rounded-md border bg-background text-foreground px-2 py-1.5 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-ring" />
              <div className="flex items-center justify-between gap-2">
                <span className="text-[10px] text-primary-foreground/60">⌘/Ctrl+Enter to save · Esc to cancel</span>
                <div className="flex gap-1">
                  <button type="button" onClick={cancelEdit} className="text-xs px-2 py-0.5 rounded border border-primary-foreground/30 hover:bg-primary-foreground/10">Cancel</button>
                  <button type="button" onClick={saveEdit} disabled={!editValue.trim()} className="text-xs px-2 py-0.5 rounded bg-primary-foreground text-primary disabled:opacity-50">Save &amp; resend</button>
                </div>
              </div>
            </div>
          ) : (() => {
            // For assistant output, strip the <next_steps>/"💡 Next steps" block
            // before passing to react-markdown — otherwise the raw tags leak
            // through as literal text. The parsed steps render as a separate
            // <NextStepsBar> below the bubble.
            const renderedContent = nextStepsResult ? nextStepsResult.stripped : message.content;
            return (
              <div className={cn('text-sm leading-relaxed markdown-content', message.streaming && 'streaming-cursor')}>
                {renderedContent ? (showRaw && message.role === 'assistant' ? (
                  <pre className="whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-foreground/90 max-h-[40rem] overflow-auto">{message.content}</pre>
                ) : message.role === 'assistant' && message.isError ? (
                  <ErrorBodyWithStack text={message.content} />
                ) : (
                  <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={rehypePlugins} components={markdownComponents}>{renderedContent}</ReactMarkdown>
                )) : message.streaming ? (
                  <span className="inline-block animate-pulse text-muted-foreground">Typing...</span>
                ) : (
                  <span className="text-muted-foreground italic">No content</span>
                )}
              </div>
            );
          })()}
        </div>

        {/* Next steps — parse <next_steps> / "💡 Next steps" from assistant output */}
        {nextStepsResult && nextStepsResult.steps.length > 0 && (
          <NextStepsBar
            steps={nextStepsResult.steps}
            yoloMode={yolo}
            autoMode={autonomy === 'auto'}
            autoDelayMs={localPrefs.autonomyDelayMs}
            onAutoSubmit={handleAutoSubmit}
            canAutoSubmit={canAutoSubmitNow}
          />
        )}

        <div className={cn('flex items-center gap-2 px-1', isUser ? 'flex-row-reverse' : 'flex-row')}>
          <span className="text-xs text-muted-foreground/50">{new Date(message.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
          {/* ── Separator ── */}
          <span className="w-px h-3 bg-border/60 shrink-0" aria-hidden />
          {message.runSummary && (
            <span className="text-[10px] text-muted-foreground/60 font-mono tabular-nums"
              title={[`Iterations: ${message.runSummary.iterations}`, `Tool calls: ${message.runSummary.tools}`, `Elapsed: ${(message.runSummary.durationMs / 1000).toFixed(2)}s`, message.runSummary.costDelta > 0 ? `Cost: ${message.runSummary.costDelta.toFixed(4)}` : ''].filter(Boolean).join('  ·  ')}>
              {message.runSummary.iterations} iter{message.runSummary.tools > 0 ? ` · ${message.runSummary.tools} tool${message.runSummary.tools === 1 ? '' : 's'}` : ''} · {message.runSummary.durationMs < 60_000 ? `${(message.runSummary.durationMs / 1000).toFixed(1)}s` : `${Math.floor(message.runSummary.durationMs / 60_000)}m ${Math.floor((message.runSummary.durationMs % 60_000) / 1000)}s`}{message.runSummary.costDelta > 0 ? ` · ${message.runSummary.costDelta >= 0.01 ? message.runSummary.costDelta.toFixed(4) : message.runSummary.costDelta.toFixed(6).replace(/0+$/, '').replace(/\.$/, '')}` : ''}
            </span>
          )}
          {message.usage && (message.usage.input > 0 || message.usage.output > 0) && (() => {
            const u = message.usage;
            const dollars = (u.input * inputCost + u.output * outputCost + (u.cacheRead ?? 0) * cacheReadCost) / 1_000_000;
            const haveCost = inputCost > 0 || outputCost > 0;
            const dollarStr = dollars >= 0.01 ? `${dollars.toFixed(4)}` : dollars > 0 ? `${dollars.toFixed(6).replace(/0+$/, '').replace(/\.$/, '')}` : '';
            return (<span className="text-[10px] text-muted-foreground/60 font-mono tabular-nums" title={[`Input: ${u.input.toLocaleString()}`, `Output: ${u.output.toLocaleString()}`, u.cacheRead ? `Cache read: ${u.cacheRead.toLocaleString()}` : '', haveCost ? `Cost: ${dollarStr}` : ''].filter(Boolean).join('  ·  ')}>
              {u.input.toLocaleString()}→{u.output.toLocaleString()}{u.cacheRead ? ` · ${u.cacheRead.toLocaleString()} ↺` : ''}{haveCost && dollarStr ? ` · ${dollarStr}` : ''}
            </span>);
          })()}
          {/* ── Actions — always visible, subtle opacity, full on hover ── */}
          {!isTool && message.content && !message.streaming && (
            <CopyButton text={message.content} label="Copy" className="opacity-50 hover:opacity-100 transition-opacity" />
          )}
          {message.role === 'assistant' && message.content && !message.streaming && (
            <button type="button" onClick={() => setShowRaw((v) => !v)} title={showRaw ? 'Show rendered markdown' : 'Show raw markdown source'}
              className={cn('text-xs inline-flex items-center gap-1 transition-opacity', showRaw ? 'text-primary hover:text-primary/80 opacity-100' : 'opacity-50 hover:opacity-100 text-muted-foreground hover:text-foreground')}>
              <FileCode2 className="h-3 w-3" /><span>{showRaw ? 'Rendered' : 'Raw'}</span>
            </button>
          )}
          {isUser && !editing && !isLoading && message.content && (
            <button type="button" onClick={startEdit} title="Edit & resend this prompt" className="opacity-50 hover:opacity-100 transition-opacity text-xs text-muted-foreground hover:text-foreground inline-flex items-center gap-1">
              <Pencil className="h-3 w-3" /><span>Edit</span>
            </button>
          )}
          {message.role === 'assistant' && message.content && !message.streaming && (
            <button type="button" onClick={() => togglePin(message.id)} title={isPinned ? 'Unpin' : 'Pin this answer'}
              className={cn('text-xs inline-flex items-center gap-1 transition-opacity', isPinned ? 'text-amber-500 hover:text-amber-600 opacity-100' : 'opacity-50 hover:opacity-100 text-muted-foreground hover:text-foreground')}>
              {isPinned ? <PinOff className="h-3 w-3" /> : <Pin className="h-3 w-3" />}<span>{isPinned ? 'Pinned' : 'Pin'}</span>
            </button>
          )}
          {isLatestAssistant && message.content && !message.streaming && (
            <button type="button" onClick={regenerate} title="Regenerate this response" className="opacity-50 hover:opacity-100 transition-opacity text-xs text-muted-foreground hover:text-foreground inline-flex items-center gap-1">
              <RotateCcw className="h-3 w-3" /><span>Retry</span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
});
