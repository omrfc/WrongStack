import { useWebSocket } from '@/hooks/useWebSocket';
import { cn } from '@/lib/utils';
import { useChatStore, useConfigStore, useFleetStore, useSessionStore } from '@/stores';
import type { SubagentView } from '@/stores';
import {
  Activity,
  ArrowDown,
  ArrowUp,
  Bot,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock,
  Cpu,
  Copy,
  Gauge,
  Sparkles,
  Wrench,
  XCircle,
  Zap,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ContextBar, ContextFillBar } from './ContextBar';
import { fmtTok } from './ChatView/utils';

// ── Helpers ────────────────────────────────────────────────────────────

export function fmtCost(v: number): string {
  if (v <= 0) return '$0';
  if (v >= 0.01) return `$${v.toFixed(3)}`;
  return `$${v.toFixed(5)}`.replace(/0+$/, '').replace(/\.$/, '');
}

export function fmtDuration(ms: number): string {
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  return `${min}m ${sec % 60}s`;
}

export function fmtElapsed(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

const SPARK = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];

/** Bucket recent tool timestamps into N bins of binMs each. */
export function bucketActivity(
  timestamps: number[],
  now: number,
  bins = 12,
  binMs = 2000,
): number[] {
  const out = new Array<number>(bins).fill(0);
  const windowStart = now - bins * binMs;
  for (const at of timestamps) {
    if (at < windowStart || at > now) continue;
    let idx = Math.floor((at - windowStart) / binMs);
    if (idx < 0) idx = 0;
    if (idx >= bins) idx = bins - 1;
    out[idx] = (out[idx] ?? 0) + 1;
  }
  return out;
}

export function sparkline(values: number[]): string {
  if (values.length === 0) return '';
  const max = Math.max(1, ...values);
  return values.map((v) => (v <= 0 ? SPARK[0] : SPARK[Math.min(SPARK.length - 1, Math.ceil((v / max) * (SPARK.length - 1)))] ?? SPARK[0])).join('');
}

const STATUS_META: Record<string, { icon: React.ReactNode; color: string; label: string }> = {
  running: {
    icon: <span className="led text-[hsl(var(--success))] led-pulse" />,
    color: 'text-[hsl(var(--success))]',
    label: 'running',
  },
  idle: {
    icon: <span className="led text-muted-foreground" />,
    color: 'text-muted-foreground',
    label: 'idle',
  },
  completed: {
    icon: <CheckCircle2 className="h-3.5 w-3.5" />,
    color: 'text-[hsl(var(--success))]',
    label: 'done',
  },
  failed: {
    icon: <XCircle className="h-3.5 w-3.5" />,
    color: 'text-destructive',
    label: 'failed',
  },
  timeout: {
    icon: <Clock className="h-3.5 w-3.5" />,
    color: 'text-[hsl(var(--warning))]',
    label: 'timeout',
  },
  stopped: {
    icon: <span className="led text-muted-foreground" />,
    color: 'text-muted-foreground',
    label: 'stopped',
  },
};

// ── Leader entry (Agent #0) synthesised from session data ──────────────

interface LeaderEntry {
  id: 'leader';
  name: string;
  provider?: string | undefined;
  model?: string | undefined;
  status: 'running' | 'idle';
  iterations: number;
  toolCalls: number;
  costUsd: number;
  ctxPct: number;
  ctxTokens: number;
  maxContext: number;
  startedAt: number;
  lastEventAt: number;
  extensions: number;
  currentTool?: string | undefined;
  toolLog: SubagentView['toolLog'];
  partialText?: string | undefined;
  finalText?: string | undefined;
  error?: { kind: string | undefined; message: string } | undefined;
}

type AgentView = SubagentView | LeaderEntry;

// ── Agent Detail ──────────────────────────────────────────────────────

function AgentDetailPanel({
  agent,
  now,
}: {
  agent: AgentView;
  now: number;
}): React.ReactElement {
  const [copied, setCopied] = useState(false);
  const handleCopy = useCallback(async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* ignore */ }
  }, []);

  const active = agent.status === 'running';
  const tool = agent.currentTool;
  const lastTool = agent.toolLog[0];
  const toolTimestamps = agent.toolLog.map((t) => t.at);
  const spark = sparkline(bucketActivity(toolTimestamps, now));

  // Build streaming / final text
  const outputText = agent.partialText || agent.finalText || undefined;
  const isStream = !agent.finalText && !!agent.partialText;

  return (
    <div className="rounded-lg border border-primary/30 bg-card p-4 space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-primary">{agent.name}</span>
          <span className={cn('text-[10px] uppercase tracking-wider', STATUS_META[agent.status]?.color ?? 'text-muted-foreground')}>
            {STATUS_META[agent.status]?.label ?? agent.status}
          </span>
        </div>
        <span className="text-[10px] text-muted-foreground tabular-nums">
          {active ? fmtElapsed(Math.max(0, now - agent.startedAt)) : '—'}
        </span>
      </div>

      {/* Sparkline + last tool */}
      {(spark || lastTool) && (
        <div className="flex items-center gap-3">
          {spark && <span className="text-sm text-[hsl(var(--success))] font-mono tracking-[-0.1em]">{spark}</span>}
          {lastTool && (
            <span className="text-xs text-muted-foreground">
              last: <span className="font-mono">{lastTool.name}</span>
              <span className="tabular-nums"> {lastTool.durationMs}ms</span>
              {!lastTool.ok && <span className="text-destructive ml-1">✗</span>}
            </span>
          )}
        </div>
      )}

      {/* Stats grid */}
      <div className="grid grid-cols-3 gap-2">
        <div className="rounded bg-muted/30 px-2 py-1.5">
          <span className="text-[9px] text-muted-foreground">Provider / Model</span>
          <div className="flex items-center gap-1 mt-0.5">
            <Cpu className="h-3 w-3 text-muted-foreground" />
            <span className="text-[11px] font-mono font-medium">
              {agent.provider ?? '?'}/{agent.model ?? '?'}
            </span>
          </div>
        </div>
        <div className="rounded bg-muted/30 px-2 py-1.5">
          <span className="text-[9px] text-muted-foreground">Iterations</span>
          <span className="block text-[11px] font-mono font-medium mt-0.5">
            L{getIterations(agent)}
          </span>
        </div>
        <div className="rounded bg-muted/30 px-2 py-1.5">
          <span className="text-[9px] text-muted-foreground">Tool Calls</span>
          <span className="block text-[11px] font-mono font-medium mt-0.5">
            {agent.toolCalls}t
          </span>
        </div>
        <div className="rounded bg-muted/30 px-2 py-1.5 col-span-3">
          <span className="text-[9px] text-muted-foreground">Cost Breakdown</span>
          <div className="flex items-center gap-2 mt-0.5">
            <span className="text-[11px] font-mono font-medium text-[hsl(var(--success))]">
              {fmtCost(agent.costUsd)} total
            </span>
            {agent.ctxPct > 0 && (
              <span className="text-[11px] font-mono text-[hsl(var(--warning))]">
                ctx {agent.ctxPct}%
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Context bar */}
      {agent.maxContext > 0 && (
        <ContextFillBar
          pct={agent.ctxPct}
          tokens={agent.ctxTokens}
          maxTokens={agent.maxContext}
        />
      )}

      {/* Current tool */}
      {tool && active && (
        <div className="rounded-lg border border-primary/30 bg-primary/[0.04] px-3 py-2 flex items-center gap-2">
          <Wrench className="h-3.5 w-3.5 text-primary animate-pulse" />
          <span className="text-xs font-mono">{tool}</span>
          <span className="text-[10px] text-muted-foreground ml-auto">running…</span>
        </div>
      )}

      {/* Output */}
      {outputText ? (
        <div className="rounded-lg border bg-muted/20 p-3">
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
              {isStream ? 'Live Output' : 'Output'}
            </span>
            <button
              type="button"
              onClick={() => handleCopy(outputText)}
              className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
            >
              {copied ? <CheckCircle2 className="h-3 w-3 text-emerald-500" /> : <Copy className="h-3 w-3" />}
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
          <pre className="text-xs whitespace-pre-wrap font-mono text-foreground/80 leading-relaxed max-h-48 overflow-y-auto">
            {outputText}
          </pre>
        </div>
      ) : active ? (
        <div className="rounded-lg border border-dashed border-border p-3 text-center">
          <span className="text-xs text-muted-foreground">Waiting for output…</span>
        </div>
      ) : null}

      {/* Extensions */}
      {agent.extensions > 0 && (
        <div className="rounded-lg bg-[hsl(var(--warning))]/10 px-3 py-1.5 flex items-center gap-2">
          <Zap className="h-3.5 w-3.5 text-[hsl(var(--warning))]" />
          <span className="text-xs">
            <span className="font-medium">{agent.extensions}</span> budget extension{agent.extensions === 1 ? '' : 's'}
          </span>
        </div>
      )}

      {/* Error */}
      {agent.error && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3">
          <span className="text-[10px] font-semibold text-destructive uppercase tracking-wider">Error</span>
          <p className="text-xs text-destructive/90 mt-1">{agent.error.message}</p>
        </div>
      )}

      {/* Tool log */}
      {agent.toolLog.length > 0 && (
        <div className="space-y-1">
          <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
            Tool Log ({agent.toolLog.length})
          </span>
          <div className="max-h-40 overflow-y-auto space-y-0.5">
            {agent.toolLog.slice(0, 20).map((tl, i) => (
              <div
                key={`${tl.name}-${tl.at}-${i}`}
                className={cn(
                  'flex items-center gap-2 rounded px-2 py-1 text-[10px]',
                  tl.ok ? 'bg-muted/30' : 'bg-destructive/5 border border-destructive/20',
                )}
              >
                <span className={cn('led shrink-0', tl.ok ? 'text-[hsl(var(--success))]' : 'text-destructive')} />
                <span className="font-mono truncate flex-1">{tl.name}</span>
                <span className="tabular text-muted-foreground">{tl.durationMs}ms</span>
                {!tl.ok && <span className="text-destructive font-medium">fail</span>}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Agent Row ──────────────────────────────────────────────────────────

function AgentRow({
  agent,
  now,
  selected,
  onClick,
}: {
  agent: AgentView;
  now: number;
  selected: boolean;
  onClick: () => void;
}): React.ReactElement {
  const meta = STATUS_META[agent.status] ?? STATUS_META.idle;
  const active = agent.status === 'running';
  const modelLabel = agent.provider && agent.model
    ? `${agent.provider}/${agent.model}`
    : agent.model ?? '—';

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'w-full text-left rounded-lg border px-3 py-2 transition-colors flex items-center gap-3',
        selected
          ? 'border-primary/50 bg-primary/[0.06]'
          : 'border-border/60 hover:border-primary/30 hover:bg-primary/[0.03]',
        agent.status === 'failed' || agent.status === 'timeout'
          ? 'opacity-80'
          : '',
      )}
    >
      {/* Selection indicator */}
      <span className={cn('shrink-0', selected ? 'text-primary' : 'text-muted-foreground/30')}>
        {selected ? <ChevronRight className="h-4 w-4" /> : <span className="w-4 inline-block" />}
      </span>

      {/* Status icon */}
      <span className={meta.color}>{meta.icon}</span>

      {/* Name */}
      <span className={cn('text-xs font-semibold min-w-0 truncate max-w-[8rem]', selected && 'text-primary')}>
        {agent.name}
      </span>

      {/* Model */}
      <span className="text-[10px] text-muted-foreground font-mono truncate max-w-[10rem] shrink">
        {modelLabel}
      </span>

      {/* Iterations / tools */}
      <span className="text-[10px] text-muted-foreground tabular-nums shrink-0">
        L{getIterations(agent)} {agent.toolCalls}t
      </span>

      {/* Context bar */}
      {agent.ctxPct > 0 && agent.maxContext > 0 && (
        <div className="shrink-0">
          <ContextFillBar
            pct={agent.ctxPct}
            tokens={agent.ctxTokens}
            maxTokens={agent.maxContext}
          />
        </div>
      )}

      {/* Current tool */}
      {active && agent.currentTool && (
        <span className="text-[10px] text-primary font-mono truncate max-w-[8rem] shrink">
          → {agent.currentTool}
        </span>
      )}

      {/* Extensions */}
      {agent.extensions > 0 && (
        <span className="text-[10px] text-[hsl(var(--warning))] shrink-0">
          ⚡×{agent.extensions}
        </span>
      )}

      {/* Elapsed */}
      <span className="text-[10px] text-muted-foreground tabular-nums shrink-0 ml-auto">
        {active ? fmtElapsed(Math.max(0, now - agent.startedAt)) : STATUS_META[agent.status]?.label ?? ''}
      </span>

      {/* Cost */}
      {agent.costUsd > 0 && (
        <span className="text-[10px] text-[hsl(var(--success))] tabular-nums font-medium shrink-0">
          {fmtCost(agent.costUsd)}
        </span>
      )}
    </button>
  );
}

export function getLastEventAt(a: AgentView): number {
  if (a.id === 'leader') return (a as LeaderEntry).lastEventAt;
  return (a as SubagentView).completedAt ?? (a as SubagentView).startedAt;
}

export function getIterations(a: AgentView): number {
  if (a.id === 'leader') return (a as LeaderEntry).iterations;
  return (a as SubagentView).iteration;
}

export function AgentsPage({
  className,
}: {
  className?: string | undefined;
}): React.ReactElement {
  const fleetAgents = useFleetStore((s) => s.agents);
  const sessionStore = useSessionStore();
  const { provider, model } = useConfigStore();
  const chatIsLoading = useChatStore((s) => s.isLoading);
  const chatMessages = useChatStore((s) => s.messages);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [nowTick, setNowTick] = useState(Date.now());

  // Live clock
  useEffect(() => {
    const t = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  // ── Build leader entry ──
  const leaderEntry: LeaderEntry = useMemo(() => {
    const toolMsgs = chatMessages.filter((m) => m.role === 'tool');
    const isLoading = chatIsLoading;

    return {
      id: 'leader',
      name: 'LEADER',
      provider,
      model,
      status: isLoading ? ('running' as const) : ('idle' as const),
      iterations: 0,
      toolCalls: toolMsgs.length,
      costUsd: sessionStore.cost,
      ctxPct: sessionStore.maxContext > 0
        ? Math.min(100, Math.round((sessionStore.lastInputTokens / sessionStore.maxContext) * 100))
        : 0,
      ctxTokens: sessionStore.lastInputTokens,
      maxContext: sessionStore.maxContext,
      startedAt: sessionStore.startTime ?? Date.now(),
      lastEventAt: Date.now(),
      extensions: 0,
      toolLog: [],
    };
  }, [provider, model, sessionStore.cost, sessionStore.lastInputTokens, sessionStore.maxContext, sessionStore.startTime, chatMessages, chatIsLoading]);

  // ── Merge leader + fleet ──
  // The server now emits subagent.event for subagentId 'leader' as well.
  // We merge that live data into our synthetic LeaderEntry so the leader row
  // gets real-time tool tracking, context updates, and cost — just like the TUI.
  // Fleet store's 'leader' entry is excluded from subagents to avoid duplication.
  const allAgents = useMemo(() => {
    const fleetLeader = fleetAgents.get('leader');
    const mergedLeader: LeaderEntry = fleetLeader
      ? {
          ...leaderEntry,
          status: fleetLeader.status === 'running' ? 'running' : leaderEntry.status,
          iterations: fleetLeader.iteration || leaderEntry.iterations,
          toolCalls: fleetLeader.toolCalls || leaderEntry.toolCalls,
          costUsd: fleetLeader.costUsd || leaderEntry.costUsd,
          ctxPct: fleetLeader.ctxPct,
          ctxTokens: fleetLeader.ctxTokens,
          maxContext: fleetLeader.maxContext || leaderEntry.maxContext,
          extensions: fleetLeader.extensions,
          currentTool: fleetLeader.currentTool ?? fleetLeader.lastTool,
          toolLog: fleetLeader.toolLog,
          partialText: fleetLeader.partialText,
          finalText: fleetLeader.finalText,
          error: fleetLeader.error,
          lastEventAt: fleetLeader.completedAt ?? fleetLeader.startedAt ?? leaderEntry.lastEventAt,
        }
      : leaderEntry;

    const list: AgentView[] = [mergedLeader];
    // Exclude the 'leader' entry from the fleet store to avoid duplication.
    const subs = Array.from(fleetAgents.values()).filter((a) => a.id !== 'leader');
    list.push(...subs);
    return list;
  }, [leaderEntry, fleetAgents]);

  // ── Sort: running first > idle > completed/failed (newest first) ──
  const sorted = useMemo(() => {
    return [...allAgents].sort((a, b) => {
      const ra = a.status === 'running' ? 0 : a.status === 'idle' ? 1 : 2;
      const rb = b.status === 'running' ? 0 : b.status === 'idle' ? 1 : 2;
      if (ra !== rb) return ra - rb;
      if (ra === 2) return getLastEventAt(b) - getLastEventAt(a);
      return a.startedAt - b.startedAt;
    });
  }, [allAgents]);

  // ── Counts ──
  const counts = useMemo(() => {
    let running = 0;
    let idle = 0;
    let completed = 0;
    let failed = 0;
    for (const a of allAgents) {
      if (a.status === 'running') running++;
      else if (a.status === 'idle') idle++;
      else if (a.status === 'completed') completed++;
      else failed++; // failed/timeout/stopped
    }
    return { running, idle, completed, failed };
  }, [allAgents]);

  // ── Totals ──
  const totalCost = useMemo(
    () => allAgents.reduce((sum, a) => sum + (a.costUsd ?? 0), 0),
    [allAgents],
  );

  const selected = selectedId ? allAgents.find((a) => a.id === selectedId) ?? null : null;

  // ── Keyboard navigation ──
  const containerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName?.toLowerCase();
      if (tag === 'input' || tag === 'textarea') return;

      if (e.key === 'ArrowDown' || e.key === 'j') {
        e.preventDefault();
        const idx = selectedId ? sorted.findIndex((a) => a.id === selectedId) : -1;
        const nextIdx = Math.min(sorted.length - 1, idx + 1);
        const next = sorted[nextIdx];
        if (next) setSelectedId(next.id);
      } else if (e.key === 'ArrowUp' || e.key === 'k') {
        e.preventDefault();
        const idx = selectedId ? sorted.findIndex((a) => a.id === selectedId) : 0;
        const prevIdx = Math.max(0, idx - 1);
        const prev = sorted[prevIdx];
        if (prev) setSelectedId(prev.id);
      } else if (e.key === 'Escape') {
        setSelectedId(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectedId, sorted]);

  // ── Model mapping ──
  const modelMap = useMemo(() => {
    const seen = new Map<string, string>();
    for (const a of sorted) {
      if (a.model && !seen.has(a.name)) {
        seen.set(a.name, `${a.provider ?? '?'}/${a.model}`);
      }
    }
    return [...seen.entries()].slice(0, 4);
  }, [sorted]);

  return (
    <div className={cn('flex flex-col h-full', className)} ref={containerRef}>
      {/* ── Header ── */}
      <div className="border-b bg-card/95 backdrop-blur-sm shrink-0">
        <div className="px-4 py-2 space-y-1.5">
          {/* Title row */}
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold flex items-center gap-1.5">
              <Bot className="h-4 w-4 text-primary" />
              AGENTS · LIVE
            </h2>
            <span className="text-muted-foreground/40">│</span>
            {counts.running > 0 && (
              <span className="flex items-center gap-1 text-[11px] text-[hsl(var(--success))] font-medium">
                <span className="led led-pulse text-[hsl(var(--success))]" />
                {counts.running} running
              </span>
            )}
            <span className="text-[11px] text-muted-foreground">
              {counts.completed} done
            </span>
            {counts.failed > 0 && (
              <span className="text-[11px] text-destructive">
                {counts.failed} failed
              </span>
            )}
            <span className="text-[10px] text-muted-foreground ml-auto">
              j/k or ↑↓ to navigate · Esc to deselect
            </span>
          </div>

          {/* Model mapping */}
          {modelMap.length > 0 && (
            <div className="flex items-center gap-2">
              <span className="text-[10px] text-muted-foreground">models</span>
              {modelMap.map(([name, mod]) => (
                <span key={name} className="text-[10px] text-muted-foreground font-mono">
                  {name}:{mod}
                </span>
              ))}
            </div>
          )}

          {/* Totals row */}
          <div className="flex items-center gap-2">
            <span className="text-[10px] text-muted-foreground">shown</span>
            <span className="text-[10px] font-medium">{sorted.length}</span>
            <span className="text-[10px] text-muted-foreground">total</span>
            <span className="text-[10px] text-[hsl(var(--success))] font-medium tabular-nums">
              {fmtCost(totalCost)}
            </span>
            <span className="text-[10px] text-muted-foreground">
              (leader {fmtCost(leaderEntry.costUsd)} · fleet {fmtCost(totalCost - leaderEntry.costUsd)})
            </span>
          </div>
        </div>
      </div>

      {/* ── Agent list ── */}
      <div className="flex-1 overflow-y-auto">
        {sorted.length === 0 ? (
          <div className="flex items-center justify-center h-full">
            <div className="text-center space-y-2">
              <Bot className="h-8 w-8 text-muted-foreground/40 mx-auto" />
              <p className="text-sm text-muted-foreground">
                No agents running.
              </p>
              <p className="text-xs text-muted-foreground/60">
                Agents appear here when the fleet is active.
              </p>
            </div>
          </div>
        ) : (
          <div className="p-3 space-y-1.5">
            {sorted.map((a) => (
              <AgentRow
                key={a.id}
                agent={a}
                now={nowTick}
                selected={a.id === selected?.id}
                onClick={() => setSelectedId(selectedId === a.id ? null : a.id)}
              />
            ))}
          </div>
        )}
      </div>

      {/* ── Selected agent detail ── */}
      {selected && (
        <div className="border-t bg-card/50 shrink-0 max-h-[50vh] overflow-y-auto p-4">
          <div className="flex items-center gap-2 mb-3">
            <span className="text-[10px] text-muted-foreground">───</span>
            <span className="text-xs font-semibold text-primary">{selected.name}</span>
            <span className="text-[10px] text-muted-foreground">details ───</span>
            <button
              type="button"
              onClick={() => setSelectedId(null)}
              className="ml-auto text-[10px] text-muted-foreground hover:text-foreground transition-colors"
            >
              ✕ close
            </button>
          </div>
          <AgentDetailPanel agent={selected} now={nowTick} />
        </div>
      )}
    </div>
  );
}
