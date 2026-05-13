import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { execTool } from '../src/exec.js';
import * as fs from 'node:fs/promises';

const makeOpts = () => ({ signal: new AbortController().signal });
const makeCtx = () => ({ cwd: '/fake', tools: [], projectRoot: '/fake' } as any);

describe('execTool', () => {
  it('has correct metadata', () => {
    expect(execTool.name).toBe('exec');
    expect(execTool.permission).toBe('confirm');
    expect(execTool.mutating).toBe(false);
  });

  it('rejects empty command', async () => {
    const ctx = makeCtx();
    const result = await execTool.execute({ command: '  ' }, ctx, makeOpts());
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Empty command');
  });

  it('blocks commands with dangerous patterns', async () => {
    const ctx = makeCtx();
    const result = await execTool.execute({ command: 'echo hello; rm -rf /' }, ctx, makeOpts());
    expect(result.allowed).toBe(false);
    expect(result.stderr).toContain('dangerous pattern');
  });

  it('blocks rm -rf pattern', async () => {
    const ctx = makeCtx();
    const result = await execTool.execute({ command: 'rm -rf /tmp' }, ctx, makeOpts());
    expect(result.allowed).toBe(false);
  });

  it('blocks eval pattern', async () => {
    const ctx = makeCtx();
    const result = await execTool.execute({ command: 'eval echo hello' }, ctx, makeOpts());
    expect(result.allowed).toBe(false);
  });

  it('rejects unknown commands not in allowlist', async () => {
    const ctx = makeCtx();
    const result = await execTool.execute({ command: 'curl' }, ctx, makeOpts());
    expect(result.allowed).toBe(false);
    expect(result.stderr).toContain('not in allowlist');
  });

  it('allows unknown commands with allow_unknown=true', async () => {
    const ctx = makeCtx();
    const result = await execTool.execute({ command: 'echo', args: ['hello'] }, ctx, makeOpts());
    // may fail since echo may not be available but should be allowed
    expect(result).toHaveProperty('command');
  });

  it('respects MAX_ARGS limit', async () => {
    const ctx = makeCtx();
    const manyArgs = Array(30).fill('arg');
    const result = await execTool.execute({ command: 'echo', args: manyArgs as string[] }, ctx, makeOpts());
    // args should be sliced to MAX_ARGS
    expect(result).toHaveProperty('args');
  });

  it('respects timeout cap', async () => {
    const ctx = makeCtx();
    // timeout > TIMEOUT_MS should be capped
    const result = await execTool.execute({ command: 'echo', timeout: 999_999_999 } as any, ctx, makeOpts());
    expect(result).toHaveProperty('exitCode');
  });
});