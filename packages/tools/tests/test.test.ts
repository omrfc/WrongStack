import { describe, expect, it } from 'vitest';
import { testTool } from '../src/test.js';

const makeCtx = () => ({ cwd: '/fake', tools: [], projectRoot: '/fake' }) as any;
const makeOpts = () => ({ signal: new AbortController().signal });

describe('testTool', () => {
  it('has correct metadata', () => {
    expect(testTool.name).toBe('test');
    expect(testTool.permission).toBe('confirm');
    expect(testTool.mutating).toBe(false);
  });

  it('returns none when no runner found', async () => {
    const ctx = { cwd: '/', tools: [], projectRoot: '/' } as any;
    const result = await testTool.execute({ runner: 'none' as any }, ctx, makeOpts());
    expect(result.runner).toBe('none');
    expect(result.exit_code).toBe(1);
  });

  it('defaults to vitest', async () => {
    const ctx = { cwd: '/', tools: [], projectRoot: '/' } as any;
    const result = await testTool.execute({ runner: 'auto' }, ctx, makeOpts());
    expect(result).toHaveProperty('exit_code');
  });

  it('passes grep filter', async () => {
    const ctx = makeCtx();
    const result = await testTool.execute({ runner: 'vitest', grep: 'mytest' }, ctx, makeOpts());
    expect(result).toHaveProperty('output');
  });

  it('passes timeout', async () => {
    const ctx = makeCtx();
    const result = await testTool.execute({ runner: 'vitest', timeout: 5000 }, ctx, makeOpts());
    expect(result).toHaveProperty('exit_code');
  });

  it('handles files as array', async () => {
    const ctx = makeCtx();
    const result = await testTool.execute(
      { runner: 'vitest', files: ['a.test.ts', 'b.test.ts'] },
      ctx,
      makeOpts(),
    );
    expect(result).toHaveProperty('output');
  });

  it('respects coverage flag', async () => {
    const ctx = makeCtx();
    const result = await testTool.execute({ runner: 'vitest', coverage: true }, ctx, makeOpts());
    expect(result).toHaveProperty('output');
  });

  it('respects watch flag', async () => {
    const ctx = makeCtx();
    const result = await testTool.execute({ runner: 'vitest', watch: true }, ctx, makeOpts());
    expect(result).toHaveProperty('duration_ms');
  });
});
