import { describe, expect, it } from 'vitest';
import { outdatedTool } from '../src/outdated.js';

const makeCtx = () => ({ cwd: '/fake', tools: [], projectRoot: '/fake' }) as any;
const makeOpts = () => ({ signal: new AbortController().signal });

describe('outdatedTool', () => {
  it('has correct metadata', () => {
    expect(outdatedTool.name).toBe('outdated');
    expect(outdatedTool.permission).toBe('auto');
    expect(outdatedTool.mutating).toBe(false);
  });

  it('handles default params', async () => {
    const ctx = makeCtx();
    const result = await outdatedTool.execute({}, ctx, makeOpts());
    expect(result).toHaveProperty('exit_code');
    expect(result).toHaveProperty('packages');
  });

  it('respects format=table', async () => {
    const ctx = makeCtx();
    const result = await outdatedTool.execute({ format: 'table' }, ctx, makeOpts());
    expect(result).toHaveProperty('exit_code');
  });

  it('respects include_deprecated', async () => {
    const ctx = makeCtx();
    const result = await outdatedTool.execute({ include_deprecated: true }, ctx, makeOpts());
    expect(result).toHaveProperty('exit_code');
  });

  it('handles check param', async () => {
    const ctx = makeCtx();
    const result = await outdatedTool.execute({ check: 'vitest' }, ctx, makeOpts());
    expect(result).toHaveProperty('exit_code');
  });

  it('handles check as array', async () => {
    const ctx = makeCtx();
    const result = await outdatedTool.execute(
      { check: ['vitest', 'prettier'] } as any,
      ctx,
      makeOpts(),
    );
    expect(result).toHaveProperty('exit_code');
  });
});
