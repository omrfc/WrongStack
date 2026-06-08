import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import * as os from 'node:os';
import { atomicWrite } from '../utils/atomic-write.js';
import { color } from '../utils/color.js';
import { FsError, ERROR_CODES } from '../types/errors.js';

/**
 * Long-running autonomous mission. A goal survives across sessions and
 * drives the EternalAutonomyEngine — every iteration of the engine
 * consults the goal to choose what to do next.
 *
 * Storage: `~/.wrongstack/projects/<hash>/goal.json`. Persistent and
 * project-scoped on purpose: the goal belongs to the codebase, not the
 * REPL session.
 */

export interface JournalEntry {
  /** ISO timestamp of the iteration. */
  at: string;
  /** Sequential iteration counter (1-based, monotonically increasing). */
  iteration: number;
  /** Source that produced the action ('todo' | 'git' | 'brainstorm' | 'resume' | 'manual' | 'parallel'). */
  source: 'todo' | 'git' | 'brainstorm' | 'resume' | 'manual' | 'parallel';
  /** Short one-line description of what the iteration set out to do. */
  task: string;
  /** Outcome status. */
  status: 'success' | 'failure' | 'aborted' | 'skipped';
  /** Optional free-form note (error message, summary, etc.). */
  note?: string | undefined;
  /** Optional token usage delta for this iteration. */
  tokens?: { input: number; output: number } | undefined;
  /** Optional USD cost delta for this iteration (provider-estimated). */
  costUsd?: number | undefined;
}

export interface GoalFile {
  version: 1;
  /** The raw mission statement as entered by the user. */
  goal: string;
  /**
   * LLM-refined version of the goal — unambiguous, with concrete
   * deliverables and acceptance criteria.
   */
  refinedGoal?: string | undefined;
  /**
   * Concrete, verifiable deliverables extracted from the refined goal.
   */
  deliverables?: string[] | undefined;
  /**
   * Estimated completion 0-100. Updated by the engine after each
   * iteration. Null means "not yet assessed".
   */
  progress?: number | undefined;
  /** Human-readable note explaining the current progress estimate. */
  progressNote?: string | undefined;
  /**
   * Time-series of progress measurements for trend analysis.
   * Last 200 entries retained. Use `recordProgress()` to append.
   */
  progressHistory?: ProgressSnapshot[] | undefined;
  /**
   * Computed trend from recent progress measurements.
   * 'accelerating' | 'steady' | 'stalling' | undefined.
   */
  progressTrend?: 'accelerating' | 'steady' | 'stalling' | undefined;
  /** When the goal was first set or last replaced. */
  setAt: string;
  /** Updated on every iteration completion. */
  lastActivityAt: string;
  /** Total iterations the engine has run against this goal (cumulative). */
  iterations: number;
  /** Engine lifecycle state — 'running' means another process owns this goal. */
  engineState: 'idle' | 'running' | 'stopped';
  /**
   * Mission-level lifecycle.
   */
  goalState?: 'active' | 'paused' | 'completed' | 'abandoned' | undefined;
  /**
   * Per-todo attempt counter.
   */
  todoAttempts?: Record<string, number>;
  /** Bounded ring buffer of recent iterations (newest last). */
  journal: JournalEntry[];
}

/** Cap on persisted journal entries — older entries are evicted FIFO. */
export const MAX_JOURNAL_ENTRIES = 500;

/**
 * Resolve the goal file path for a given project root.
 */
export function goalFilePath(projectRoot: string): string {
  const hash = createHash('sha256').update(path.resolve(projectRoot)).digest('hex').slice(0, 12);
  return path.join(os.homedir(), '.wrongstack', 'projects', hash, 'goal.json');
}

export async function loadGoal(filePath: string): Promise<GoalFile | null> {
  let raw: string;
  try {
    raw = await fsp.readFile(filePath, 'utf8');
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as GoalFile;
    if (parsed?.version !== 1 || typeof parsed.goal !== 'string' || !Array.isArray(parsed.journal)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export async function saveGoal(filePath: string, goal: GoalFile): Promise<void> {
  try {
    await atomicWrite(filePath, JSON.stringify(goal, null, 2), { mode: 0o600 });
  } catch (err) {
    throw new FsError({
      message: err instanceof Error ? err.message : String(err),
      code: ERROR_CODES.FS_ATOMIC_WRITE_FAILED,
      path: filePath,
      cause: err,
    });
  }
}

export function emptyGoal(goal: string): GoalFile {
  const now = new Date().toISOString();
  return {
    version: 1,
    goal,
    setAt: now,
    lastActivityAt: now,
    iterations: 0,
    engineState: 'idle',
    goalState: 'active',
    todoAttempts: {},
    journal: [],
  };
}

/**
 * Set progress estimate on a goal. Returns a new GoalFile.
 * Clamps progress to 0-100.
 */
export function setProgress(
  goal: GoalFile,
  progress: number,
  note?: string,
): GoalFile {
  const clamped = Math.min(100, Math.max(0, progress));
  return {
    ...goal,
    progress: clamped,
    progressNote: note ?? clamped + '% complete',
  };
}

/**
 * Append a journal entry, bumping iteration counters and trimming the
 * ring buffer. Returns a new GoalFile — does not mutate the argument.
 */
export function appendJournal(goal: GoalFile, entry: Omit<JournalEntry, 'iteration' | 'at'>): GoalFile {
  const iteration = goal.iterations + 1;
  const at = new Date().toISOString();
  const full: JournalEntry = { ...entry, iteration, at };
  const journal = [...goal.journal, full];
  const trimmed = journal.length > MAX_JOURNAL_ENTRIES
    ? journal.slice(journal.length - MAX_JOURNAL_ENTRIES)
    : journal;
  return {
    ...goal,
    iterations: iteration,
    lastActivityAt: at,
    journal: trimmed,
  };
}

/**
 * Aggregate cumulative cost + tokens across all journal entries.
 */
export function summarizeUsage(goal: GoalFile): {
  totalCostUsd: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  iterationsWithUsage: number;
} {
  let totalCostUsd = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let iterationsWithUsage = 0;
  for (const e of goal.journal) {
    if (typeof e.costUsd === 'number') totalCostUsd += e.costUsd;
    if (e.tokens) {
      totalInputTokens += e.tokens.input;
      totalOutputTokens += e.tokens.output;
    }
    if (typeof e.costUsd === 'number' || e.tokens) iterationsWithUsage++;
  }
  return { totalCostUsd, totalInputTokens, totalOutputTokens, iterationsWithUsage };
}

const DOLLAR = '\u0024';

/** Format the goal + recent journal as a human-readable status block. */
export function formatGoal(goal: GoalFile, journalLimit = 10): string {
  const lines: string[] = [];

  // Header — show refined goal, with original as annotation if different
  const displayGoal = goal.refinedGoal || goal.goal;
  lines.push(color.bold('Goal') + ': ' + displayGoal);
  if (goal.refinedGoal && goal.refinedGoal !== goal.goal) {
    const snippet = goal.goal.length > 60 ? goal.goal.slice(0, 60) + '…' : goal.goal;
    lines.push(color.dim('  (original: "' + snippet + '")'));
  }

  // Progress bar (20-segment)
  if (typeof goal.progress === 'number') {
    const pct = Math.min(100, Math.max(0, Math.round(goal.progress)));
    const filled = Math.round(pct / 5);
    const empty = 20 - filled;
    const bar = color.green('█'.repeat(filled)) + color.dim('░'.repeat(empty));
    lines.push('Progress: ' + bar + ' ' + color.bold(pct + '%'));
    if (goal.progressNote) {
      lines.push('  ' + color.dim(goal.progressNote));
    }
    // Trend indicator
    if (goal.progressTrend) {
      const trendIcon = goal.progressTrend === 'accelerating' ? '🚀'
        : goal.progressTrend === 'stalling' ? '⚠️'
        : '➡️';
      lines.push('  Trend: ' + trendIcon + ' ' + goal.progressTrend);
    }
  }

  // Deliverables checklist
  if (goal.deliverables && goal.deliverables.length > 0) {
    lines.push('');
    lines.push(color.bold('Deliverables:'));
    for (const d of goal.deliverables) {
      const done = /^\[[x✓]\]|✅|\(done\)/i.test(d);
      const marker = done ? color.green('✓') : color.dim('○');
      lines.push('  ' + marker + ' ' + d);
    }
  }

  lines.push('');
  lines.push('Set: ' + goal.setAt);
  lines.push('Last activity: ' + goal.lastActivityAt);
  lines.push('Iterations: ' + goal.iterations);
  const stateLabel = goal.goalState ?? 'active';
  lines.push('State: ' + stateLabel + (goal.iterations > 0 ? ' (iteration #' + goal.iterations + ')' : ''));
  lines.push('Engine: ' + goal.engineState);
  const usage = summarizeUsage(goal);
  if (usage.iterationsWithUsage > 0) {
    const spent = 'Spent: ' + DOLLAR + usage.totalCostUsd.toFixed(4)
      + '  (in ' + usage.totalInputTokens + ' / out ' + usage.totalOutputTokens
      + ' tokens across ' + usage.iterationsWithUsage + ' iterations)';
    lines.push(spent);
  }
  if (goal.journal.length > 0) {
    lines.push('');
    lines.push('Recent journal (last ' + Math.min(journalLimit, goal.journal.length) + '):');
    const tail = goal.journal.slice(-journalLimit);
    for (const e of tail) {
      const mark = e.status === 'success' ? '✓' : e.status === 'failure' ? '✗' : e.status === 'aborted' ? '⊘' : '·';
      const note = e.note ? ' — ' + e.note : '';
      const cost = typeof e.costUsd === 'number' ? ' (' + DOLLAR + e.costUsd.toFixed(4) + ')' : '';
      lines.push('  #' + e.iteration + ' ' + mark + ' [' + e.source + '] ' + e.task + cost + note);
    }
  }
  return lines.join('\n');
}

/** A single progress measurement at a point in time. */
export interface ProgressSnapshot {
  at: string;
  progress: number;
  note?: string | undefined;
}

/**
 * Parse [PROGRESS: N%] from agent final text.
 * Supports formats:
 *   [PROGRESS: 45%]
 *   [PROGRESS: 45%] — 3/5 deliverables done
 *   [progress: 100%]
 * Returns null if no match.
 */
export function parseProgressFromText(text: string): { progress: number; note?: string } | null {
  const re = /\[progress:\s*(\d{1,3})%\]\s*(?:[—\-]\s*(.+))?/i;
  const m = text.match(re);
  if (!m) return null;
  const progress = Math.min(100, Math.max(0, Number.parseInt(m[1]!, 10)));
  const note = m[2]?.trim() || undefined;
  return { progress, note };
}

/**
 * Record a progress measurement. Returns a new GoalFile with:
 * - progress + progressNote updated
 * - progressHistory appended (last 200 entries kept)
 * - progress trend computed (accelerating/steady/stalling)
 */
export function recordProgress(
  goal: GoalFile,
  progress: number,
  note?: string,
): GoalFile {
  const clamped = Math.min(100, Math.max(0, progress));
  const history = [...(goal.progressHistory ?? []), { at: new Date().toISOString(), progress: clamped, note }];
  // Keep last 200 snapshots
  const trimmed = history.length > 200 ? history.slice(-200) : history;

  return {
    ...goal,
    progress: clamped,
    progressNote: note ?? `${clamped}% complete`,
    progressHistory: trimmed,
    progressTrend: computeTrend(trimmed),
  };
}

/** Max progress history entries to retain. */
export const MAX_PROGRESS_HISTORY = 200;

function computeTrend(history: ProgressSnapshot[]): 'accelerating' | 'steady' | 'stalling' | undefined {
  if (history.length < 3) return undefined;
  const recent = history.slice(-5);
  const deltas: number[] = [];
  for (let i = 1; i < recent.length; i++) {
    deltas.push(recent[i]!.progress - recent[i - 1]!.progress);
  }
  if (deltas.length < 2) return undefined;
  const avgDelta = deltas.reduce((a, b) => a + b, 0) / deltas.length;
  if (avgDelta > 2) return 'accelerating';
  if (avgDelta < -1) return 'stalling';
  return 'steady';
}
