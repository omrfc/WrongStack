import { describe, it, expect } from 'vitest';
import { parseToolInput } from '../src/_tool-input.js';

describe('parseToolInput (provider stream → canonical Record<string, unknown>)', () => {
  it('returns {} for undefined / empty', () => {
    expect(parseToolInput(undefined)).toEqual({});
    expect(parseToolInput('')).toEqual({});
  });

  it('returns the parsed object as-is for valid JSON object', () => {
    const r = parseToolInput('{"a":1,"b":"hi"}');
    expect(r).toEqual({ a: 1, b: 'hi' });
  });

  it('wraps a JSON array under __raw to preserve object contract', () => {
    const r = parseToolInput('[1,2,3]');
    expect(r).toHaveProperty('__raw');
    expect((r as { __raw: unknown }).__raw).toEqual([1, 2, 3]);
  });

  it('wraps a scalar (string) under __raw', () => {
    const r = parseToolInput('"plain string"');
    expect(r).toEqual({ __raw: 'plain string' });
  });

  it('wraps a scalar (number) under __raw', () => {
    const r = parseToolInput('42');
    expect(r).toEqual({ __raw: 42 });
  });

  it('wraps JSON null under __raw (defensive — falsy but parseable)', () => {
    const r = parseToolInput('null');
    // null is the JSON value; we still return an object envelope. The
    // __raw field holds the original raw string so the executor can see
    // exactly what arrived.
    expect(r).toHaveProperty('__raw');
  });

  it('preserves invalid JSON via __raw rather than throwing', () => {
    const r = parseToolInput('{not valid json');
    expect(r).toEqual({ __raw: '{not valid json' });
  });

  it('result is always a plain object (callers can index by key)', () => {
    const cases = ['', '{}', '[]', '"x"', '42', 'null', 'true', '{bad'];
    for (const c of cases) {
      const r = parseToolInput(c);
      expect(typeof r).toBe('object');
      expect(r).not.toBeNull();
      expect(Array.isArray(r)).toBe(false);
    }
  });
});
