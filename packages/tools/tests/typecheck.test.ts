import { describe, it, expect } from 'vitest';
import { typecheckTool } from '../src/typecheck.js';

const makeCtx = () => ({ cwd: '/fake', tools: [], projectRoot: '/fake' } as any);
const makeOpts = () => ({ signal: new AbortController().signal });

describe('typecheckTool', () => {
  it('has correct metadata', () => {
    expect(typecheckTool.name).toBe('typecheck');
    expect(typecheckTool.permission).toBe('confirm');
    expect(typecheckTool.mutating).toBe(false);
  });

  it('runs all when all=true', async () => {
    const ctx = makeCtx();
    const result = await typecheckTool.execute({ all: true }, ctx, makeOpts());
    expect(result).toHaveProperty('project');
    expect(result).toHaveProperty('exit_code');
  });

  it('respects strict flag', async () => {
    const ctx = makeCtx();
    const result = await typecheckTool.execute({ strict: true } as any, ctx, makeOpts());
    expect(result).toHaveProperty('output');
  });

  it('handles project option', async () => {
    const ctx = makeCtx();
    // project path is resolved relative to cwd (tmpDir which exists)
    const result = await typecheckTool.execute({ project: 'tsconfig.json' }, ctx, makeOpts());
    expect(result).toHaveProperty('project');
  });
});