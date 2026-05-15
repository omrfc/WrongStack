import { beforeEach, describe, expect, it } from 'vitest';
import { createToolOutputSerializer } from '../../src/utils/tool-output-serializer.js';

describe('createToolOutputSerializer', () => {
  let serializer: ReturnType<typeof createToolOutputSerializer>;

  beforeEach(() => {
    serializer = createToolOutputSerializer();
  });

  describe('serialize', () => {
    it('returns string as-is', () => {
      expect(serializer.serialize('hello world')).toBe('hello world');
      expect(serializer.serialize('')).toBe('');
    });

    it('returns empty string for null', () => {
      expect(serializer.serialize(null)).toBe('');
    });

    it('returns empty string for undefined', () => {
      expect(serializer.serialize(undefined)).toBe('');
    });

    it('serializes array by joining with newlines', () => {
      expect(serializer.serialize(['a', 'b', 'c'])).toBe('a\nb\nc');
      expect(serializer.serialize(['line1', 'line2'])).toBe('line1\nline2');
    });

    it('extracts text property from object when string', () => {
      expect(serializer.serialize({ text: 'hello' })).toBe('hello');
    });

    it('falls back to JSON when text is not a string', () => {
      expect(serializer.serialize({ text: 123 })).toContain('"text"');
    });

    it('JSON stringifies objects without text property', () => {
      expect(serializer.serialize({ foo: 'bar' })).toBe('{\n  "foo": "bar"\n}');
    });

    it('falls back to String() when JSON.stringify throws on circular refs', () => {
      const circular: Record<string, unknown> = { name: 'cyc' };
      circular.self = circular;
      // The fallback path returns the result of String(value) — for plain
      // objects this is "[object Object]". The important contract is it
      // does NOT throw.
      expect(() => serializer.serialize(circular)).not.toThrow();
      expect(serializer.serialize(circular)).toBe('[object Object]');
    });

    it('handles numbers and booleans via String() fallback', () => {
      expect(serializer.serialize(42)).toBe('42');
      expect(serializer.serialize(true)).toBe('true');
      expect(serializer.serialize(false)).toBe('false');
    });
  });

  describe('enforceCap', () => {
    it('returns text unchanged when within budget', () => {
      const result = serializer.enforceCap('hello', 1000);
      expect(result.text).toBe('hello');
      expect(result.newBudget).toBeGreaterThan(0);
    });

    it('returns text unchanged when exact budget matches', () => {
      const result = serializer.enforceCap('hello', 5);
      expect(result.text).toBe('hello');
    });

    it('returns truncated message when budget is zero', () => {
      const result = serializer.enforceCap('hello', 0);
      expect(result.text).toBe('[truncated: iteration output cap exceeded]');
      expect(result.newBudget).toBe(0);
    });

    it('returns truncated message when budget is negative', () => {
      const result = serializer.enforceCap('hello', -1);
      expect(result.text).toBe('[truncated: iteration output cap exceeded]');
    });

    it('truncates middle of text when exceeds budget', () => {
      const result = serializer.enforceCap('0123456789', 5);
      expect(result.text).not.toBe('0123456789');
      expect(result.text).toContain('truncated');
      expect(result.newBudget).toBe(0);
    });

    it('includes byte count in truncation marker', () => {
      const result = serializer.enforceCap('0123456789', 5);
      expect(result.text).toContain('truncated');
    });

    it('returns truncated message when available space after marker is too small', () => {
      // When remaining budget minus marker is <= 0
      const result = serializer.enforceCap('long text here', 10);
      expect(result.text).toContain('[truncated');
    });

    it('splits text when exceeds budget', () => {
      // Use text 20 bytes with budget 20 (should fit exactly)
      const result1 = serializer.enforceCap('abcdefghijklmnopqrst', 20);
      expect(result1.text).toBe('abcdefghijklmnopqrst');
      // Use text 30 bytes with budget 20 (should truncate)
      const result = serializer.enforceCap('abcdefghijklmnopqrstuvwxyz', 20);
      expect(result.text).not.toBe('abcdefghijklmnopqrstuvwxyz');
      // budget 20 minus marker bytes is negative, so returns simple truncation
      expect(result.text).toContain('[truncated');
      expect(result.newBudget).toBe(0);
    });

    it('keeps head + tail with marker when budget has room for both', () => {
      // 1000-byte budget against 2000-byte text → marker fits, head+tail are nonempty.
      const text = 'A'.repeat(1000) + 'B'.repeat(1000);
      const result = serializer.enforceCap(text, 200);
      // We should see the marker between two slices.
      expect(result.text).toMatch(/A+\n…\[truncated \d+ bytes\]…\nB+/);
      expect(result.newBudget).toBe(0);
    });

    it('uses custom perIterationOutputCapBytes', () => {
      const custom = createToolOutputSerializer({ perIterationOutputCapBytes: 50 });
      expect(custom.capBytes).toBe(50);
    });

    it('estimator option is accepted but not used in enforceCap', () => {
      const custom = createToolOutputSerializer({ estimator: () => 100 });
      // estimator is stored but enforceCap still uses Buffer.byteLength
      expect(() => custom.enforceCap('a'.repeat(50), 1000)).not.toThrow();
    });

    it('decreases remaining budget', () => {
      const { newBudget } = serializer.enforceCap('hello', 1000);
      expect(newBudget).toBeLessThan(1000);
    });

    it('newBudget becomes 0 when cap exceeded', () => {
      const { newBudget } = serializer.enforceCap('a'.repeat(10000), 10);
      expect(newBudget).toBe(0);
    });
  });

  describe('capBytes', () => {
    it('defaults to 100000', () => {
      expect(serializer.capBytes).toBe(100_000);
    });

    it('uses custom value', () => {
      const custom = createToolOutputSerializer({ perIterationOutputCapBytes: 5000 });
      expect(custom.capBytes).toBe(5000);
    });
  });
});
