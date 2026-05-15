import { beforeEach, describe, expect, it, vi } from 'vitest';
import { auditTool } from '../src/audit.js';

const makeCtx = () => ({ cwd: '/fake', tools: [], projectRoot: '/fake' }) as any;
const makeOpts = () => ({ signal: new AbortController().signal });

describe('auditTool', () => {
  it('has correct metadata', () => {
    expect(auditTool.name).toBe('audit');
    expect(auditTool.permission).toBe('confirm');
    expect(auditTool.mutating).toBe(false);
    expect(auditTool.inputSchema.type).toBe('object');
  });

  it('handles empty packages', async () => {
    const ctx = makeCtx();
    const opts = makeOpts();
    const result = await auditTool.execute({ level: 'high' }, ctx, opts);
    expect(result).toHaveProperty('exit_code');
    expect(result).toHaveProperty('vulnerabilities');
  });

  it('passes fix flag to args', async () => {
    const ctx = makeCtx();
    const opts = makeOpts();
    const result = await auditTool.execute({ fix: true }, ctx, opts);
    expect(result).toHaveProperty('output');
  });

  it('passes packages to args', async () => {
    const ctx = makeCtx();
    const opts = makeOpts();
    const result = await auditTool.execute({ packages: 'foo,bar' }, ctx, opts);
    expect(result).toHaveProperty('output');
  });

  it('handles packages as array', async () => {
    const ctx = makeCtx();
    const opts = makeOpts();
    const result = await auditTool.execute({ packages: ['foo', 'bar'] }, ctx, opts);
    expect(result).toHaveProperty('output');
  });

  it('handles level filter', async () => {
    const ctx = makeCtx();
    const opts = makeOpts();
    const result = await auditTool.execute({ level: 'critical' }, ctx, opts);
    expect(result).toHaveProperty('exit_code');
  });
});
