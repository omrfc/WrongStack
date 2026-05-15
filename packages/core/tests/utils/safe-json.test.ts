import { describe, expect, it } from 'vitest';
import { safeParse, safeStringify, sanitizeJsonString } from '../../src/utils/safe-json.js';

describe('safe-json', () => {
  it('safeParse returns value on valid', () => {
    const r = safeParse<{ a: number }>('{"a":1}');
    expect(r.ok).toBe(true);
    expect(r.value).toEqual({ a: 1 });
  });
  it('safeParse returns error on invalid', () => {
    const r = safeParse('{not json}');
    expect(r.ok).toBe(false);
    expect(r.error).toBeDefined();
  });
  it('safeParse rejects oversized input', () => {
    const r = safeParse('x'.repeat(100), 10);
    expect(r.ok).toBe(false);
  });
  it('safeStringify handles circular refs', () => {
    const obj: Record<string, unknown> = { a: 1 };
    obj.self = obj;
    const out = safeStringify(obj);
    expect(out).toContain('[Circular]');
  });
  it('safeStringify handles BigInt', () => {
    const out = safeStringify({ n: 9007199254740993n });
    expect(out).toContain('9007199254740993');
  });
  it('safeStringify handles Error', () => {
    const out = safeStringify({ err: new Error('boom') });
    expect(out).toContain('boom');
  });
  it('sanitizeJsonString strips trailing commas', () => {
    expect(sanitizeJsonString('{"a":1,}')).toBe('{"a":1}');
    expect(sanitizeJsonString('[1,2,3,]')).toBe('[1,2,3]');
  });
  it('sanitizeJsonString returns null for unrecoverable input', () => {
    expect(sanitizeJsonString('{not json at all}')).toBe(null);
    expect(sanitizeJsonString('{"a":1]')).toBe(null); // mismatched bracket
  });
});
