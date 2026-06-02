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
  /** Active or completed collaborative debugging session. */
  collabSession?: {
    sessionId: string | null;
    bugCount: number;
    planCount: number;
    evalCount: number;
    overallVerdict: 'approve' | 'needs_revision' | 'reject' | null;
    timeline: Array<{ at: number; icon: string; color: string; text: string }>;
    startedAt: number | null;
  } | null;
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
 * `now`, returning a per-bin count. Drives the per-agent activity sparkline
 * in the Agents (live) monitor; exported here because it was historically
 * defined alongside the fleet monitor.
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

function fmtCost(n: number): string {
  if (n === 0) return '—';
  return `$${n.toFixed(3)}`;
}

/**
 * Fleet orchestration dashboard (Ctrl+F). Concurrency gauge, fleet totals,
 * a compact one-line-per-agent table, and a recent-events timeline. Live
 * per-agent context (current tool / streaming tail) lives in the Agents
 * monitor (Ctrl+G) — this view is for "how the fleet is doing overall".
 */
export function FleetMonitor({
  entries,
  totalCost,
  totalTokens,
  maxConcurrent = 4,
  nowTick,
  collabSession,
}: FleetMonitorProps): React.ReactElement {
  const all = Object.values(entries);
  const running = all.filter((e) => e.status === 'running');
  const idle = all.filter((e) => e.status === 'idle').length;
  const done = all.filter((e) => e.status === 'success').length;
  const failed = all.filter((e) => e.status === 'failed' || e.status === 'timeout').length;

  const concurrencyRatio = maxConcurrent > 0 ? running.length / maxConcurrent : 0;

  // Sort: running → idle → recently-finished (newest first).
  const ordered = [...all].sort((a, b) => {
    const ra = a.status === 'running' ? 0 : a.status === 'idle' ? 1 : 2;
    const rb = b.status === 'running' ? 0 : b.status === 'idle' ? 1 : 2;
    if (ra !== rb) return ra - rb;
    if (ra === 2) return b.lastEventAt - a.lastEventAt;
    return a.startedAt - b.startedAt;
  });
  const shown = ordered.slice(0, 12);
  const overflow = all.length - shown.length;

  // Timeline: spawn + terminal-status events across all agents + collab session events, newest first.
  const events: Array<{ at: number; icon: string; color: string; text: string }> = [];
  for (const e of all) {
    events.push({ at: e.startedAt, icon: '●', color: 'cyan', text: `${e.name} spawned` });
    if (e.status !== 'running' && e.status !== 'idle') {
      const s = STATUS[e.status];
      const reason = e.failureReason ? ` [${e.failureReason}]` : '';
      events.push({
        at: e.lastEventAt,
        icon: s.icon,
        color: s.color,
        text: `${e.name} ${e.status} (${e.toolCalls}t)${reason}`,
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
  const timeline = events.slice(0, 20);

  // Collab verdict chip color
  const VERDICT_COLOR: Record<string, string> = {
    approve: 'green',
    needs_revision: 'yellow',
    reject: 'red',
  };

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      {/* Header — orchestration identity, distinct from AGENTS · LIVE */}
      <Box flexDirection="row" gap={1}>
        <Text bold color="cyan">
          FLEET · ORCHESTRATION
        </Text>
        <Text dimColor>│</Text>
        <Text color="yellow">▶{running.length}</Text>
        <Text dimColor>○{idle}</Text>
        <Text color="green">✓{done}</Text>
        {failed > 0 ? <Text color="red">✗{failed}</Text> : null}
        <Text dimColor>· Ctrl+F to close</Text>
      </Box>

      {/* Collab session banner — shown when a session is active or completed */}
      {collabSession ? (
        <Box flexDirection="column" marginTop={1}>
          <Box flexDirection="row" gap={1}>
            <Text bold color="magenta">
              ⚡ COLLAB SESSION
            </Text>
            {collabSession.sessionId ? (
              <Text dimColor>{collabSession.sessionId.slice(0, 8)}</Text>
            ) : null}
            <Text dimColor>│</Text>
            <Text color="red">🐛{collabSession.bugCount}</Text>
            <Text dimColor>│</Text>
            <Text color="yellow">📐{collabSession.planCount}</Text>
            <Text dimColor>│</Text>
            <Text color="blue">⚖️{collabSession.evalCount}</Text>
            {collabSession.overallVerdict ? (
              <>
                <Text dimColor>│</Text>
                <Text bold color={VERDICT_COLOR[collabSession.overallVerdict]}>
                  {collabSession.overallVerdict}
                </Text>
              </>
            ) : null}
          </Box>
          {/* Inline collab timeline — first 6 entries */}
          {collabSession.timeline.length > 0 ? (
            <Box flexDirection="column" marginTop={0}>
              {collabSession.timeline.slice(0, 6).map((ev, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: timeline is rebuilt per render
                <Box key={i} flexDirection="row" gap={1}>
                  <Text dimColor>
                    {`${fmtElapsed(Math.max(0, nowTick - ev.at))} ago`.padEnd(10)}
                  </Text>
                  <Text color={ev.color}>{ev.icon}</Text>
                  <Text dimColor>{ev.text}</Text>
                </Box>
              ))}
            </Box>
          ) : null}
        </Box>
      ) : null}

      {/* Concurrency + totals gauge */}
      <Box flexDirection="row" gap={1}>
        <Text dimColor>concurrency</Text>
        <Text color="cyan">[{renderProgress(concurrencyRatio, 12)}]</Text>
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

      {/* Compact one-line-per-agent table */}
      {shown.length > 0 ? (
        <Box flexDirection="column" marginTop={1}>
          <Box flexDirection="row" gap={1}>
            <Text dimColor>{'  '}</Text>
            <Text dimColor>{'name'.padEnd(16)}</Text>
            <Text dimColor>{'status'.padEnd(10)}</Text>
            <Text dimColor>{'L/t'.padEnd(8)}</Text>
            <Text dimColor>{'elapsed'.padEnd(8)}</Text>
            <Text dimColor>cost</Text>
          </Box>
          {shown.map((e) => {
            const s = STATUS[e.status];
            const elapsed =
              e.status === 'running'
                ? fmtElapsed(Math.max(0, nowTick - e.startedAt))
                : fmtElapsed(Math.max(0, nowTick - e.lastEventAt)) + ' ago';
            return (
              <Box key={e.id} flexDirection="row" gap={1}>
                <Text color={s.color}>{s.icon}</Text>
                <Text>{e.name.padEnd(16).slice(0, 16)}</Text>
                <Text color={s.color}>{e.status.padEnd(10)}</Text>
                <Text dimColor>{`L${e.iterations} ${e.toolCalls}t`.padEnd(8)}</Text>
                <Text dimColor>{elapsed.padEnd(8).slice(0, 8)}</Text>
                <Text color="yellow">{fmtCost(e.cost)}</Text>
                {e.extensions && e.extensions > 0 ? (
                  <Text color="yellow"> ⚡×{e.extensions}</Text>
                ) : null}
              </Box>
            );
          })}
          {overflow > 0 ? <Text dimColor>{`  … +${overflow} more`}</Text> : null}
        </Box>
      ) : null}

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
