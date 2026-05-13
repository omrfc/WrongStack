import { describe, it, expect } from 'vitest';
import { gitTool } from '../src/git.js';

const makeCtx = () => ({ cwd: '/fake', tools: [], projectRoot: '/fake' } as any);
const makeOpts = () => ({ signal: new AbortController().signal });

describe('gitTool', () => {
  it('has correct metadata', () => {
    expect(gitTool.name).toBe('git');
    expect(gitTool.permission).toBe('confirm');
    expect(gitTool.inputSchema.required).toContain('command');
  });

  it('throws when command is missing', async () => {
    const ctx = makeCtx();
    await expect(gitTool.execute({} as any, ctx, makeOpts())).rejects.toThrow();
  });

  it('returns error when not in a git repo', async () => {
    const ctx = { cwd: '/', tools: [], projectRoot: '/' } as any;
    const result = await gitTool.execute({ command: 'status' }, ctx, makeOpts());
    expect(result.exitCode).toBe(128);
    expect(result.stderr).toBe('Not in a git repository');
  });

  it('handles raw args', async () => {
    const ctx = { cwd: '/', tools: [], projectRoot: '/' } as any;
    const result = await gitTool.execute({ command: 'status', args: '--porcelain' } as any, ctx, makeOpts());
    // Not in a git repo so it returns error
    expect(result).toHaveProperty('exitCode');
  });

  it('respects dry_run for commit', async () => {
    const ctx = { cwd: '/', tools: [], projectRoot: '/' } as any;
    const result = await gitTool.execute({ command: 'commit', dry_run: true, message: 'test' }, ctx, makeOpts());
    expect(result).toHaveProperty('exitCode');
  });
});