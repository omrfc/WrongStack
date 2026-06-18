/**
 * MonitorDashboard — real-time monitoring panel for WrongStack fleet.
 *
 * Displays:
 * - Active clients (TUI, WebUI, REPL counts)
 * - Mail queue activity (messages flowing)
 * - Agent counts (total and active)
 * - Open replies and unread messages
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Activity,
  Bot,
  Clock,
  Globe,
  Mail,
  Monitor,
  RefreshCw,
  Terminal,
  Users,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  useFleetStore,
  useMailboxStore,
  useMonitorStore,
  type MailActivity,
} from '@/stores';

// ── Helpers ──────────────────────────────────────────────────────────────

function fmtElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}h ${m % 60}m ago`;
  if (m > 0) return `${m}m ${s % 60}s ago`;
  return `${s}s ago`;
}

function fmtTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

// ── Stat Card ───────────────────────────────────────────────────────────

interface StatCardProps {
  icon: React.ReactNode;
  label: string;
  value: number | string;
  sublabel?: string;
  accent?: 'default' | 'success' | 'warning' | 'danger';
}

function StatCard({ icon, label, value, sublabel, accent = 'default' }: StatCardProps): React.ReactElement {
  const accentClasses = {
    default: 'bg-muted/50 border-border',
    success: 'bg-emerald-500/10 border-emerald-500/30',
    warning: 'bg-amber-500/10 border-amber-500/30',
    danger: 'bg-destructive/10 border-destructive/30',
  };

  return (
    <div className={cn('rounded-lg border p-3 space-y-2', accentClasses[accent])}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-muted-foreground">
          <span className="h-4 w-4">{icon}</span>
          <span className="text-xs font-medium">{label}</span>
        </div>
      </div>
      <div className="flex items-end gap-2">
        <span className="text-2xl font-bold tabular-nums">{value}</span>
        {sublabel && <span className="text-xs text-muted-foreground mb-0.5">{sublabel}</span>}
      </div>
    </div>
  );
}

// ── Client Type Badge ───────────────────────────────────────────────────

interface ClientBadgeProps {
  icon: React.ReactNode;
  label: string;
  count: number;
  color: string;
}

function ClientBadge({ icon, label, count, color }: ClientBadgeProps): React.ReactElement {
  return (
    <div className="flex items-center gap-3 rounded-lg bg-muted/50 px-3 py-2">
      <div className={cn('flex items-center justify-center w-8 h-8 rounded-lg', color)}>
        <span className="h-4 w-4">{icon}</span>
      </div>
      <div className="flex-1">
        <div className="text-xs text-muted-foreground">{label}</div>
        <div className="text-lg font-bold tabular-nums">{count}</div>
      </div>
    </div>
  );
}

// ── Mail Activity Feed ───────────────────────────────────────────────────

interface MailActivityItemProps {
  activity: MailActivity;
}

function MailActivityItem({ activity }: MailActivityItemProps): React.ReactElement {
  const typeConfig = {
    sent: { label: 'Sent', color: 'text-blue-500', bg: 'bg-blue-500/10' },
    delivered: { label: 'Delivered', color: 'text-emerald-500', bg: 'bg-emerald-500/10' },
    read: { label: 'Read', color: 'text-amber-500', bg: 'bg-amber-500/10' },
    completed: { label: 'Completed', color: 'text-purple-500', bg: 'bg-purple-500/10' },
  };

  const config = typeConfig[activity.type];

  return (
    <div className="flex items-center gap-2 py-1.5">
      <span className={cn('px-2 py-0.5 rounded text-[10px] font-medium uppercase', config.color, config.bg)}>
        {config.label}
      </span>
      {activity.subject && (
        <span className="text-xs truncate flex-1">{activity.subject}</span>
      )}
      <span className="text-[10px] text-muted-foreground tabular-nums">
        {fmtTime(activity.timestamp)}
      </span>
    </div>
  );
}

// ── Agent Status ─────────────────────────────────────────────────────────

function AgentStatusRow(): React.ReactElement {
  const agents = useMailboxStore((s) => s.agents);
  const onlineCount = useMemo(() => agents.filter((a) => a.online).length, [agents]);

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Bot className="h-4 w-4 text-muted-foreground" />
          <span className="text-xs text-muted-foreground">Mailbox Agents</span>
        </div>
        <span className="text-xs tabular-nums">
          <span className="font-bold text-emerald-500">{onlineCount}</span>
          <span className="text-muted-foreground">/{agents.length}</span>
        </span>
      </div>
      {agents.length === 0 ? (
        <p className="text-xs text-muted-foreground italic">No agents registered</p>
      ) : (
        <div className="space-y-1">
          {agents.slice(0, 5).map((agent) => (
            <div key={agent.agentId} className="flex items-center gap-2 text-xs">
              <span className={cn(
                'w-1.5 h-1.5 rounded-full',
                agent.online ? 'bg-emerald-500' : 'bg-muted-foreground'
              )} />
              <span className="truncate flex-1">{agent.name}</span>
              <span className="text-muted-foreground">{agent.role || 'agent'}</span>
            </div>
          ))}
          {agents.length > 5 && (
            <p className="text-[10px] text-muted-foreground">+{agents.length - 5} more</p>
          )}
        </div>
      )}
    </div>
  );
}

// ── Fleet Agents ────────────────────────────────────────────────────────

function FleetAgentsStatus(): React.ReactElement {
  const agents = useFleetStore((s) => s.agents);
  const agentCount = agents.size;
  const activeCount = useMemo(() => {
    let count = 0;
    for (const a of agents.values()) {
      if (a.status === 'running') count++;
    }
    return count;
  }, [agents]);

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Users className="h-4 w-4 text-muted-foreground" />
          <span className="text-xs text-muted-foreground">Fleet Agents</span>
        </div>
        <span className="text-xs tabular-nums">
          <span className="font-bold text-emerald-500">{activeCount}</span>
          <span className="text-muted-foreground">/{agentCount} active</span>
        </span>
      </div>
      {agentCount === 0 ? (
        <p className="text-xs text-muted-foreground italic">No fleet agents running</p>
      ) : (
        <div className="space-y-1">
          {Array.from(agents.values()).slice(0, 5).map((agent) => (
            <div key={agent.id} className="flex items-center gap-2 text-xs">
              <span className={cn(
                'w-1.5 h-1.5 rounded-full',
                agent.status === 'running' ? 'bg-emerald-500 animate-pulse' : 'bg-muted-foreground'
              )} />
              <span className="truncate flex-1">{agent.name}</span>
              <span className="text-muted-foreground tabular-nums">{agent.iteration} iter</span>
            </div>
          ))}
          {agentCount > 5 && (
            <p className="text-[10px] text-muted-foreground">+{agentCount - 5} more</p>
          )}
        </div>
      )}
    </div>
  );
}

// ── Main Dashboard ──────────────────────────────────────────────────────

export function MonitorDashboard(): React.ReactElement {
  const [now, setNow] = useState(Date.now());
  const { clientCounts, mailActivity, totalMessages, openMessages, unreadMessages, totalAgents, activeAgents, lastUpdated } = useMonitorStore();
  const totalClients = clientCounts.tui + clientCounts.webui + clientCounts.repl;

  // Update "now" every second for relative time display
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const lastUpdatedText = useMemo(() => fmtElapsed(lastUpdated), [lastUpdated, now]);

  return (
    <div className="h-full flex flex-col overflow-y-auto">
      {/* Header */}
      <div className="shrink-0 border-b bg-card px-4 py-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Monitor className="h-4 w-4 text-primary" />
            <span className="text-sm font-semibold">Fleet Monitor</span>
          </div>
          <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
            <RefreshCw className="h-3 w-3" />
            <span>{lastUpdatedText}</span>
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-6">
        {/* Client Counts */}
        <section className="space-y-3">
          <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
            Connected Clients
          </h3>
          <div className="grid grid-cols-3 gap-2">
            <ClientBadge
              icon={<Terminal className="h-4 w-4" />}
              label="Terminal"
              count={clientCounts.tui}
              color="bg-blue-500/20"
            />
            <ClientBadge
              icon={<Globe className="h-4 w-4" />}
              label="Web UI"
              count={clientCounts.webui}
              color="bg-emerald-500/20"
            />
            <ClientBadge
              icon={<Activity className="h-4 w-4" />}
              label="REPL"
              count={clientCounts.repl}
              color="bg-purple-500/20"
            />
          </div>
          <div className="text-center">
            <span className="text-lg font-bold tabular-nums">{totalClients}</span>
            <span className="text-xs text-muted-foreground ml-1">total connected</span>
          </div>
        </section>

        {/* Stats Grid */}
        <section className="space-y-3">
          <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
            Mail Queue
          </h3>
          <div className="grid grid-cols-2 gap-2">
            <StatCard
              icon={<Mail className="h-4 w-4" />}
              label="Total"
              value={totalMessages}
              sublabel="messages"
              accent="default"
            />
            <StatCard
              icon={<Mail className="h-4 w-4" />}
              label="Open"
              value={openMessages}
              sublabel="uncompleted"
              accent={openMessages > 0 ? 'warning' : 'default'}
            />
            <StatCard
              icon={<Mail className="h-4 w-4" />}
              label="Unread"
              value={unreadMessages}
              sublabel="waiting"
              accent={unreadMessages > 0 ? 'danger' : 'default'}
            />
            <StatCard
              icon={<Clock className="h-4 w-4" />}
              label="Agents"
              value={activeAgents}
              sublabel={`of ${totalAgents} total`}
              accent="default"
            />
          </div>
        </section>

        {/* Agent Status */}
        <section className="space-y-3">
          <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
            Agent Roster
          </h3>
          <div className="space-y-3 rounded-lg border bg-card p-3">
            <AgentStatusRow />
            <div className="border-t border-border pt-3">
              <FleetAgentsStatus />
            </div>
          </div>
        </section>

        {/* Mail Activity Feed */}
        <section className="space-y-3">
          <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
            Live Mail Activity
          </h3>
          <div className="rounded-lg border bg-card p-3">
            {mailActivity.length === 0 ? (
              <p className="text-xs text-muted-foreground italic">No recent activity</p>
            ) : (
              <div className="space-y-0">
                {mailActivity.slice(0, 15).map((activity) => (
                  <MailActivityItem key={activity.seq ?? activity.timestamp} activity={activity} />
                ))}
              </div>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
