/**
 * SideEffectTimeline — audit trail of non-filesystem side effects
 * (bash commands, package installs, network requests) produced during
 * the current session.
 *
 * P2 #5 Phase 4 (WebUI): reads from the side-effect store and renders
 * a scrollable table. Refreshes by sending `side_effects.list` to the
 * server via the WS client.
 */

import { useEffect } from 'react';
import { Activity, RefreshCw, Terminal, Package, Globe } from 'lucide-react';
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

export function SideEffectTimeline() {
  const sideEffects = useSideEffectStore((s) => s.sideEffects);
  const loading = useSideEffectStore((s) => s.loading);

  useEffect(() => {
    // Request the initial side-effect list on mount.
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

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-zinc-800 px-3 py-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-400">
          Side Effects ({sideEffects.length})
        </h3>
        <button
          onClick={refresh}
          className="flex items-center gap-1 rounded px-2 py-1 text-xs text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300"
        >
          <RefreshCw className={cn('h-3 w-3', loading && 'animate-spin')} />
          Refresh
        </button>
      </div>
      <div className="flex-1 overflow-y-auto">
        <table className="w-full text-xs">
          <thead className="sticky top-0 bg-zinc-900 text-zinc-500">
            <tr>
              <th className="px-2 py-1 text-left font-medium">Time</th>
              <th className="px-2 py-1 text-left font-medium">Tool</th>
              <th className="px-2 py-1 text-left font-medium">Risk</th>
              <th className="px-2 py-1 text-left font-medium">Detail</th>
              <th className="px-2 py-1 text-left font-medium">Outcome</th>
            </tr>
          </thead>
          <tbody>
            {sideEffects.map((se, i) => {
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
