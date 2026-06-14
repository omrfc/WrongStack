import { useWebSocket } from '@/hooks/useWebSocket';
import { cn } from '@/lib/utils';
import { useMailboxStore } from '@/stores';
import {
  CheckCircle2,
  Mail,
  MailOpen,
  MessageSquare,
  Users,
  Circle,
  AlertCircle,
  FileText,
  HelpCircle,
  Send,
  Bell,
  RotateCw,
  UserCheck,
  Trash2,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { confirmModal } from './ConfirmModal';

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

function fmtTime(iso: string): string {
  const d = new Date(iso);
  const now = Date.now();
  const diff = now - d.getTime();
  if (diff < 60_000) return 'now';
  if (diff < 3600_000) return `${Math.round(diff / 60_000)}m`;
  if (diff < 86400_000) return `${Math.round(diff / 3600_000)}h`;
  return d.toLocaleDateString();
}

// ── Component ─────────────────────────────────────────────────────────

export function MailboxPanel({ className }: { className?: string }) {
  // Messages/agents live in the central mailbox store — populated by the
  // ws-handlers registry, refreshed on every mailbox.event. This panel
  // only triggers an extra refresh when (re)mounted.
  const messages = useMailboxStore((s) => s.messages);
  const agents = useMailboxStore((s) => s.agents);
  const [collapsed, setCollapsed] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const { client } = useWebSocket();
  // Track the socket lifecycle so the initial queries fire once the
  // connection is actually open (client.send drops messages otherwise).
  const [ready, setReady] = useState(client.status.state === 'open');
  useEffect(() => {
    const off = client.onStatus((s) => setReady(s.state === 'open'));
    return () => off();
  }, [client]);

  // Query mailbox on mount and when WS becomes ready
  useEffect(() => {
    if (!ready) return;
    client.send({ type: 'mailbox.messages', payload: { limit: 30 } });
    client.send({ type: 'mailbox.agents', payload: {} });
  }, [ready, client]);

  const unreadCount = messages.filter((m) => !m.completed).length;
  const onlineCount = agents.filter((a) => a.online).length;

  async function handleDeleteAll() {
    if (messages.length === 0) return;
    const ok = await confirmModal({
      title: `Delete all ${messages.length} message${messages.length === 1 ? '' : 's'}?`,
      message: 'The mailbox file is truncated for every agent. This cannot be undone.',
      confirmLabel: 'Delete all',
      danger: true,
    });
    if (!ok) return;
    setDeleting(true);
    client.send({ type: 'mailbox.clear' });
  }

  // Reset deleting state once messages are cleared (after server confirms).
  useEffect(() => {
    if (deleting && messages.length === 0) setDeleting(false);
  }, [deleting, messages.length]);

  return (
    <div className={cn('rounded-lg border border-border bg-card/60 backdrop-blur-sm', className)}>
      {/* Header */}
      <button
        type="button"
        onClick={() => setCollapsed((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2.5 text-left hover:bg-accent/40 rounded-t-lg transition-colors"
      >
        <Mail className="h-4 w-4 text-cyan-500" />
        <span className="text-xs font-semibold text-foreground flex-1 min-w-0 truncate">
          Mailbox
        </span>
        {unreadCount > 0 && (
          <span className="inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px] font-bold bg-yellow-100 dark:bg-yellow-900/40 text-yellow-700 dark:text-yellow-400">
            {unreadCount}
          </span>
        )}
        <span className="text-[10px] text-muted-foreground">
          {onlineCount} online
        </span>
      </button>

      {!collapsed && (
        <div className="px-3 pb-3 space-y-2">
          {/* Messages */}
          {messages.length > 0 ? (
            <div className="space-y-1">
              <div className="flex items-center justify-between">
                <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">
                  Messages
                </span>
                <button
                  type="button"
                  onClick={handleDeleteAll}
                  disabled={deleting}
                  className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-red-500 disabled:opacity-40 transition-colors"
                  title="Delete all messages"
                >
                  <Trash2 className="h-3 w-3" />
                  {deleting ? 'Deleting…' : 'Delete all'}
                </button>
              </div>
              {messages.slice(0, 8).map((m) => {
                const Icon = TYPE_ICONS[m.type] ?? MessageSquare;
                const isRead = m.readByCount > 0;
                return (
                  <div
                    key={m.id}
                    className={cn(
                      'flex items-start gap-2 px-2 py-1.5 rounded text-xs',
                      !isRead && 'bg-yellow-50 dark:bg-yellow-950/20',
                    )}
                  >
                    <Icon className={cn('h-3.5 w-3.5 mt-0.5 shrink-0', isRead ? 'text-muted-foreground' : 'text-yellow-600')} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <span className={cn('font-medium truncate', !isRead && 'text-yellow-800 dark:text-yellow-300')}>
                          {m.from}
                        </span>
                        {m.completed && <CheckCircle2 className="h-3 w-3 text-green-500 shrink-0" />}
                        {!isRead && <span className="text-[9px] text-yellow-600 font-bold">NEW</span>}
                      </div>
                      <div className="text-muted-foreground truncate">{m.subject}</div>
                      <div className="text-[10px] text-muted-foreground/70 truncate">
                        {m.body.slice(0, 60)}{m.body.length > 60 ? '…' : ''}
                      </div>
                    </div>
                    <div className="shrink-0 text-[10px] text-muted-foreground flex flex-col items-end gap-0.5">
                      <span>{fmtTime(m.timestamp)}</span>
                      {isRead && (
                        <span className="flex items-center gap-0.5">
                          <UserCheck className="h-3 w-3" />
                          {m.readByCount}
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="text-xs text-muted-foreground py-2 text-center">
              <MailOpen className="h-4 w-4 mx-auto mb-1 opacity-40" />
              No messages yet.
            </div>
          )}

          {/* Online agents */}
          {agents.length > 0 && (
            <div className="border-t border-border pt-2">
              <div className="text-[10px] font-semibold text-muted-foreground mb-1 flex items-center gap-1">
                <Users className="h-3 w-3" /> Agents
              </div>
              {agents.filter((a) => a.online).slice(0, 5).map((a) => (
                <div key={a.agentId} className="flex items-center gap-1.5 text-[10px] text-muted-foreground py-0.5">
                  <span className={cn('h-1.5 w-1.5 rounded-full', a.online ? 'bg-green-500' : 'bg-muted-foreground/30')} />
                  <span className="font-medium text-foreground/80">{a.name}</span>
                  {a.role && <span className="opacity-60">({a.role})</span>}
                  <span className="opacity-50">{a.status}</span>
                  {a.currentTool && <span className="text-cyan-500">{a.currentTool}</span>}
                  <span className="ml-auto opacity-50">{fmtTime(a.lastSeenAt)}</span>
                </div>
              ))}
              {agents.filter((a) => !a.online).length > 0 && (
                <div className="text-[10px] text-muted-foreground/50 mt-0.5">
                  +{agents.filter((a) => !a.online).length} offline
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
