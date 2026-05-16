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

const STATUS_ICON: Record<FleetEntry['status'], { icon: string; color: string }> = {
  idle: { icon: '○', color: 'gray' },
  running: { icon: '●', color: 'green' },
  success: { icon: '✓', color: 'green' },
  failed: { icon: '✗', color: 'red' },
  timeout: { icon: '⏱', color: 'yellow' },
  stopped: { icon: '⊘', color: 'yellow' },
};

function fmtCost(n: number): string {
  if (n === 0) return '—';
  return `$${n.toFixed(3)}`;
}

function fmtCount(n: number): string {
  if (n === 0) return '—';
  return String(n);
}

function fmtModel(provider?: string, model?: string): string {
  if (!provider && !model) return '';
  const p = provider ?? '';
  const m = model ?? '';
  return p && m ? `${p}/${m}` : p || m;
}

function resolveName(entry: FleetEntry, roster?: Record<string, { name: string }>): string {
  // Try roster lookup by id first.
  const rosterEntry = roster?.[entry.id];
  if (rosterEntry) return rosterEntry.name;
  return entry.name;
}

/**
 * Live fleet panel rendered below the status bar when director mode is
 * active. Shows every known subagent with status, streaming output (for
 * running agents), iteration/tool/cost counts, and a fleet-wide cost total.
 *
 * Designed to be compact — each subagent is one or two lines. When no
 * subagents have been spawned yet, the panel is hidden entirely.
 */
export function FleetPanel({ entries, totalCost, roster }: FleetPanelProps): React.ReactElement | null {
  const list = Object.values(entries);
  if (list.length === 0) return null;

  // Sort: running first, then recent activity, then idle/done.
  const sorted = [...list].sort((a, b) => {
    const order: Record<string, number> = { running: 0, success: 1, failed: 2, timeout: 3, stopped: 4, idle: 5 };
    const ao = order[a.status] ?? 9;
    const bo = order[b.status] ?? 9;
    if (ao !== bo) return ao - bo;
    return b.lastEventAt - a.lastEventAt;
  });

  const runningCount = list.filter((e) => e.status === 'running').length;
  const totalLabel =
    totalCost > 0
      ? `$${totalCost.toFixed(3)} · ${runningCount} active`
      : `${runningCount} active`;

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
      {/* Header */}
      <Box flexDirection="row" gap={2}>
        <Text dimColor>Fleet</Text>
        <Text dimColor>│</Text>
        <Text dimColor>{list.length} agent{list.length === 1 ? '' : 's'}</Text>
        <Text dimColor>│</Text>
        <Text dimColor>{totalLabel}</Text>
      </Box>

      {/* Per-subagent rows */}
      {sorted.map((entry) => {
        const si = STATUS_ICON[entry.status];
        const modelTag = fmtModel(entry.provider, entry.model);
        const name = resolveName(entry, roster);

        return (
          <Box key={entry.id} flexDirection="column">
            <Box flexDirection="row" gap={1}>
              <Text color={si.color}>{si.icon}</Text>
              <Text>{name.slice(0, 16).padEnd(16)}</Text>
              {modelTag ? (
                <>
                  <Text dimColor>·</Text>
                  <Text dimColor>{modelTag}</Text>
                </>
              ) : null}
              <Text dimColor>·</Text>
              <Text dimColor>{fmtCount(entry.iterations).padStart(3)}it</Text>
              <Text dimColor>{fmtCount(entry.toolCalls).padStart(3)}tc</Text>
              <Text dimColor>·</Text>
              <Text color="yellow">{fmtCost(entry.cost)}</Text>
            </Box>
            {/* Current tool — shown only while a tool is mid-flight. */}
            {entry.status === 'running' && entry.currentTool ? (
              <Box paddingLeft={2}>
                <Text color="cyan">→ {entry.currentTool.name}</Text>
                <Text dimColor> ({Math.max(0, Date.now() - entry.currentTool.startedAt)}ms)</Text>
              </Box>
            ) : null}
            {/* Streaming tail for running agents */}
            {entry.status === 'running' && entry.streamingText ? (
              <Box paddingLeft={2}>
                <Text dimColor>
                  {'>'} {entry.streamingText.slice(-80)}
                </Text>
              </Box>
            ) : null}
            {/* JSONL transcript path — dim, last so users grep -F it. */}
            {entry.transcriptPath ? (
              <Box paddingLeft={2}>
                <Text dimColor>log: {entry.transcriptPath}</Text>
              </Box>
            ) : null}
          </Box>
        );
      })}
    </Box>
  );
}
