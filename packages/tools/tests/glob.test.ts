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
});
