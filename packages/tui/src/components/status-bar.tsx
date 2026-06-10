import { expectDefined } from '@wrongstack/core';
import type { TokenCounter, AutonomyStage } from '@wrongstack/core';
import { Box, Text, useStdout } from '../ink.js';
import type React from 'react';
import { useEffect, useState } from 'react';
import type { GitInfo } from '../git-info.js';
// ─── Mode icon map ───────────────────────────────────────────────────────────

/** Map mode ids to compact icons for the status bar chip. */
const MODE_ICONS: Record<string, string> = {
  teach: '🧑‍🏫',
  brief: '⚡',
  'code-reviewer': '🔍',
  'bug-hunter': '🐛',
  'security-scanner': '🛡️',
  'refactor-planner': '🔧',
  architect: '🏗️',
  debugger: '🪲',
  test: '🧪',
  document: '📝',
  'skill-creator': '🛠️',
};

function modeIcon(label?: string): string {
  if (!label) return '';
  const icon = MODE_ICONS[label] ?? '▪';
  return `${icon} ${label}`;
}

/** Minimum terminal width before we switch to ultra-compact mode. Exported so
 *  the TUI mouse hit-test can skip the model-chip click in compact mode (where
 *  line 1 uses a different layout than `statusBarModelSpan` assumes). */
export const COMPACT_THRESHOLD = 50;
/** Above this width, show most available information. */
const COMFORTABLE_THRESHOLD = 90;

// Animated braille spinner shown when the agent is thinking/streaming.
const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const SPINNER_INTERVAL_MS = 250;

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

export interface TaskCounts {
  pending: number;
  inProgress: number;
  completed: number;
  blocked: number;
  failed: number;
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
  tool?: string | undefined;
  /** Cumulative budget auto-extensions granted — rendered as "⚡×N". */
  extensions?: number | undefined;
}

export interface BrainStatusChip {
  state: 'idle' | 'deciding' | 'answered' | 'ask_human' | 'denied';
  source?: string | undefined;
  risk?: 'low' | 'medium' | 'high' | 'critical' | undefined;
  summary?: string | undefined;
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
  version?: string | undefined;
  state: 'idle' | 'running' | 'streaming' | 'aborting';
  tokenCounter?: TokenCounter | undefined;
  hint?: string | undefined;
  queueCount?: number | undefined;
  yolo?: boolean | undefined;
  /** Session start timestamp (ms). Elapsed time is computed internally on
   *  the same interval as the spinner so the display stays live without
   *  forcing a full App tree re-render every second. */
  startedAt?: number | undefined;
  todos?: TodoCounts | undefined;
  /**
   * Plan board counts surfaced as a chip on line 2. Distinct from
   * `todos` — plans are higher-level and persist across resume; the
   * chip uses a different glyph (📋) so the user can tell them apart
   * at a glance.
   */
  plan?: PlanCounts | undefined;
  /**
   * Task board counts surfaced as a chip on line 3. Shows structured
   * work items (from the `task` tool) with type/priority/deps.
   * Distinct from `plan` (strategic) and `todos` (tactical).
   */
  tasks?: TaskCounts | undefined;
  /**
   * Per-status fleet breakdown. When provided, takes precedence over
   * `subagentCount` for chip rendering. `subagentCount` is kept for
   * backwards compatibility when callers haven't wired the richer
   * breakdown yet.
   */
  fleet?: FleetCounts | undefined;
  /**
   * Optional per-agent detail row (up to ~4 agents). Renders below the
   * aggregate fleet chip on a dedicated 4th line so the user can see
   * which specific agent is burning time/tools right now without
   * scrolling history.
   */
  fleetAgents?: FleetAgentDetail[] | undefined;
  git?: GitInfo | null | undefined;
  subagentCount?: number | undefined;
  /** Renders the "ctx ████░░ 42%" chip on line 1 when present. */
  context?: ContextWindow | undefined;
  /** Live Brain arbiter state, shown as a compact work chip when active/recent. */
  brain?: BrainStatusChip | undefined;
  /**
   * Project / working-folder name. Rendered on line 2 just before the git
   * branch so users running multiple WrongStack windows can tell at a
   * glance which repo each one is pinned to. Usually the basename of
   * `agent.ctx.projectRoot`.
   */
  projectName?: string | undefined;
  /**
   * Working directory relative to the project root. Rendered on line 2
   * as a 📂 chip so the user knows which subdirectory tools will resolve
   * against. Updated live via `ctx.onWorkingDirChanged()`.
   */
  workingDir?: string | undefined;
  /** Autonomy mode chip: 'off' | 'suggest' | 'auto' | 'eternal' | 'eternal-parallel'. */
  autonomy?: 'off' | 'suggest' | 'auto' | 'eternal' | 'eternal-parallel' | undefined;
  /** Number of tracked bash/exec processes from the process registry. */
  processCount?: number | undefined;
  /** Items to hide from the status bar. */
  hiddenItems?: Array<'todos' | 'plan' | 'tasks' | 'fleet' | 'git' | 'elapsed' | 'context' | 'cost' | 'working_dir'> | undefined;
  /**
   * Live iteration stage from the active autonomy engine. When set, renders
   * a chip like `⏸ decide` or `▶ execute(todo:fix-auth)` next to the
   * autonomy chip on line 2.
   */
  eternalStage?: AutonomyStage | null | undefined;
  /** Active goal summary for startup banner display. */
  goalSummary?: {
    goal: string;
    goalState: 'active' | 'paused' | 'completed' | 'abandoned';
    iterations: number;
    lastTask?: string | undefined;
    lastStatus?: string | undefined;
  } | null;
  /**
   * Seconds remaining in the auto-proceed countdown. null = not counting.
   * Rendered as a chip on line 2 when non-null.
   */
  autoProceedCountdown?: number | null | undefined;
  /** Codebase indexing state — rendered as a chip on line 1 when indexing. */
  indexState?: { ready: boolean; indexing: boolean; currentFile: number; totalFiles: number };
  /** Active agent mode label with icon (e.g. "🧑‍🏫 teach", "⚡ brief"). Rendered on line 2. */
  modeLabel?: string | undefined;
  /**
   * Live debug-stream telemetry — pushed into the TUI reducer by the
   * throttled callback from stream-debug-state.ts. When non-null, renders
   * a "🐛 stream" chip on line 3 with chunk count, size, delta, and total
   * bytes. Cleared on provider.response (per-iteration stream reset).
   */
  debugStreamStats?: {
    chunkCount: number;
    lastChunkSize: number;
    lastDeltaMs: number;
    totalBytes: number;
    lastChunkAt: string;
  } | null | undefined;
  /**
   * Seconds remaining in the prompt-refinement auto-send countdown.
   * When non-null, replaces the old in-panel timer display with a
   * line-3 chip like `⏳ auto-send in 5s` so the countdown never
   * causes blank entries in the chat scrollback.
   */
  enhanceCountdown?: number | null | undefined;
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
  startedAt,
  todos,
  plan,
  tasks,
  fleet,
  fleetAgents,
  git,
  subagentCount = 0,
  brain,
  projectName,
  workingDir,
  processCount,
  context,
  hiddenItems,
  eternalStage,
  goalSummary,
  indexState,
  modeLabel,
  debugStreamStats,
  enhanceCountdown,
  autoProceedCountdown,
}: StatusBarProps): React.ReactElement {
  // Track terminal width so we can adapt layout on narrow terminals.
  // We snapshot into state so that renders are stable — we don't want
  // the live-region to churn on every resize event during active streaming.
  const { stdout } = useStdout();
  const [termWidth, setTermWidth] = useState(stdout?.columns ?? 90);
  useEffect(() => {
    const handleResize = () => setTermWidth(stdout?.columns ?? 90);
    handleResize(); // snapshot immediately
    process.stdout.on('resize', handleResize);
    return () => {
      process.stdout.off('resize', handleResize);
    };
  }, [stdout]);

  const isCompact = termWidth < COMPACT_THRESHOLD;
  const isComfortable = termWidth >= COMFORTABLE_THRESHOLD;
  const hiddenSet = new Set(hiddenItems);
  const usage = tokenCounter?.total();
  const cost = tokenCounter?.estimateCost();
  const cache = tokenCounter?.cacheStats();

  // Elapsed time display — updated locally on a 1s interval so the "⏱ 12:34"
  // chip stays live without forcing a full App tree re-render.
  const [elapsedMs, setElapsedMs] = useState(startedAt ? Date.now() - startedAt : 0);
  useEffect(() => {
    if (startedAt == null) return;
    const t = setInterval(() => setElapsedMs(Date.now() - startedAt), 1000);
    return () => clearInterval(t);
  }, [startedAt]);

  // Animated braille spinner — cycles while the agent is thinking/streaming.
  // Stops when idle so the interval doesn't drive unnecessary re-renders.
  const [spinnerIdx, setSpinnerIdx] = useState(0);
  useEffect(() => {
    if (state === 'idle' || state === 'aborting') return;
    const t = setInterval(
      () => setSpinnerIdx((n) => (n + 1) % SPINNER_FRAMES.length),
      SPINNER_INTERVAL_MS,
    );
    return () => clearInterval(t);
  }, [state]);
  const spinner = expectDefined(SPINNER_FRAMES[spinnerIdx]);

  const { label: stateLabel, color: stateColor } = stateChip(state, fleet?.running ?? 0);
  // Animated spinner for thinking/streaming; static ● for idle/aborting.
  const statePrefix = state === 'idle' || state === 'aborting' ? '●' : spinner;
  // When the agent is actively working, paint the state chip as a moving
  // rainbow wave (each glyph cycles through the hue wheel, offset per char and
  // shifted by the spinner tick). Idle/aborting stay flat-colored.
  const thinking = state === 'running' || state === 'streaming';

  // Line 2 is *session context* — slow-moving facts about where you
  // are: the project, the branch, the elapsed clock, YOLO chip. These
  // change at most once per session.
  const hasAutoProceed = autoProceedCountdown != null && autoProceedCountdown > 0;
  const hasSecondLine =
    yolo ||
    (autonomy && autonomy !== 'off') ||
    startedAt != null ||
    (git !== null && git !== undefined) ||
    (projectName !== undefined && projectName.length > 0) ||
    (workingDir !== undefined && workingDir.length > 0) ||
    (goalSummary !== null && goalSummary !== undefined) ||
    !!modeLabel ||
    hasAutoProceed;

  // Line 3 is *active work* — the dynamic chips that mutate as the
  // agent / subagents make progress. Hidden when nothing is in flight
  // so a fresh session keeps the two-line baseline.
  const fleetHasActivity =
    (fleet && (fleet.running > 0 || fleet.idle > 0 || fleet.pending > 0 || fleet.completed > 0)) ||
    subagentCount > 0;
  const hasBrainActivity = !!brain && brain.state !== 'idle';
  const hasDebugStream = !!debugStreamStats;
  const hasEnhanceCountdown = enhanceCountdown != null && enhanceCountdown > 0;
  const hasTaskActivity = tasks && (tasks.pending > 0 || tasks.inProgress > 0 || tasks.completed > 0 || tasks.blocked > 0 || tasks.failed > 0);
  const hasThirdLine =
    (todos && (todos.pending > 0 || todos.inProgress > 0 || todos.completed > 0)) ||
    (plan && (plan.open > 0 || plan.inProgress > 0 || plan.done > 0)) ||
    hasTaskActivity ||
    fleetHasActivity ||
    hasBrainActivity ||
    hasDebugStream ||
    hasEnhanceCountdown;

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
      {/* Line 1: Essential runtime info. Compact mode shows only state + model. */}
      <Box flexDirection="row" gap={2}>
        {isCompact ? (
          // Ultra-compact: state · model
          <>
            {thinking ? (
              <WaveText text={`${statePrefix}${stateLabel}`} phase={spinnerIdx} />
            ) : (
              <Text color={stateColor}>
                {statePrefix}
                {stateLabel}
              </Text>
            )}
            <Text dimColor>·</Text>
            <Text color="magenta">{model}</Text>
          </>
        ) : (
          // Full mode: version · state · model · context · tokens · cost · queue · processes · hint
          <>
            {version ? (
              <>
                <Text>
                  <Text color="blue" bold>
                    WS
                  </Text>
                  <Text dimColor> v{version}</Text>
                </Text>
                <Text dimColor>│</Text>
              </>
            ) : null}
            {thinking ? (
              <WaveText text={`${statePrefix} ${stateLabel}`} phase={spinnerIdx} />
            ) : (
              <Text color={stateColor}>
                {statePrefix} {stateLabel}
              </Text>
            )}
            <Text dimColor>│</Text>
            <Text color="magenta">{model}</Text>
            {context && !hiddenSet.has('context') ? (
              <>
                <Text dimColor>│</Text>
                <Text color={context.used / context.max < 0.6 ? 'green' : context.used / context.max < 0.75 ? 'yellow' : 'red'}>
                  ctx {renderMeter(context.used / context.max, 8)} {Math.round((context.used / context.max) * 100)}%
                </Text>
              </>
            ) : null}
            {usage && isComfortable ? (
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
            {cache && cache.hitRatio > 0 && isComfortable ? (
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
                <Text color="red">
                  ⚡ {processCount} process{processCount === 1 ? '' : 'es'}
                </Text>
              </>
            ) : null}
            {hint ? (
              <>
                <Text dimColor>│</Text>
                <Text dimColor>{hint}</Text>
              </>
            ) : null}
            {indexState?.indexing ? (
              <>
                <Text dimColor>│</Text>
                <Text color="yellow">
                  ⚙ indexing {indexState.currentFile}/{indexState.totalFiles}
                </Text>
              </>
            ) : null}
          </>
        )}
      </Box>

      {/* Line 2 always rendered — empty spacer when no content, to keep the
          live-region height stable. Without this, the
          StatusBar jumping from 1→2 or 2→1 lines shifts the Ink layout and
          pushes the input area into the static history scrollback. */}
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
                color={autonomy === 'eternal' ? 'red' : autonomy === 'auto' ? 'yellow' : 'cyan'}
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
              {yolo || (autonomy && autonomy !== 'off') || eternalStage ? (
                <Text dimColor>│</Text>
              ) : null}
              <Text dimColor>⏱ {fmtElapsed(elapsedMs)}</Text>
            </>
          ) : null}
          {projectName ? (
            <>
              {yolo || startedAt != null ? <Text dimColor>│</Text> : null}
              <Text color="blue">📁 {projectName}</Text>
            </>
          ) : null}
          {workingDir && !hiddenSet.has('working_dir') ? (
            <>
              {yolo ||
              startedAt != null ||
              projectName ||
              goalSummary ? (
                <Text dimColor>│</Text>
              ) : null}
              <Text color="blue">📂 {workingDir}</Text>
            </>
          ) : null}
          {goalSummary ? (
            <>
              {yolo || startedAt != null || projectName || workingDir ? <Text dimColor>│</Text> : null}
              <Text
                color={
                    ? 'green'
                    : goalSummary.goalState === 'paused'
                      ? 'yellow'
                      : goalSummary.goalState === 'completed'
                        ? 'green'
                        : 'dim'
                }
              >
                🎯{' '}
                {goalSummary.goal.length > 40
                  ? `${goalSummary.goal.slice(0, 37)}…`
                  : goalSummary.goal}{' '}
                [{goalSummary.goalState}] (iter {goalSummary.iterations})
              </Text>
            </>
          ) : null}
          {modeLabel ? (
            <>
              {yolo ||
              (autonomy && autonomy !== 'off') ||
              eternalStage ||
              startedAt != null ||
              projectName ||
              workingDir ||
              goalSummary ? (
                <Text dimColor>│</Text>
              ) : null}
              <Text color="cyan">{modeIcon(modeLabel)}</Text>
            </>
          ) : null}
          {hasAutoProceed ? (
            <>
              {yolo ||
              (autonomy && autonomy !== 'off') ||
              eternalStage ||
              startedAt != null ||
              projectName ||
              workingDir ||
              goalSummary ||
              modeLabel ? (
                <Text dimColor>│</Text>
              ) : null}
              <Text color={autoProceedCountdown != null && autoProceedCountdown <= 5 ? 'yellow' : 'cyan'}>
                ⏳ auto in {autoProceedCountdown}s
              </Text>
            </>
          ) : null}
          {git ? (
            <>
              {yolo || startedAt != null || projectName || workingDir ? <Text dimColor>│</Text> : null}
              <Text>
                <Text color="magenta">⎇ {git.branch}</Text>
                {git.deleted > 0 ? <Text color="red"> -{git.deleted}</Text> : null}
                {git.untracked > 0 ? <Text dimColor> ?{git.untracked}</Text> : null}
              </Text>
            </>
          ) : null}
        </Box>
      ) : (
        <Box height={1}>
          <Text> </Text>
        </Box>
      )}

      {/* Line 3 always rendered — same stability guarantee as line 2. */}
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
          {hasTaskActivity ? (
            <>
              {(todos && (todos.pending > 0 || todos.inProgress > 0 || todos.completed > 0)) ||
              (plan && (plan.open > 0 || plan.inProgress > 0 || plan.done > 0)) ? (
                <Text dimColor>│</Text>
              ) : null}
              <Text>
                <Text color="magenta">⚡ </Text>
                {tasks!.inProgress > 0 ? <Text color="yellow">⌛{tasks!.inProgress}</Text> : null}
                {tasks!.inProgress > 0 && (tasks!.pending > 0 || tasks!.blocked > 0) ? ' ' : ''}
                {tasks!.pending > 0 ? <Text dimColor>☐{tasks!.pending}</Text> : null}
                {tasks!.pending > 0 && tasks!.blocked > 0 ? ' ' : ''}
                {tasks!.blocked > 0 ? <Text color="red">⊘{tasks!.blocked}</Text> : null}
                {(tasks!.pending > 0 || tasks!.blocked > 0) && (tasks!.completed > 0 || tasks!.failed > 0) ? ' ' : ''}
                {tasks!.completed > 0 ? <Text color="green">✓{tasks!.completed}</Text> : null}
                {tasks!.completed > 0 && tasks!.failed > 0 ? ' ' : ''}
                {tasks!.failed > 0 ? <Text color="red">✗{tasks!.failed}</Text> : null}
              </Text>
            </>
          ) : null}
          {fleetHasActivity ? (
            <>
              {(todos && (todos.pending > 0 || todos.inProgress > 0 || todos.completed > 0)) ||
              (plan && (plan.open > 0 || plan.inProgress > 0 || plan.done > 0)) ? (
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
          {hasBrainActivity && brain ? (
            <>
              {(todos && (todos.pending > 0 || todos.inProgress > 0 || todos.completed > 0)) ||
              (plan && (plan.open > 0 || plan.inProgress > 0 || plan.done > 0)) ||
              fleetHasActivity ? (
                <Text dimColor>│</Text>
              ) : null}
              <BrainChip brain={brain} />
            </>
          ) : null}
          {hasDebugStream && debugStreamStats ? (
            <>
              {(todos && (todos.pending > 0 || todos.inProgress > 0 || todos.completed > 0)) ||
              (plan && (plan.open > 0 || plan.inProgress > 0 || plan.done > 0)) ||
              fleetHasActivity ||
              hasBrainActivity ? (
                <Text dimColor>│</Text>
              ) : null}
              <Text color="cyan">
                <Text bold>🐛 stream</Text>
                <Text dimColor> #{debugStreamStats.chunkCount}</Text>
                <Text dimColor> · {debugStreamStats.lastChunkSize}B</Text>
                <Text dimColor> · +{debugStreamStats.lastDeltaMs}ms</Text>
                <Text dimColor> · {fmtDebugBytes(debugStreamStats.totalBytes)}</Text>
              </Text>
            </>
          ) : null}
          {hasEnhanceCountdown && enhanceCountdown != null ? (
            <>
              {(todos && (todos.pending > 0 || todos.inProgress > 0 || todos.completed > 0)) ||
              (plan && (plan.open > 0 || plan.inProgress > 0 || plan.done > 0)) ||
              fleetHasActivity ||
              hasBrainActivity ||
              hasDebugStream ? (
                <Text dimColor>│</Text>
              ) : null}
              <Text color={enhanceCountdown <= 5 ? 'yellow' : 'cyan'}>
                ⏳ auto-send in {enhanceCountdown}s
              </Text>
            </>
          ) : null}
        </Box>
      ) : (
        <Box height={1}>
          <Text> </Text>
        </Box>
      )}

      {/* Fleet agent detail line — always rendered with a spacer so the
          live-region height never changes when subagents start/stop.
          Without this the Input area above scrolls into static history
          when the first agent appears (the "pyramid" bug). */}
      {fleetAgents && fleetAgents.length > 0 ? (
        <Box flexDirection="row" gap={2}>
          {fleetAgents.map((a, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: agent list is stable per render
            <Text key={i}>
              <Text color={a.color} bold>
                {a.label}
              </Text>
              <Text dimColor> </Text>
              <Text dimColor={!a.running} {...(a.running ? { color: 'yellow' } : {})}>
                {a.running ? '▶' : '·'}
              </Text>
              <Text dimColor> </Text>
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
      ) : (
        <Box height={1}>
          <Text> </Text>
        </Box>
      )}
    </Box>
  );
}

function BrainChip({ brain }: { brain: BrainStatusChip }): React.ReactElement {
  const color =
    brain.state === 'denied'
      ? 'red'
      : brain.state === 'ask_human'
        ? 'yellow'
        : brain.state === 'deciding'
          ? 'magenta'
          : 'cyan';
  const label =
    brain.state === 'deciding' ? 'deciding' : brain.state === 'ask_human' ? 'human' : brain.state;
  const scope = brain.source ? ` ${brain.source}` : '';
  const summary = brain.summary ? ` · ${brain.summary.slice(0, 40)}` : '';
  return (
    <Text color={color}>
      🧠 {label}
      <Text dimColor>{scope}</Text>
      <Text dimColor>{summary}</Text>
    </Text>
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
        <Text
          color={
            stage.status === 'success' ? 'green' : stage.status === 'failure' ? 'red' : 'yellow'
          }
        >
          ↩ reflect: {stage.status}
        </Text>
      );
    case 'decompose':
      return <Text color="cyan">⬇ decompose</Text>;
    case 'fanout':
      return <Text color="magenta">⇄ fanout: {stage.slots}</Text>;
    case 'await':
      return <Text color="magenta">⏳ await: {stage.taskIds.length}</Text>;
    case 'aggregate':
      return (
        <Text color={stage.goalComplete ? 'green' : 'magenta'}>
          ↩ aggregate: {stage.successCount}/{stage.total}
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

/**
 * Compute the leading state chip (label + Ink color) for the status bar.
 *
 * The foreground loop reports 'idle' between turns, but background subagents
 * can still be running — e.g. between eternal/parallel autonomy iterations,
 * or a fleet spawned outside a foreground run. Showing plain "idle" then is
 * misleading, so when `fleetRunning > 0` and the foreground is idle we surface
 * the live agent count (`agents ▶N`) in a distinct color instead.
 */
// Layout constants shared by the status-bar span helpers below — they MUST
// mirror the `<Box gap={2} paddingX={1}>` rows rendered above so the TUI mouse
// hit-test lands on the right chip.
const SB_GAP = 2;
const SB_PADX = 1;

/**
 * 0-based column span (offset from the box's left edge, including the left
 * paddingX) of the `{provider}/{model}` chip on status-bar line 1. The TUI
 * mouse handler uses it to make the model chip clickable (→ open model
 * picker). Mirrors the line-1 flex layout: optional `WS v…` chip + `│`, then
 * `● {stateLabel}` + `│`, then the model.
 */
export function statusBarModelSpan(opts: {
  version?: string | undefined;
  state: 'idle' | 'running' | 'streaming' | 'aborting';
  fleetRunning?: number | undefined;
  model: string;
}): { start: number; len: number } {
  let col = SB_PADX;
  if (opts.version) {
    col += `WS v${opts.version}`.length + SB_GAP; // WS chip
    col += 1 + SB_GAP; // │ separator
  }
  const { label } = stateChip(opts.state, opts.fleetRunning ?? 0);
  col += 2 + label.length + SB_GAP; // "● " + label
  col += 1 + SB_GAP; // │ separator
  return { start: col, len: opts.model.length };
}

/**
 * 0-based column span of the `∞ MODE` autonomy chip on status-bar line 2, or
 * null when it isn't shown (autonomy off/unset). When YOLO is on it precedes
 * the autonomy chip (plus a `│` separator), so the span shifts right.
 */
export function statusBarAutonomySpan(opts: {
  yolo?: boolean | undefined;
  autonomy?: 'off' | 'suggest' | 'auto' | 'eternal' | 'eternal-parallel' | undefined;
}): { start: number; len: number } | null {
  if (!opts.autonomy || opts.autonomy === 'off') return null;
  let col = SB_PADX;
  if (opts.yolo) {
    col += '⚠ YOLO'.length + SB_GAP;
    col += 1 + SB_GAP; // │ separator
  }
  return { start: col, len: 2 + opts.autonomy.toUpperCase().length }; // "∞ " + MODE
}

/**
 * 0-based column span of the `todos ⌛N ☐M ✓K` chip on status-bar line 3.
 * Returns null when no todos are visible. Used by the TUI mouse handler
 * to make the todos chip clickable (→ F5 right panel / F6 overlay).
 * The chip is always at the start of line 3 with only left padding.
 */
export function statusBarTodosSpan(): { start: number; len: number } {
  // Line 3: paddingX(1) + chip text (variable). The chip is the first item.
  // We return a fixed span for the label portion — the exact width depends
  // on counts, so we use a generous estimate that covers "todos ⌛99 ☐99 ✓99".
  const LABEL_MAX = 20;
  return { start: SB_PADX, len: LABEL_MAX };
}

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

// Pastel (Catppuccin Mocha) hue-wheel for the animated "thinking…" wave. 12
// stops give a smooth gradient as the per-character offset shifts each spinner
// tick — soft tones so the wave stays gentle rather than neon.
const WAVE_COLORS = [
  '#f38ba8', // red
  '#eba0ac', // maroon
  '#fab387', // peach
  '#f9e2af', // yellow
  '#a6e3a1', // green
  '#94e2d5', // teal
  '#89dceb', // sky
  '#89b4fa', // blue
  '#b4befe', // lavender
  '#cba6f7', // mauve
  '#f5c2e7', // pink
  '#f2cdcd', // flamingo
];

/**
 * Render `text` as a moving rainbow: each glyph gets a color from {@link
 * WAVE_COLORS} indexed by (charIndex + phase), so advancing `phase` slides the
 * gradient sideways like a wave. Whitespace is emitted plain (color is a no-op
 * on it) to keep word spacing intact.
 */
function WaveText({ text, phase }: { text: string; phase: number }): React.ReactElement {
  return (
    <Text bold>
      {Array.from(text).map((ch, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: glyph order is positional and re-rendered each tick
        <Text key={i} color={WAVE_COLORS[(i + phase) % WAVE_COLORS.length] ?? '#ffffff'}>
          {ch}
        </Text>
      ))}
    </Text>
  );
}

const FILLED = '█';
const EMPTY = '░';

export function renderProgress(ratio: number, width: number): string {
  const clamped = Math.max(0, Math.min(1, ratio));
  const filled = clamped === 0 ? 0 : Math.max(1, Math.round(clamped * width));
  const capped = Math.min(width, filled);
  return FILLED.repeat(capped) + EMPTY.repeat(width - capped);
}

// Sub-cell-precise meter: each cell is 1/8 resolution via Unicode block
// fractions, so the bar grows smoothly token-by-token instead of jumping a
// whole cell. Empty track stays '░'. Total width is always `width` chars.
const EIGHTHS = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉'];

export function renderMeter(ratio: number, width: number): string {
  const clamped = Math.max(0, Math.min(1, ratio));
  let remaining = Math.round(clamped * width * 8);
  let out = '';
  for (let i = 0; i < width; i++) {
    if (remaining >= 8) {
      out += FILLED;
      remaining -= 8;
    } else if (remaining > 0) {
      out += EIGHTHS[remaining];
      remaining = 0;
    } else {
      out += EMPTY;
    }
  }
  return out;
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

function fmtDebugBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1_048_576) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / 1_048_576).toFixed(1)}MB`;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}
