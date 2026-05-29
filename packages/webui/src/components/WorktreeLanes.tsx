import type { WorktreeHandleView } from '@/types';

const STATUS_META: Record<string, { icon: string; label: string; tint: string; dot: string }> = {
  allocating:    { icon: '○', label: 'allocating', tint: 'border-zinc-600/40', dot: 'bg-zinc-400' },
  active:        { icon: '●', label: 'active',     tint: 'border-amber-500/40', dot: 'bg-amber-400 animate-pulse' },
  committing:    { icon: '◐', label: 'committing', tint: 'border-cyan-500/40', dot: 'bg-cyan-400 animate-pulse' },
  merging:       { icon: '⇡', label: 'merging',    tint: 'border-blue-500/40', dot: 'bg-blue-400 animate-pulse' },
  merged:        { icon: '✓', label: 'merged',     tint: 'border-emerald-500/40', dot: 'bg-emerald-400' },
  'needs-review':{ icon: '⚠', label: 'conflict',   tint: 'border-fuchsia-500/50', dot: 'bg-fuchsia-400' },
  failed:        { icon: '✗', label: 'failed',     tint: 'border-rose-500/50', dot: 'bg-rose-400' },
};

function meta(status: string) {
  return STATUS_META[status] ?? { icon: '?', label: status, tint: 'border-zinc-600/40', dot: 'bg-zinc-400' };
}

const shortBranch = (b: string) => b.replace(/^wstack\/ap\//, '');

/**
 * WorktreeLanes — one horizontal swim-lane per git worktree AutoPhase uses for
 * per-phase isolation. Shows status, branch, owner phase, live diff stats, and
 * a flowing recent-activity strip. Pure/props-driven; animations are Tailwind.
 */
export function WorktreeLanes({
  worktrees,
  baseBranch,
}: {
  worktrees: WorktreeHandleView[];
  baseBranch: string;
}): React.ReactElement | null {
  if (worktrees.length === 0) return null;
  const sorted = [...worktrees].sort((a, b) => a.allocatedAt - b.allocatedAt);

  return (
    <div className="border-t border-[--color-border-dark] bg-[--color-surface-dark]/40 px-4 py-3">
      <div className="mb-2 flex items-center gap-2 text-xs text-[--color-text-dark-secondary]">
        <span className="font-semibold tracking-wide">WORKTREES</span>
        <span className="opacity-60">· base</span>
        <code className="font-mono text-[--color-primary]">{baseBranch || 'HEAD'}</code>
        <span className="opacity-60">· {sorted.length} isolated</span>
      </div>

      <div className="flex flex-col gap-1.5">
        {sorted.map((w) => {
          const m = meta(w.status);
          const conflict = w.status === 'needs-review';
          const magnitude = Math.min(100, w.insertions + w.deletions);
          return (
            <div
              key={w.handleId}
              className={`group relative flex items-center gap-3 rounded-lg border ${m.tint} bg-[--color-card-dark]/60 px-3 py-2 transition-all duration-500`}
            >
              <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${m.dot}`} aria-hidden />
              <code className="w-44 shrink-0 truncate font-mono text-sm">{shortBranch(w.branch)}</code>
              <span className="shrink-0 rounded bg-[--color-surface-dark] px-2 py-0.5 text-xs text-[--color-text-dark-secondary]">
                ⟵ {w.ownerLabel}
              </span>

              {/* live diff-stat badge */}
              {conflict ? (
                <span className="font-mono text-xs font-bold text-fuchsia-400">CONFLICT</span>
              ) : (
                <span className="flex items-center gap-1 font-mono text-xs transition-all duration-500">
                  <span className="text-emerald-400">+{w.insertions}</span>
                  <span className="text-[--color-text-dark-secondary]">·</span>
                  <span className="text-rose-400">-{w.deletions}</span>
                  <span className="ml-1 text-[--color-text-dark-secondary]">{w.files}f</span>
                </span>
              )}

              {/* magnitude bar */}
              <div className="ml-auto hidden h-1 w-24 overflow-hidden rounded-full bg-[--color-surface-dark] sm:block">
                <div
                  className="h-full bg-gradient-to-r from-emerald-500 to-rose-500 transition-all duration-700"
                  style={{ width: `${magnitude}%` }}
                />
              </div>
              <span className="w-20 shrink-0 text-right text-xs text-[--color-text-dark-secondary]">{m.label}</span>

              {/* flowing recent activity (last item) */}
              {w.recentActivity.length > 0 ? (
                <span className="absolute -bottom-2 left-9 max-w-[60%] truncate rounded bg-[--color-surface-dark] px-1.5 text-[10px] text-[--color-text-dark-secondary] opacity-0 transition-opacity duration-300 group-hover:opacity-100">
                  {w.recentActivity[w.recentActivity.length - 1]?.kind}: {w.recentActivity[w.recentActivity.length - 1]?.text}
                </span>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
