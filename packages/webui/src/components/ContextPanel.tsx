import { expectDefined } from '@wrongstack/core';
import { useWebSocket } from '@/hooks/useWebSocket';
import { cn } from '@/lib/utils';
import { getWSClient } from '@/lib/ws-client';
import { useConfigStore, useSessionStore } from '@/stores';
import {
  Activity,
  AlertTriangle,
  Check,
  ChevronDown,
  Cpu,
  Eraser,
  Gauge,
  RefreshCw,
  Shrink,
  Wrench,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ContextBar, ContextFillBar } from './ContextBar';
import { fmtTok } from './ChatView/utils';

const FALLBACK_MODES = [
  {
    id: 'balanced',
    name: 'Balanced',
    description: 'Default rolling compaction — good for most sessions.',
    thresholds: { warn: 0.6, soft: 0.75, hard: 0.9 },
    preserveK: 10,
    eliseThreshold: 2000,
  },
  {
    id: 'frugal',
    name: 'Frugal',
    description: 'Aggressive compaction — keeps context small, costs low.',
    thresholds: { warn: 0.4, soft: 0.55, hard: 0.7 },
    preserveK: 5,
    eliseThreshold: 1000,
  },
  {
    id: 'deep',
    name: 'Deep',
    description: 'Preserves more history — for complex multi-step tasks.',
    thresholds: { warn: 0.7, soft: 0.85, hard: 0.95 },
    preserveK: 20,
    eliseThreshold: 4000,
  },
  {
    id: 'archival',
    name: 'Archival',
    description: 'Minimal compaction — maximum context retention.',
    thresholds: { warn: 0.8, soft: 0.9, hard: 0.98 },
    preserveK: 50,
    eliseThreshold: 8000,
  },
];

type ContextMode = {
  id: string;
  name: string;
  description: string;
  thresholds: { warn: number; soft: number; hard: number };
  preserveK: number;
  eliseThreshold: number;
};

/** Debug payload from context.debug WS response. */
interface ContextDebugPayload {
  total: number;
  mode?: string | undefined;
  policy?: unknown | undefined;
  systemPrompt: number;
  tools: { total: number; count: number; breakdown: Array<{ name: string; tokens: number }> };
  messages: {
    total: number;
    count: number;
    breakdown: Array<{ index: number; role: string; tokens: number; preview: string }>;
  };
}

/** Compacted payload from context.compacted WS response. */
interface ContextCompactedPayload {
  before: number;
  after: number;
  saved: number;
  reductions: Array<{ phase: string; saved: number }>;
  repaired?: {
    removedToolUses: string[];
    removedToolResults: string[];
    removedMessages: number;
  };
}

export function ContextPanel({
  className,
}: {
  className?: string | undefined;
}): React.ReactElement {
  const sessionStore = useSessionStore();
  const contextMode = sessionStore.contextMode;
  const contextModes = sessionStore.contextModes;
  const { lastInputTokens, maxContext, totalTokens, startTime, cost } = sessionStore;

  const { switchContextMode } = useWebSocket();
  const wsUrl = useConfigStore((s) => s.wsUrl);

  // Modes — fetched or fallback
  const [modesOpen, setModesOpen] = useState(false);
  const modesRef = useRef<HTMLDivElement>(null);
  const modes = contextModes.length > 0 ? contextModes : FALLBACK_MODES as unknown as typeof contextModes;

  // Context debug
  const [debugData, setDebugData] = useState<ContextDebugPayload | null>(null);
  const [debugOpen, setDebugOpen] = useState(false);
  const [debugLoading, setDebugLoading] = useState(false);

  // Compaction result
  const [compactResult, setCompactResult] = useState<ContextCompactedPayload | null>(null);
  const [compactLoading, setCompactLoading] = useState(false);
  const [repairLoading, setRepairLoading] = useState(false);

  // Context window stats
  const ctxPct =
    maxContext > 0 && lastInputTokens > 0
      ? Math.min(100, Math.round((lastInputTokens / maxContext) * 100))
      : 0;

  const activeMode = useMemo(() => {
    const found = modes.find((m) => m.id === contextMode);
    if (found) return found;
    return expectDefined(modes[0]);
  }, [modes, contextMode]);

  // Outside click for modes dropdown
  useEffect(() => {
    if (!modesOpen) return;
    const onClick = (e: MouseEvent) => {
      if (!modesRef.current?.contains(e.target as Node)) setModesOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setModesOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [modesOpen]);

  // Operations
  const handleClear = () => {
    const ws = getWSClient(wsUrl);
    ws?.send?.({ type: 'context.clear' });
  };

  const handleCompact = () => {
    setCompactLoading(true);
    setCompactResult(null);
    const ws = getWSClient(wsUrl);
    ws?.send?.({ type: 'context.compact', payload: { aggressive: false } });
    // Server will respond with context.compacted event
    // We listen in the WebSocket handler and update compactResult
    // For now, just mark as done after a short delay
    setTimeout(() => {
      setCompactLoading(false);
      setCompactResult(null);
    }, 2000);
  };

  const handleCompactAggressive = () => {
    setCompactLoading(true);
    setCompactResult(null);
    const ws = getWSClient(wsUrl);
    ws?.send?.({ type: 'context.compact', payload: { aggressive: true } });
    setTimeout(() => {
      setCompactLoading(false);
      setCompactResult(null);
    }, 2000);
  };

  const handleRepair = () => {
    setRepairLoading(true);
    const ws = getWSClient(wsUrl);
    ws?.send?.({ type: 'context.repair' });
    setTimeout(() => {
      setRepairLoading(false);
    }, 2000);
  };

  const handleDebug = () => {
    setDebugLoading(true);
    setDebugData(null);
    setDebugOpen(true);
    const ws = getWSClient(wsUrl);
    ws?.send?.({ type: 'context.debug' });
    // The server will reply with context.debug event — we listen in ws-handlers
    // For now, show loading state
    setTimeout(() => {
      setDebugLoading(false);
    }, 3000);
  };

  const formatDuration = (start: number | null) => {
    if (!start) return '--';
    const seconds = Math.floor((Date.now() - start) / 1000);
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${minutes}m ${secs}s`;
  };

  return (
    <div className={cn('flex flex-col gap-4', className)}>
      {/* ── Header ── */}
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold flex items-center gap-1.5">
          <Gauge className="h-4 w-4 text-primary" />
          Context
        </h2>
        <span className="text-[10px] text-muted-foreground tabular-nums">
          {formatDuration(startTime)}
        </span>
      </div>

      {/* ── Context Fill Visualization ── */}
      <div className="rounded-lg border bg-card p-3 space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
            Window Usage
          </span>
          <span className="text-[10px] text-muted-foreground tabular-nums">
            {fmtTok(lastInputTokens)} / {fmtTok(maxContext)} tokens
          </span>
        </div>

        {/* Unicode-style bar (matches TUI precision) */}
        <ContextBar
          pct={ctxPct}
          tokens={lastInputTokens}
          maxTokens={maxContext}
          segments={12}
          showTokens={false}
        />

        {/* CSS horizontal bar */}
        <div className="flex items-center gap-2">
          <span className="flex-1 h-2 overflow-hidden rounded-full bg-muted">
            <span
              className={cn(
                'h-full rounded-full transition-all duration-500',
                ctxPct >= 75
                  ? 'bg-destructive'
                  : ctxPct >= 60
                    ? 'bg-[hsl(var(--warning))]'
                    : 'bg-[hsl(var(--success))]',
              )}
              style={{ width: `${Math.max(2, ctxPct)}%` }}
            />
          </span>
          <span
            className={cn(
              'text-xs font-mono tabular-nums font-medium',
              ctxPct >= 75
                ? 'text-destructive'
                : ctxPct >= 60
                  ? 'text-[hsl(var(--warning))]'
                  : 'text-[hsl(var(--success))]',
            )}
          >
            {ctxPct}%
          </span>
        </div>

        {/* Threshold markers */}
        {modes.length > 0 && (
          <div className="relative h-1 mt-1">
            {(() => {
              const active = modes.find((m) => m.id === contextMode) ?? modes[0];
              const t = active?.thresholds;
              if (!t) return null;
              const markers = [
                { pct: Math.round((t.warn ?? 0.6) * 100), color: 'bg-[hsl(var(--warning))]', label: 'warn' },
                { pct: Math.round(t.soft * 100), color: 'bg-destructive', label: 'soft' },
                { pct: Math.round(t.hard * 100), color: 'bg-destructive/60', label: 'hard' },
              ];
              return markers.map((m) => (
                <span
                  key={m.label}
                  className="absolute top-0 -translate-x-1/2 flex flex-col items-center"
                  style={{ left: `${Math.min(100, m.pct)}%` }}
                  title={`${m.label}: ${m.pct}%`}
                >
                  <span className={cn('w-0.5 h-2', m.color)} />
                  <span className="text-[8px] text-muted-foreground/60 mt-0.5">{m.pct}%</span>
                </span>
              ));
            })()}
          </div>
        )}
      </div>

      {/* ── Session Stats ── */}
      <div className="rounded-lg border bg-card p-3">
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
          Session Stats
        </span>
        <div className="grid grid-cols-2 gap-2 mt-2">
          <div className="rounded bg-muted/30 px-2 py-1.5">
            <span className="text-[9px] text-muted-foreground">Input Tokens</span>
            <span className="block text-xs font-mono font-medium">{fmtTok(totalTokens.input)}</span>
          </div>
          <div className="rounded bg-muted/30 px-2 py-1.5">
            <span className="text-[9px] text-muted-foreground">Output Tokens</span>
            <span className="block text-xs font-mono font-medium">{fmtTok(totalTokens.output)}</span>
          </div>
          <div className="rounded bg-muted/30 px-2 py-1.5">
            <span className="text-[9px] text-muted-foreground">Cache Read</span>
            <span className="block text-xs font-mono font-medium">
              {fmtTok(totalTokens.cacheRead ?? 0)}
            </span>
          </div>
          <div className="rounded bg-muted/30 px-2 py-1.5">
            <span className="text-[9px] text-muted-foreground">Cost</span>
            <span className="block text-xs font-mono font-medium text-[hsl(var(--success))]">
              ${cost.toFixed(4)}
            </span>
          </div>
        </div>
      </div>

      {/* ── Context Mode Switcher ── */}
      <div className="rounded-lg border bg-card p-3">
        <div className="flex items-center justify-between mb-2">
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
            Context Policy
          </span>
          <div ref={modesRef} className="relative">
            <button
              type="button"
              onClick={() => setModesOpen((v) => !v)}
              className="flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium bg-primary/10 text-primary hover:bg-primary/20 transition-colors"
            >
              <Cpu className="h-3 w-3" />
              {contextMode || 'balanced'}
              <ChevronDown className="h-3 w-3" />
            </button>
            {modesOpen && (
              <div className="absolute right-0 top-full mt-1 w-72 rounded-md border bg-popover shadow-lg z-30 py-1">
                <div className="px-3 py-1.5 text-[10px] uppercase tracking-wider text-muted-foreground border-b">
                  Select Policy
                </div>
                {modes.map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    onClick={() => {
                      switchContextMode(m.id);
                      setModesOpen(false);
                    }}
                    className={cn(
                      'w-full text-left px-3 py-2 hover:bg-accent/40 flex items-start gap-2',
                      m.id === contextMode && 'bg-accent/30',
                    )}
                  >
                    <Check
                      className={cn(
                        'h-3.5 w-3.5 mt-0.5 shrink-0',
                        m.id === contextMode ? 'opacity-100 text-primary' : 'opacity-0',
                      )}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-xs font-mono font-medium">{m.id}</span>
                        {'thresholds' in m && (m as ContextMode).thresholds && (
                          <span className="text-[10px] text-muted-foreground tabular-nums">
                            {Math.round((m as ContextMode).thresholds.warn * 100)}/
                            {Math.round((m as ContextMode).thresholds.soft * 100)}/
                            {Math.round((m as ContextMode).thresholds.hard * 100)}%
                          </span>
                        )}
                      </div>
                      <div className="text-[11px] text-muted-foreground leading-snug">
                        {m.description}
                      </div>
                      {'preserveK' in m && 'eliseThreshold' in m && (
                        <div className="mt-1 text-[10px] text-muted-foreground/80">
                          keep {(m as ContextMode).preserveK} recent · elide {(m as ContextMode).eliseThreshold}+ tokens
                        </div>
                      )}
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Active mode description */}
        <div className="text-[11px] text-muted-foreground leading-relaxed">
          {activeMode?.description ?? 'No description'}
        </div>
        {activeMode && 'thresholds' in activeMode && (activeMode as ContextMode).thresholds && (
          <div className="mt-1.5 flex gap-3 text-[10px]">
            <span className="text-[hsl(var(--warning))]">
              warn: {Math.round((activeMode as ContextMode).thresholds.warn * 100)}%
            </span>
            <span className="text-destructive/80">
              soft: {Math.round((activeMode as ContextMode).thresholds.soft * 100)}%
            </span>
            <span className="text-destructive/60">
              hard: {Math.round((activeMode as ContextMode).thresholds.hard * 100)}%
            </span>
            {'preserveK' in activeMode && (
              <span className="text-muted-foreground">
                keep {(activeMode as ContextMode).preserveK} recent
              </span>
            )}
          </div>
        )}
      </div>

      {/* ── Operations ── */}
      <div className="rounded-lg border bg-card p-3">
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
          Operations
        </span>
        <div className="mt-2 space-y-1.5">
          <button
            type="button"
            onClick={handleClear}
            className="w-full flex items-center gap-2 px-3 py-2 rounded-md text-xs hover:bg-accent transition-colors group"
            title="Clear the current conversation context"
          >
            <Eraser className="h-3.5 w-3.5 text-muted-foreground group-hover:text-destructive transition-colors" />
            <span className="flex-1 text-left">Clear Context</span>
            <span className="text-[10px] text-muted-foreground font-mono">Ctrl+L</span>
          </button>

          <button
            type="button"
            onClick={handleCompact}
            disabled={compactLoading}
            className="w-full flex items-center gap-2 px-3 py-2 rounded-md text-xs hover:bg-accent transition-colors group disabled:opacity-50"
            title="Compact the context window to save tokens"
          >
            {compactLoading ? (
              <RefreshCw className="h-3.5 w-3.5 text-muted-foreground animate-spin" />
            ) : (
              <Shrink className="h-3.5 w-3.5 text-muted-foreground group-hover:text-primary transition-colors" />
            )}
            <span className="flex-1 text-left">Compact Context</span>
            <span className="text-[10px] text-muted-foreground font-mono">/compact</span>
          </button>

          <button
            type="button"
            onClick={handleCompactAggressive}
            disabled={compactLoading}
            className="w-full flex items-center gap-2 px-3 py-2 rounded-md text-xs hover:bg-accent transition-colors group disabled:opacity-50"
            title="Aggressively compact the context window"
          >
            <Activity className="h-3.5 w-3.5 text-muted-foreground group-hover:text-[hsl(var(--warning))] transition-colors" />
            <span className="flex-1 text-left">Aggressive Compact</span>
          </button>

          <button
            type="button"
            onClick={handleRepair}
            disabled={repairLoading}
            className="w-full flex items-center gap-2 px-3 py-2 rounded-md text-xs hover:bg-accent transition-colors group disabled:opacity-50"
            title="Repair orphan tool_use/tool_result pairs"
          >
            {repairLoading ? (
              <RefreshCw className="h-3.5 w-3.5 text-muted-foreground animate-spin" />
            ) : (
              <Wrench className="h-3.5 w-3.5 text-muted-foreground group-hover:text-primary transition-colors" />
            )}
            <span className="flex-1 text-left">Repair Context</span>
          </button>

          <button
            type="button"
            onClick={handleDebug}
            disabled={debugLoading}
            className="w-full flex items-center gap-2 px-3 py-2 rounded-md text-xs hover:bg-accent transition-colors group disabled:opacity-50"
            title="Show context breakdown for debugging"
          >
            {debugLoading ? (
              <RefreshCw className="h-3.5 w-3.5 text-muted-foreground animate-spin" />
            ) : (
              <AlertTriangle className="h-3.5 w-3.5 text-muted-foreground group-hover:text-[hsl(var(--warning))] transition-colors" />
            )}
            <span className="flex-1 text-left">Debug Context</span>
          </button>
        </div>

        {/* Compact result */}
        {compactResult && (
          <div className="mt-2 rounded-md bg-emerald-500/10 border border-emerald-500/20 p-2 text-xs">
            <span className="font-medium text-emerald-600 dark:text-emerald-400">
              Compacted: {fmtTok(compactResult.before)} → {fmtTok(compactResult.after)}
            </span>
            <span className="text-muted-foreground ml-2">
              saved {fmtTok(compactResult.saved)} tokens
            </span>
          </div>
        )}
      </div>

      {/* ── Debug Overlay ── */}
      {debugOpen && (
        <div className="fixed inset-0 z-50 flex items-start justify-center pt-[10vh] bg-black/40 backdrop-blur-sm">
          <div className="w-full max-w-2xl max-h-[80vh] overflow-y-auto rounded-xl border bg-card shadow-2xl">
            <div className="flex items-center justify-between px-4 py-3 border-b">
              <h3 className="text-sm font-semibold flex items-center gap-2">
                <AlertTriangle className="h-4 w-4 text-[hsl(var(--warning))]" />
                Context Debug
              </h3>
              <button
                type="button"
                onClick={() => setDebugOpen(false)}
                className="p-1 rounded-md hover:bg-muted transition-colors"
              >
                ✕
              </button>
            </div>
            <div className="p-4">
              {debugLoading ? (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <RefreshCw className="h-4 w-4 animate-spin" />
                  Loading context debug…
                </div>
              ) : debugData ? (
                <div className="space-y-4">
                  <div className="grid grid-cols-3 gap-2">
                    <div className="rounded bg-muted/30 px-3 py-2">
                      <span className="text-[10px] text-muted-foreground">Total Tokens</span>
                      <span className="block text-sm font-mono font-medium">{debugData.total}</span>
                    </div>
                    <div className="rounded bg-muted/30 px-3 py-2">
                      <span className="text-[10px] text-muted-foreground">System Prompt</span>
                      <span className="block text-sm font-mono font-medium">{debugData.systemPrompt}</span>
                    </div>
                    <div className="rounded bg-muted/30 px-3 py-2">
                      <span className="text-[10px] text-muted-foreground">Tools</span>
                      <span className="block text-sm font-mono font-medium">
                        {debugData.tools.total} ({debugData.tools.count} tools)
                      </span>
                    </div>
                  </div>
                  <div>
                    <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
                      Tool Breakdown
                    </span>
                    <div className="mt-1 space-y-1">
                      {debugData.tools.breakdown.map((t) => (
                        <div key={t.name} className="flex items-center justify-between text-xs">
                          <span className="font-mono">{t.name}</span>
                          <span className="tabular-nums text-muted-foreground">{t.tokens} tok</span>
                        </div>
                      ))}
                    </div>
                  </div>
                  <div>
                    <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
                      Messages ({debugData.messages.count}) — {debugData.messages.total} tok
                    </span>
                    <div className="mt-1 space-y-1">
                      {debugData.messages.breakdown.slice(0, 15).map((m) => (
                        <div key={m.index} className="flex items-center gap-2 text-xs">
                          <span className="text-muted-foreground font-mono w-6">{m.index}</span>
                          <span className="text-muted-foreground font-mono w-12">{m.role}</span>
                          <span className="tabular-nums text-muted-foreground w-12">{m.tokens}t</span>
                          <span className="text-muted-foreground/80 truncate">
                            {m.preview.slice(0, 60)}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">
                  No debug data received yet. Click Debug Context again.
                </p>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
