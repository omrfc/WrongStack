import { cn } from '@/lib/utils';
import { Activity, Bot, Cpu, Pause, UserX } from 'lucide-react';
import type React from 'react';

export interface AgentPhaseAssignment {
  agentId: string;
  agentName: string;
  agentStatus: 'idle' | 'running' | 'paused' | 'error';
  phaseId: string;
  phaseName: string;
  taskId?: string;
  taskTitle?: string;
  startedAt: number;
}

export interface PhaseAgentsMonitorProps {
  assignments: AgentPhaseAssignment[];
  /** Her fazda kaç agent var */
  phaseAgentCounts: Array<{ phaseId: string; phaseName: string; count: number; status: string }>;
  /** Toplam agent sayısı */
  totalAgents: number;
  /** Aktif çalışan agent sayısı */
  activeAgents: number;
  /** Agent fazdan çıkar */
  onReleaseAgent?: (agentId: string, phaseId: string) => void;
  /** Agent faza ata */
  onAssignAgent?: (agentId: string, phaseId: string) => void;
  className?: string;
}

const AGENT_STATUS_CONFIG: Record<
  AgentPhaseAssignment['agentStatus'],
  { icon: React.ReactNode; color: string; label: string }
> = {
  idle: { icon: <Pause className="w-3 h-3" />, color: 'text-slate-400', label: 'Bekliyor' },
  running: { icon: <Activity className="w-3 h-3" />, color: 'text-emerald-500', label: 'Çalışıyor' },
  paused: { icon: <Pause className="w-3 h-3" />, color: 'text-amber-500', label: 'Duraklatıldı' },
  error: { icon: <Cpu className="w-3 h-3" />, color: 'text-red-500', label: 'Hata' },
};

function formatDuration(ms: number): string {
  const m = Math.floor(ms / 60000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return rem > 0 ? `${h}h ${rem}m` : `${h}h`;
}

/**
 * PhaseAgentsMonitor — Her fazda hangi agent'ların çalıştığını gösteren panel.
 *
 * Fleet monitor'dan farkı: faz bazlı gruplama ve agent atama/çıkarma.
 */
export function PhaseAgentsMonitor({
  assignments,
  phaseAgentCounts,
  totalAgents,
  activeAgents,
  onReleaseAgent,
  className,
}: PhaseAgentsMonitorProps): React.ReactElement {
  return (
    <div className={cn('flex flex-col h-full w-64 border-l border-border bg-card', className)}>
      {/* Header */}
      <div className="p-4 border-b border-border">
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-sm font-semibold text-foreground flex items-center gap-1.5">
            <Bot className="w-4 h-4" />
            Agent'lar
          </h2>
        </div>
        <div className="flex gap-3 text-xs">
          <div>
            <span className="text-muted-foreground">Toplam:</span>{' '}
            <span className="font-medium">{totalAgents}</span>
          </div>
          <div>
            <span className="text-muted-foreground">Aktif:</span>{' '}
            <span className="font-medium text-emerald-600">{activeAgents}</span>
          </div>
        </div>
      </div>

      {/* Phase Agent Counts */}
      <div className="p-3 border-b border-border">
        <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">
          Fazlara Göre
        </h3>
        <div className="space-y-1.5">
          {phaseAgentCounts.map((pac) => (
            <div
              key={pac.phaseId}
              className="flex items-center justify-between text-xs rounded px-2 py-1 bg-muted/50"
            >
              <span className="truncate max-w-[120px]">{pac.phaseName}</span>
              <div className="flex items-center gap-1.5">
                <span className="font-medium">{pac.count}</span>
                <div
                  className={cn(
                    'w-1.5 h-1.5 rounded-full',
                    pac.status === 'running' ? 'bg-emerald-500' :
                    pac.status === 'completed' ? 'bg-slate-400' :
                    'bg-amber-500',
                  )}
                />
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Active Assignments */}
      <div className="flex-1 overflow-y-auto p-3">
        <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">
          Aktif Atamalar
        </h3>
        <div className="space-y-2">
          {assignments.map((a) => {
            const status = AGENT_STATUS_CONFIG[a.agentStatus];
            return (
              <div
                key={`${a.agentId}-${a.phaseId}`}
                className="rounded-lg border border-border p-2.5 bg-background"
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1.5">
                    <Bot className="w-3.5 h-3.5 text-muted-foreground" />
                    <span className="text-xs font-medium">{a.agentName}</span>
                  </div>
                  <span className={cn('flex items-center gap-1', status.color)}>
                    {status.icon}
                    <span className="text-[10px]">{status.label}</span>
                  </span>
                </div>

                <div className="mt-1.5 text-[11px] text-muted-foreground">
                  <div className="truncate">{a.phaseName}</div>
                  {a.taskTitle && (
                    <div className="truncate mt-0.5 text-amber-600">→ {a.taskTitle}</div>
                  )}
                  <div className="mt-1">
                    {formatDuration(Date.now() - a.startedAt)}
                  </div>
                </div>

                {/* Actions */}
                <div className="flex gap-1 mt-2">
                  {onReleaseAgent && (
                    <button
                      type="button"
                      onClick={() => onReleaseAgent(a.agentId, a.phaseId)}
                      className="flex items-center gap-1 px-2 py-0.5 text-[10px] rounded bg-red-100 text-red-700 hover:bg-red-200 transition-colors"
                    >
                      <UserX className="w-3 h-3" />
                      Çıkar
                    </button>
                  )}
                </div>
              </div>
            );
          })}

          {assignments.length === 0 && (
            <div className="text-center text-xs text-muted-foreground py-4">
              Aktif agent ataması yok
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
