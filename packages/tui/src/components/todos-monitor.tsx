import type { TodoItem } from '@wrongstack/core';
import { Box, Text, useStdout } from '../ink.js';
import type React from 'react';

/**
 * Full-screen Todos monitor overlay (F6 to open, F6 to close).
 * Surfaces the live agent.ctx.todos board — compact status-bar chips
 * aren't enough when the board has 10+ items. Mirrors the bordered-
 * panel look of the fleet/agents/worktree monitors so it sits naturally
 * in the bottom region.
 */
export function TodosMonitor({ todos }: { todos: TodoItem[] }): React.ReactElement {
  const { stdout } = useStdout();

  const done = todos.filter((t) => t.status === 'completed').length;
  const inProgress = todos.filter((t) => t.status === 'in_progress').length;
  const pending = todos.filter((t) => t.status === 'pending').length;

  // Pick a layout strategy based on available width.
  // Below 100 cols: single column; 100+ cols: two-column.
  const w = stdout?.columns ?? 80;
  const twoCols = w >= 100;
  const mid = Math.ceil(todos.length / 2);

  // Width for each column in two-column mode (account for gap + border padding).
  const colWidth = twoCols ? Math.floor((w - 8) / 2) : w - 6;

  /** Truncate `text` to fit within `maxLen` cols, appending "…" if cut. */
  const trunc = (text: string, maxLen: number): string => {
    if (text.length <= maxLen) return text;
    return text.slice(0, maxLen - 1) + '\u2026';
  };

  /** Render a single todo row with marker + label. */
  const renderRow = (t: TodoItem, idx: number): React.ReactElement => {
    const num = String(idx + 1).padStart(2);
    const label = t.status === 'in_progress' && t.activeForm ? t.activeForm : t.content;
    const display = trunc(label, colWidth - 8); // 8 chars: " NN. [X] "

    if (t.status === 'completed') {
      return (
        <Text key={t.id} dimColor>
          {'  '}
          <Text dimColor>{num}.</Text> <Text color="green">[x]</Text> {display}
        </Text>
      );
    }
    if (t.status === 'in_progress') {
      return (
        <Text key={t.id}>
          {'  '}
          <Text dimColor>{num}.</Text>{' '}
          <Text color="yellow" bold>
            [~]
          </Text>{' '}
          <Text color="yellow">{display}</Text>
        </Text>
      );
    }
    // pending
    return (
      <Text key={t.id}>
        {'  '}
        <Text dimColor>{num}.</Text> <Text dimColor>[ ]</Text> {display}
      </Text>
    );
  };

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
      {/* Header */}
      <Box flexDirection="row" gap={1} marginBottom={1}>
        <Text bold color="yellow">
          TODOS
        </Text>
        <Text dimColor>│</Text>
        <Text dimColor>
          {done}/{todos.length} done
        </Text>
        {inProgress > 0 ? (
          <>
            <Text dimColor>·</Text>
            <Text color="yellow">⌛{inProgress}</Text>
          </>
        ) : null}
        {pending > 0 ? (
          <>
            <Text dimColor>·</Text>
            <Text dimColor>☐{pending}</Text>
          </>
        ) : null}
        {done > 0 ? (
          <>
            <Text dimColor>·</Text>
            <Text color="green">✓{done}</Text>
          </>
        ) : null}
        <Text dimColor>│ F6 to close</Text>
      </Box>

      {todos.length === 0 ? (
        <Box marginY={1}>
          <Text dimColor>No todos. The agent will create them as it plans work.</Text>
        </Box>
      ) : twoCols ? (
        /* Two-column layout: split the list in half, render side-by-side.
           Pass the absolute position so numbering is continuous across columns. */
        <Box flexDirection="row" gap={2}>
          <Box flexDirection="column" width={colWidth}>
            {todos.slice(0, mid).map((t, i) => renderRow(t, i))}
          </Box>
          <Box flexDirection="column" width={colWidth}>
            {todos.slice(mid).map((t, i) => renderRow(t, mid + i))}
          </Box>
        </Box>
      ) : (
        /* Single column layout */
        <Box flexDirection="column">{todos.map(renderRow)}</Box>
      )}
    </Box>
  );
}
