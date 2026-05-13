import { describe, it, expect } from 'vitest';
import { lintTool } from '../src/lint.js';

const makeCtx = () => ({ cwd: '/fake', tools: [], projectRoot: '/fake' } as any);
const makeOpts = () => ({ signal: new AbortController().signal });

describe('lintTool', () => {
  it('has correct metadata', () => {
    expect(lintTool.name).toBe('lint');
    expect(lintTool.permission).toBe('confirm');
    expect(lintTool.mutating).toBe(false);
  });

  it('falls back to biome when no linter config found', async () => {
    const ctx = { cwd: '/', tools: [], projectRoot: '/' } as any;
    const result = await lintTool.execute({ linter: 'auto' }, ctx, makeOpts());
    // detectLinter falls through to 'biome' when no config files found
    expect(result.linter).toBe('biome');
  });

  it('respects fix flag', async () => {
    const ctx = makeCtx();
    const result = await lintTool.execute({ fix: true }, ctx, makeOpts());
    expect(result).toHaveProperty('fix_applied');
  });

  it('passes files to linter', async () => {
    const ctx = makeCtx();
    const result = await lintTool.execute({ files: 'src/**/*.ts' }, ctx, makeOpts());
    expect(result).toHaveProperty('files_checked');
  });

  it('handles files as array', async () => {
    const ctx = makeCtx();
    const result = await lintTool.execute({ files: ['a.ts', 'b.ts'] }, ctx, makeOpts());
    expect(result).toHaveProperty('files_checked');
  });
});