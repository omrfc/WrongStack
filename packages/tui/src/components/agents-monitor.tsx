import { Box, Text } from 'ink';
import type React from 'react';
import type { FleetEntry } from '../app.js';
import { fmtElapsed } from './status-bar.js';
import { bucketActivity, sparkline } from './fleet-monitor.js';

export interface AgentsMonitorProps {
  entries: Record<string, FleetEntry>;
  /** Fleet-wide accumulated cost. */
  totalCost: number;
  /** Fleet-wide token totals, when available. */
  totalTokens?: { input: number; output: number };
  /** 1s clock tick so elapsed times + sparklines stay live. */
  nowTick: number;
}

const STATUS: Record<FleetEntry['status'], { icon: string; color: string }> = {
  idle: { icon: '○', color: 'gray' },
  running: { icon: '▶', color: 'yellow' },
  success: { icon: '✓', color: 'green' },
  failed: { icon: '✗', color: 'red' },
  timeout: { icon: '⏱', color: 'yellow' },
  stopped: { icon: '⊘', color: 'gray' },
};

/**
 * Terminal statuses linger this long in the live view before being evicted,
 * so users see the just-finished agent and the outcome icon flashes briefly
 * instead of staying on the screen forever after the run is over.
 */
const TERMINAL_LINGER_MS = 10_000;

function isTerminal(status: FleetEntry['status']): boolean {
  return status === 'success' || status === 'failed' || status === 'timeout' || status === 'stopped';
}

function fmtTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

function snippet(s: string, max = 72): string {
  const oneLine = s.replace(/\s+/g, ' ').trim();
  if (oneLine.length <= max) return oneLine;
  return `${oneLine.slice(0, max - 1)}…`;
}

/**
 * Live per-agent context view (Ctrl+G). Each active agent gets a card with
 * its current tool, the last tool result, the most recent streaming /
 * message text, an activity sparkline, and budget pressure. Completed
 * agents linger for {@link TERMINAL_LINGER_MS} so the outcome is visible,
 * then drop off so the monitor reflects only what's actually live.
 */
export function AgentsMonitor({
  entries,
  totalCost,
  totalTokens,
  nowTick,
}: AgentsMonitorProps): React.ReactElement {
  const all = Object.values(entries);

  // Filter: keep running/idle always; keep terminal-status agents only for the
  // grace window after their last event — the FleetPanel + history still have
  // the full record, this view is for what's happening right now.
  const live = all.filter((e) => {
    if (!isTerminal(e.status)) return true;
    return nowTick - e.lastEventAt <= TERMINAL_LINGER_MS;
  });

  const running = live.filter((e) => e.status === 'running').length;
  const done = live.filter((e) => e.status === 'success').length;
  const failed = live.filter((e) => e.status === 'failed' || e.status === 'timeout').length;
  const hidden = all.length - live.length;

  // Running first, then idle, then recently-finished (newest first).
  const ordered = [...live].sort((a, b) => {
    const ra = a.status === 'running' ? 0 : a.status === 'idle' ? 1 : 2;
    const rb = b.status === 'running' ? 0 : b.status === 'idle' ? 1 : 2;
    if (ra !== rb) return ra - rb;
    if (ra === 2) return b.lastEventAt - a.lastEventAt;
    return a.startedAt - b.startedAt;
  });
  const shown = ordered.slice(0, 8);

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="magenta" paddingX={1}>
      {/* Header — live identity, distinct from FLEET MONITOR */}
      <Box flexDirection="row" gap={1}>
        <Text bold color="magenta">
          AGENTS · LIVE
        </Text>
        <Text dimColor>│</Text>
        <Text color="yellow">▶{running}</Text>
        <Text color="green">✓{done}</Text>
        {failed > 0 ? <Text color="red">✗{failed}</Text> : null}
        <Text dimColor>· Ctrl+G to close</Text>
      </Box>

      {/* Token + cost row */}
      <Box flexDirection="row" gap={1}>
        <Text dimColor>shown</Text>
        <Text color="magenta">{live.length}</Text>
        {hidden > 0 ? <Text dimColor>(+{hidden} finished)</Text> : null}
        {totalTokens ? (
          <Text dimColor>
            {' '}
            {fmtTokens(totalTokens.input)}↑ {fmtTokens(totalTokens.output)}↓
          </Text>
        ) : null}
        <Text color="green">{`  $${totalCost.toFixed(3)}`}</Text>
      </Box>

      {shown.length === 0 ? (
        <Text dimColor>No live agents — spawn with /spawn or /fleet dispatch.</Text>
      ) : null}

      {/* Per-agent live cards */}
      {shown.map((e) => {
        const s = STATUS[e.status];
        const elapsed =
          e.status === 'running' ? fmtElapsed(Math.max(0, nowTick - e.startedAt)) : e.status;
        const spark = sparkline(bucketActivity(e.recentTools, nowTick));
        const lastTool = e.recentTools[e.recentTools.length - 1];
        const lastMessage = e.recentMessages[e.recentMessages.length - 1];
        const streamTail = e.streamingText
          ? snippet(e.streamingText.slice(-160))
          : '';
        const toolElapsed = e.currentTool
          ? Math.max(0, nowTick - e.currentTool.startedAt)
          : 0;

        return (
          <Box key={e.id} flexDirection="column" marginTop={1}>
            {/* Identity line: icon · name · elapsed · iter/tools · extensions */}
            <Box flexDirection="row" gap={1}>
              <Text color={s.color} bold>
                {s.icon}
              </Text>
              <Text bold>{e.name}</Text>
              <Text dimColor>·</Text>
              <Text dimColor>{elapsed}</Text>
              <Text dimColor>·</Text>
              <Text dimColor>
                L{e.iterations} {e.toolCalls}t
              </Text>
              {e.extensions && e.extensions > 0 ? (
                <Text color="yellow">⚡×{e.extensions}</Text>
              ) : null}
            </Box>

            {/* Current tool (live, ms-precision) — only while inside a tool */}
            {e.status === 'running' && e.currentTool ? (
              <Box flexDirection="row" gap={1} paddingLeft={2}>
                <Text color="cyan">→ {e.currentTool.name}</Text>
                <Text dimColor>({toolElapsed}ms)</Text>
              </Box>
            ) : null}

            {/* Activity sparkline + last completed tool summary */}
            {spark || lastTool ? (
              <Box flexDirection="row" gap={1} paddingLeft={2}>
                <Text color="green">{spark || ''}</Text>
                {lastTool ? (
                  <Text dimColor>
                    last: {lastTool.name}
                    {typeof lastTool.durationMs === 'number'
                      ? ` ${lastTool.durationMs}ms`
                      : ''}
                    {lastTool.ok === false ? ' ✗' : ''}
                  </Text>
                ) : null}
              </Box>
            ) : null}

            {/* Live streaming tail (for running agents) */}
            {e.status === 'running' && streamTail ? (
              <Box paddingLeft={2}>
                <Text dimColor>{'>'} {streamTail}</Text>
              </Box>
            ) : null}

            {/* Latest finished-message snippet (when nothing streaming) */}
            {(e.status !== 'running' || !streamTail) && lastMessage ? (
              <Box paddingLeft={2}>
                <Text dimColor>msg: {snippet(lastMessage.text)}</Text>
              </Box>
            ) : null}

            {/* Budget pressure */}
            {e.budgetWarning ? (
              <Box paddingLeft={2}>
                <Text color="yellow">
                  ⚡ {e.budgetWarning.kind} {e.budgetWarning.used}/{e.budgetWarning.limit} —
                  extending
                </Text>
              </Box>
            ) : null}
          </Box>
        );
      })}
    </Box>
  );
}
