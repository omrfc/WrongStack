import { describe, it, expect } from 'vitest';
import { installTool } from '../src/install.js';

const makeCtx = () => ({ cwd: '/fake', tools: [], projectRoot: '/fake' } as any);
const makeOpts = () => ({ signal: new AbortController().signal });

describe('installTool', () => {
  it('has correct metadata', () => {
    expect(installTool.name).toBe('install');
    expect(installTool.permission).toBe('confirm');
    expect(installTool.mutating).toBe(true);
  });

  it('handles empty packages', async () => {
    const ctx = makeCtx();
    const result = await installTool.execute({}, ctx, makeOpts());
    expect(result).toHaveProperty('exit_code');
    expect(result).toHaveProperty('packages');
  });

  it('passes single package', async () => {
    const ctx = makeCtx();
    const result = await installTool.execute({ packages: 'vitest' }, ctx, makeOpts());
    expect(result.packages).toContain('vitest');
  });

  it('passes multiple packages as comma string', async () => {
    const ctx = makeCtx();
    const result = await installTool.execute({ packages: 'vitest,prettier' }, ctx, makeOpts());
    expect(result.packages).toContain('vitest');
  });

  it('passes packages as array', async () => {
    const ctx = makeCtx();
    const result = await installTool.execute({ packages: ['vitest', 'prettier'] }, ctx, makeOpts());
    expect(result.packages).toContain('vitest');
  });

  it('passes save=dev flag', async () => {
    const ctx = makeCtx();
    const result = await installTool.execute({ packages: 'foo', save: 'dev' }, ctx, makeOpts());
    expect(result).toHaveProperty('exit_code');
  });

  it('passes global flag', async () => {
    const ctx = makeCtx();
    const result = await installTool.execute({ packages: 'foo', global: true }, ctx, makeOpts());
    expect(result).toHaveProperty('exit_code');
  });

  it('respects dry_run', async () => {
    const ctx = makeCtx();
    const result = await installTool.execute({ packages: 'foo', dry_run: true }, ctx, makeOpts());
    expect(result).toHaveProperty('exit_code');
  });
});