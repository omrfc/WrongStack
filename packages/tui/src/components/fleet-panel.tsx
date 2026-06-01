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
  /** When set, the LEADER row is always shown (even when idle) with a collab session indicator. */
  collabSession?: { sessionId: string | null; bugCount: number; planCount: number; evalCount: number } | null;
}

/**
 * Compact fleet summary rendered below the status bar when director mode is
 * active. Max 4 lines: fleet summary + up to 3 running agents with only
 * name and current tool. Idle/finished agents are excluded unless a collab
 * session is active (LEADER always shows as "waiting" in that case).
 */
export function FleetPanel({ entries, totalCost, collabSession }: FleetPanelProps): React.ReactElement | null {
  const list = Object.values(entries);
  if (list.length === 0 && !collabSession) return null;

  // Always extract the leader entry separately — it gets special treatment.
  const leader = list.find((e) => e.id === 'leader');
  const subagents = list.filter((e) => e.id !== 'leader');

  // Only running agents — idle and finished agents are not shown.
  // But when a collab session is active, the leader is always shown with its
  // collab-specific status so the user can see the director is still alive.
  const running = subagents.filter((e) => e.status === 'running');
  const runningCount = running.length;
  const hasCollab = !!collabSession;

  // Fleet summary line
  const costLabel = totalCost > 0 ? ` · ${totalCost.toFixed(3)}` : '';
  const collabLabel = hasCollab && collabSession.sessionId
    ? ` · collab(${collabSession.bugCount}b/${collabSession.planCount}p/${collabSession.evalCount}e)`
    : '';
  const summaryLine =
    runningCount > 0
      ? `${runningCount} running${costLabel}${collabLabel}`
      : `idle${costLabel}${collabLabel}`;

  // Show up to 3 running agents (collab agents or regular subagents).
  const shown = running.slice(0, 3);
  const overflow = running.length > 3 ? running.length - 3 : 0;

  // Leader status label: when collab is active show "waiting for agents",
  // otherwise show its current tool or a dash.
  const leaderTool = hasCollab
    ? 'waiting for agents'
    : (leader?.currentTool?.name ?? (leader?.status === 'running' ? 'running' : '—'));

  return (
    <Box flexDirection="column" paddingX={1}>
      {/* Fleet summary */}
      <Box flexDirection="row" gap={1}>
        <Text dimColor>⚡ Fleet</Text>
        <Text dimColor>│</Text>
        <Text>{summaryLine}</Text>
      </Box>

      {/* Leader row — always shown when collab session is active, regardless of idle/running */}
      {hasCollab && leader ? (
        <Box flexDirection="row" gap={1}>
          <Text color="yellow">●</Text>
          <Text>{leader.name.slice(0, 14).padEnd(14)}</Text>
          <Text dimColor>→</Text>
          <Text color="yellow">{leaderTool}</Text>
        </Box>
      ) : null}

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

      {/* Overflow indicator — show count and the first overflowed agent name */}
      {overflow > 0 ? (
        <Text dimColor>
          {' '}+{overflow}: {running[3]?.name?.slice(0, 12) ?? 'agent'}…
        </Text>
      ) : null}
    </Box>
  );
}
