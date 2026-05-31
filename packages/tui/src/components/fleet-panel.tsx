import { Box, Text } from 'ink';
import type React from 'react';
import type { FleetEntry } from '../app.js';

export interface FleetPanelProps {
  /** Per-subagent state, keyed by subagentId. */
  entries: Record<string, FleetEntry>;
  /** Fleet-wide accumulated cost (from FleetUsageAggregator). */
  totalCost: number;
  /** Optional roster for resolving role ids to display names. */
  roster?: Record<string, { name: string }>;
}

/**
 * Compact fleet summary rendered below the status bar when director mode is
 * active. Max 4 lines: fleet summary + up to 3 running agents with only
 * name and current tool. Idle/finished agents are excluded.
 */
export function FleetPanel({ entries, totalCost, roster }: FleetPanelProps): React.ReactElement | null {
  const list = Object.values(entries);
  if (list.length === 0) return null;

  // Only running agents - idle and finished agents are not shown
  const running = list.filter((e) => e.status === 'running');
  const runningCount = running.length;

  // Fleet summary line
  const costLabel = totalCost > 0 ? ` · $${totalCost.toFixed(3)}` : '';
  const summaryLine =
    runningCount > 0
      ? `${runningCount} running${costLabel}`
      : `idle${costLabel}`;

  // Show up to 3 running agents
  const shown = running.slice(0, 3);
  const overflow = running.length > 3 ? running.length - 3 : 0;

  return (
    <Box flexDirection="column" paddingX={1}>
      {/* Fleet summary */}
      <Box flexDirection="row" gap={1}>
        <Text dimColor>⚡ Fleet</Text>
        <Text dimColor>│</Text>
        <Text>{summaryLine}</Text>
      </Box>

      {/* Running agents: name + current tool only */}
      {shown.map((entry) => {
        // entry.name is the subagent's display name (nickname when assigned,
        // e.g. "Einstein (Bug Hunter)") — prefer it over the raw id.
        const name = entry.name && entry.name !== entry.id ? entry.name : entry.id.slice(0, 8);
        const tool = entry.currentTool?.name ?? '—';
        return (
          <Box key={entry.id} flexDirection="row" gap={1}>
            <Text color="green">●</Text>
            <Text>{name.slice(0, 14).padEnd(14)}</Text>
            <Text dimColor>→</Text>
            <Text color="cyan">{tool}</Text>
          </Box>
        );
      })}

      {/* Overflow indicator */}
      {overflow > 0 ? (
        <Text dimColor>  +{overflow} more running</Text>
      ) : null}
    </Box>
  );
}
