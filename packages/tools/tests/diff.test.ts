import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { diffTool } from '../src/diff.js';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'diff-tool-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

const makeCtx = () => ({ cwd: tmpDir, tools: [], projectRoot: tmpDir } as any);
const makeOpts = () => ({ signal: new AbortController().signal });

describe('diffTool', () => {
  it('has correct metadata', () => {
    expect(diffTool.name).toBe('diff');
    expect(diffTool.permission).toBe('auto');
    expect(diffTool.mutating).toBe(false);
  });

  it('rejects when no files specified for file diff', async () => {
    const ctx = makeCtx();
    const result = await diffTool.execute({}, ctx, makeOpts());
    expect(result.diff).toBe('No files specified');
    expect(result.files).toEqual([]);
  });

  it('returns error when not in git repo for git diff', async () => {
    const ctx = { cwd: '/', tools: [], projectRoot: '/' } as any;
    const result = await diffTool.execute({ a: 'HEAD~1', b: 'HEAD' }, ctx, makeOpts());
    expect(result.diff).toBe('');
    expect(result.files).toEqual([]);
  });

  it('handles staged diff', async () => {
    const ctx = { cwd: '/', tools: [], projectRoot: '/' } as any;
    const result = await diffTool.execute({ staged: true }, ctx, makeOpts());
    expect(result).toHaveProperty('mode');
  });

  it('handles context option', async () => {
    const filePath = path.join(tmpDir, 'file.txt');
    await fs.writeFile(filePath, 'hello\nworld', 'utf8');
    const ctx = makeCtx();
    const result = await diffTool.execute({ files: 'file.txt', context: 5 }, ctx, makeOpts());
    expect(result.mode).toBe('unified');
  });

  it('handles side-by-side mode', async () => {
    const filePath = path.join(tmpDir, 'file.txt');
    await fs.writeFile(filePath, 'hello\nworld', 'utf8');
    const ctx = makeCtx();
    const result = await diffTool.execute({ files: 'file.txt', mode: 'side-by-side' }, ctx, makeOpts());
    expect(result.mode).toBe('side-by-side');
  });

  it('handles stat mode', async () => {
    const filePath = path.join(tmpDir, 'file.txt');
    await fs.writeFile(filePath, 'hello\nworld', 'utf8');
    const ctx = makeCtx();
    const result = await diffTool.execute({ files: 'file.txt', mode: 'stat' }, ctx, makeOpts());
    expect(result.mode).toBe('stat');
  });
});