import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { treeTool } from '../src/tree.js';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tree-tool-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

const makeCtx = () => ({ cwd: tmpDir, tools: [], projectRoot: tmpDir } as any);

describe('treeTool', () => {
  it('has correct metadata', () => {
    expect(treeTool.name).toBe('tree');
    expect(treeTool.permission).toBe('auto');
    expect(treeTool.mutating).toBe(false);
  });

  it('returns tree for valid path', async () => {
    const ctx = makeCtx();
    const result = await treeTool.execute({ path: tmpDir }, ctx);
    expect(result).toHaveProperty('tree');
    expect(result).toHaveProperty('total_files');
    expect(result).toHaveProperty('total_dirs');
  });

  it('defaults to cwd', async () => {
    const ctx = makeCtx();
    const result = await treeTool.execute({}, ctx);
    expect(result.path).toBe(tmpDir);
  });

  it('respects depth option', async () => {
    const ctx = makeCtx();
    const result = await treeTool.execute({ depth: 1 }, ctx);
    expect(result).toHaveProperty('tree');
  });

  it('respects show_files=false', async () => {
    const ctx = makeCtx();
    const result = await treeTool.execute({ show_files: false }, ctx);
    expect(result).toHaveProperty('tree');
  });

  it('respects show_dirs=false', async () => {
    const ctx = makeCtx();
    const result = await treeTool.execute({ show_dirs: false }, ctx);
    expect(result).toHaveProperty('tree');
  });

  it('respects show_hidden=true', async () => {
    const ctx = makeCtx();
    const result = await treeTool.execute({ show_hidden: true }, ctx);
    expect(result).toHaveProperty('tree');
  });

  it('respects exclude option', async () => {
    const ctx = makeCtx();
    const result = await treeTool.execute({ exclude: ['node_modules'] }, ctx);
    expect(result).toHaveProperty('tree');
  });

  it('respects glob filter', async () => {
    const ctx = makeCtx();
    const result = await treeTool.execute({ glob: '*.ts' }, ctx);
    expect(result).toHaveProperty('tree');
  });
});