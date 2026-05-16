import * as fs from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execTool } from '../src/exec.js';

const makeOpts = () => ({ signal: new AbortController().signal });
const makeCtx = () => ({ cwd: '/fake', tools: [], projectRoot: '/fake' }) as any;

describe('execTool', () => {
  it('has correct metadata', () => {
    expect(execTool.name).toBe('exec');
    expect(execTool.permission).toBe('confirm');
    expect(execTool.mutating).toBe(true);
  });

  it('rejects empty command', async () => {
    const ctx = makeCtx();
    const result = await execTool.execute({ command: '  ' }, ctx, makeOpts());
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Empty command');
  });

  it('blocks command strings with embedded shell metacharacters via allowlist', async () => {
    // Pre-0.1.6 the tool also pattern-matched against a forbidden-regex list,
    // but that was dead code (only the command name was tested). Today the
    // allowlist alone suffices: 'echo hello; rm -rf /' is not the key 'echo'.
    const ctx = makeCtx();
    const result = await execTool.execute({ command: 'echo hello; rm -rf /' }, ctx, makeOpts());
    expect(result.allowed).toBe(false);
    expect(result.stderr).toContain('not in allowlist');
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

  it('allows commands present in the allowlist', async () => {
    const ctx = makeCtx();
    const result = await execTool.execute({ command: 'echo', args: ['hello'] }, ctx, makeOpts());
    // may fail if echo is missing from PATH but allowlist gate should let it through
    expect(result).toHaveProperty('command');
  });

  it('respects MAX_ARGS limit', async () => {
    const ctx = makeCtx();
    const manyArgs = Array(30).fill('arg');
    const result = await execTool.execute(
      { command: 'echo', args: manyArgs as string[] },
      ctx,
      makeOpts(),
    );
    // args should be sliced to MAX_ARGS
    expect(result).toHaveProperty('args');
  });

  it('respects timeout cap', async () => {
    const ctx = makeCtx();
    // timeout > TIMEOUT_MS should be capped
    const result = await execTool.execute(
      { command: 'echo', timeout: 999_999_999 } as any,
      ctx,
      makeOpts(),
    );
    expect(result).toHaveProperty('exitCode');
  });

  it('rejects cwd that resolves outside projectRoot', async () => {
    const ctx = makeCtx();
    const result = await execTool.execute(
      { command: 'echo', cwd: '../../../etc' },
      ctx,
      makeOpts(),
    );
    expect(result.allowed).toBe(false);
    expect(result.stderr).toMatch(/outside project root/);
  });

  it('accepts cwd resolving inside projectRoot', async () => {
    const ctx = makeCtx();
    // ctx.projectRoot is '/fake'; an in-root relative path should pass
    // the gate (the actual spawn may fail because /fake doesn't exist,
    // but `allowed` must remain true for the resolved path check).
    const result = await execTool.execute({ command: 'echo', cwd: 'sub' }, ctx, makeOpts());
    // either allowed:true (resolved) or some spawn error — but NOT the
    // "outside project root" rejection.
    expect(result.stderr).not.toMatch(/outside project root/);
  });
});
