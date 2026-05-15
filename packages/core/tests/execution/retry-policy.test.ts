import { describe, expect, it } from 'vitest';
import { DefaultRetryPolicy } from '../../src/execution/retry-policy.js';
import { ProviderError } from '../../src/types/provider.js';

describe('DefaultRetryPolicy', () => {
  const p = new DefaultRetryPolicy();
  it('429 retries up to 5 attempts', () => {
    const err = new ProviderError('rate limited', 429, true, 'anthropic');
    expect(p.shouldRetry(err, 0)).toBe(true);
    expect(p.shouldRetry(err, 4)).toBe(true);
    expect(p.shouldRetry(err, 5)).toBe(false);
  });
  it('5xx retries up to 3', () => {
    const err = new ProviderError('server', 503, true, 'x');
    expect(p.shouldRetry(err, 0)).toBe(true);
    expect(p.shouldRetry(err, 2)).toBe(true);
    expect(p.shouldRetry(err, 3)).toBe(false);
  });
  it('4xx does not retry', () => {
    const err = new ProviderError('auth', 401, false, 'x');
    expect(p.shouldRetry(err, 0)).toBe(false);
  });
  it('network errors retry up to 2', () => {
    const err = new Error('ECONNRESET');
    expect(p.shouldRetry(err, 0)).toBe(true);
    expect(p.shouldRetry(err, 2)).toBe(false);
  });
  it('delayMs respects 30s cap with jitter', () => {
    for (let i = 0; i < 10; i++) {
      const d = p.delayMs(10);
      expect(d).toBeLessThanOrEqual(30_000);
    }
  });

  it('529 retries up to 3 attempts', () => {
    const err = new ProviderError('overloaded', 529, true, 'x');
    expect(p.shouldRetry(err, 0)).toBe(true);
    expect(p.shouldRetry(err, 2)).toBe(true);
    expect(p.shouldRetry(err, 3)).toBe(false);
  });

  it('non-retryable ProviderError exits immediately', () => {
    const err = new ProviderError('bad', 503, false, 'x');
    expect(p.shouldRetry(err, 0)).toBe(false);
  });

  it('generic Error does not retry', () => {
    expect(p.shouldRetry(new Error('mystery'), 0)).toBe(false);
  });

  it('maxAttempts returns expected counts', () => {
    expect(p.maxAttempts(new ProviderError('', 429, true, 'x'))).toBe(5);
    expect(p.maxAttempts(new ProviderError('', 529, true, 'x'))).toBe(3);
    expect(p.maxAttempts(new ProviderError('', 503, true, 'x'))).toBe(3);
    expect(p.maxAttempts(new ProviderError('', 400, true, 'x'))).toBe(0);
    expect(p.maxAttempts(new Error('x'))).toBe(2);
  });

  it('delayMs grows with attempt index on average', () => {
    let sum0 = 0;
    let sum3 = 0;
    for (let i = 0; i < 30; i++) {
      sum0 += p.delayMs(0);
      sum3 += p.delayMs(3);
    }
    expect(sum3).toBeGreaterThan(sum0);
  });
});
