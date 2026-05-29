import { Box, Text, useInput } from 'ink';
import type React from 'react';
import type { WorktreeRow } from './worktree-panel.js';

const fmtElapsed = (ms: number): string => {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}:${String(m % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  if (m > 0) return `${m}:${String(s % 60).padStart(2, '0')}`;
  return `${s}s`;
};

const WT_STATUS: Record<string, { icon: string; color: string; label: string }> = {
  allocating:    { icon: '○', color: 'gray',    label: 'allocating' },
  active:        { icon: '●', color: 'yellow',  label: 'active' },
  committing:    { icon: '◐', color: 'cyan',    label: 'committing' },
  merging:       { icon: '⇡', color: 'blue',    label: 'merging' },
  merged:        { icon: '✓', color: 'green',   label: 'merged' },
  'needs-review':{ icon: '⚠', color: 'magenta', label: 'needs-review' },
  failed:        { icon: '✗', color: 'red',     label: 'failed' },
};

function fmt(s: string) {
  return WT_STATUS[s] ?? { icon: '?', color: 'white', label: s };
}

/**
 * Full-screen Worktree monitor overlay (Ctrl+W in TUI). Shows each AutoPhase
 * worktree: branch, base→branch, owner phase, diff stats, and conflict files
 * for any worktree left in needs-review.
 */
export function WorktreeMonitor({
  worktrees,
  baseBranch,
  nowTick,
  onClose,
}: {
  worktrees: Record<string, WorktreeRow & { baseBranch?: string }>;
  baseBranch?: string;
  nowTick: number;
  onClose: () => void;
}): React.ReactElement {
  useInput((_, key) => {
    if (key.escape) onClose();
  });

  const list = Object.values(worktrees);
  const active = list.filter((w) => ['active', 'committing', 'merging'].includes(w.status)).length;
  const merged = list.filter((w) => w.status === 'merged').length;
  const failed = list.filter((w) => w.status === 'failed' || w.status === 'needs-review').length;

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="green" paddingX={1}>
      <Box flexDirection="row" gap={1} marginBottom={1}>
        <Text bold color="green">WORKTREE MONITOR</Text>
        <Text dimColor>│</Text>
        {baseBranch ? <Text dimColor>base {baseBranch}</Text> : null}
        <Text dimColor>│</Text>
        <Text color="yellow">▶{active}</Text>
        <Text dimColor>·</Text>
        <Text color="green">✓{merged}</Text>
        {failed > 0 ? (
          <>
            <Text dimColor>·</Text>
            <Text color="red">✗{failed}</Text>
          </>
        ) : null}
        <Text dimColor>│ Ctrl+W / Esc to close</Text>
      </Box>

      {list.length === 0 ? (
        <Text dimColor>No worktrees. They appear when AutoPhase runs with isolation on.</Text>
      ) : (
        list.map((w) => {
          const s = fmt(w.status);
          const short = w.branch.replace(/^wstack\/ap\//, '');
          const elapsed = w.allocatedAt ? fmtElapsed(nowTick - w.allocatedAt) : '—';
          return (
            <Box key={w.branch} flexDirection="column" marginTop={1}>
              <Box flexDirection="row" gap={1}>
                <Text color={s.color} bold>{s.icon}</Text>
                <Text bold>{short}</Text>
                <Text dimColor>·</Text>
                <Text color={s.color}>{s.label}</Text>
                <Text dimColor>· elapsed {elapsed}</Text>
              </Box>
              <Box flexDirection="row" gap={1} marginLeft={2}>
                <Text dimColor>{w.baseBranch ?? baseBranch ?? 'base'} → {short}</Text>
                <Text dimColor>· owner: {w.ownerLabel}</Text>
              </Box>
              <Box flexDirection="row" gap={1} marginLeft={2}>
                <Text color="green">+{w.insertions}</Text>
                <Text color="red">-{w.deletions}</Text>
                <Text dimColor>· {w.files} files</Text>
              </Box>
              {w.conflictFiles && w.conflictFiles.length > 0 ? (
                <Box marginLeft={2}>
                  <Text color="magenta">conflicts: {w.conflictFiles.join(', ')}</Text>
                </Box>
              ) : null}
            </Box>
          );
        })
      )}

      <Box marginTop={1}>
        <Text dimColor>Esc close · merge conflicts with /worktree merge &lt;branch&gt;</Text>
      </Box>
    </Box>
  );
}
