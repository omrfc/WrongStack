import { describe, it, expect, vi } from 'vitest';
import { toolUseTool } from '../src/tool-use.js';

const makeOpts = () => ({ signal: new AbortController().signal });

const makeCtx = (tools: any[] = []) =>
  ({ cwd: '/fake', tools, projectRoot: '/fake' } as any);

describe('toolUseTool', () => {
  it('has correct metadata', () => {
    expect(toolUseTool.name).toBe('tool_use');
    expect(toolUseTool.permission).toBe('confirm');
    expect(toolUseTool.mutating).toBe(false);
    expect(toolUseTool.inputSchema.required).toContain('tool');
  });

  it('rejects missing tool name', async () => {
    const ctx = makeCtx([]);
    const result = await toolUseTool.execute({ tool: '' } as any, ctx, makeOpts());
    expect(result.success).toBe(false);
    expect(result.error).toContain('required');
  });

  it('returns error for unknown tool', async () => {
    const ctx = makeCtx([]);
    const result = await toolUseTool.execute({ tool: 'nonexistent' }, ctx, makeOpts());
    expect(result.success).toBe(false);
    expect(result.error).toContain('not found');
  });

  it('returns error for denied tool', async () => {
    const ctx = makeCtx([{
      name: 'denied',
      execute: vi.fn(),
      permission: 'deny',
      mutating: false,
    }]);
    const result = await toolUseTool.execute({ tool: 'denied' }, ctx, makeOpts());
    expect(result.success).toBe(false);
    expect(result.error).toContain('denied by policy');
  });

  it('returns error for confirm tool', async () => {
    const ctx = makeCtx([{
      name: 'needs-confirm',
      execute: vi.fn(),
      permission: 'confirm',
      mutating: false,
    }]);
    const result = await toolUseTool.execute({ tool: 'needs-confirm', input: {} }, ctx, makeOpts());
    expect(result.success).toBe(false);
    expect(result.error).toContain('requires confirmation');
  });

  it('returns error when execute throws', async () => {
    const ctx = makeCtx([{
      name: 'broken',
      execute: vi.fn().mockRejectedValue(new Error('boom')),
      permission: 'auto',
      mutating: false,
    }]);
    const result = await toolUseTool.execute({ tool: 'broken' }, ctx, makeOpts());
    expect(result.success).toBe(false);
    expect(result.error).toContain('boom');
  });

  it('returns result on success', async () => {
    const ctx = makeCtx([{
      name: 'works',
      execute: vi.fn().mockResolvedValue({ value: 42 }),
      permission: 'auto',
      mutating: false,
    }]);
    const result = await toolUseTool.execute({ tool: 'works' }, ctx, makeOpts());
    expect(result.success).toBe(true);
    expect(result.result).toEqual({ value: 42 });
  });

  it('reports execution time', async () => {
    const ctx = makeCtx([{
      name: 'works',
      execute: vi.fn().mockResolvedValue({ value: 42 }),
      permission: 'auto',
      mutating: false,
    }]);
    const result = await toolUseTool.execute({ tool: 'works' }, ctx, makeOpts());
    expect(result.executionMs).toBeGreaterThanOrEqual(0);
  });
});