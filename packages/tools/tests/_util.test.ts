import * as os from 'node:os';
import * as path from 'node:path';
import type { Context } from '@wrongstack/core';
import { describe, expect, it } from 'vitest';
import {
  COMMAND_OUTPUT_MAX_BYTES,
  collapseCarriageReturns,
  collapseConsecutiveDuplicates,
  ensureInsideRoot,
  isBinaryBuffer,
  normalizeCommandOutput,
  resolvePath,
  safeResolve,
  truncateHeadTail,
  truncateMiddle,
} from '../src/_util.js';

const ctx = (overrides: Partial<Context> = {}): Context =>
  ({
    cwd: overrides.cwd ?? path.resolve('/tmp/project'),
    projectRoot: overrides.projectRoot ?? path.resolve('/tmp/project'),
  }) as Context;

describe('resolvePath', () => {
  it('returns absolute input normalized', () => {
    const c = ctx();
    const abs = path.resolve('/tmp/project/a/b/c.txt');
    expect(resolvePath(abs, c)).toBe(path.normalize(abs));
  });

  it('resolves relative input against ctx.cwd', () => {
    const c = ctx({ cwd: path.resolve('/tmp/project') });
    const out = resolvePath('sub/file.txt', c);
    expect(path.isAbsolute(out)).toBe(true);
    expect(out).toBe(path.resolve('/tmp/project/sub/file.txt'));
  });
});

describe('ensureInsideRoot', () => {
  it('returns the resolved target when inside the root', () => {
    const c = ctx();
    const target = path.resolve('/tmp/project/a.txt');
    expect(ensureInsideRoot(target, c)).toBe(target);
  });

  it('throws when the path is outside the root', () => {
    const c = ctx({ projectRoot: path.resolve('/tmp/project') });
    const outside = path.resolve('/tmp/elsewhere/a.txt');
    expect(() => ensureInsideRoot(outside, c)).toThrow(/outside project root/);
  });

  it('allows the root itself', () => {
    const c = ctx();
    const root = c.projectRoot;
    expect(ensureInsideRoot(root, c)).toBe(path.resolve(root));
  });

  it('rejects parent traversal', () => {
    const c = ctx({ projectRoot: path.resolve('/tmp/project') });
    const parent = path.resolve('/tmp');
    expect(() => ensureInsideRoot(parent, c)).toThrow(/outside project root/);
  });
});

describe('safeResolve', () => {
  it('resolves and validates in one step', () => {
    const c = ctx();
    const out = safeResolve('a.txt', c);
    expect(out).toBe(path.resolve(c.cwd, 'a.txt'));
  });

  it('throws when the resolved path escapes the root', () => {
    const c = ctx({
      cwd: path.resolve('/tmp/project/sub'),
      projectRoot: path.resolve('/tmp/project'),
    });
    expect(() => safeResolve('../../escape.txt', c)).toThrow(/outside project root/);
  });
});

describe('truncateMiddle', () => {
  it('returns input unchanged when under the byte limit', () => {
    expect(truncateMiddle('hello', 100)).toBe('hello');
  });

  it('uses byte length, not character length', () => {
    // 'é' is 2 UTF-8 bytes — 4 chars but 8 bytes.
    const s = 'éééé';
    expect(truncateMiddle(s, 8)).toBe(s); // 8 bytes fits exactly at limit 8
    const out = truncateMiddle(s, 4);
    expect(out).not.toBe(s);
    expect(out).toContain('truncated');
    expect(out).toContain('4 bytes'); // 8 - 4 = 4 bytes removed
  });

  it('truncates the middle and notes the byte count removed', () => {
    const s = 'a'.repeat(1000);
    const out = truncateMiddle(s, 100);
    expect(out).toContain('truncated');
    expect(out).toContain('900 bytes');
    expect(out.startsWith('a'.repeat(50))).toBe(true);
    expect(out.endsWith('a'.repeat(50))).toBe(true);
  });

  it('handles exact-fit input without truncation', () => {
    const s = 'a'.repeat(10);
    expect(truncateMiddle(s, 10)).toBe(s);
  });
});

describe('isBinaryBuffer', () => {
  it('returns true when the buffer contains a NUL byte in the first 8KB', () => {
    const buf = Buffer.concat([Buffer.from('text'), Buffer.from([0]), Buffer.from('more')]);
    expect(isBinaryBuffer(buf)).toBe(true);
  });

  it('returns false for ASCII text', () => {
    expect(isBinaryBuffer(Buffer.from('hello world'))).toBe(false);
  });

  it('returns false for UTF-8 multi-byte content with no NUL', () => {
    expect(isBinaryBuffer(Buffer.from('éà漢字'))).toBe(false);
  });

  it('returns false for an empty buffer', () => {
    expect(isBinaryBuffer(Buffer.alloc(0))).toBe(false);
  });

  it('only scans the first 8KB', () => {
    // Place NUL at byte 9000, well past the scan window.
    const buf = Buffer.alloc(10_000, 0x61);
    buf[9000] = 0;
    expect(isBinaryBuffer(buf)).toBe(false);
  });

  it('detects NUL right at the start', () => {
    const buf = Buffer.concat([Buffer.from([0]), Buffer.from('rest')]);
    expect(isBinaryBuffer(buf)).toBe(true);
  });
});

describe('tmpdir round-trip', () => {
  it('resolvePath + ensureInsideRoot together work with real os.tmpdir', () => {
    const root = os.tmpdir();
    const c = ctx({ cwd: root, projectRoot: root });
    const target = path.join(root, 'demo.txt');
    expect(safeResolve('demo.txt', c)).toBe(target);
  });
});

describe('collapseCarriageReturns', () => {
  it('normalizes CRLF to LF', () => {
    expect(collapseCarriageReturns('a\r\nb\r\n')).toBe('a\nb\n');
  });

  it('collapses a progress bar into its final frame, not N lines', () => {
    const progress = 'Progress: 1%\rProgress: 2%\rProgress: 100%';
    expect(collapseCarriageReturns(progress)).toBe('Progress: 100%');
  });

  it('keeps only the text after the last CR per line', () => {
    expect(collapseCarriageReturns('aaa\rbbb\rccc\nnext')).toBe('ccc\nnext');
  });

  it('leaves CR-free text untouched', () => {
    expect(collapseCarriageReturns('clean\noutput')).toBe('clean\noutput');
  });
});

describe('collapseConsecutiveDuplicates', () => {
  it('collapses a run of >=3 identical lines into one + a marker', () => {
    const out = collapseConsecutiveDuplicates('warn\nwarn\nwarn\nwarn\ndone');
    expect(out).toBe('warn\n… ⟨repeated 4×⟩\ndone');
  });

  it('leaves short runs (<3) intact', () => {
    expect(collapseConsecutiveDuplicates('a\na\nb')).toBe('a\na\nb');
  });

  it('only collapses CONSECUTIVE duplicates, never reorders', () => {
    expect(collapseConsecutiveDuplicates('a\nb\na\nb')).toBe('a\nb\na\nb');
  });
});

describe('truncateHeadTail', () => {
  it('returns the input unchanged when within the cap', () => {
    expect(truncateHeadTail('short', 100)).toBe('short');
  });

  it('keeps both ends and never exceeds the cap', () => {
    const s = `${'H'.repeat(500)}${'M'.repeat(500)}${'T'.repeat(500)}`;
    const out = truncateHeadTail(s, 200);
    expect(Buffer.byteLength(out, 'utf8')).toBeLessThanOrEqual(200);
    expect(out.startsWith('H')).toBe(true); // head kept
    expect(out.endsWith('T')).toBe(true); // tail kept
    expect(out).toContain('truncated');
  });

  it('reports the number of dropped bytes', () => {
    const out = truncateHeadTail('x'.repeat(1000), 200);
    expect(out).toMatch(/truncated \d+ bytes/);
  });
});

describe('normalizeCommandOutput', () => {
  it('strips ANSI, collapses progress, dedups, and squeezes blanks', () => {
    const raw =
      '[32mok[0m\n' +
      'step 1%\rstep 99%\n' +
      'warn\nwarn\nwarn\nwarn\n' +
      '\n\n\n' +
      'done   ';
    const out = normalizeCommandOutput(raw);
    expect(out).not.toContain('['); // no ANSI
    expect(out).toContain('step 99%');
    expect(out).not.toContain('step 1%');
    expect(out).toContain('… ⟨repeated 4×⟩');
    expect(out).not.toMatch(/\n{3,}/); // no 3+ blank runs
    expect(out).toContain('done');
    expect(out.includes('done   ')).toBe(false); // trailing ws trimmed
  });

  it('caps oversized output at COMMAND_OUTPUT_MAX_BYTES', () => {
    // Distinct lines so the dedup pass can't shrink it before truncation.
    let big = '';
    for (let i = 0; i < 50_000; i++) big += `line ${i}\n`;
    const out = normalizeCommandOutput(big);
    expect(Buffer.byteLength(out, 'utf8')).toBeLessThanOrEqual(COMMAND_OUTPUT_MAX_BYTES);
    expect(out).toContain('truncated');
  });

  it('passes through empty input', () => {
    expect(normalizeCommandOutput('')).toBe('');
  });
});
