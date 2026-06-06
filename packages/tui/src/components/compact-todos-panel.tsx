import type { TodoItem } from '@wrongstack/core';
import { Box, Text, useStdout } from 'ink';
import type React from 'react';

/**
 * Compact right-panel todo list. Designed for ~30% terminal width
 * (16-30 cols). Shows a minimal header + one-line-per-item with
 * status marker and auto-truncated label. No border — the parent
 * App wraps this in a bordered Box.
 *
 * Vertical overflow: limits visible items to the available terminal
 * rows, showing a "+N more" indicator when items are truncated.
 * In-progress items always float to the visible window so the user
 * never loses sight of the active task.
 *
 * Status legend: [~] in-progress (yellow), [x] done (green), [ ] pending (dim).
 */
export function CompactTodosPanel({ todos }: { todos: TodoItem[] }): React.ReactElement {
  const { stdout } = useStdout();
  const w = stdout?.columns ?? 80;
  const h = stdout?.rows ?? 24;

  // Estimate available width: parent box has border + padding (~4 chars).
  const avail = Math.max(10, Math.floor(w * 0.3) - 4);

  // Label chars after "  [ ] " prefix + some padding = 7 chars overhead
  const labelMax = Math.max(4, avail - 7);

  const trunc = (s: string): string => {
    if (s.length <= labelMax) return s;
    return s.slice(0, labelMax - 1) + '\u2026';
  };

  // ── Vertical space budget ──────────────────────────────────────
  // Panel typically spans full terminal height in managed mode.
  // Deduct: header (~3 rows) + border (~2) + padding (~2) = 7 overhead.
  const OVERHEAD = 7;
  const maxVisible = Math.max(4, h - OVERHEAD);

  // Sort: in_progress first, then pending, then completed.
  const sorted = [...todos].sort((a, b) => {
    const order = { in_progress: 0, pending: 1, completed: 2 } as const;
    return (order[a.status] ?? 1) - (order[b.status] ?? 1);
  });

  const visible = sorted.slice(0, maxVisible);
  const overflow = sorted.length - visible.length;

  // Counts
  const done = todos.filter((t) => t.status === 'completed').length;
  const inProgress = todos.filter((t) => t.status === 'in_progress').length;
  const pending = todos.length - done - inProgress;

  /** Render one todo row. */
  const renderRow = (t: TodoItem): React.ReactElement => {
    const label = t.status === 'in_progress' && t.activeForm ? t.activeForm : t.content;
    const display = trunc(label);

    if (t.status === 'completed') {
      return (
        <Box key={t.id} flexDirection="row" flexShrink={0}>
          <Text color="green">[x]</Text>
          <Text dimColor> {display}</Text>
        </Box>
      );
    }
    if (t.status === 'in_progress') {
      return (
        <Box key={t.id} flexDirection="row" flexShrink={0}>
          <Text color="yellow">[~]</Text>
          <Text color="yellow"> {display}</Text>
        </Box>
      );
    }
    return (
      <Box key={t.id} flexDirection="row" flexShrink={0}>
        <Text dimColor>[ ]</Text>
        <Text dimColor> {display}</Text>
      </Box>
    );
  };

  return (
    <Box flexDirection="column" flexGrow={1} paddingX={1}>
      {/* Compact header */}
      <Box flexDirection="column" marginBottom={1}>
        <Box flexDirection="row" gap={1}>
          <Text bold color="yellow">
            TODOS
          </Text>
          <Text dimColor>
            {done}/{todos.length}
          </Text>
          {overflow > 0 ? (
            <Text color="yellow">+{overflow}</Text>
          ) : null}
        </Box>
        <Box flexDirection="row" gap={1}>
          {inProgress > 0 ? <Text color="yellow">⌛{inProgress}</Text> : null}
          {pending > 0 ? <Text dimColor>☐{pending}</Text> : null}
          {done > 0 ? <Text color="green">✓{done}</Text> : null}
        </Box>
      </Box>

      {/* Item list */}
      {todos.length === 0 ? (
        <Text dimColor>No todos</Text>
      ) : (
        <Box flexDirection="column">
          {visible.map(renderRow)}
          {overflow > 0 ? (
            <Box flexDirection="row" flexShrink={0} marginTop={0}>
              <Text dimColor>…</Text>
              <Text dimColor> +{overflow} more</Text>
            </Box>
          ) : null}
        </Box>
      )}
    </Box>
  );
}
