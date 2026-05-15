import { describe, expect, it } from 'vitest';
import { type ModelPrice, PRICING, priceFor } from '../src/pricing.js';

describe('pricing (deprecated)', () => {
  it('PRICING is always empty', () => expect(PRICING).toEqual({}));
  it('priceFor always returns undefined', () => {
    expect(priceFor('gpt-4')).toBeUndefined();
    expect(priceFor('claude-sonnet-4-6')).toBeUndefined();
  });
  it('ModelPrice interface is intact', () => {
    const p: ModelPrice = { input: 1, output: 5, cacheRead: 0.2, cacheWrite: 0.4 };
    expect(p.input).toBe(1);
    expect(p.output).toBe(5);
  });
});
