import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { atomicWrite } from '../utils/atomic-write.js';

/**
 * Long-running autonomous mission. A goal survives across sessions and
 * drives the EternalAutonomyEngine — every iteration of the engine
 * consults the goal to choose what to do next.
 *
 * Storage: `<projectRoot>/.wrongstack/goal.json`. Persistent and
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
  note?: string;
  /** Optional token usage delta for this iteration. */
  tokens?: { input: number; output: number };
  /** Optional USD cost delta for this iteration (provider-estimated). */
  costUsd?: number;
}

export interface GoalFile {
  version: 1;
  /** The mission statement. */
  goal: string;
  /** When the goal was first set or last replaced. */
  setAt: string;
  /** Updated on every iteration completion. */
  lastActivityAt: string;
  /** Total iterations the engine has run against this goal (cumulative). */
  iterations: number;
  /** Engine lifecycle state — 'running' means another process owns this goal. */
  engineState: 'idle' | 'running' | 'stopped';
  /**
   * Mission-level lifecycle. `active` is the default; `completed` is set
   * when the engine detects `[GOAL_COMPLETE]` in a successful iteration's
   * final text AND a verification pass agrees; `abandoned` is set by the
   * user (e.g. `/goal abandon`) or when the engine exceeds a configured
   * failure ceiling. Once not `active`, the engine refuses to run further
   * iterations against this goal — protects against accidental restarts
   * burning through API quota after the work is done.
   *
   * Optional for backward compatibility — pre-existing `goal.json` files
   * without this field load as `active`.
   */
  goalState?: 'active' | 'paused' | 'completed' | 'abandoned';
  /**
   * Per-todo attempt counter. Keyed by TodoItem id. Used by the engine
   * to skip a todo that has failed N times rather than spinning on it
   * forever. Persisted so attempt counts survive restarts (`/autonomy
   * stop` + resume should not reset progress against a stuck task).
   */
  todoAttempts?: Record<string, number>;
  /** Bounded ring buffer of recent iterations (newest last). */
  journal: JournalEntry[];
}

/** Cap on persisted journal entries — older entries are evicted FIFO. */
export const MAX_JOURNAL_ENTRIES = 500;

/**
 * Resolve the goal file path for a given project root.
 * Exposed so the engine and CLI use one canonical path.
 */
export function goalFilePath(projectRoot: string): string {
  return path.join(projectRoot, '.wrongstack', 'goal.json');
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
  await atomicWrite(filePath, JSON.stringify(goal, null, 2), { mode: 0o600 });
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
 * Append a journal entry, bumping iteration counters and trimming the
 * ring buffer. Returns a new GoalFile — does not mutate the argument.
 */
export function appendJournal(goal: GoalFile, entry: Omit<JournalEntry, 'iteration' | 'at'>): GoalFile {
  const iteration = goal.iterations + 1;
  const at = new Date().toISOString();
  const full: JournalEntry = { ...entry, iteration, at };
  const journal = [...goal.journal, full];
  // Trim FIFO if over cap. Slice from the tail so the *newest* MAX entries survive.
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
 * Aggregate cumulative cost + tokens across all journal entries. Entries
 * without telemetry are skipped (legacy entries from before the field
 * was added still load cleanly).
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

/** Format the goal + recent journal as a human-readable status block. */
export function formatGoal(goal: GoalFile, journalLimit = 10): string {
  const lines: string[] = [];
  lines.push(`Goal: ${goal.goal}`);
  lines.push(`Set: ${goal.setAt}`);
  lines.push(`Last activity: ${goal.lastActivityAt}`);
  lines.push(`Iterations: ${goal.iterations}`);
  const stateLabel = goal.goalState ?? 'active';
  lines.push(`State: ${stateLabel}${goal.iterations > 0 ? ` (iteration #${goal.iterations})` : ''}`);
  lines.push(`Engine: ${goal.engineState}`);
  const usage = summarizeUsage(goal);
  if (usage.iterationsWithUsage > 0) {
    lines.push(
      `Spent: $${usage.totalCostUsd.toFixed(4)}  (in ${usage.totalInputTokens} / out ${usage.totalOutputTokens} tokens across ${usage.iterationsWithUsage} iterations)`,
    );
  }
  if (goal.journal.length > 0) {
    lines.push('');
    lines.push(`Recent journal (last ${Math.min(journalLimit, goal.journal.length)}):`);
    const tail = goal.journal.slice(-journalLimit);
    for (const e of tail) {
      const mark = e.status === 'success' ? '✓' : e.status === 'failure' ? '✗' : e.status === 'aborted' ? '⊘' : '·';
      const note = e.note ? ` — ${e.note}` : '';
      const cost = typeof e.costUsd === 'number' ? ` ($${e.costUsd.toFixed(4)})` : '';
      lines.push(`  #${e.iteration} ${mark} [${e.source}] ${e.task}${cost}${note}`);
    }
  }
  return lines.join('\n');
}
