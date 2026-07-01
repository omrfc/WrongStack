import type { TokenCounter } from '@wrongstack/core';
import { describe, expect, it } from 'vitest';
import { snapshotTokenCounter } from '../src/hooks/use-token-counter-refresh.js';

function fakeTokenCounter(): TokenCounter {
  return {
    account: () => undefined,
    setCurrentRequestTokens: () => undefined,
    currentRequestTokens: () => ({ input: 123, cacheRead: 45 }),
    total: () => ({ input: 1234, output: 567, cacheRead: 89, cacheWrite: 10 }),
    estimateCost: () => ({ input: 0.0123, output: 0.0456, total: 0.0579, currency: 'USD' }),
    cacheStats: () => ({ readTokens: 89, writeTokens: 10, hitRatio: 0.0672 }),
    reset: () => undefined,
  };
}

describe('snapshotTokenCounter', () => {
  it('reads live token, cost, and cache totals from the provided counter', () => {
    expect(snapshotTokenCounter(fakeTokenCounter())).toEqual({
      usage: { input: 1234, output: 567, cacheRead: 89, cacheWrite: 10 },
      currentRequest: { input: 123, cacheRead: 45 },
      cost: { input: 0.0123, output: 0.0456, total: 0.0579, currency: 'USD' },
      cacheStats: { readTokens: 89, writeTokens: 10, hitRatio: 0.0672 },
    });
  });
});
