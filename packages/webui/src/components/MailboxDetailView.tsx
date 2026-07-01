/**
 * MailboxDetailView — displays the selected mailbox message in the main content area.
 * Shown when currentView === 'mailbox'.
 */

import {
  ArrowLeft,
  CheckCircle2,
  Clock,
  Mail,
  Tag,
  User,
  AlertCircle,
  FileText,
  HelpCircle,
  Send,
  RotateCw,
  Bell,
  Circle,
  MessageSquare,
  Reply,
  X,
} from 'lucide-react';
import { useEffect } from 'react';
import ReactMarkdown from 'react-markdown';
import { cn } from '@/lib/utils';
import { showPanel } from '@/lib/view-navigation';
import { useUIStore } from '@/stores/ui-store';
import { markdownComponents } from './MessageBubble/utils';

// ── Helpers ───────────────────────────────────────────────────────────

const TYPE_ICONS: Record<string, typeof MessageSquare> = {
  note: FileText,
  ask: HelpCircle,
  assign: Send,
  steer: RotateCw,
  btw: Bell,
  broadcast: Send,
  status: Circle,
  result: CheckCircle2,
};

const TYPE_LABELS: Record<string, string> = {
  note: 'Note',
  ask: 'Question',
  assign: 'Assignment',
  steer: 'Steer',
  btw: 'By the way',
  broadcast: 'Broadcast',
  status: 'Status',
  result: 'Result',
};

const PRIORITY_COLORS: Record<string, string> = {
  high: 'text-red-600 bg-red-50 dark:bg-red-950/30',
  normal: 'text-muted-foreground bg-muted',
  low: 'text-slate-500 bg-slate-50 dark:bg-slate-950/20',
};

function fmtTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString();
}

function fmtRelative(iso: string): string {
  const d = new Date(iso);
  const diff = Date.now() - d.getTime();
  if (diff < 60_000) return 'just now';
  if (diff < 3600_000) return `${Math.round(diff / 60_000)}m ago`;
  if (diff < 86400_000) return `${Math.round(diff / 3600_000)}h ago`;
  if (diff < 604800_000) return `${Math.round(diff / 86400_000)}d ago`;
  return d.toLocaleDateString();
}

// ── Component ─────────────────────────────────────────────────────────

function EmptyState() {
  return (
    <div className="flex-1 flex flex-col items-center justify-center text-muted-foreground gap-3">
      <Mail className="h-12 w-12 opacity-20" />
      <div className="text-sm font-medium">No message selected</div>
      <div className="text-xs max-w-[260px] text-center opacity-60">
        Click a message in the Mailbox panel to view it here.
      </div>
    </div>
  );
}

function _MessageNotFound() {
  return (
    <div className="flex flex-col items-center justify-center gap-3 p-8 text-muted-foreground">
      <AlertCircle className="h-10 w-10 opacity-30" />
      <div className="text-sm font-medium">Message not found</div>
      <div className="text-xs opacity-60">This message may have been deleted or purged.</div>
    </div>
  );
}

function ReadByList({ readBy }: { readBy: Record<string, string> }) {
  const entries = Object.entries(readBy);
  if (entries.length === 0) return null;
  return (
    <div className="space-y-1">
      <div className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">Read by</div>
      <div className="flex flex-wrap gap-1.5">
        {entries.map(([agentId, timestamp]) => (
          <span
            key={agentId}
            className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] bg-green-50 text-green-700 dark:bg-green-950/30 dark:text-green-400"
            title={fmtTime(timestamp)}
          >
            <CheckCircle2 className="h-2.5 w-2.5" />
            {agentId}
          </span>
        ))}
      </div>
    </div>
  );
}

export function MailboxDetailView({ className }: { className?: string }) {
  const msg = useUIStore((s) => s.selectedMailMessage);
  const setSelectedMailMessage = useUIStore((s) => s.setSelectedMailMessage);

  // Clear selectedMailMessage whenever the detail view unmounts (user navigates
  // away via panel switch, keyboard shortcut, command palette, etc.).
  useEffect(() => {
    return () => {
      setSelectedMailMessage(null);
    };
  }, [setSelectedMailMessage]);

  function handleClose() {
    setSelectedMailMessage(null);
    showPanel('chat');
  }

  if (!msg) return <EmptyState />;

  const Icon = TYPE_ICONS[msg.type] ?? MessageSquare;
  const typeLabel = TYPE_LABELS[msg.type] ?? msg.type;
  const priorityClass = PRIORITY_COLORS[msg.priority] ?? PRIORITY_COLORS.normal;

  return (
    <div className={cn('flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden', className)}>
      {/* ── Header bar ── */}
      <div className="flex items-center gap-3 px-4 py-2.5 border-b border-border bg-card/40 shrink-0">
        <button
          type="button"
          onClick={handleClose}
          className="flex items-center justify-center w-7 h-7 rounded-md hover:bg-accent text-muted-foreground hover:text-foreground transition-colors shrink-0"
          title="Back to chat"
        >
          <ArrowLeft className="h-4 w-4" />
        </button>

        <div className={cn('p-1.5 rounded-md shrink-0', msg.completed ? 'bg-green-100 dark:bg-green-950/40' : 'bg-amber-100 dark:bg-amber-950/40')}>
          <Icon className={cn('h-4 w-4', msg.completed ? 'text-green-600 dark:text-green-400' : 'text-amber-600 dark:text-amber-400')} />
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold text-foreground truncate">{msg.subject}</h2>
            {msg.completed && (
              <span className="inline-flex items-center gap-1 text-[10px] font-medium text-green-600 dark:text-green-400 shrink-0">
                <CheckCircle2 className="h-3 w-3" />
                Completed
              </span>
            )}
          </div>
          <div className="flex items-center gap-2 text-[11px] text-muted-foreground mt-0.5">
            <span className="font-medium text-foreground/80">{msg.from}</span>
            <span>→</span>
            <span>{msg.to === '*' || msg.to === 'all' ? 'everyone' : msg.to}</span>
            <span className="opacity-40">•</span>
            <span className="inline-flex items-center gap-1">
              <Clock className="h-3 w-3" />
              {fmtRelative(msg.timestamp)}
            </span>
          </div>
        </div>

        <button
          type="button"
          onClick={handleClose}
          className="flex items-center justify-center w-7 h-7 rounded-md hover:bg-accent text-muted-foreground hover:text-foreground transition-colors shrink-0"
          title="Close (Esc)"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* ── Body ── */}
      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">
        <div className="px-4 py-4">
          <div className="markdown-content prose prose-sm dark:prose-invert max-w-none text-sm leading-relaxed">
            <ReactMarkdown components={markdownComponents}>{msg.body}</ReactMarkdown>
          </div>
        </div>
      </div>

      {/* ── Metadata footer ── */}
      <div className="border-t border-border bg-card/30 px-4 py-3 shrink-0">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-6 gap-y-2 text-xs">
          {/* Type */}
          <div className="flex items-center gap-1.5 text-muted-foreground">
            <Tag className="h-3 w-3 shrink-0" />
            <span>{typeLabel}</span>
          </div>

          {/* Priority */}
          <div className="flex items-center gap-1.5">
            <span className={cn('px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase', priorityClass)}>
              {msg.priority || 'normal'}
            </span>
          </div>

          {/* From */}
          <div className="flex items-center gap-1.5 text-muted-foreground">
            <User className="h-3 w-3 shrink-0" />
            <span className="truncate" title={msg.from}>{msg.from}</span>
          </div>

          {/* Timestamp */}
          <div className="flex items-center gap-1.5 text-muted-foreground">
            <Clock className="h-3 w-3 shrink-0" />
            <span>{fmtTime(msg.timestamp)}</span>
          </div>

          {/* Reply To */}
          {msg.replyTo && (
            <div className="flex items-center gap-1.5 text-muted-foreground col-span-2">
              <Reply className="h-3 w-3 shrink-0" />
              <span className="truncate">In reply to: {msg.replyTo}</span>
            </div>
          )}

          {/* Completed by */}
          {msg.completed && msg.completedBy && (
            <div className="flex items-center gap-1.5 text-muted-foreground col-span-2">
              <CheckCircle2 className="h-3 w-3 shrink-0 text-green-500" />
              <span>Completed by {msg.completedBy}{msg.completedAt ? ` at ${fmtTime(msg.completedAt)}` : ''}</span>
            </div>
          )}

          {/* Outcome */}
          {msg.outcome && (
            <div className="flex items-start gap-1.5 text-muted-foreground col-span-2 sm:col-span-4">
              <span className="text-[10px] font-semibold uppercase tracking-wide shrink-0 mt-0.5">Outcome:</span>
              <span>{msg.outcome}</span>
            </div>
          )}

          {/* Task Context */}
          {msg.taskContext && (
            <div className="flex items-start gap-1.5 text-muted-foreground col-span-2 sm:col-span-4">
              <span className="text-[10px] font-semibold uppercase tracking-wide shrink-0 mt-0.5">Task:</span>
              <span>{msg.taskContext}</span>
            </div>
          )}
        </div>

        {/* Read by list */}
        {Object.keys(msg.readBy ?? {}).length > 0 && (
          <div className="mt-3 pt-3 border-t border-border/50">
            <ReadByList readBy={msg.readBy} />
          </div>
        )}
      </div>
    </div>
  );
}
