import { AlertCircle, Bot, Brain, Check, CircleDot, Copy, Info, MessageSquareText, Wrench } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';
import { cn } from '@/lib/utils';
import type { AgentTranscriptEntry, AgentTranscriptKind } from '@/stores';

interface AgentTranscriptProps {
  entries: AgentTranscriptEntry[];
  agentName?: string | undefined;
  className?: string | undefined;
  compact?: boolean | undefined;
  maxHeightClassName?: string | undefined;
  title?: string | undefined;
  showHeader?: boolean | undefined;
}

const KIND_META: Record<
  AgentTranscriptKind,
  {
    label: string;
    icon: React.ComponentType<{ className?: string | undefined }>;
    tone: string;
    bubble: string;
  }
> = {
  text: {
    label: 'Assistant',
    icon: MessageSquareText,
    tone: 'text-primary',
    bubble: 'border-border bg-card',
  },
  thinking: {
    label: 'Thinking',
    icon: Brain,
    tone: 'text-violet-500',
    bubble: 'border-violet-500/20 bg-violet-500/5',
  },
  tool_use: {
    label: 'Tool call',
    icon: Wrench,
    tone: 'text-amber-500',
    bubble: 'border-amber-500/20 bg-amber-500/5',
  },
  tool_result: {
    label: 'Tool result',
    icon: Check,
    tone: 'text-emerald-500',
    bubble: 'border-emerald-500/20 bg-emerald-500/5',
  },
  error: {
    label: 'Error',
    icon: AlertCircle,
    tone: 'text-destructive',
    bubble: 'border-destructive/25 bg-destructive/5',
  },
  status: {
    label: 'Status',
    icon: Info,
    tone: 'text-muted-foreground',
    bubble: 'border-border bg-muted/25',
  },
  system: {
    label: 'System',
    icon: CircleDot,
    tone: 'text-muted-foreground',
    bubble: 'border-border bg-muted/25',
  },
};

function formatTime(ts: string): string {
  const time = Date.parse(ts);
  if (!Number.isFinite(time)) return '';
  return new Date(time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function transcriptText(entries: AgentTranscriptEntry[]): string {
  return entries
    .map((entry) => {
      const meta = KIND_META[entry.kind] ?? KIND_META.status;
      const time = formatTime(entry.ts);
      const tool = entry.toolName ? ` [${entry.toolName}]` : '';
      return `[${time}] ${entry.agentName} · ${meta.label}${tool}\n${entry.content}`;
    })
    .join('\n\n');
}

export function AgentTranscript({
  entries,
  agentName,
  className,
  compact = false,
  maxHeightClassName,
  title = 'Chat history',
  showHeader = true,
}: AgentTranscriptProps): React.ReactElement {
  const [copied, setCopied] = useState(false);
  const copyText = useMemo(() => transcriptText(entries), [entries]);
  const handleCopy = useCallback(async () => {
    if (!copyText) return;
    try {
      await navigator.clipboard.writeText(copyText);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      // Clipboard can be unavailable in hardened browser contexts.
    }
  }, [copyText]);

  return (
    <div className={cn('rounded-lg border bg-card', className)}>
      {showHeader && (
        <div className="flex items-center justify-between gap-3 border-b bg-muted/25 px-3 py-2">
          <div className="flex min-w-0 items-center gap-2">
            <Bot className="h-3.5 w-3.5 shrink-0 text-primary" />
            <span className="truncate text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              {title}
            </span>
            {agentName && (
              <span className="truncate text-[10px] text-muted-foreground">
                {agentName}
              </span>
            )}
            <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[9px] tabular-nums text-muted-foreground">
              {entries.length}
            </span>
          </div>
          <button
            type="button"
            onClick={handleCopy}
            disabled={entries.length === 0}
            className="flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
            title="Copy agent chat history"
          >
            {copied ? <Check className="h-3 w-3 text-emerald-500" /> : <Copy className="h-3 w-3" />}
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
      )}
      <div className={cn('space-y-2 overflow-y-auto p-2', maxHeightClassName ?? (compact ? 'max-h-72' : 'max-h-[32rem]'))}>
        {entries.length === 0 ? (
          <div className="rounded-md border border-dashed border-border p-3 text-center text-xs text-muted-foreground">
            No chat history for this agent yet.
          </div>
        ) : (
          entries.map((entry) => {
            const meta = KIND_META[entry.kind] ?? KIND_META.status;
            const Icon = meta.icon;
            return (
              <div
                key={entry.id}
                className={cn(
                  'rounded-md border px-3 py-2',
                  meta.bubble,
                  compact ? 'space-y-1' : 'space-y-1.5',
                )}
              >
                <div className="flex min-w-0 items-center gap-2">
                  <Icon className={cn('h-3.5 w-3.5 shrink-0', meta.tone)} />
                  <span className="shrink-0 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                    {meta.label}
                  </span>
                  {entry.toolName && (
                    <span className="min-w-0 truncate rounded bg-background/70 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                      {entry.toolName}
                    </span>
                  )}
                  <span className="ml-auto shrink-0 font-mono text-[9px] tabular-nums text-muted-foreground">
                    {formatTime(entry.ts)}
                  </span>
                </div>
                <pre
                  className={cn(
                    'whitespace-pre-wrap break-words font-mono text-foreground/85',
                    compact ? 'text-[10px] leading-relaxed' : 'text-xs leading-relaxed',
                  )}
                >
                  {entry.content}
                </pre>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
