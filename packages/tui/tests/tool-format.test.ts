import { describe, expect, it } from 'vitest';
import {
  extractDiffPreview,
  fmtDuration,
  formatToolArgs,
  formatToolOutput,
} from '../src/components/history.js';

describe('formatToolArgs', () => {
  it('read/edit/write: just the (shortened) path', () => {
    expect(formatToolArgs('read', { path: '/tmp/x.ts' })).toBe('/tmp/x.ts');
    expect(formatToolArgs('edit', { path: '/tmp/x.ts', old_string: 'a', new_string: 'b' })).toBe(
      '/tmp/x.ts',
    );
    expect(formatToolArgs('write', { path: '/tmp/x.ts', content: 'z' })).toBe('/tmp/x.ts');
  });

  it('read with very deep path is shortened with an ellipsis prefix', () => {
    const deep = '/' + 'subdir/'.repeat(20) + 'file.ts';
    const out = formatToolArgs('read', { path: deep });
    expect(out.length).toBeLessThanOrEqual(60);
    expect(out.startsWith('…')).toBe(true);
    expect(out.endsWith('file.ts')).toBe(true);
  });

  it('grep: quoted pattern + optional scope', () => {
    expect(formatToolArgs('grep', { pattern: 'foo' })).toBe('"foo"');
    expect(formatToolArgs('grep', { pattern: 'foo', path: '/src' })).toBe('"foo" in /src');
  });

  it('bash: just the command, truncated', () => {
    expect(formatToolArgs('bash', { command: 'ls -la' })).toBe('ls -la');
    const long = 'echo ' + 'x'.repeat(200);
    const out = formatToolArgs('bash', { command: long });
    expect(out.length).toBeLessThanOrEqual(60);
    expect(out.endsWith('…')).toBe(true);
  });

  it('fetch / webfetch: just the URL', () => {
    expect(formatToolArgs('fetch', { url: 'https://example.com' })).toBe('https://example.com');
  });

  it('todo: item count', () => {
    expect(formatToolArgs('todo', { todos: [{}, {}, {}] })).toBe('3 items');
    expect(formatToolArgs('todo', { todos: [{}] })).toBe('1 item');
  });

  it('unknown tool: picks the most identifying field', () => {
    expect(formatToolArgs('weird', { name: 'thing', misc: 'noise' })).toBe('thing');
  });

  it('unknown tool with no identifying field: compact JSON preview', () => {
    const out = formatToolArgs('weird', { x: 1, y: 2 });
    expect(out).toContain('"x":1');
  });

  it('returns empty string for missing/non-object input', () => {
    expect(formatToolArgs('read', undefined)).toBe('');
    expect(formatToolArgs('read', null)).toBe('');
    expect(formatToolArgs('read', 'string-input')).toBe('');
  });
});

describe('formatToolOutput', () => {
  it('grep: count from parsed JSON', () => {
    const none = formatToolOutput(
      'grep',
      JSON.stringify({ count: 0, matches: [], truncated: false }),
      true,
    );
    expect(none).toEqual(['no matches']);

    const some = formatToolOutput(
      'grep',
      JSON.stringify({ count: 3, matches: [], truncated: false }),
      true,
    );
    expect(some).toEqual(['3 matches']);

    const trunc = formatToolOutput(
      'grep',
      JSON.stringify({ count: 1, matches: [], truncated: true }),
      true,
    );
    expect(trunc).toHaveLength(1);
    expect(trunc[0]).toContain('1 match');
    expect(trunc[0]).toContain('truncated');
  });

  it('grep: appends a first-match hint when matches are present', () => {
    const out = formatToolOutput(
      'grep',
      JSON.stringify({
        count: 2,
        matches: [{ file: 'src/foo.ts', line: 42, text: 'foo()' }],
        truncated: false,
      }),
      true,
    );
    expect(out).toHaveLength(2);
    expect(out[0]).toContain('2 matches');
    expect(out[1]).toContain('src/foo.ts');
    expect(out[1]).toContain('42');
  });

  it('read: surfaces the line range and total count on a single line', () => {
    const text = '   1→hello\n   2→world\n   3→!';
    const out = formatToolOutput('read', text, true);
    expect(out).toHaveLength(1);
    expect(out[0]).toContain('L1–3');
    expect(out[0]).toContain('3 lines');
  });

  it('read: single-line read shows just the line number', () => {
    const out = formatToolOutput('read', '  42→only', true);
    expect(out).toHaveLength(1);
    expect(out[0]).toContain('L42');
  });

  it('read: non-contiguous numbered lines flag gaps', () => {
    const text = '   1→a\n   2→b\n  50→c';
    const out = formatToolOutput('read', text, true);
    expect(out).toHaveLength(1);
    expect(out[0]).toContain('L1–50');
    expect(out[0]).toContain('gaps');
  });

  it('edit: surfaces replacement count from JSON', () => {
    expect(formatToolOutput('edit', JSON.stringify({ replacements: 2, path: '/x' }), true)).toEqual(
      ['2 replacements'],
    );
    expect(formatToolOutput('edit', JSON.stringify({ replacements: 1, path: '/x' }), true)).toEqual(
      ['1 replacement'],
    );
  });

  it('write: bytes written', () => {
    const out = formatToolOutput('write', JSON.stringify({ bytes: 1024, path: '/x' }), true);
    expect(out).toHaveLength(1);
    expect(out[0]).toContain('1.0KB');
  });

  it('bash: 2 lines when stdout has content (header + preview)', () => {
    const out = formatToolOutput(
      'bash',
      JSON.stringify({ exit_code: 0, stdout: 'first line\nsecond\nthird' }),
      true,
    );
    expect(out).toHaveLength(2);
    expect(out[0]).toContain('exit 0');
    expect(out[0]).toContain('3 out');
    expect(out[1]).toContain('first line');
  });

  it('bash: 3 lines when both stdout and stderr have content', () => {
    const out = formatToolOutput(
      'bash',
      JSON.stringify({
        exit_code: 0,
        stdout: 'normal output',
        stderr: 'a warning happened',
      }),
      true,
    );
    expect(out).toHaveLength(3);
    expect(out[0]).toContain('1 out');
    expect(out[0]).toContain('1 err');
    expect(out[1]).toContain('normal output');
    expect(out[2]).toMatch(/^! /);
    expect(out[2]).toContain('warning');
  });

  it('bash: 1 line when only exit code is known', () => {
    const out = formatToolOutput(
      'bash',
      JSON.stringify({ exit_code: 0, stdout: '', stderr: '' }),
      true,
    );
    expect(out).toEqual(['exit 0']);
  });

  it('bash: stderr-only shows a single preview line marked with !', () => {
    const out = formatToolOutput(
      'bash',
      JSON.stringify({ exit_code: 1, stdout: '', stderr: 'boom' }),
      true,
    );
    expect(out).toHaveLength(2);
    expect(out[0]).toContain('exit 1');
    expect(out[0]).toContain('1 err');
    expect(out[1]).toContain('boom');
  });

  it('todo: no extra line on success (item count is already in args)', () => {
    expect(formatToolOutput('todo', 'updated', true)).toEqual([]);
  });

  it('unknown tool: all whitespace collapsed to single line', () => {
    // The fallback used to take only the first non-empty line, which
    // broke pretty-printed JSON results (the first line was just `{`).
    // The new behavior joins every line with single spaces so the
    // preview surfaces the actual content, not just the opening brace.
    expect(formatToolOutput('weird', '\n\nfirst line\nsecond line', true)).toEqual([
      'first line second line',
    ]);
  });

  it('unknown tool: JSON object rendered as key=value preview', () => {
    // Pretty-printed JSON used to display as `└─ {` (just the opening
    // brace from the first line). The new behavior summarizes by key.
    const json = JSON.stringify(
      { ok: false, stopReason: 'host_timeout', error: 'too slow', toolCalls: 12 },
      null,
      2,
    );
    const out = formatToolOutput('delegate', json, false);
    expect(out).toHaveLength(1);
    expect(out[0]).toContain('ok=false');
    expect(out[0]).toContain('stopReason="host_timeout"');
    expect(out[0]).toContain('error="too slow"');
    expect(out[0]).toContain('toolCalls=12');
  });

  it('failed tool with empty output renders ["failed"]', () => {
    expect(formatToolOutput('weird', undefined, false)).toEqual(['failed']);
    expect(formatToolOutput('weird', '', false)).toEqual(['failed']);
  });

  it('successful tool with empty output renders []', () => {
    expect(formatToolOutput('weird', '', true)).toEqual([]);
  });
});

describe('formatToolOutput (extended tools)', () => {
  it('write: reports created vs updated with bytes', () => {
    expect(
      formatToolOutput('write', JSON.stringify({ bytes_written: 1024, created: true }), true),
    ).toEqual(['created · 1.0KB']);
    expect(
      formatToolOutput('write', JSON.stringify({ bytes_written: 512, created: false }), true),
    ).toEqual(['updated · 512B']);
  });

  it('patch: applied / rejected + first file', () => {
    const out = formatToolOutput(
      'patch',
      JSON.stringify({ applied: 2, rejected: 1, files: ['src/a.ts', 'src/b.ts'] }),
      true,
    );
    expect(out).toHaveLength(2);
    expect(out[0]).toContain('2 applied');
    expect(out[0]).toContain('1 rejected');
    expect(out[1]).toContain('src/a.ts');
    expect(out[1]).toContain('+1');
  });

  it('test: passed/failed/duration summary', () => {
    const out = formatToolOutput(
      'test',
      JSON.stringify({
        runner: 'vitest',
        exit_code: 0,
        tests_run: 10,
        passed: 9,
        failed: 1,
        duration_ms: 4200,
      }),
      true,
    );
    expect(out).toEqual(['vitest · 9/10 passed · 1 failed · 4.2s']);
  });

  it('lint: errors + warnings + linter', () => {
    const out = formatToolOutput(
      'lint',
      JSON.stringify({ linter: 'biome', files_checked: 12, errors: 2, warnings: 5 }),
      true,
    );
    expect(out[0]).toContain('biome');
    expect(out[0]).toContain('2 errors');
    expect(out[0]).toContain('5 warnings');
    expect(out[0]).toContain('12 files');
  });

  it('fetch: HTTP status + content type + size', () => {
    const out = formatToolOutput(
      'fetch',
      JSON.stringify({
        status: 200,
        content_type: 'text/html',
        url: 'https://x',
        content: 'a'.repeat(2048),
      }),
      true,
    );
    expect(out[0]).toContain('HTTP 200');
    expect(out[0]).toContain('text/html');
    expect(out[0]).toContain('2.0KB');
  });

  it('tree: files + dirs counts', () => {
    expect(
      formatToolOutput(
        'tree',
        JSON.stringify({ total_files: 42, total_dirs: 7, tree: 'x', truncated: false, path: '.' }),
        true,
      ),
    ).toEqual(['42 files · 7 dirs']);
  });

  it('audit: zero-vuln short-circuits', () => {
    expect(
      formatToolOutput(
        'audit',
        JSON.stringify({
          exit_code: 0,
          vulnerabilities: [],
          total: 0,
          summary: 'No vulnerabilities found',
        }),
        true,
      ),
    ).toEqual(['no vulnerabilities']);
  });

  it('outdated: surfaces first package upgrade', () => {
    const out = formatToolOutput(
      'outdated',
      JSON.stringify({
        exit_code: 1,
        total: 3,
        packages: [{ name: 'foo', current: '1.0.0', wanted: '1.2.0' }],
      }),
      true,
    );
    expect(out).toHaveLength(2);
    expect(out[0]).toContain('3 outdated');
    expect(out[1]).toContain('foo: 1.0.0 → 1.2.0');
  });
});

describe('extractDiffPreview', () => {
  const sampleDiff = [
    'diff --git a/x.ts b/x.ts',
    'index abc..def 100644',
    '--- a/x.ts',
    '+++ b/x.ts',
    '@@ -1,3 +1,3 @@',
    ' unchanged',
    '-removed line',
    '+added line',
    ' another',
  ].join('\n');

  it('returns undefined when tool has no diff field', () => {
    expect(extractDiffPreview('bash', JSON.stringify({ exit_code: 0 }))).toBeUndefined();
    expect(extractDiffPreview('read', '  1→hello')).toBeUndefined();
    expect(extractDiffPreview('edit', undefined)).toBeUndefined();
  });

  it('parses an edit-tool diff JSON into add/del/hunk rows', () => {
    const out = extractDiffPreview(
      'edit',
      JSON.stringify({ path: '/x', replacements: 1, diff: sampleDiff }),
    );
    expect(out).toBeDefined();
    const kinds = out!.rows.map((r) => r.kind);
    expect(kinds).toContain('hunk');
    expect(kinds).toContain('add');
    expect(kinds).toContain('del');
    expect(kinds).toContain('ctx');
    // header lines (diff --git, index, ---, +++) are stripped.
    expect(out!.rows.some((r) => r.text.startsWith('---'))).toBe(false);
    expect(out!.rows.some((r) => r.text.startsWith('+++'))).toBe(false);
  });

  it('caps preview at 8 lines and reports the hidden remainder', () => {
    const many = ['@@ -1,20 +1,20 @@', ...Array.from({ length: 30 }, (_, i) => `+line ${i}`)].join(
      '\n',
    );
    const out = extractDiffPreview('edit', JSON.stringify({ diff: many }));
    expect(out!.rows.length).toBeLessThanOrEqual(8);
    expect(out!.hidden).toBeGreaterThan(0);
  });

  it('skips no-op edit sentinel diff', () => {
    const out = extractDiffPreview(
      'edit',
      JSON.stringify({ diff: '(no-op: old and new are identical)' }),
    );
    expect(out).toBeUndefined();
  });

  it('parses raw unified diff for patch tool (no JSON wrapper)', () => {
    const out = extractDiffPreview('patch', sampleDiff);
    expect(out).toBeDefined();
    expect(out!.rows.some((r) => r.kind === 'add')).toBe(true);
    expect(out!.rows.some((r) => r.kind === 'del')).toBe(true);
  });
});

describe('fmtDuration', () => {
  it('renders ms below 1s', () => {
    expect(fmtDuration(0)).toBe('0ms');
    expect(fmtDuration(42)).toBe('42ms');
    expect(fmtDuration(999)).toBe('999ms');
  });

  it('renders seconds with one decimal up to 1 minute', () => {
    expect(fmtDuration(1_000)).toBe('1.0s');
    expect(fmtDuration(45_300)).toBe('45.3s');
  });

  it('renders Xm Ys at one minute and above', () => {
    expect(fmtDuration(60_000)).toBe('1m0s');
    expect(fmtDuration(75_000)).toBe('1m15s');
    expect(fmtDuration(3_600_000)).toBe('60m0s');
  });
});
