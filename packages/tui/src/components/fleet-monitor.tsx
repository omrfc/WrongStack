import { Box, Text } from 'ink';
import type React from 'react';
import type { FleetEntry } from '../app.js';
import { fmtElapsed, renderProgress } from './status-bar.js';

export interface FleetMonitorProps {
  entries: Record<string, FleetEntry>;
  /** Fleet-wide accumulated cost. */
  totalCost: number;
  /** Fleet-wide token totals, when available. */
  totalTokens?: { input: number; output: number };
  /** Concurrency ceiling for the gauge. */
  maxConcurrent?: number;
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

const SPARK = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];

/**
 * Bucket recent tool executions into a fixed number of time bins ending at
 * `now`, returning a per-bin count. Drives the per-agent activity sparkline.
 */
export function bucketActivity(
  recentTools: ReadonlyArray<{ at: number }>,
  now: number,
  bins = 12,
  binMs = 2000,
): number[] {
  const out = new Array<number>(bins).fill(0);
  const windowStart = now - bins * binMs;
  for (const t of recentTools) {
    if (t.at < windowStart || t.at > now) continue;
    let idx = Math.floor((t.at - windowStart) / binMs);
    if (idx < 0) idx = 0;
    if (idx >= bins) idx = bins - 1;
    out[idx]!++;
  }
  return out;
}

/** Render a numeric series as a unicode sparkline. */
export function sparkline(values: number[]): string {
  if (values.length === 0) return '';
  const max = Math.max(1, ...values);
  return values
    .map((v) => {
      if (v <= 0) return SPARK[0];
      const idx = Math.min(SPARK.length - 1, Math.ceil((v / max) * (SPARK.length - 1)));
      return SPARK[idx];
    })
    .join('');
}

function fmtTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/**
 * Full graphical fleet dashboard (Ctrl+F). Header counts, a concurrency +
 * token/cost gauge, a per-agent block with a relative-load progress bar and
 * an activity sparkline, and a compact event timeline.
 */
export function FleetMonitor({
  entries,
  totalCost,
  totalTokens,
  maxConcurrent = 4,
  nowTick,
}: FleetMonitorProps): React.ReactElement {
  const all = Object.values(entries);
  const running = all.filter((e) => e.status === 'running');
  const done = all.filter((e) => e.status === 'success').length;
  const failed = all.filter((e) => e.status === 'failed' || e.status === 'timeout').length;

  const concurrencyRatio = maxConcurrent > 0 ? running.length / maxConcurrent : 0;
  // Per-agent load bar normalizes tool calls against the busiest agent so the
  // bars are comparable at a glance — who's doing the most work right now.
  const maxTools = Math.max(1, ...all.map((e) => e.toolCalls));

  // Active first (running → idle), then most-recently-finished, capped.
  const ordered = [...all].sort((a, b) => {
    const ra = a.status === 'running' ? 0 : a.status === 'idle' ? 1 : 2;
    const rb = b.status === 'running' ? 0 : b.status === 'idle' ? 1 : 2;
    if (ra !== rb) return ra - rb;
    return a.startedAt - b.startedAt;
  });
  const shown = ordered.slice(0, 8);

  // Timeline: spawn + terminal-status events across all agents, newest first.
  const events: Array<{ at: number; icon: string; color: string; text: string }> = [];
  for (const e of all) {
    events.push({ at: e.startedAt, icon: '●', color: 'cyan', text: `${e.name} spawned` });
    if (e.status !== 'running' && e.status !== 'idle') {
      const s = STATUS[e.status];
      events.push({
        at: e.lastEventAt,
        icon: s.icon,
        color: s.color,
        text: `${e.name} ${e.status} (${e.toolCalls}t)`,
      });
    }
    if (e.budgetWarning) {
      events.push({
        at: e.budgetWarning.at,
        icon: '⚡',
        color: 'yellow',
        text: `${e.name} ${e.budgetWarning.kind} ${e.budgetWarning.used}/${e.budgetWarning.limit} — extending`,
      });
    }
  }
  events.sort((a, b) => b.at - a.at);
  const timeline = events.slice(0, 6);

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      {/* Header */}
      <Box flexDirection="row" gap={1}>
        <Text bold color="cyan">
          FLEET MONITOR
        </Text>
        <Text dimColor>│</Text>
        <Text color="yellow">▶{running.length}</Text>
        <Text color="green">✓{done}</Text>
        {failed > 0 ? <Text color="red">✗{failed}</Text> : null}
        <Text dimColor>· Ctrl+F to close</Text>
      </Box>

      {/* Concurrency + token/cost gauge */}
      <Box flexDirection="row" gap={1}>
        <Text dimColor>concurrency</Text>
        <Text color="cyan">[{renderProgress(concurrencyRatio, 10)}]</Text>
        <Text dimColor>
          {running.length}/{maxConcurrent}
        </Text>
        {totalTokens ? (
          <Text dimColor>
            {'  '}
            {fmtTokens(totalTokens.input)}↑ {fmtTokens(totalTokens.output)}↓
          </Text>
        ) : null}
        <Text color="green">{`  $${totalCost.toFixed(3)}`}</Text>
      </Box>

      {shown.length === 0 ? (
        <Text dimColor>No subagents yet — spawn with /fleet spawn or /fleet dispatch.</Text>
      ) : null}

      {/* Per-agent blocks */}
      {shown.map((e) => {
        const s = STATUS[e.status];
        const elapsed =
          e.status === 'running' ? fmtElapsed(Math.max(0, nowTick - e.startedAt)) : e.status;
        const spark = sparkline(bucketActivity(e.recentTools, nowTick));
        const tool = e.currentTool?.name ?? e.recentTools[e.recentTools.length - 1]?.name ?? '';
        return (
          <Box key={e.id} flexDirection="column">
            <Box flexDirection="row" gap={1}>
              <Text color={s.color} bold>
                {s.icon}
              </Text>
              <Text bold>{e.name.padEnd(12).slice(0, 12)}</Text>
              <Text dimColor>{elapsed.padEnd(7).slice(0, 7)}</Text>
              <Text color="cyan">{renderProgress(e.toolCalls / maxTools, 10)}</Text>
              <Text dimColor>
                L{e.iterations} {e.toolCalls}t
              </Text>
              {e.extensions && e.extensions > 0 ? (
                <Text color="yellow">⚡×{e.extensions}</Text>
              ) : null}
            </Box>
            <Box flexDirection="row" gap={1}>
              <Text dimColor>{'  '}</Text>
              <Text color="green">{spark}</Text>
              {tool ? <Text dimColor>{tool}</Text> : null}
            </Box>
          </Box>
        );
      })}

      {/* Timeline */}
      {timeline.length > 0 ? (
        <Box flexDirection="column" marginTop={1}>
          <Text dimColor>timeline</Text>
          {timeline.map((ev, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: timeline is rebuilt per render
            <Box key={i} flexDirection="row" gap={1}>
              <Text dimColor>{`${fmtElapsed(Math.max(0, nowTick - ev.at))} ago`.padEnd(10)}</Text>
              <Text color={ev.color}>{ev.icon}</Text>
              <Text dimColor>{ev.text}</Text>
            </Box>
          ))}
        </Box>
      ) : null}
    </Box>
  );
}
