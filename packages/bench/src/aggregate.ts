import type { CellResult, ModelCell, TaskResult } from './types.js';

/**
 * Fold every per-(task × cell) result for ONE cell into its leaderboard row.
 * All metrics are derived from deterministic signals (grader pass/fail, the
 * `--output-json` usage block, and session-log tool counts) — nothing here
 * consults a model.
 */
export function aggregateCell(cell: ModelCell, results: TaskResult[]): CellResult {
  const taskCount = results.length;
  if (taskCount === 0) {
    return {
      cell,
      taskCount: 0,
      gradedCount: 0,
      passRate: 0,
      editApplyRate: 1,
      avgCostUsd: 0,
      avgTokensIn: 0,
      avgTokensOut: 0,
      p50Iterations: 0,
      p50ElapsedMs: 0,
      timeoutRate: 0,
      totalRateLimitRetries: 0,
    };
  }

  // Only count rows that produced an actual verdict — exported-but-ungraded
  // SWE-bench rows (graded === false) must not deflate the pass rate.
  const graded = results.filter((r) => r.grade.graded !== false);
  const passed = graded.filter((r) => r.grade.passed).length;
  const timeouts = results.filter((r) => r.run.status === 'timeout').length;

  const editCalls = sum(results, (r) => r.tools.editCalls);
  const editErrors = sum(results, (r) => r.tools.editErrors);
  // Edit-apply rate is undefined when no edit was ever attempted; report 1
  // (nothing failed to apply) so a no-op run doesn't drag the column down.
  const editApplyRate = editCalls === 0 ? 1 : (editCalls - editErrors) / editCalls;

  return {
    cell,
    taskCount,
    gradedCount: graded.length,
    passRate: graded.length === 0 ? 0 : passed / graded.length,
    editApplyRate,
    avgCostUsd: sum(results, (r) => r.run.costUsd) / taskCount,
    avgTokensIn: sum(results, (r) => r.run.tokensIn) / taskCount,
    avgTokensOut: sum(results, (r) => r.run.tokensOut) / taskCount,
    p50Iterations: median(results.map((r) => r.run.iterations)),
    p50ElapsedMs: median(results.map((r) => r.run.elapsedMs)),
    timeoutRate: timeouts / taskCount,
    totalRateLimitRetries: sum(results, (r) => r.tools.rateLimitRetries),
  };
}

/** Group all results by cell label and aggregate each group. */
export function aggregateAll(cells: ModelCell[], results: TaskResult[]): CellResult[] {
  return cells.map((cell) =>
    aggregateCell(
      cell,
      results.filter((r) => r.cell.label === cell.label),
    ),
  );
}

/** Median of a numeric array (0 for empty). Exported for tests. */
export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2
    : (sorted[mid] as number);
}

function sum<T>(items: T[], pick: (item: T) => number): number {
  let total = 0;
  for (const item of items) total += pick(item);
  return total;
}
