// ── Goal types + parsing ─────────────────────────────────────────────────────
// Pure, dependency-free module shared by the GoalPanel component and the goal
// store. Kept out of GoalPanel.tsx so non-React consumers (stores, tests under
// the root vitest config which has no `@` alias) don't pull in React/lucide.

export interface GoalDeliverable {
  id: string;
  text: string;
  status: 'pending' | 'done';
}

export interface GoalJournalEntry {
  iteration: number;
  task?: string | undefined;
  status?: string | undefined;
  progress?: number | undefined;
  progressNote?: string | undefined;
  timestamp?: string | undefined;
}

export interface GoalState {
  goal: string;
  refinedGoal?: string | undefined;
  goalState: 'active' | 'paused' | 'completed' | 'failed';
  iterations: number;
  progress: number;
  progressNote?: string | undefined;
  progressTrend?: 'up' | 'down' | 'stable' | undefined;
  deliverables?: GoalDeliverable[] | undefined;
  journal?: GoalJournalEntry[] | undefined;
  lastTask?: string | undefined;
  lastStatus?: string | undefined;
}

/**
 * Formats raw goal JSON from the server into a GoalState.
 * Gracefully handles missing / partial data.
 */
export function parseGoalState(raw: Record<string, unknown> | null): GoalState | null {
  if (!raw || typeof raw.goal !== 'string' || !raw.goal.trim()) return null;
  return {
    goal: raw.goal as string,
    refinedGoal: typeof raw.refinedGoal === 'string' ? raw.refinedGoal : undefined,
    goalState: (['active', 'paused', 'completed', 'failed'].includes(raw.goalState as string)
      ? (raw.goalState as GoalState['goalState'])
      : 'active') as GoalState['goalState'],
    iterations: typeof raw.iterations === 'number' ? raw.iterations : 0,
    progress: typeof raw.progress === 'number' ? raw.progress : 0,
    progressNote: typeof raw.progressNote === 'string' ? raw.progressNote : undefined,
    progressTrend: (['up', 'down', 'stable'].includes(raw.progressTrend as string)
      ? (raw.progressTrend as GoalState['progressTrend'])
      : undefined) as GoalState['progressTrend'] | undefined,
    deliverables: Array.isArray(raw.deliverables)
      ? (raw.deliverables as GoalDeliverable[])
      : undefined,
    journal: Array.isArray(raw.journal) ? (raw.journal as GoalJournalEntry[]) : undefined,
    lastTask: typeof raw.lastTask === 'string' ? raw.lastTask : undefined,
    lastStatus: typeof raw.lastStatus === 'string' ? raw.lastStatus : undefined,
  };
}
