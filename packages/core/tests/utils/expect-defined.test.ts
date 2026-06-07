import { describe, expect, it } from 'vitest';
import { expectDefined } from '../../src/utils/expect-defined.js';

describe('expectDefined', () => {
  it('returns defined values', () => {
    expect(expectDefined('hello')).toBe('hello');
    expect(expectDefined(0)).toBe(0);
    expect(expectDefined(false)).toBe(false);
  });

  it('throws for null and undefined', () => {
    expect(() => expectDefined(null)).toThrow('Expected value to be defined');
    expect(() => expectDefined(undefined)).toThrow('Expected value to be defined');
  });

  it('uses an optional label in the error message', () => {
    expect(() => expectDefined(undefined, 'active provider')).toThrow(
      'Expected active provider to be defined',
    );
  });
});
