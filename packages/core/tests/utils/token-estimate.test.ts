import { describe, expect, it } from 'vitest';
import { estimateToolInputTokens } from '../../src/utils/token-estimate.js';

describe('estimateToolInputTokens', () => {
  it('returns a positive integer for string input', () => {
    expect(estimateToolInputTokens('hello world')).toBeGreaterThan(0);
  });

  it('returns a positive integer for object input', () => {
    expect(estimateToolInputTokens({ command: 'ls -la' })).toBeGreaterThan(0);
  });

  it('handles null and primitive non-strings without throwing', () => {
    expect(estimateToolInputTokens(null)).toBeGreaterThan(0);
    expect(estimateToolInputTokens(42)).toBeGreaterThan(0);
    expect(estimateToolInputTokens(true)).toBeGreaterThan(0);
  });

  it('does NOT mutate the input object', () => {
    // Previously the function attached `__tokenEstimate` to the input — which
    // threw on frozen inputs and was visible to anyone iterating the object.
    const input = { command: 'echo hi', args: ['--flag'] };
    estimateToolInputTokens(input);
    expect(Object.keys(input).sort()).toEqual(['args', 'command']);
    expect(Object.getOwnPropertyNames(input).sort()).toEqual(['args', 'command']);
  });

  it('does NOT throw on a frozen input', () => {
    const frozen = Object.freeze({ url: 'https://example.com' });
    expect(() => estimateToolInputTokens(frozen)).not.toThrow();
  });

  it('returns the same estimate on repeated calls (cache hit)', () => {
    const input = { command: 'pwd' };
    const a = estimateToolInputTokens(input);
    const b = estimateToolInputTokens(input);
    expect(a).toBe(b);
  });
});
