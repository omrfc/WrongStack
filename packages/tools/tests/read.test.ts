import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readTool } from '../src/read.js';
import { type Sandbox, mkSandbox, newSignal } from './fixtures.js';

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
});
