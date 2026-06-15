import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { globTool } from '../src/glob.js';
import { type Sandbox, mkSandbox, newSignal } from './fixtures.js';

describe('glob tool', () => {
  let sb: Sandbox;
  beforeEach(async () => {
    sb = await mkSandbox();
  });
  afterEach(async () => {
    await sb.cleanup();
  });

  it('matches files with simple pattern', async () => {
    await fs.writeFile(path.join(sb.dir, 'a.ts'), '');
    await fs.writeFile(path.join(sb.dir, 'b.js'), '');
    const out = await globTool.execute({ pattern: '*.ts' }, sb.ctx, { signal: newSignal() });
    expect(out.files.some((f) => f.endsWith('a.ts'))).toBe(true);
    expect(out.files.some((f) => f.endsWith('b.js'))).toBe(false);
  });

  it('recurses with **', async () => {
    await fs.mkdir(path.join(sb.dir, 'src', 'deep'), { recursive: true });
    await fs.writeFile(path.join(sb.dir, 'src', 'deep', 'a.ts'), '');
    const out = await globTool.execute({ pattern: '**/*.ts' }, sb.ctx, { signal: newSignal() });
    expect(out.files.length).toBe(1);
  });

  it('ignores node_modules by default', async () => {
    await fs.mkdir(path.join(sb.dir, 'node_modules', 'foo'), { recursive: true });
    await fs.writeFile(path.join(sb.dir, 'node_modules', 'foo', 'index.js'), '');
    await fs.writeFile(path.join(sb.dir, 'me.js'), '');
    const out = await globTool.execute({ pattern: '**/*.js' }, sb.ctx, { signal: newSignal() });
    expect(out.files.some((f) => f.includes('node_modules'))).toBe(false);
    expect(out.files.some((f) => f.endsWith('me.js'))).toBe(true);
  });

  it('matches a nested file by basename when the pattern has no slashes', async () => {
    // rel ("src/deep/x.ts") won't match "x.ts", but the basename does → exercises
    // the `re.test(name)` arm of the match check.
    await fs.mkdir(path.join(sb.dir, 'src', 'deep'), { recursive: true });
    await fs.writeFile(path.join(sb.dir, 'src', 'deep', 'x.ts'), '');
    const out = await globTool.execute({ pattern: 'x.ts' }, sb.ctx, { signal: newSignal() });
    expect(out.files.some((f) => f.endsWith('x.ts'))).toBe(true);
  });

  it('requires a pattern', async () => {
    await expect(
      globTool.execute({ pattern: '' }, sb.ctx, { signal: newSignal() }),
    ).rejects.toThrow(/pattern is required/);
  });

  it('returns no files when the base path is not a directory (readdir fails)', async () => {
    await fs.writeFile(path.join(sb.dir, 'afile.ts'), '');
    const out = await globTool.execute({ pattern: '*', path: 'afile.ts' }, sb.ctx, {
      signal: newSignal(),
    });
    expect(out.files).toEqual([]);
  });

  it('reads and applies .gitignore entries', async () => {
    await fs.writeFile(path.join(sb.dir, '.gitignore'), '# comment\nignored\n\n');
    await fs.mkdir(path.join(sb.dir, 'ignored'));
    await fs.writeFile(path.join(sb.dir, 'ignored', 'hidden.ts'), '');
    await fs.writeFile(path.join(sb.dir, 'visible.ts'), '');
    const out = await globTool.execute({ pattern: '**/*.ts' }, sb.ctx, { signal: newSignal() });
    expect(out.files.some((f) => f.endsWith('visible.ts'))).toBe(true);
    expect(out.files.some((f) => f.includes('ignored'))).toBe(false);
  });

  it('hits limit and truncates', async () => {
    // Create more files than the default limit of 1000
    for (let i = 0; i < 50; i++) {
      await fs.writeFile(path.join(sb.dir, `file${i}.ts`), '');
    }
    const out = await globTool.execute({ pattern: '*.ts', limit: 5 }, sb.ctx, {
      signal: newSignal(),
    });
    expect(out.truncated).toBe(true);
    expect(out.files.length).toBeLessThanOrEqual(5);
  });

  it('stops walking sibling entries once a subdirectory hits the limit', async () => {
    // The limit is reached inside `sub`, so the parent walk returns at the
    // post-recursion `if (truncated) return` guard.
    await fs.mkdir(path.join(sb.dir, 'sub'), { recursive: true });
    for (let i = 0; i < 4; i++) {
      await fs.writeFile(path.join(sb.dir, 'sub', `f${i}.ts`), '');
    }
    await fs.writeFile(path.join(sb.dir, 'zzz-sibling.ts'), '');
    const out = await globTool.execute({ pattern: '**/*.ts', limit: 2 }, sb.ctx, {
      signal: newSignal(),
    });
    expect(out.truncated).toBe(true);
    expect(out.files.length).toBeLessThanOrEqual(2);
  });
});
