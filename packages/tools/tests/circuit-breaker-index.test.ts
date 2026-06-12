/**
 * Tests for the codebase-index circuit breaker (closed → open → half-open).
 *
 * The breaker guards every index run so repeated failures/timeouts stop
 * queuing work behind a possibly-wedged mutex. Uses an injected clock — no
 * real timers involved.
 */

import { describe, expect, it } from 'vitest';
import { IndexCircuitBreaker } from '../src/codebase-index/circuit-breaker.js';

function makeBreaker(opts: { failureThreshold?: number; cooldownMs?: number } = {}) {
  let now = 0;
  const breaker = new IndexCircuitBreaker({
    failureThreshold: opts.failureThreshold ?? 3,
    cooldownMs: opts.cooldownMs ?? 1000,
    now: () => now,
  });
  return {
    breaker,
    tick: (ms: number) => {
      now += ms;
    },
  };
}

describe('IndexCircuitBreaker', () => {
  it('stays closed below the failure threshold', () => {
    const { breaker } = makeBreaker();
    breaker.recordFailure(new Error('a'));
    breaker.recordFailure(new Error('b'));
    expect(breaker.snapshot().state).toBe('closed');
    expect(breaker.allowRequest()).toBe(true);
  });

  it('opens after threshold consecutive failures and rejects requests', () => {
    const { breaker } = makeBreaker();
    for (let i = 0; i < 3; i++) breaker.recordFailure(new Error(`fail ${i}`));
    expect(breaker.snapshot()).toMatchObject({
      state: 'open',
      consecutiveFailures: 3,
      lastFailure: 'fail 2',
    });
    expect(breaker.allowRequest()).toBe(false);
  });

  it('a success resets the consecutive-failure counter', () => {
    const { breaker } = makeBreaker();
    breaker.recordFailure(new Error('a'));
    breaker.recordFailure(new Error('b'));
    breaker.recordSuccess();
    breaker.recordFailure(new Error('c'));
    breaker.recordFailure(new Error('d'));
    expect(breaker.snapshot().state).toBe('closed');
  });

  it('reports cooldown remaining while open', () => {
    const { breaker, tick } = makeBreaker({ cooldownMs: 1000 });
    for (let i = 0; i < 3; i++) breaker.recordFailure(new Error('x'));
    tick(400);
    expect(breaker.snapshot().cooldownRemainingMs).toBe(600);
  });

  it('admits exactly one half-open probe after the cooldown', () => {
    const { breaker, tick } = makeBreaker({ cooldownMs: 1000 });
    for (let i = 0; i < 3; i++) breaker.recordFailure(new Error('x'));
    expect(breaker.allowRequest()).toBe(false);
    tick(1001);
    expect(breaker.allowRequest()).toBe(true); // the probe
    expect(breaker.allowRequest()).toBe(false); // second request denied while probe in flight
  });

  it('a successful probe closes the circuit', () => {
    const { breaker, tick } = makeBreaker({ cooldownMs: 1000 });
    for (let i = 0; i < 3; i++) breaker.recordFailure(new Error('x'));
    tick(1001);
    expect(breaker.allowRequest()).toBe(true);
    breaker.recordSuccess();
    expect(breaker.snapshot().state).toBe('closed');
    expect(breaker.allowRequest()).toBe(true);
  });

  it('a failed probe re-opens the circuit for a fresh cooldown', () => {
    const { breaker, tick } = makeBreaker({ cooldownMs: 1000 });
    for (let i = 0; i < 3; i++) breaker.recordFailure(new Error('x'));
    tick(1001);
    expect(breaker.allowRequest()).toBe(true);
    breaker.recordFailure(new Error('probe failed'));
    expect(breaker.snapshot().state).toBe('open');
    expect(breaker.allowRequest()).toBe(false);
    tick(1001);
    expect(breaker.allowRequest()).toBe(true); // next probe admitted
  });

  it('reset force-closes the circuit (manual /codebase-reindex recovery)', () => {
    const { breaker } = makeBreaker();
    for (let i = 0; i < 3; i++) breaker.recordFailure(new Error('x'));
    expect(breaker.allowRequest()).toBe(false);
    breaker.reset();
    expect(breaker.snapshot()).toMatchObject({
      state: 'closed',
      consecutiveFailures: 0,
      lastFailure: null,
    });
    expect(breaker.allowRequest()).toBe(true);
  });
});
