import { describe, expect, it } from 'vitest';
import { aggregateCell, median } from '../src/aggregate.js';
import type { ModelCell, TaskResult } from '../src/types.js';

const cell: ModelCell = { label: 'opus', provider: 'anthropic', model: 'claude-opus-4-8' };

function result(over: Partial<TaskResult> & { passed: boolean; graded?: boolean }): TaskResult {
  return {
    taskId: over.taskId ?? 't',
    cell,
    run: {
      status: 'completed',
      finalText: null,
      iterations: 10,
      tokensIn: 1000,
      tokensOut: 500,
      costUsd: 0.2,
      elapsedMs: 5000,
      exitCode: 0,
      ...over.run,
    },
    grade: { passed: over.passed, graded: over.graded },
    tools: { totalCalls: 5, editCalls: 4, editErrors: 0, rateLimitRetries: 0, ...over.tools },
  };
}

describe('median', () => {
  it('handles odd and even lengths', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(median([])).toBe(0);
  });
});

describe('aggregateCell', () => {
  it('computes pass rate and edit-apply rate', () => {
    const results = [
      result({
        taskId: 'a',
        passed: true,
        tools: { totalCalls: 4, editCalls: 4, editErrors: 0, rateLimitRetries: 0 },
      }),
      result({
        taskId: 'b',
        passed: false,
        tools: { totalCalls: 6, editCalls: 6, editErrors: 3, rateLimitRetries: 1 },
      }),
    ];
    const agg = aggregateCell(cell, results);
    expect(agg.taskCount).toBe(2);
    expect(agg.passRate).toBe(0.5);
    // 10 edit calls, 3 errors → 7/10 applied cleanly.
    expect(agg.editApplyRate).toBeCloseTo(0.7, 5);
    expect(agg.totalRateLimitRetries).toBe(1);
  });

  it('reports edit-apply rate of 1 when no edits were attempted', () => {
    const agg = aggregateCell(cell, [
      result({
        passed: true,
        tools: { totalCalls: 2, editCalls: 0, editErrors: 0, rateLimitRetries: 0 },
      }),
    ]);
    expect(agg.editApplyRate).toBe(1);
  });

  it('computes timeout rate and p50 metrics', () => {
    const results = [
      result({
        taskId: 'a',
        passed: true,
        run: {
          status: 'completed',
          iterations: 8,
          elapsedMs: 4000,
          finalText: null,
          tokensIn: 0,
          tokensOut: 0,
          costUsd: 0.1,
          exitCode: 0,
        },
      }),
      result({
        taskId: 'b',
        passed: false,
        run: {
          status: 'timeout',
          iterations: 40,
          elapsedMs: 600000,
          finalText: null,
          tokensIn: 0,
          tokensOut: 0,
          costUsd: 0.5,
          exitCode: null,
        },
      }),
    ];
    const agg = aggregateCell(cell, results);
    expect(agg.timeoutRate).toBe(0.5);
    expect(agg.p50Iterations).toBe(24); // median(8, 40)
    expect(agg.avgCostUsd).toBeCloseTo(0.3, 5);
  });

  it('returns a safe zeroed row for an empty result set', () => {
    const agg = aggregateCell(cell, []);
    expect(agg.taskCount).toBe(0);
    expect(agg.gradedCount).toBe(0);
    expect(agg.passRate).toBe(0);
    expect(agg.editApplyRate).toBe(1);
  });

  it('excludes ungraded rows (graded:false) from pass rate', () => {
    const results = [
      result({ taskId: 'a', passed: true, graded: true }),
      result({ taskId: 'b', passed: false, graded: false }), // exported, ungraded
      result({ taskId: 'c', passed: false, graded: false }),
    ];
    const agg = aggregateCell(cell, results);
    expect(agg.taskCount).toBe(3);
    expect(agg.gradedCount).toBe(1);
    // Only the one graded task counts → 100% pass over graded.
    expect(agg.passRate).toBe(1);
  });

  it('reports gradedCount 0 when every row is ungraded', () => {
    const agg = aggregateCell(cell, [
      result({ passed: false, graded: false }),
      result({ passed: false, graded: false }),
    ]);
    expect(agg.gradedCount).toBe(0);
    expect(agg.passRate).toBe(0);
  });
});
