import { Box, Text, useInput } from 'ink';
import { useMemo, useState } from 'react';
import type React from 'react';
import type { FleetEntry } from '../app.js';
import { bucketActivity, fmtModelLabel, sparkline } from './fleet-monitor.js';
import { fmtElapsed } from './status-bar.js';

export interface AgentsMonitorProps {
  entries: Record<string, FleetEntry>;
  /** Fleet (subagents) accumulated cost — excludes the leader/main session. */
  totalCost: number;
  /**
   * Leader (main session) cost — the same figure the statusline shows. Added
   * to `totalCost` for a trustworthy grand total. Optional for callers that
   * don't track it (defaults to 0).
   */
  leaderCost?: number | undefined;
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
  tokens?: number | undefined;
  maxTokens?: number | undefined;
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
 * Compact single-line agent row. All the essential info in one line:
 * status icon, name, model, iterations/tools, context bar, cost.
 */
function AgentRow({
  entry,
  now,
  selected,
}: {
  entry: FleetEntry;
  now: number;
  selected: boolean;
}): React.ReactElement {
  const s = STATUS[entry.status];
  const elapsed =
    entry.status === 'running' ? fmtElapsed(Math.max(0, now - entry.startedAt)) : entry.status;
  const modelLabel = fmtModelLabel(entry.provider, entry.model);

  return (
    <Box flexDirection="row" gap={1}>
      {/* Selection indicator */}
      <Text color={selected ? 'magenta' : 'gray'}>{selected ? '▶' : ' '}</Text>
      {/* Status icon */}
      <Text color={s.color} bold>
        {s.icon}
      </Text>
      {/* Name */}
      <Text bold={selected} color={selected ? 'magenta' : undefined}>
        {entry.name}
      </Text>
      {/* Model */}
      {modelLabel ? <Text dimColor>{modelLabel}</Text> : null}
      {/* Iterations / tool calls */}
      <Text dimColor>
        L{entry.iterations} {entry.toolCalls}t
      </Text>
      {/* Context bar */}
      {entry.ctxPct !== undefined ? (
        <ContextBar pct={entry.ctxPct} tokens={entry.ctxTokens} maxTokens={entry.ctxMaxTokens} />
      ) : null}
      {/* Current tool (inline) */}
      {entry.status === 'running' && entry.currentTool ? (
        <Text color="cyan">
          → {entry.currentTool.name}
          <Text dimColor> ({Math.max(0, now - entry.currentTool.startedAt)}ms)</Text>
        </Text>
      ) : null}
      {/* Elapsed */}
      <Text dimColor>{elapsed}</Text>
      {/* Extensions badge */}
      {entry.extensions && entry.extensions > 0 ? (
        <Text color="yellow">⚡×{entry.extensions}</Text>
      ) : null}
      {/* Cost */}
      {entry.cost > 0 ? <Text color="green">${entry.cost.toFixed(4)}</Text> : null}
    </Box>
  );
}

/**
 * Expanded detail card for the selected agent — shows sparkline, last tool,
 * streaming text, budget warnings, and failure reason.
 */
function AgentDetail({
  entry,
  now,
}: {
  entry: FleetEntry;
  now: number;
}): React.ReactElement {
  const spark = sparkline(bucketActivity(entry.recentTools, now));
  const lastTool = entry.recentTools[entry.recentTools.length - 1];
  const lastMessage = entry.recentMessages[entry.recentMessages.length - 1];
  const streamTail = entry.streamingText ? snippet(entry.streamingText.slice(-160)) : '';

  return (
    <Box flexDirection="column" paddingLeft={4} borderStyle="single" borderColor="magenta" borderLeft>
      {/* Activity sparkline + last completed tool */}
      {spark || lastTool ? (
        <Box flexDirection="row" gap={1}>
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

      {/* Live streaming tail */}
      {entry.status === 'running' && streamTail ? (
        <Box>
          <Text dimColor>
            {'>'} {streamTail}
          </Text>
        </Box>
      ) : null}

      {/* Latest finished-message snippet */}
      {(entry.status !== 'running' || !streamTail) && lastMessage ? (
        <Box>
          <Text dimColor>msg: {snippet(lastMessage.text)}</Text>
        </Box>
      ) : null}

      {/* Budget pressure */}
      {entry.budgetWarning ? (
        <Box>
          <Text color="yellow">
            ⚡ {entry.budgetWarning.kind} {entry.budgetWarning.used}/{entry.budgetWarning.limit} —
            extending
          </Text>
        </Box>
      ) : null}

      {/* Failure reason */}
      {entry.failureReason && entry.status !== 'success' ? (
        <Box>
          <Text color="red">✗ {entry.failureReason}</Text>
        </Box>
      ) : null}
    </Box>
  );
}

/**
 * Live per-agent monitor (Ctrl+G / F3). Hybrid compact view:
 * - All agents rendered in single-line rows with ↑↓/jk navigation.
 * - Selected agent expands an inline detail card showing sparkline,
 *   last tool, streaming text, budget warnings, and failure reason.
 * - Terminal agents are excluded; stale idle agents pruned after 60s.
 */
export function AgentsMonitor({
  entries,
  totalCost,
  leaderCost = 0,
  totalTokens,
  nowTick,
}: AgentsMonitorProps): React.ReactElement {
  const all = Object.values(entries);
  const grandCost = leaderCost + totalCost;

  const live = useMemo(() => selectLiveAgents(all, nowTick), [all, nowTick]);
  const [selectedIndex, setSelectedIndex] = useState(0);

  // Clamp selection when the list shrinks
  const safeIndex = Math.min(selectedIndex, Math.max(0, live.length - 1));

  // Keyboard navigation
  useInput((input, key) => {
    if (key.upArrow || input === 'k') {
      setSelectedIndex((prev) => Math.max(0, prev - 1));
    } else if (key.downArrow || input === 'j') {
      setSelectedIndex((prev) => Math.min(live.length - 1, prev + 1));
    }
  });

  const running = live.filter((e) => e.status === 'running').length;
  const totalDone = all.filter((e) => e.status === 'success').length;
  const totalFailed = all.filter((e) => e.status === 'failed' || e.status === 'timeout').length;
  const hiddenIdle = all.filter(
    (e) => e.status === 'idle' && nowTick - e.lastEventAt >= IDLE_HIDE_MS,
  ).length;

  const selected = live[safeIndex];

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="magenta" paddingX={1}>
      {/* Header */}
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
        <Text dimColor>· ↑↓ nav · Ctrl+G / F3 close</Text>
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
        <Text dimColor>total</Text>
        <Text color="green" bold>
          ${grandCost.toFixed(4)}
        </Text>
        <Text dimColor>
          (leader ${leaderCost.toFixed(4)} · fleet ${totalCost.toFixed(4)})
        </Text>
        {hiddenIdle > 0 ? <Text dimColor>· {hiddenIdle} idle hidden</Text> : null}
      </Box>

      {live.length === 0 ? (
        <Text dimColor>No live agents — spawn with /spawn or /fleet dispatch.</Text>
      ) : null}

      {/* Compact agent rows */}
      {live.map((e) => (
        <AgentRow key={e.id} entry={e} now={nowTick} selected={e.id === selected?.id} />
      ))}

      {/* Expanded detail for selected agent */}
      {selected ? (
        <Box flexDirection="column" marginTop={1}>
          <Box flexDirection="row" gap={1} paddingLeft={2}>
            <Text dimColor>───</Text>
            <Text color="magenta">{selected.name}</Text>
            <Text dimColor>details ───</Text>
          </Box>
          <AgentDetail entry={selected} now={nowTick} />
        </Box>
      ) : null}
    </Box>
  );
}
