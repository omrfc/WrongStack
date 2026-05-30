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
  /** Current/last tool the subagent invoked, shown as its live action. */
  tool?: string;
  /** Cumulative budget auto-extensions granted — rendered as "⚡×N". */
  extensions?: number;
}

export interface ContextWindow {
  /** Input tokens of the most recent provider request — the de-facto live context size. */
  used: number;
  /** Provider's declared maxContext capability. */
  max: number;
}

export interface StatusBarProps {
  model: string;
  /**
   * App version string (e.g. "0.7.0"). When set, renders a compact
   * `WS v0.7.0` chip at the head of line 1 so the running build is always
   * visible, not just in the startup banner.
   */
  version?: string;
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
  /** Autonomy mode chip: 'off' | 'suggest' | 'auto' | 'eternal' | 'eternal-parallel'. */
  autonomy?: 'off' | 'suggest' | 'auto' | 'eternal' | 'eternal-parallel';
  /** Number of tracked bash/exec processes from the process registry. */
  processCount?: number;
  /** Items to hide from the status bar. */
  hiddenItems?: Array<'todos' | 'plan' | 'fleet' | 'git' | 'elapsed' | 'context' | 'cost'>;
  /**
   * Live iteration stage from the eternal engine. When set, renders a
   * chip like `⏸ decide` or `▶ execute(todo:fix-auth)` next to the
   * autonomy chip on line 2.
   */
  eternalStage?: {
    phase: 'idle';
  } | {
    phase: 'decide';
    reason: string;
  } | {
    phase: 'execute';
    task: string;
  } | {
    phase: 'reflect';
    status: 'success' | 'failure' | 'aborted' | 'skipped';
    note?: string;
  } | {
    phase: 'sleep';
    ms: number;
  } | {
    phase: 'paused';
  } | {
    phase: 'stopped';
  } | {
    phase: 'error';
    message: string;
  } | null;
  /** Active goal summary for startup banner display. */
  goalSummary?: {
    goal: string;
    goalState: 'active' | 'paused' | 'completed' | 'abandoned';
    iterations: number;
    lastTask?: string;
    lastStatus?: string;
  } | null;
  /**
   * Seconds remaining in the auto-proceed countdown. null = not counting.
   * Rendered as a chip on line 2 when non-null.
   */
  autoProceedCountdown?: number | null;
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
  version,
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
  processCount,
  hiddenItems,
  eternalStage,
  goalSummary,
  autoProceedCountdown,
}: StatusBarProps): React.ReactElement {
  const hiddenSet = new Set(hiddenItems);
  const usage = tokenCounter?.total();
  const cost = tokenCounter?.estimateCost();
  const cache = tokenCounter?.cacheStats();
  const { label: stateLabel, color: stateColor } = stateChip(state, fleet?.running ?? 0);

  // Line 2 is *session context* — slow-moving facts about where you
  // are: the project, the branch, the elapsed clock, YOLO chip. These
  // change at most once per session.
  const hasSecondLine =
    yolo ||
    (autonomy && autonomy !== 'off') ||
    elapsedMs !== undefined ||
    (git !== null && git !== undefined) ||
    (projectName !== undefined && projectName.length > 0) ||
    (goalSummary !== null && goalSummary !== undefined);

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
        {version ? (
          <>
            <Text>
              <Text color="blue" bold>WS</Text>
              <Text dimColor> v{version}</Text>
            </Text>
            <Text dimColor>│</Text>
          </>
        ) : null}
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
        {typeof processCount === 'number' && processCount > 0 ? (
          <>
            <Text dimColor>│</Text>
            <Text color="red">⚡ {processCount} process{processCount === 1 ? '' : 'es'}</Text>
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
              <Text
                color={
                  autonomy === 'eternal' ? 'red' : autonomy === 'auto' ? 'yellow' : 'cyan'
                }
                bold
              >
                ∞ {autonomy.toUpperCase()}
              </Text>
            </>
          ) : null}
          {eternalStage ? (
            <>
              {yolo || (autonomy && autonomy !== 'off') ? <Text dimColor>│</Text> : null}
              <EternalStageChip stage={eternalStage} />
            </>
          ) : null}
          {elapsedMs !== undefined && !hiddenSet.has('elapsed') ? (
            <>
              {yolo || (autonomy && autonomy !== 'off') || eternalStage ? <Text dimColor>│</Text> : null}
              <Text dimColor>⏱ {fmtElapsed(elapsedMs)}</Text>
            </>
          ) : null}
          {projectName ? (
            <>
              {yolo || elapsedMs !== undefined ? <Text dimColor>│</Text> : null}
              <Text color="blue">📁 {projectName}</Text>
            </>
          ) : null}
          {goalSummary ? (
            <>
              {yolo || elapsedMs !== undefined || projectName ? <Text dimColor>│</Text> : null}
              <Text color={goalSummary.goalState === 'active' ? 'green' : goalSummary.goalState === 'paused' ? 'yellow' : goalSummary.goalState === 'completed' ? 'green' : 'dim'}>
                🎯 {goalSummary.goal.length > 40 ? `${goalSummary.goal.slice(0, 37)}…` : goalSummary.goal} [{goalSummary.goalState}] (iter {goalSummary.iterations})
              </Text>
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
              {a.tool ? (
                <>
                  <Text dimColor>{' · '}</Text>
                  <Text color="cyan">{a.tool}</Text>
                </>
              ) : null}
              {a.extensions && a.extensions > 0 ? (
                <>
                  <Text dimColor>{' · '}</Text>
                  <Text color="yellow">⚡×{a.extensions}</Text>
                </>
              ) : null}
            </Text>
          ))}
        </Box>
      ) : null}
    </Box>
  );
}

function EternalStageChip({
  stage,
}: {
  stage: NonNullable<StatusBarProps['eternalStage']>;
}): React.ReactElement {
  switch (stage.phase) {
    case 'idle':
      return <Text dimColor>⬜ idle</Text>;
    case 'decide':
      return <Text color="cyan">⬇ decide: {stage.reason}</Text>;
    case 'execute':
      return (
        <Text color="green">
          ▶ <Text bold>execute</Text>
          {stage.task ? `(${stage.task})` : ''}
        </Text>
      );
    case 'reflect':
      return (
        <Text color={stage.status === 'success' ? 'green' : stage.status === 'failure' ? 'red' : 'yellow'}>
          ↩ reflect: {stage.status}
        </Text>
      );
    case 'sleep':
      return <Text dimColor>💤 sleep {Math.round(stage.ms / 1000)}s</Text>;
    case 'paused':
      return <Text color="yellow">⏸ paused</Text>;
    case 'stopped':
      return <Text dimColor>■ stopped</Text>;
    case 'error':
      return <Text color="red">⚠ error: {stage.message}</Text>;
  }
}

function ContextChip({ ctx }: { ctx: ContextWindow }): React.ReactElement {
  const ratio = Math.max(0, Math.min(1, ctx.used / ctx.max));
  const pct = Math.round(ratio * 100);
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

/**
 * Compute the leading state chip (label + Ink color) for the status bar.
 *
 * The foreground loop reports 'idle' between turns, but background subagents
 * can still be running — e.g. between eternal/parallel autonomy iterations,
 * or a fleet spawned outside a foreground run. Showing plain "idle" then is
 * misleading, so when `fleetRunning > 0` and the foreground is idle we surface
 * the live agent count (`agents ▶N`) in a distinct color instead.
 */
export function stateChip(
  state: 'idle' | 'running' | 'streaming' | 'aborting',
  fleetRunning: number,
): { label: string; color: string } {
  if (state === 'idle' && fleetRunning > 0) {
    return { label: `agents ▶${fleetRunning}`, color: 'magenta' };
  }
  if (state === 'idle') return { label: 'idle', color: 'cyan' };
  if (state === 'aborting') return { label: 'aborting…', color: 'yellow' };
  return { label: 'thinking…', color: 'green' };
}

const FILLED = '█';
const EMPTY = '░';

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
