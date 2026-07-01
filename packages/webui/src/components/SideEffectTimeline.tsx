/**
 * SideEffectTimeline — audit trail of non-filesystem side effects
 * (bash commands, package installs, network requests) produced during
 * the current session.
 *
 * P2 #5 Phase 4 (WebUI): reads from the side-effect store and renders
 * a scrollable table with risk-level filter and sortable columns.
 * Auto-refreshes via the server's event-driven side_effects push.
 */

import { useEffect, useMemo, useState } from 'react';
import { Activity, RefreshCw, Terminal, Package, Globe, ChevronUp, ChevronDown, Download } from 'lucide-react';
import { useSideEffectStore } from '@/stores';
import type { SideEffectEntry } from '@/stores';
import { cn } from '@/lib/utils';

const RISK_ICONS: Record<string, typeof Terminal> = {
  shell: Terminal,
  package: Package,
  network: Globe,
  'fs.write': Activity,
  config: Activity,
};

const RISK_COLORS: Record<string, string> = {
  shell: 'text-orange-400',
  package: 'text-blue-400',
  network: 'text-green-400',
  'fs.write': 'text-purple-400',
  config: 'text-yellow-400',
};

const RISK_FILTERS = ['all', 'shell', 'package', 'network', 'fs.write', 'config'] as const;
type RiskFilter = (typeof RISK_FILTERS)[number];

type SortKey = 'time' | 'tool' | 'risk';
type SortDir = 'asc' | 'desc';

function formatTime(ts: string): string {
  try {
    const d = new Date(ts);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch {
    return ts.slice(11, 19);
  }
}

function formatInput(se: SideEffectEntry): string {
  if (se.input['command']) return String(se.input['command']).slice(0, 80);
  if (se.input['url']) return String(se.input['url']).slice(0, 80);
  if (se.input['packages']) {
    const pkgs = se.input['packages'];
    return Array.isArray(pkgs) ? pkgs.join(', ').slice(0, 80) : String(pkgs).slice(0, 80);
  }
  return JSON.stringify(se.input).slice(0, 80);
}

/** Escape a value for CSV — wraps in quotes if it contains commas, quotes, or newlines. */
function csvEscape(value: string): string {
  if (/[",\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/** Build a CSV string from side effects and trigger a browser download. */
function exportCSV(entries: SideEffectEntry[]): void {
  const header = 'timestamp,tool,risk,detail,outcome';
  const rows = entries.map((se) => {
    const detail = se.input['command'] ?? se.input['url'] ?? se.input['packages'] ?? JSON.stringify(se.input);
    return [
      csvEscape(se.ts),
      csvEscape(se.toolName),
      csvEscape(se.risk),
      csvEscape(String(detail)),
      csvEscape(se.outcome ?? ''),
    ].join(',');
  });
  const csv = [header, ...rows].join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `side-effects-${new Date().toISOString().slice(0, 19).replace(/[:.]/g, '-')}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

export function SideEffectTimeline() {
  const sideEffects = useSideEffectStore((s) => s.sideEffects);
  const loading = useSideEffectStore((s) => s.loading);

  const [riskFilter, setRiskFilter] = useState<RiskFilter>('all');
  const [sortKey, setSortKey] = useState<SortKey>('time');
  const [sortDir, setSortDir] = useState<SortDir>('desc');

  useEffect(() => {
    useSideEffectStore.getState().setLoading(true);
    import('@/lib/ws-client').then(({ getWSClient }) => {
      getWSClient().send({ type: 'side_effects.list' } as never);
    });
  }, []);

  const refresh = () => {
    useSideEffectStore.getState().setLoading(true);
    import('@/lib/ws-client').then(({ getWSClient }) => {
      getWSClient().send({ type: 'side_effects.list' } as never);
    });
  };

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir(sortDir === 'asc' ? 'desc' : 'asc');
    } else {
      setSortKey(key);
      setSortDir(key === 'time' ? 'desc' : 'asc');
    }
  };

  const filtered = useMemo(() => {
    const result = riskFilter === 'all'
      ? [...sideEffects]
      : sideEffects.filter((se) => se.risk === riskFilter);

    result.sort((a, b) => {
      let cmp = 0;
      if (sortKey === 'time') cmp = a.ts.localeCompare(b.ts);
      else if (sortKey === 'tool') cmp = a.toolName.localeCompare(b.toolName);
      else if (sortKey === 'risk') cmp = a.risk.localeCompare(b.risk);
      return sortDir === 'asc' ? cmp : -cmp;
    });

    return result;
  }, [sideEffects, riskFilter, sortKey, sortDir]);

  if (sideEffects.length === 0 && !loading) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 py-8 text-zinc-500">
        <Activity className="h-8 w-8 opacity-40" />
        <p className="text-sm">No side effects recorded yet.</p>
        <p className="text-xs text-zinc-600">
          Bash commands, package installs, and network requests will appear here.
        </p>
      </div>
    );
  }

  const SortIcon = ({ column }: { column: SortKey }) => {
    if (sortKey !== column) return <span className="opacity-30">↕</span>;
    return sortDir === 'asc' ? <ChevronUp className="inline h-3 w-3" /> : <ChevronDown className="inline h-3 w-3" />;
  };

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      {/* Header: title + refresh */}
      <div className="flex items-center justify-between border-b border-zinc-800 px-3 py-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-400">
          Side Effects ({filtered.length}{riskFilter !== 'all' ? `/${sideEffects.length}` : ''})
        </h3>
        <div className="flex items-center gap-1">
          <button
            onClick={() => exportCSV(filtered)}
            disabled={filtered.length === 0}
            className="flex items-center gap-1 rounded px-2 py-1 text-xs text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300 disabled:opacity-30 disabled:cursor-not-allowed"
            title="Export filtered side effects as CSV"
          >
            <Download className="h-3 w-3" />
            CSV
          </button>
          <button
            onClick={refresh}
            className="flex items-center gap-1 rounded px-2 py-1 text-xs text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300"
          >
            <RefreshCw className={cn('h-3 w-3', loading && 'animate-spin')} />
            Refresh
          </button>
        </div>
      </div>

      {/* Filter bar */}
      <div className="flex items-center gap-1 border-b border-zinc-800/50 px-2 py-1">
        {RISK_FILTERS.map((risk) => (
          <button
            key={risk}
            onClick={() => setRiskFilter(risk)}
            className={cn(
              'rounded px-2 py-0.5 text-[10px] font-medium uppercase transition-colors',
              riskFilter === risk
                ? 'bg-zinc-700 text-zinc-200'
                : 'text-zinc-500 hover:bg-zinc-800 hover:text-zinc-400',
            )}
          >
            {risk === 'all' ? 'All' : risk}
          </button>
        ))}
      </div>

      {/* Table */}
      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">
        <table className="w-full text-xs">
          <thead className="sticky top-0 bg-zinc-900 text-zinc-500">
            <tr>
              <th
                className="cursor-pointer select-none px-2 py-1 text-left font-medium hover:text-zinc-300"
                onClick={() => toggleSort('time')}
              >
                Time <SortIcon column="time" />
              </th>
              <th
                className="cursor-pointer select-none px-2 py-1 text-left font-medium hover:text-zinc-300"
                onClick={() => toggleSort('tool')}
              >
                Tool <SortIcon column="tool" />
              </th>
              <th
                className="cursor-pointer select-none px-2 py-1 text-left font-medium hover:text-zinc-300"
                onClick={() => toggleSort('risk')}
              >
                Risk <SortIcon column="risk" />
              </th>
              <th className="px-2 py-1 text-left font-medium">Detail</th>
              <th className="px-2 py-1 text-left font-medium">Outcome</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((se, i) => {
              const Icon = RISK_ICONS[se.risk] ?? Activity;
              const colorClass = RISK_COLORS[se.risk] ?? 'text-zinc-400';
              return (
                <tr
                  key={`${se.toolUseId}-${i}`}
                  className="border-b border-zinc-900 hover:bg-zinc-800/50"
                >
                  <td className="whitespace-nowrap px-2 py-1.5 text-zinc-500">
                    {formatTime(se.ts)}
                  </td>
                  <td className="whitespace-nowrap px-2 py-1.5 font-medium text-zinc-300">
                    {se.toolName}
                  </td>
                  <td className="whitespace-nowrap px-2 py-1.5">
                    <span className={cn('flex items-center gap-1', colorClass)}>
                      <Icon className="h-3 w-3" />
                      {se.risk}
                    </span>
                  </td>
                  <td className="max-w-xs truncate px-2 py-1.5 font-mono text-zinc-400">
                    {formatInput(se)}
                  </td>
                  <td className="whitespace-nowrap px-2 py-1.5 text-zinc-500">
                    {se.outcome ?? ''}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
