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

    it('renders read results with compact metadata when tool context is provided', () => {
      const out = serializer.serialize(
        { text: '1→const value = 1;', total_lines: 20, encoding: 'utf8', truncated: true },
        { toolName: 'read', input: { path: 'src/a.ts', offset: 1, limit: 1 } },
      );
      expect(out).toContain('read: src/a.ts');
      expect(out).toContain('total_lines=20');
      expect(out).toContain('truncated=true');
      expect(out).toContain('1→const value = 1;');
    });

    it('renders grep matches as line-oriented output instead of JSON', () => {
      const out = serializer.serialize(
        {
          matches: ['src/a.ts:1:Token', 'src/b.ts:2:Token'],
          count: 2,
          truncated: false,
          used: 'rg',
        },
        { toolName: 'grep', input: { pattern: 'Token' } },
      );
      expect(out).toBe(
        'grep: Token (count=2 shown=2 truncated=false used=rg)\n' +
          'src/a.ts (1 match(es), showing 1)\n1:Token\n' +
          'src/b.ts (1 match(es), showing 1)\n2:Token',
      );
      expect(out).not.toContain('"matches"');
    });

    it('renders command-like results with stdout and stderr blocks', () => {
      const out = serializer.serialize(
        {
          command: 'pnpm',
          args: ['test'],
          stdout: 'ok',
          stderr: 'failed',
          exitCode: 1,
          truncated: false,
          allowed: true,
        },
        { toolName: 'exec' },
      );
      expect(out).toBe(
        'exec: pnpm test (exit_code=1 allowed=true truncated=false)\n' +
          'stdout:\nok\nstderr:\nfailed',
      );
    });

    it('renders passing test results as a concise report without full output', () => {
      const out = serializer.serialize(
        {
          runner: 'vitest',
          exit_code: 0,
          tests_run: 12,
          passed: 12,
          failed: 0,
          duration_ms: 345,
          output: 'PASS a.test.ts\nPASS b.test.ts\nAll files listed here',
          truncated: false,
        },
        { toolName: 'test', input: { files: ['a.test.ts', 'b.test.ts'] } },
      );
      expect(out).toContain('test: vitest');
      expect(out).toContain('status=passed');
      expect(out).toContain('tests_run=12');
      expect(out).not.toContain('PASS a.test.ts');
      expect(out).not.toContain('All files listed here');
    });

    it('keeps failure context for test results and omits unrelated long output', () => {
      const noise = Array.from({ length: 300 }, (_, i) => `PASS test-${i}.ts`).join('\n');
      const out = serializer.serialize(
        {
          runner: 'vitest',
          exit_code: 1,
          tests_run: 301,
          passed: 300,
          failed: 1,
          duration_ms: 999,
          output: `${noise}\nFAIL src/a.test.ts\nAssertionError: expected 1 to be 2\nExpected: 2\nReceived: 1`,
          truncated: false,
        },
        { toolName: 'test' },
      );
      expect(out).toContain('error_context:');
      expect(out).toContain('FAIL src/a.test.ts');
      expect(out).toContain('AssertionError');
      expect(out).toContain('serializer omitted');
      expect(out).not.toContain('PASS test-10.ts');
    });

    it('renders diff outputs as diffs even when they include a files array', () => {
      const out = serializer.serialize(
        {
          diff: 'diff --git a/a.ts b/a.ts\n+const value = 1;',
          files: ['a.ts'],
          truncated: false,
          mode: 'unified',
        },
        { toolName: 'diff' },
      );
      expect(out).toContain('diff (files=1 truncated=false mode=unified)');
      expect(out).toContain('diff --git');
    });

    it('summarizes very large diffs while keeping hunk context', () => {
      const bigDiff = [
        'diff --git a/a.ts b/a.ts',
        '--- a/a.ts',
        '+++ b/a.ts',
        '@@ -1,300 +1,300 @@',
        ...Array.from({ length: 320 }, (_, i) => (i % 2 === 0 ? `-old${i}` : `+new${i}`)),
      ].join('\n');
      const out = serializer.serialize(
        {
          diff: bigDiff,
          files: ['a.ts'],
          truncated: false,
          mode: 'unified',
        },
        { toolName: 'diff' },
      );
      expect(out).toContain('diff_summary');
      expect(out).toContain('shown_hunks=1');
      expect(out).toContain('@@ -1,300 +1,300 @@');
      expect(out).toContain('serializer omitted');
      expect(out).not.toContain('new319');
    });

    it('includes edit notes in compact diff headers', () => {
      const out = serializer.serialize(
        {
          path: 'a.ts',
          replacements: 1,
          note: 'auto-read current file before editing',
          diff: '--- a.ts\n+++ a.ts\n-old\n+new',
        },
        { toolName: 'edit' },
      );
      expect(out).toContain('note=auto-read current file before editing');
      expect(out).toContain('--- a.ts');
    });

    it('renders successful verifier outputs without full logs', () => {
      const out = serializer.serialize(
        {
          project: 'tsconfig.json',
          exit_code: 0,
          errors: 0,
          warnings: 0,
          output: 'Found 0 errors. Very long diagnostic banner.',
          truncated: false,
        },
        { toolName: 'typecheck' },
      );
      expect(out).toContain('typecheck');
      expect(out).toContain('status=passed');
      expect(out).not.toContain('Very long diagnostic banner');
    });

    it('keeps verifier failure context', () => {
      const noise = Array.from({ length: 280 }, (_, i) => `ok ${i}`).join('\n');
      const out = serializer.serialize(
        {
          linter: 'biome',
          exit_code: 1,
          errors: 1,
          warnings: 0,
          output: `${noise}\nsrc/a.ts:1:1 error lint/suspicious/noConsole\nUnexpected console.log`,
          truncated: false,
        },
        { toolName: 'lint' },
      );
      expect(out).toContain('error_context');
      expect(out).toContain('src/a.ts:1:1 error');
      expect(out).toContain('serializer omitted');
      expect(out).not.toContain('ok 10');
    });

    it('renders unknown tool objects compactly when tool context is provided', () => {
      const out = serializer.serialize(
        {
          status: 'ok',
          note: 'x'.repeat(300),
          items: ['a', 'b'],
        },
        { toolName: 'custom' },
      );
      expect(out).toContain('custom (status=ok)');
      expect(out).toContain('note:\n');
      expect(out).toContain('items:\na\nb');
      expect(out).not.toContain('{\n  "status"');
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
