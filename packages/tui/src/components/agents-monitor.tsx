import { Box, Text } from 'ink';
import type React from 'react';
import type { FleetEntry } from '../app.js';
import { bucketActivity, fmtModelLabel, sparkline } from './fleet-monitor.js';
import { fmtElapsed } from './status-bar.js';

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

function isTerminal(status: FleetEntry['status']): boolean {
  return (
    status === 'success' || status === 'failed' || status === 'timeout' || status === 'stopped'
  );
}

/**
 * An idle agent that hasn't produced any event for this long is considered
 * stale and dropped from the live view — a running agent is never hidden.
 * `lastEventAt` is bumped on every tool / message / stream event.
 */
export const IDLE_HIDE_MS = 60_000;

/**
 * Select the agents the live monitor should render: never-terminal agents,
 * with idle agents pruned once they've been silent longer than `idleHideMs`.
 * Running agents come first (oldest first), then surviving idle agents
 * (most-recently-active first). Pure + exported for unit testing.
 */
export function selectLiveAgents(
  all: FleetEntry[],
  now: number,
  idleHideMs: number = IDLE_HIDE_MS,
): FleetEntry[] {
  const visible = all.filter((e) => {
    if (isTerminal(e.status)) return false;
    if (e.status === 'running') return true;
    // idle: keep only while it's been recently active
    return now - e.lastEventAt < idleHideMs;
  });
  return visible.sort((a, b) => {
    if (a.status === 'running' && b.status !== 'running') return -1;
    if (a.status !== 'running' && b.status === 'running') return 1;
    if (a.status === 'running') return a.startedAt - b.startedAt; // oldest run first
    return b.lastEventAt - a.lastEventAt; // freshest idle first
  });
}

function fmtTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

export function fmtExactTokens(n: number): string {
  return `${Math.round(n).toLocaleString('en-US')} tok`;
}

function snippet(s: string, max = 72): string {
  const oneLine = s.replace(/\s+/g, ' ').trim();
  if (oneLine.length <= max) return oneLine;
  return `${oneLine.slice(0, max - 1)}…`;
}

/** Colored context-window fill bar: ████░░░░░░ 67% */
function ContextBar({
  pct,
  tokens,
  maxTokens,
}: {
  pct: number;
  tokens?: number;
  maxTokens?: number;
}): React.ReactElement {
  const clamped = Math.max(0, Math.min(2, pct)); // cap visual at 200%
  const totalBars = 10;
  const filled = Math.round(clamped * totalBars);
  const empty = totalBars - filled;
  const color = pct < 0.6 ? 'green' : pct < 0.75 ? 'yellow' : 'red';
  const pctText = pct >= 1 ? `${Math.round(pct * 100)}%+` : `${Math.round(pct * 100)}%`;
  const tokenText = tokens ? ` ${fmtTokens(tokens)}/${fmtTokens(maxTokens ?? 200_000)}` : '';
  return (
    <Text color={color}>
      {'█'.repeat(filled)}
      {'░'.repeat(Math.max(0, empty))} {pctText}
      {tokenText}
    </Text>
  );
}

/**
 * Live per-agent context view (Ctrl+G). Each active agent gets a card with
 * its current tool, the last tool result, the most recent streaming /
 * message text, an activity sparkline, and budget pressure. Terminal
 * agents are excluded so the monitor reflects only what's actually live.
 */
export function AgentsMonitor({
  entries,
  totalCost,
  totalTokens,
  nowTick,
}: AgentsMonitorProps): React.ReactElement {
  const all = Object.values(entries);

  // Terminal agents are excluded, and idle agents that have been silent for
  // longer than IDLE_HIDE_MS are pruned — the FleetPanel + history still hold
  // the full record; this view shows only what's actually live right now.
  const live = selectLiveAgents(all, nowTick);

  const running = live.filter((e) => e.status === 'running').length;
  const totalDone = all.filter((e) => e.status === 'success').length;
  const totalFailed = all.filter((e) => e.status === 'failed' || e.status === 'timeout').length;
  // Idle agents pruned for being stale (live but not in the visible set).
  const hiddenIdle = all.filter(
    (e) => e.status === 'idle' && nowTick - e.lastEventAt >= IDLE_HIDE_MS,
  ).length;

  const ordered = live;
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
        <Text dimColor>─────────────────</Text>
        <Text dimColor>done</Text>
        <Text color="green">✓{totalDone}</Text>
        <Text dimColor>·</Text>
        <Text dimColor>failed</Text>
        {totalFailed > 0 ? <Text color="red">✗{totalFailed}</Text> : null}
        <Text dimColor>· Ctrl+G / F3 to close</Text>
      </Box>

      {/* Token + cost row */}
      <Box flexDirection="row" gap={1}>
        <Text dimColor>shown</Text>
        <Text color="magenta">{live.length}</Text>
        {totalTokens ? (
          <Text dimColor>
            {' '}
            {fmtTokens(totalTokens.input)}↑ {fmtTokens(totalTokens.output)}↓
          </Text>
        ) : null}
        <Text color="green">${totalCost.toFixed(3)}</Text>
        {hiddenIdle > 0 ? <Text dimColor>· {hiddenIdle} idle hidden</Text> : null}
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
        const streamTail = e.streamingText ? snippet(e.streamingText.slice(-160)) : '';
        const toolElapsed = e.currentTool ? Math.max(0, nowTick - e.currentTool.startedAt) : 0;

        return (
          <Box key={e.id} flexDirection="column" marginTop={1}>
            {/* Identity line: icon · name · model · elapsed · iter/tools · ctx · extensions
                — ctx bar lives here (not its own line) to save vertical space. */}
            <Box flexDirection="row" gap={1}>
              <Text color={s.color} bold>
                {s.icon}
              </Text>
              <Text bold>{e.name}</Text>
              {fmtModelLabel(e.provider, e.model) ? (
                <Text dimColor>{fmtModelLabel(e.provider, e.model)}</Text>
              ) : null}
              {e.ctxMaxTokens && e.ctxMaxTokens > 0 ? (
                <Text color="blue">ctx max {fmtExactTokens(e.ctxMaxTokens)}</Text>
              ) : null}
              <Text dimColor>·</Text>
              <Text dimColor>{elapsed}</Text>
              <Text dimColor>·</Text>
              <Text dimColor>
                L{e.iterations} {e.toolCalls}t
              </Text>
              {e.ctxPct !== undefined ? (
                <>
                  <Text dimColor>·</Text>
                  <ContextBar pct={e.ctxPct} tokens={e.ctxTokens} maxTokens={e.ctxMaxTokens} />
                </>
              ) : null}
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
                    {typeof lastTool.durationMs === 'number' ? ` ${lastTool.durationMs}ms` : ''}
                    {lastTool.ok === false ? ' ✗' : ''}
                  </Text>
                ) : null}
              </Box>
            ) : null}

            {/* Live streaming tail (for running agents) */}
            {e.status === 'running' && streamTail ? (
              <Box paddingLeft={2}>
                <Text dimColor>
                  {'>'} {streamTail}
                </Text>
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

            {/* Failure reason (shown for failed/timeout/stopped agents) */}
            {e.failureReason && e.status !== 'success' ? (
              <Box paddingLeft={2}>
                <Text color="red">✗ {e.failureReason}</Text>
              </Box>
            ) : null}
          </Box>
        );
      })}
    </Box>
  );
}
