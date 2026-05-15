import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { replaceTool } from '../src/replace.js';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'replace-tool-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

const makeCtx = () => ({ cwd: tmpDir, tools: [], projectRoot: tmpDir }) as any;

describe('replaceTool', () => {
  it('has correct metadata', () => {
    expect(replaceTool.name).toBe('replace');
    expect(replaceTool.permission).toBe('confirm');
    expect(replaceTool.mutating).toBe(true);
  });

  it('throws when pattern is missing', async () => {
    const ctx = makeCtx();
    await expect(
      replaceTool.execute({ files: 'a.txt', pattern: '', replacement: 'x' } as any, ctx),
    ).rejects.toThrow('pattern is required');
  });

  it('throws when replacement is missing', async () => {
    const ctx = makeCtx();
    await expect(
      replaceTool.execute({ files: 'a.txt', pattern: 'foo', replacement: undefined } as any, ctx),
    ).rejects.toThrow('replacement is required');
  });

  it('throws when files is missing', async () => {
    const ctx = makeCtx();
    await expect(
      replaceTool.execute({ pattern: 'foo', replacement: 'x' } as any, ctx),
    ).rejects.toThrow('files is required');
  });

  it('dry_run does not modify files', async () => {
    const filePath = path.join(tmpDir, 'test.txt');
    await fs.writeFile(filePath, 'hello world', 'utf8');
    const ctx = makeCtx();
    const result = await replaceTool.execute(
      { pattern: 'world', replacement: 'wstack', files: filePath, dry_run: true },
      ctx,
    );
    expect(result.files_modified).toBe(1);
    expect(result.dry_run).toBe(true);
    const content = await fs.readFile(filePath, 'utf8');
    expect(content).toBe('hello world'); // unchanged
  });

  it('actually replaces when not dry_run', async () => {
    const filePath = path.join(tmpDir, 'test.txt');
    await fs.writeFile(filePath, 'hello world', 'utf8');
    const ctx = makeCtx();
    const result = await replaceTool.execute(
      { pattern: 'world', replacement: 'wstack', files: filePath },
      ctx,
    );
    expect(result.files_modified).toBe(1);
    expect(result.total_replacements).toBe(1);
    const content = await fs.readFile(filePath, 'utf8');
    expect(content).toBe('hello wstack');
  });

  it('returns empty results when no matches', async () => {
    const filePath = path.join(tmpDir, 'test.txt');
    await fs.writeFile(filePath, 'hello world', 'utf8');
    const ctx = makeCtx();
    const result = await replaceTool.execute(
      { pattern: 'nonexistent', replacement: 'x', files: filePath },
      ctx,
    );
    expect(result.files_modified).toBe(0);
    expect(result.total_replacements).toBe(0);
  });

  it('handles glob pattern', async () => {
    const filePath = path.join(tmpDir, 'file.txt');
    await fs.writeFile(filePath, 'foo bar', 'utf8');
    const ctx = makeCtx();
    const result = await replaceTool.execute(
      { pattern: 'foo', replacement: 'baz', files: '*.txt' },
      ctx,
    );
    expect(result).toHaveProperty('files_modified');
  });

  it('reports diff for dry run', async () => {
    const filePath = path.join(tmpDir, 'test.txt');
    await fs.writeFile(filePath, 'hello world', 'utf8');
    const ctx = makeCtx();
    const result = await replaceTool.execute(
      { pattern: 'world', replacement: 'wstack', files: filePath, dry_run: true },
      ctx,
    );
    expect(result.results[0].diff).toBeDefined();
  });

  it('skips binary files', async () => {
    const filePath = path.join(tmpDir, 'binary.bin');
    const buf = Buffer.from([0x00, 0x01, 0x02]);
    await fs.writeFile(filePath, buf);
    const ctx = makeCtx();
    const result = await replaceTool.execute(
      { pattern: 'foo', replacement: 'bar', files: filePath },
      ctx,
    );
    expect(result.files_modified).toBe(0);
  });
});
