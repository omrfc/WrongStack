import { describe, expect, it } from 'vitest';
import { BudgetExceededError, SubagentBudget } from '../../src/coordination/subagent-budget.js';

describe('SubagentBudget', () => {
  it('records iterations and throws when over limit', () => {
    const b = new SubagentBudget({ maxIterations: 2 });
    b.recordIteration();
    b.recordIteration();
    expect(() => b.recordIteration()).toThrow(BudgetExceededError);
  });

  it('records tool calls and throws when over limit', () => {
    const b = new SubagentBudget({ maxToolCalls: 1 });
    b.recordToolCall();
    try {
      b.recordToolCall();
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(BudgetExceededError);
      expect((err as BudgetExceededError).kind).toBe('tool_calls');
      expect((err as BudgetExceededError).limit).toBe(1);
      expect((err as BudgetExceededError).observed).toBe(2);
    }
  });

  it('records tokens and throws when total exceeds limit', () => {
    const b = new SubagentBudget({ maxTokens: 100 });
    b.recordUsage({ input: 60, output: 30 });
    expect(() => b.recordUsage({ input: 5, output: 10 })).toThrow(BudgetExceededError);
  });

  it('records cost and throws when over limit', () => {
    const b = new SubagentBudget({ maxCostUsd: 0.5 });
    b.recordUsage({ input: 0, output: 0 }, 0.3);
    expect(() => b.recordUsage({ input: 0, output: 0 }, 0.3)).toThrow(BudgetExceededError);
  });

  it('checkTimeout throws after deadline', async () => {
    const b = new SubagentBudget({ timeoutMs: 30 });
    b.start();
    await new Promise((r) => setTimeout(r, 60));
    expect(() => b.checkTimeout()).toThrow(BudgetExceededError);
  });

  it('checkTimeout is a no-op without start()', () => {
    const b = new SubagentBudget({ timeoutMs: 1 });
    expect(() => b.checkTimeout()).not.toThrow();
  });

  it('isTimedOut returns boolean without throwing', async () => {
    const b = new SubagentBudget({ timeoutMs: 20 });
    b.start();
    expect(b.isTimedOut()).toBe(false);
    await new Promise((r) => setTimeout(r, 40));
    expect(b.isTimedOut()).toBe(true);
  });

  it('usage reports cumulative state', () => {
    const b = new SubagentBudget({});
    b.start();
    b.recordIteration();
    b.recordIteration();
    b.recordToolCall();
    b.recordUsage({ input: 100, output: 50 }, 0.01);
    const u = b.usage();
    expect(u.iterations).toBe(2);
    expect(u.toolCalls).toBe(1);
    expect(u.tokens.total).toBe(150);
    expect(u.costUsd).toBeCloseTo(0.01);
  });

  it('limits are frozen and not mutable from outside', () => {
    const b = new SubagentBudget({ maxIterations: 5 });
    expect(() => {
      // @ts-expect-error readonly
      b.limits.maxIterations = 999;
    }).toThrow();
  });

  it('unbounded limits never throw', () => {
    const b = new SubagentBudget({});
    for (let i = 0; i < 1000; i++) {
      b.recordIteration();
      b.recordToolCall();
      b.recordUsage({ input: 1000, output: 1000 }, 1);
    }
    expect(b.usage().iterations).toBe(1000);
  });
});
