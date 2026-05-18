import type { TokenCounter } from '@wrongstack/core';
import { Box, Text } from 'ink';
import type React from 'react';
import type { GitInfo } from '../git-info.js';

export interface TodoCounts {
  pending: number;
  inProgress: number;
  completed: number;
}

export interface PlanCounts {
  open: number;
  inProgress: number;
  done: number;
}

/**
 * Fleet activity breakdown surfaced on the work-in-flight line. Derived
 * from `director.status()` in the host app and refreshed alongside the
 * other dynamic chips. Kept optional (and the chip is only rendered
 * when any field is non-zero) so single-agent sessions stay quiet.
 */
export interface FleetCounts {
  /** Subagents currently mid-task. */
  running: number;
  /** Subagents spawned but idle (no current task). */
  idle: number;
  /** Tasks queued but not yet picked up by a worker. */
  pending: number;
  /** Tasks resolved (success/failure/timeout/stopped). */
  completed: number;
}

/**
 * Per-agent detail surfaced on the optional 4th line — one chip per
 * currently-running subagent so the user can see at a glance which
 * agent is doing what, for how long, and how many tools it has called.
 * Truncated to the top N by the host (typically 3-4) to keep the bar
 * from wrapping.
 */
export interface FleetAgentDetail {
  /** Stable label used by the streaming history (e.g. "AGENT#1 bug-hunter"). */
  label: string;
  /** Ink color name — same palette as the per-agent history prefix. */
  color: string;
  /** Ms since the subagent's first iteration. */
  elapsedMs: number;
  /** Tool calls observed via tool.executed. */
  toolCalls: number;
  /** True when the subagent is actively iterating. */
  running: boolean;
}

export interface ContextWindow {
  /** Input tokens of the most recent provider request — the de-facto live context size. */
  used: number;
  /** Provider's declared maxContext capability. */
  max: number;
}

export interface StatusBarProps {
  model: string;
  state: 'idle' | 'running' | 'streaming' | 'aborting';
  tokenCounter?: TokenCounter;
  hint?: string;
  queueCount?: number;
  yolo?: boolean;
  /** Session elapsed in milliseconds. Renders as `mm:ss` (< 1h) or `h:mm:ss`. */
  elapsedMs?: number;
  todos?: TodoCounts;
  /**
   * Plan board counts surfaced as a chip on line 2. Distinct from
   * `todos` — plans are higher-level and persist across resume; the
   * chip uses a different glyph (📋) so the user can tell them apart
   * at a glance.
   */
  plan?: PlanCounts;
  /**
   * Per-status fleet breakdown. When provided, takes precedence over
   * `subagentCount` for chip rendering. `subagentCount` is kept for
   * backwards compatibility when callers haven't wired the richer
   * breakdown yet.
   */
  fleet?: FleetCounts;
  /**
   * Optional per-agent detail row (up to ~4 agents). Renders below the
   * aggregate fleet chip on a dedicated 4th line so the user can see
   * which specific agent is burning time/tools right now without
   * scrolling history.
   */
  fleetAgents?: FleetAgentDetail[];
  git?: GitInfo | null;
  subagentCount?: number;
  /** Renders the "ctx ████░░ 42%" chip on line 1 when present. */
  context?: ContextWindow;
  /**
   * Project / working-folder name. Rendered on line 2 just before the git
   * branch so users running multiple WrongStack windows can tell at a
   * glance which repo each one is pinned to. Usually the basename of
   * `agent.ctx.projectRoot`.
   */
  projectName?: string;
  /** Autonomy mode chip: 'off' | 'suggest' | 'auto'. */
  autonomy?: 'off' | 'suggest' | 'auto';
}

/**
 * Two-line status bar. The first line stays compact and shows the
 * runtime essentials (state · model · tokens · cost · queue · running
 * tool). The second line opts in only when there's actually something
 * to show — git branch, elapsed time, todo counts, YOLO marker — so a
 * vanilla session keeps the original single-line footprint.
 */
export function StatusBar({
  model,
  state,
  tokenCounter,
  hint,
  queueCount = 0,
  yolo = false,
  autonomy,
  elapsedMs,
  todos,
  plan,
  fleet,
  fleetAgents,
  git,
  subagentCount = 0,
  context,
  projectName,
}: StatusBarProps): React.ReactElement {
  const usage = tokenCounter?.total();
  const cost = tokenCounter?.estimateCost();
  const cache = tokenCounter?.cacheStats();
  const stateColor = state === 'idle' ? 'cyan' : state === 'aborting' ? 'yellow' : 'green';
  const stateLabel = state === 'idle' ? 'idle' : state === 'aborting' ? 'aborting…' : 'thinking…';

  // Line 2 is *session context* — slow-moving facts about where you
  // are: the project, the branch, the elapsed clock, YOLO chip. These
  // change at most once per session.
  const hasSecondLine =
    yolo ||
    (autonomy && autonomy !== 'off') ||
    elapsedMs !== undefined ||
    (git !== null && git !== undefined) ||
    (projectName !== undefined && projectName.length > 0);

  // Line 3 is *active work* — the dynamic chips that mutate as the
  // agent / subagents make progress. Hidden when nothing is in flight
  // so a fresh session keeps the two-line baseline.
  const fleetHasActivity =
    (fleet &&
      (fleet.running > 0 || fleet.idle > 0 || fleet.pending > 0 || fleet.completed > 0)) ||
    subagentCount > 0;
  const hasThirdLine =
    (todos && (todos.pending > 0 || todos.inProgress > 0 || todos.completed > 0)) ||
    (plan && (plan.open > 0 || plan.inProgress > 0 || plan.done > 0)) ||
    fleetHasActivity;

  return (
    <Box
      flexDirection="column"
      paddingX={1}
      borderStyle="single"
      borderTop={true}
      borderBottom={false}
      borderLeft={false}
      borderRight={false}
    >
      <Box flexDirection="row" gap={2}>
        <Text color={stateColor}>● {stateLabel}</Text>
        <Text dimColor>│</Text>
        <Text color="magenta">{model}</Text>
        {context && context.max > 0 ? (
          <>
            <Text dimColor>│</Text>
            <ContextChip ctx={context} />
          </>
        ) : null}
        {usage ? (
          <>
            <Text dimColor>│</Text>
            <Text>
              ↑{' '}
              <Text color="cyan">
                {/* Total tokens sent: fresh `input` + the two cached subsets.
                    Usage is disjoint, so this sum is the true uplink count
                    the user wants to see — without it, prompt-cached turns
                    look artificially cheap on this chip. */}
                {fmtTok(usage.input + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0))}
              </Text>{' '}
              ↓ <Text color="cyan">{fmtTok(usage.output)}</Text>
            </Text>
          </>
        ) : null}
        {cache && cache.hitRatio > 0 ? (
          <>
            <Text dimColor>│</Text>
            <Text dimColor>cache {(cache.hitRatio * 100).toFixed(0)}%</Text>
          </>
        ) : null}
        {cost && cost.total > 0 ? (
          <>
            <Text dimColor>│</Text>
            <Text color="yellow">${cost.total.toFixed(4)}</Text>
          </>
        ) : null}
        {queueCount > 0 ? (
          <>
            <Text dimColor>│</Text>
            <Text color="cyan">⌛ queued: {queueCount}</Text>
          </>
        ) : null}
        {hint ? (
          <>
            <Text dimColor>│</Text>
            <Text dimColor>{hint}</Text>
          </>
        ) : null}
      </Box>

      {hasSecondLine ? (
        <Box flexDirection="row" gap={2}>
          {yolo ? (
            <Text color="red" bold>
              ⚠ YOLO
            </Text>
          ) : null}
          {autonomy && autonomy !== 'off' ? (
            <>
              {yolo ? <Text dimColor>│</Text> : null}
              <Text color={autonomy === 'auto' ? 'yellow' : 'cyan'} bold>
                ∞ {autonomy.toUpperCase()}
              </Text>
            </>
          ) : null}
          {elapsedMs !== undefined ? (
            <>
              {yolo ? <Text dimColor>│</Text> : null}
              <Text dimColor>⏱ {fmtElapsed(elapsedMs)}</Text>
            </>
          ) : null}
          {projectName ? (
            <>
              {yolo || elapsedMs !== undefined ? <Text dimColor>│</Text> : null}
              <Text color="blue">📁 {projectName}</Text>
            </>
          ) : null}
          {git ? (
            <>
              {yolo || elapsedMs !== undefined || projectName ? <Text dimColor>│</Text> : null}
              <Text>
                <Text color="magenta">⎇ {git.branch}</Text>
                {git.added > 0 ? <Text color="green"> +{git.added}</Text> : null}
                {git.deleted > 0 ? <Text color="red"> -{git.deleted}</Text> : null}
                {git.untracked > 0 ? <Text dimColor> ?{git.untracked}</Text> : null}
              </Text>
            </>
          ) : null}
        </Box>
      ) : null}

      {hasThirdLine ? (
        <Box flexDirection="row" gap={2}>
          {todos && (todos.pending > 0 || todos.inProgress > 0 || todos.completed > 0) ? (
            <Text>
              <Text dimColor>todos </Text>
              {todos.inProgress > 0 ? <Text color="yellow">⌛{todos.inProgress}</Text> : null}
              {todos.inProgress > 0 && (todos.pending > 0 || todos.completed > 0) ? ' ' : ''}
              {todos.pending > 0 ? <Text dimColor>☐{todos.pending}</Text> : null}
              {todos.pending > 0 && todos.completed > 0 ? ' ' : ''}
              {todos.completed > 0 ? <Text color="green">✓{todos.completed}</Text> : null}
            </Text>
          ) : null}
          {plan && (plan.open > 0 || plan.inProgress > 0 || plan.done > 0) ? (
            <>
              {todos && (todos.pending > 0 || todos.inProgress > 0 || todos.completed > 0) ? (
                <Text dimColor>│</Text>
              ) : null}
              <Text>
                <Text color="cyan">📋 </Text>
                {plan.inProgress > 0 ? <Text color="yellow">⌛{plan.inProgress}</Text> : null}
                {plan.inProgress > 0 && (plan.open > 0 || plan.done > 0) ? ' ' : ''}
                {plan.open > 0 ? <Text dimColor>☐{plan.open}</Text> : null}
                {plan.open > 0 && plan.done > 0 ? ' ' : ''}
                {plan.done > 0 ? <Text color="green">✓{plan.done}</Text> : null}
              </Text>
            </>
          ) : null}
          {fleetHasActivity ? (
            <>
              {((todos && (todos.pending > 0 || todos.inProgress > 0 || todos.completed > 0)) ||
                (plan && (plan.open > 0 || plan.inProgress > 0 || plan.done > 0))) ? (
                <Text dimColor>│</Text>
              ) : null}
              {fleet ? (
                <Text>
                  <Text color="blue">🌐 </Text>
                  {fleet.running > 0 ? <Text color="yellow">▶{fleet.running}</Text> : null}
                  {fleet.running > 0 && (fleet.pending > 0 || fleet.idle > 0 || fleet.completed > 0)
                    ? ' '
                    : ''}
                  {fleet.pending > 0 ? <Text dimColor>☐{fleet.pending}</Text> : null}
                  {fleet.pending > 0 && (fleet.idle > 0 || fleet.completed > 0) ? ' ' : ''}
                  {fleet.idle > 0 ? <Text dimColor>·{fleet.idle}idle</Text> : null}
                  {fleet.idle > 0 && fleet.completed > 0 ? ' ' : ''}
                  {fleet.completed > 0 ? <Text color="green">✓{fleet.completed}</Text> : null}
                </Text>
              ) : (
                <Text color="blue">
                  🌐 {subagentCount} agent{subagentCount === 1 ? '' : 's'}
                </Text>
              )}
            </>
          ) : null}
        </Box>
      ) : null}

      {fleetAgents && fleetAgents.length > 0 ? (
        <Box flexDirection="row" gap={2}>
          {fleetAgents.map((a, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: agent list is stable per render
            <Text key={i}>
              <Text color={a.color} bold>
                {a.label}
              </Text>
              <Text dimColor>{' '}</Text>
              <Text color={a.running ? 'yellow' : undefined} dimColor={!a.running}>
                {a.running ? '▶' : '·'}
              </Text>
              <Text dimColor>{' '}</Text>
              <Text dimColor>{fmtElapsed(a.elapsedMs)}</Text>
              <Text dimColor>{' · '}</Text>
              <Text dimColor>{a.toolCalls}t</Text>
            </Text>
          ))}
        </Box>
      ) : null}
    </Box>
  );
}

function ContextChip({ ctx }: { ctx: ContextWindow }): React.ReactElement {
  const ratio = Math.max(0, Math.min(1, ctx.used / ctx.max));
  const pct = Math.round(ratio * 100); // true percentage of max context
  const filled = ratio === 0 ? 0 : Math.max(1, Math.round(ratio * 10)); // bar cells (min 1 so low usage still visible)
  // Colour ramp: cool while there's plenty of headroom, warn at the
  // two-thirds mark, alarm once we're inside the last 20% — the model
  // typically starts losing the head of the conversation around there.
  const color = ratio >= 0.85 ? 'red' : ratio >= 0.65 ? 'yellow' : 'cyan';
  return (
    <Text>
      <Text dimColor>ctx </Text>
      <Text color={color}>{renderProgress(ratio, 10)}</Text>
      <Text color={color}> {pct}%</Text>
      <Text dimColor>
        {' '}
        ({fmtTok(ctx.used)}/{fmtTok(ctx.max)})
      </Text>
    </Text>
  );
}

const FILLED = '█';
const EMPTY = '░';

/**
 * Render a ratio 0..1 as a width-N block bar. We round to the nearest
 * cell rather than flooring so a 5% bar still shows one filled cell —
 * otherwise low-usage sessions look identical to an empty start.
 */
export function renderProgress(ratio: number, width: number): string {
  const clamped = Math.max(0, Math.min(1, ratio));
  const filled = clamped === 0 ? 0 : Math.max(1, Math.round(clamped * width));
  const capped = Math.min(width, filled);
  return FILLED.repeat(capped) + EMPTY.repeat(width - capped);
}

function fmtTok(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

export function fmtElapsed(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) {
    return `${h}:${pad2(m)}:${pad2(s)}`;
  }
  return `${pad2(m)}:${pad2(s)}`;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}
