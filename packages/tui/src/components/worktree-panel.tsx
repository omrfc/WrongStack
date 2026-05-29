import { Box, Text } from 'ink';
import type React from 'react';

const fmtElapsed = (ms: number): string => {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}:${String(m % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  if (m > 0) return `${m}:${String(s % 60).padStart(2, '0')}`;
  return `${s}s`;
};

export interface WorktreeRow {
  branch: string;
  ownerLabel: string;
  status: string;
  insertions: number;
  deletions: number;
  files: number;
  allocatedAt: number;
  conflictFiles?: string[];
}

const STATUS: Record<string, { icon: string; color: string }> = {
  allocating:    { icon: '○', color: 'gray' },
  active:        { icon: '●', color: 'yellow' },
  committing:    { icon: '◐', color: 'cyan' },
  merging:       { icon: '⇡', color: 'blue' },
  merged:        { icon: '✓', color: 'green' },
  'needs-review':{ icon: '⚠', color: 'magenta' },
  failed:        { icon: '✗', color: 'red' },
};

function st(status: string) {
  return STATUS[status] ?? { icon: '?', color: 'white' };
}

/**
 * Worktree sidebar panel — shown beside the AutoPhase PhasePanel when git
 * worktree isolation is active. One compact row per worktree (branch, owner
 * phase, diff stats, status). Always visible while live; details on Ctrl+W.
 */
export function WorktreePanel({
  worktrees,
  nowTick,
}: {
  worktrees: Record<string, WorktreeRow>;
  nowTick: number;
}): React.ReactElement | null {
  const list = Object.values(worktrees);
  if (list.length === 0) return null;

  const active = list.filter((w) => w.status === 'active' || w.status === 'committing' || w.status === 'merging').length;
  const merged = list.filter((w) => w.status === 'merged').length;
  const failed = list.filter((w) => w.status === 'failed' || w.status === 'needs-review').length;

  return (
    <Box
      flexDirection="column"
      paddingX={1}
      borderStyle="single"
      borderTop={false}
      borderBottom={false}
      borderLeft={false}
      borderRight={false}
    >
      <Box flexDirection="row" gap={2}>
        <Text dimColor>Worktrees</Text>
        <Text dimColor>│</Text>
        <Text color="yellow">▶{active}</Text>
        <Text color="green">✓{merged}</Text>
        {failed > 0 ? <Text color="red">✗{failed}</Text> : null}
        <Text dimColor>· {list.length} total · Ctrl+W for details</Text>
      </Box>

      {list.map((w) => {
        const s = st(w.status);
        const conflict = w.status === 'needs-review';
        const elapsed = w.allocatedAt ? fmtElapsed(nowTick - w.allocatedAt) : '';
        return (
          <Box key={w.branch} flexDirection="row" gap={1}>
            <Text color={s.color}>{s.icon}</Text>
            <Text>{w.branch.replace(/^wstack\/ap\//, '').slice(0, 18).padEnd(18)}</Text>
            <Text dimColor>{w.ownerLabel.slice(0, 12)}</Text>
            {conflict ? (
              <Text color="magenta"> CONFLICT</Text>
            ) : (
              <Text dimColor> +{w.insertions}/-{w.deletions} {w.files}f</Text>
            )}
            {elapsed && (w.status === 'active' || w.status === 'committing') ? (
              <Text dimColor> {elapsed}</Text>
            ) : null}
          </Box>
        );
      })}
    </Box>
  );
}
