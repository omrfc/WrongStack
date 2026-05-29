import type { WorktreeHandleView } from '@/types';

const LANE_COLORS = ['#3b82f6', '#06b6d4', '#22c55e', '#eab308', '#f97316', '#a855f7', '#ec4899'];

const shortBranch = (b: string) => b.replace(/^wstack\/ap\//, '');

interface GraphNode {
  handle: WorktreeHandleView;
  color: string;
  y: number;
}

/**
 * Derive a simple trunk+branches graph from the flat snapshot: the base branch
 * is the trunk; each worktree is a branch off it. Pure — no extra backend data.
 */
export function deriveWorktreeGraph(worktrees: WorktreeHandleView[]): GraphNode[] {
  return [...worktrees]
    .sort((a, b) => a.allocatedAt - b.allocatedAt)
    .map((handle, i) => ({ handle, color: LANE_COLORS[i % LANE_COLORS.length], y: 60 + i * 48 }));
}

const EDGE_STATE: Record<string, { dash: string; opacity: number }> = {
  allocating: { dash: '4 4', opacity: 0.4 },
  active: { dash: '4 4', opacity: 0.6 },
  committing: { dash: '4 4', opacity: 0.8 },
  merging: { dash: '0', opacity: 0.9 },
  merged: { dash: '0', opacity: 1 },
  'needs-review': { dash: '2 3', opacity: 0.9 },
  failed: { dash: '2 3', opacity: 0.6 },
};

/**
 * WorktreeGraph — live DAG: the base trunk with one branch per worktree
 * forking off and (when merged) folding back in. SVG + Tailwind transitions.
 */
export function WorktreeGraph({
  worktrees,
  baseBranch,
}: {
  worktrees: WorktreeHandleView[];
  baseBranch: string;
}): React.ReactElement {
  const nodes = deriveWorktreeGraph(worktrees);
  const height = Math.max(120, 60 + nodes.length * 48 + 20);
  const trunkX = 40;
  const branchX = 220;

  return (
    <div className="overflow-x-auto rounded-lg border border-[--color-border-dark] bg-[--color-card-dark]/40 p-3">
      <svg width="100%" height={height} viewBox={`0 0 600 ${height}`} className="min-w-[420px]">
        {/* trunk */}
        <line x1={trunkX} y1={20} x2={trunkX} y2={height - 10} stroke="#F93951" strokeWidth={3} />
        <text x={trunkX - 4} y={14} fontSize={11} fill="#9ca3af">{baseBranch || 'HEAD'}</text>
        <circle cx={trunkX} cy={20} r={5} fill="#F93951" />

        {nodes.map((n) => {
          const e = EDGE_STATE[n.handle.status] ?? EDGE_STATE.active!;
          const merged = n.handle.status === 'merged';
          const conflict = n.handle.status === 'needs-review' || n.handle.status === 'failed';
          return (
            <g key={n.handle.handleId} className="transition-all duration-500">
              {/* fork out from trunk */}
              <path
                d={`M ${trunkX} ${n.y - 24} C ${trunkX + 60} ${n.y - 24}, ${branchX - 60} ${n.y}, ${branchX} ${n.y}`}
                fill="none"
                stroke={n.color}
                strokeWidth={2}
                strokeDasharray={e.dash}
                opacity={e.opacity}
              />
              {/* merge back into trunk (only when merged) */}
              {merged ? (
                <path
                  d={`M ${branchX} ${n.y} C ${branchX - 60} ${n.y + 20}, ${trunkX + 60} ${n.y + 24}, ${trunkX} ${n.y + 24}`}
                  fill="none"
                  stroke="#34d399"
                  strokeWidth={2}
                  opacity={0.9}
                />
              ) : null}
              <circle cx={branchX} cy={n.y} r={5} fill={conflict ? '#e879f9' : n.color} />
              <text x={branchX + 12} y={n.y - 6} fontSize={12} fill="#e5e7eb" fontFamily="monospace">
                {shortBranch(n.handle.branch)}
              </text>
              <text x={branchX + 12} y={n.y + 10} fontSize={10} fill="#9ca3af">
                {conflict
                  ? `⚠ ${n.handle.status}`
                  : merged
                    ? `✓ merged → ${baseBranch}`
                    : `+${n.handle.insertions}/-${n.handle.deletions} · ${n.handle.ownerLabel}`}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
