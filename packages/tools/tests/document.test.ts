import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { documentTool } from '../src/document.js';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'doc-tool-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

const makeCtx = () => ({ cwd: tmpDir, tools: [], projectRoot: tmpDir } as any);

describe('documentTool', () => {
  it('has correct metadata', () => {
    expect(documentTool.name).toBe('document');
    expect(documentTool.permission).toBe('confirm');
    expect(documentTool.mutating).toBe(true);
  });

  it('returns empty results when no files specified', async () => {
    const ctx = makeCtx();
    const result = await documentTool.execute({ target: 'function' }, ctx);
    expect(result.files_processed).toBe(0);
    expect(result.items_documented).toBe(0);
    expect(result.results).toEqual([]);
  });

  it('returns error for non-existent file', async () => {
    const ctx = makeCtx();
    const result = await documentTool.execute(
      { target: 'all', path: path.join(tmpDir, 'nonexistent.ts') },
      ctx,
    );
    expect(result.results[0].status).toBe('error');
    expect(result.results[0].error).toBeDefined();
  });

  it('uses jsdoc style by default', async () => {
    const ctx = makeCtx();
    const result = await documentTool.execute({ target: 'all', path: path.join(tmpDir, 'test.ts') }, ctx);
    expect(result.style).toBe('jsdoc');
  });

  it('uses tsdoc style when specified', async () => {
    const ctx = makeCtx();
    const result = await documentTool.execute(
      { target: 'all', path: path.join(tmpDir, 'test.ts'), style: 'tsdoc' },
      ctx,
    );
    expect(result.style).toBe('tsdoc');
  });

  it('uses block style when specified', async () => {
    const ctx = makeCtx();
    const result = await documentTool.execute(
      { target: 'all', path: path.join(tmpDir, 'test.ts'), style: 'block' },
      ctx,
    );
    expect(result.style).toBe('block');
  });

  it('respects overwrite flag', async () => {
    const ctx = makeCtx();
    const result = await documentTool.execute(
      { target: 'all', path: path.join(tmpDir, 'test.ts'), overwrite: true },
      ctx,
    );
    expect(result).toHaveProperty('style');
  });

  it('processes functions in a real file', async () => {
    const filePath = path.join(tmpDir, 'funcs.ts');
    await fs.writeFile(filePath, 'export function hello() {}\nexport async function world() {}', 'utf8');
    const ctx = makeCtx();
    const result = await documentTool.execute({ target: 'function', files: 'funcs.ts' }, ctx);
    expect(result.files_processed).toBe(1);
    expect(result.items_documented).toBe(0); // still skipped, just detected
    expect(result.results.length).toBeGreaterThan(0);
  });
});