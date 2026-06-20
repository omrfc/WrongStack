import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readTool } from '../src/read.js';
import { mkSandbox, newSignal, type Sandbox } from './fixtures.js';

describe('read tool', () => {
  let sb: Sandbox;
  beforeEach(async () => {
    sb = await mkSandbox();
  });
  afterEach(async () => {
    await sb.cleanup();
  });

  it('reads with line numbers', async () => {
    const file = path.join(sb.dir, 'a.txt');
    await fs.writeFile(file, 'first\nsecond\nthird\n');
    const out = await readTool.execute({ path: 'a.txt' }, sb.ctx, { signal: newSignal() });
    expect(out.text).toContain('1→first');
    expect(out.text).toContain('2→second');
    expect(out.total_lines).toBeGreaterThanOrEqual(3);
  });

  it('supports offset and limit', async () => {
    const file = path.join(sb.dir, 'b.txt');
    await fs.writeFile(file, Array.from({ length: 100 }, (_, i) => `line${i + 1}`).join('\n'));
    const out = await readTool.execute({ path: 'b.txt', offset: 10, limit: 5 }, sb.ctx, {
      signal: newSignal(),
    });
    expect(out.text).toContain('10→line10');
    expect(out.text).toContain('14→line14');
    expect(out.text).not.toContain('15→');
  });

  it('suppresses repeated reads of an unchanged already-seen range', async () => {
    const file = path.join(sb.dir, 'repeat.txt');
    await fs.writeFile(file, 'first\nsecond\nthird\n');
    const first = await readTool.execute({ path: 'repeat.txt' }, sb.ctx, {
      signal: newSignal(),
    });
    expect(first.text).toContain('1→first');

    const second = await readTool.execute({ path: 'repeat.txt' }, sb.ctx, {
      signal: newSignal(),
    });
    expect(second.cached).toBe(true);
    expect(second.text).toContain('unchanged since previous read');
    expect(second.text).not.toContain('1→first');
  });

  it('does not suppress a new explicit range that was not seen yet', async () => {
    const file = path.join(sb.dir, 'ranges.txt');
    await fs.writeFile(file, Array.from({ length: 20 }, (_, i) => `line${i + 1}`).join('\n'));
    await readTool.execute({ path: 'ranges.txt', offset: 1, limit: 3 }, sb.ctx, {
      signal: newSignal(),
    });

    const out = await readTool.execute({ path: 'ranges.txt', offset: 10, limit: 2 }, sb.ctx, {
      signal: newSignal(),
    });
    expect(out.cached).toBeUndefined();
    expect(out.text).toContain('10→line10');
    expect(out.text).toContain('11→line11');
  });

  it('supports compact summary mode', async () => {
    const file = path.join(sb.dir, 'summary.ts');
    await fs.writeFile(
      file,
      [
        "import { value } from './value';",
        'const hidden = 1;',
        'export function run() {',
        '  return value + hidden;',
        '}',
      ].join('\n'),
    );
    const out = await readTool.execute({ path: 'summary.ts', mode: 'summary' }, sb.ctx, {
      signal: newSignal(),
    });
    expect(out.text).toContain('summary: summary.ts');
    expect(out.text).toContain('1: import');
    expect(out.text).toContain('3: export function run');
    expect(out.text).not.toContain('return value');
  });

  it('requires a path', async () => {
    await expect(readTool.execute({ path: '' }, sb.ctx, { signal: newSignal() })).rejects.toThrow(
      /path is required/,
    );
  });

  it('rejects a directory (not a regular file)', async () => {
    await fs.mkdir(path.join(sb.dir, 'adir'));
    await expect(
      readTool.execute({ path: 'adir' }, sb.ctx, { signal: newSignal() }),
    ).rejects.toThrow(/not a regular file/);
  });

  it('rejects files larger than the 5MB cap', async () => {
    const file = path.join(sb.dir, 'big.txt');
    await fs.writeFile(file, Buffer.alloc(5 * 1024 * 1024 + 1, 0x61)); // 5MB+1 of 'a'
    await expect(
      readTool.execute({ path: 'big.txt' }, sb.ctx, { signal: newSignal() }),
    ).rejects.toThrow(/file too large/);
  });

  it('rejects binary files', async () => {
    const file = path.join(sb.dir, 'bin.bin');
    await fs.writeFile(file, Buffer.from([0, 1, 2, 3, 0, 5]));
    await expect(
      readTool.execute({ path: 'bin.bin' }, sb.ctx, { signal: newSignal() }),
    ).rejects.toThrow(/binary/);
  });

  it('records read in context', async () => {
    const file = path.join(sb.dir, 'c.txt');
    await fs.writeFile(file, 'x');
    await readTool.execute({ path: 'c.txt' }, sb.ctx, { signal: newSignal() });
    const abs = path.normalize(path.resolve(sb.dir, 'c.txt'));
    expect(sb.ctx.hasRead(abs)).toBe(true);
  });

  it('rejects sandbox escape', async () => {
    await expect(
      readTool.execute({ path: '../../etc/passwd' }, sb.ctx, { signal: newSignal() }),
    ).rejects.toThrow();
  });

  it('rejects file that does not exist', async () => {
    await expect(
      readTool.execute({ path: 'nonexistent.txt' }, sb.ctx, { signal: newSignal() }),
    ).rejects.toThrow(/not found/);
  });

  it('returns empty text with truncated=true when limit=0', async () => {
    const file = path.join(sb.dir, 'd.txt');
    await fs.writeFile(file, 'first\nsecond\nthird\n');
    const out = await readTool.execute({ path: 'd.txt', limit: 0 }, sb.ctx, {
      signal: newSignal(),
    });
    expect(out.text).toBe('');
    expect(out.truncated).toBe(true);
    expect(out.total_lines).toBeGreaterThan(0);
    // ctx.recordRead should still be called
    const abs = path.normalize(path.resolve(sb.dir, 'd.txt'));
    expect(sb.ctx.hasRead(abs)).toBe(true);
  });

  it('returns past-EOF message when offset exceeds file length', async () => {
    const file = path.join(sb.dir, 'eof.txt');
    await fs.writeFile(file, 'line1\nline2\nline3\n');
    const out = await readTool.execute({ path: 'eof.txt', offset: 999 }, sb.ctx, {
      signal: newSignal(),
    });
    // Must NOT be an empty string — empty results cause tool-use loops on
    // models with weak instruction-following (k2p7, etc.).
    expect(out.text).not.toBe('');
    expect(out.text).toContain('past end of file');
    expect(out.text).toContain('999');
    expect(out.text).toContain('line'); // "N line(s)" — exact count varies by trailing newline
    expect(out.total_lines).toBeGreaterThanOrEqual(3);
    // Still records the read so edit safety checks pass.
    const abs = path.normalize(path.resolve(sb.dir, 'eof.txt'));
    expect(sb.ctx.hasRead(abs)).toBe(true);
  });

  it('returns past-EOF message when offset equals total+1 (boundary)', async () => {
    const file = path.join(sb.dir, 'boundary.txt');
    await fs.writeFile(file, 'only\n');
    // File has ~2 lines after split (content + empty trailing), so offset 10
    // is safely past EOF.
    const out = await readTool.execute({ path: 'boundary.txt', offset: 10 }, sb.ctx, {
      signal: newSignal(),
    });
    expect(out.text).toContain('past end of file');
  });

  // F-04 (CWE-59): a symlink that lives INSIDE the project root but points
  // outside must not be followed — `safeResolve`'s syntactic check passes it,
  // the realpath cross-check (safeResolveReal) must reject it.
  it('refuses to read through an in-root symlink pointing outside the root', async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-outside-'));
    try {
      const secret = path.join(outside, 'secret.txt');
      await fs.writeFile(secret, 'TOP SECRET');
      const link = path.join(sb.dir, 'escape.txt');
      try {
        await fs.symlink(secret, link);
      } catch (err) {
        // Symlink creation can require privileges (Windows without dev mode).
        if ((err as NodeJS.ErrnoException).code === 'EPERM') return; // skip
        throw err;
      }
      await expect(
        readTool.execute({ path: 'escape.txt' }, sb.ctx, { signal: newSignal() }),
      ).rejects.toThrow(/symlink outside project root/);
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });
});
