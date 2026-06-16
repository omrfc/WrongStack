import { describe, expect, it } from 'vitest';
import { LargeAnswerStore } from '../../src/coordination/large-answer-store.js';

describe('LargeAnswerStore', () => {
  it('returns null/undefined inline', () => {
    const s = new LargeAnswerStore();
    expect(s.storeAnswer(null)).toEqual({ summary: 'null', inline: true });
    expect(s.storeAnswer(undefined)).toEqual({ summary: 'undefined', inline: true });
    expect(s.size).toBe(0);
  });

  it('returns small string values inline (truncated to 500 chars)', () => {
    const s = new LargeAnswerStore(2000);
    const r = s.storeAnswer('short answer');
    expect(r.inline).toBe(true);
    expect(r.summary).toBe('short answer');
    expect(r.key).toBeUndefined();
  });

  it('serializes and inlines small objects below the threshold', () => {
    const s = new LargeAnswerStore(2000);
    const r = s.storeAnswer({ a: 1, b: 'two' });
    expect(r.inline).toBe(true);
    expect(r.summary).toContain('"a":1');
  });

  it('stores oversize values out-of-context and retrieves them by key', () => {
    const s = new LargeAnswerStore(10);
    const big = 'x'.repeat(50);
    const r = s.storeAnswer(big);
    expect(r.inline).toBe(false);
    expect(r.key).toMatch(/^a-/);
    expect(r.summary).toContain('stored: 50 chars');
    expect(s.retrieveAnswer(r.key!)).toBe(big);
    expect(s.hasAnswer(r.key!)).toBe(true);
    expect(s.size).toBe(1);
    expect(s.totalChars).toBe(50);
  });

  it('derives a stable key for identical content', () => {
    const s = new LargeAnswerStore(10);
    const v = 'y'.repeat(40);
    expect(s.storeAnswer(v).key).toBe(s.storeAnswer(v).key);
  });

  it('returns undefined for unknown keys and false for hasAnswer', () => {
    const s = new LargeAnswerStore();
    expect(s.retrieveAnswer('nope')).toBeUndefined();
    expect(s.hasAnswer('nope')).toBe(false);
  });

  it('clears all entries', () => {
    const s = new LargeAnswerStore(10);
    s.storeAnswer('z'.repeat(30));
    expect(s.size).toBe(1);
    s.clear();
    expect(s.size).toBe(0);
    expect(s.totalChars).toBe(0);
  });
});
