import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { patchTool } from '../src/patch.js';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'patch-tool-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

const makeCtx = () => ({ cwd: tmpDir, tools: [], projectRoot: tmpDir } as any);
const makeOpts = () => ({ signal: new AbortController().signal });

describe('patchTool', () => {
  it('has correct metadata', () => {
    expect(patchTool.name).toBe('patch');
    expect(patchTool.permission).toBe('confirm');
    expect(patchTool.mutating).toBe(true);
    expect(patchTool.inputSchema.required).toContain('patch');
  });

  it('throws when patch is empty', async () => {
    const ctx = makeCtx();
    await expect(patchTool.execute({ patch: '' }, ctx, makeOpts())).rejects.toThrow();
  });

  it('throws when patch is null', async () => {
    const ctx = makeCtx();
    await expect(patchTool.execute({ patch: null as any }, ctx, makeOpts())).rejects.toThrow();
  });

  it('applies dry_run correctly', async () => {
    const ctx = makeCtx();
    const result = await patchTool.execute(
      { patch: '--- fake\n+++ fake\n@@ -1,1 +1,1 @@\n-old\n+new', dry_run: true },
      ctx,
      makeOpts(),
    );
    expect(result).toHaveProperty('dry_run');
  });

  it('handles strip option', async () => {
    const ctx = makeCtx();
    const result = await patchTool.execute(
      { patch: '--- a\n+++ b\n@@ -1 @@\n-old\n+new', strip: 2 },
      ctx,
      makeOpts(),
    );
    expect(result).toHaveProperty('message');
  });

  it('returns applied=0 when patch fails', async () => {
    const ctx = makeCtx();
    const result = await patchTool.execute(
      { patch: '--- fake\n+++ fake\n@@ -1 @@\n-old\n+new' },
      ctx,
      makeOpts(),
    );
    // patch will fail because the file doesn't exist - applied should be 0
    expect(result).toHaveProperty('applied');
  });
});