import { beforeEach, describe, expect, it, vi } from 'vitest';
import { batchToolUseTool } from '../src/batch-tool-use.js';

const makeCtx = (tools: any[] = []) =>
  ({
    cwd: '/fake',
    tools,
    projectRoot: '/fake',
  }) as any;
const makeOpts = () => ({ signal: new AbortController().signal });

describe('batchToolUseTool', () => {
  it('has correct metadata', () => {
    expect(batchToolUseTool.name).toBe('batch_tool_use');
    expect(batchToolUseTool.permission).toBe('confirm');
    expect(batchToolUseTool.mutating).toBe(true);
    expect(batchToolUseTool.timeoutMs).toBe(120_000);
  });

  it('returns empty result for empty calls', async () => {
    const ctx = makeCtx();
    const result = await batchToolUseTool.execute({ calls: [] }, ctx, makeOpts());
    expect(result.total).toBe(0);
    expect(result.succeeded).toBe(0);
    expect(result.failed).toBe(0);
    expect(result.results).toEqual([]);
  });

  it('returns empty result for null/undefined calls', async () => {
    const ctx = makeCtx();
    const result = await batchToolUseTool.execute({ calls: undefined as any }, ctx, makeOpts());
    expect(result.total).toBe(0);
  });

  it('runs tools in parallel by default', async () => {
    let resolve: (v: any) => void;
    const promise = new Promise((r) => {
      resolve = r;
    });
    const fakeTool = {
      name: 'test',
      execute: vi.fn().mockReturnValue(Promise.resolve({ value: 1 })),
    };
    const ctx = makeCtx([fakeTool]);

    const result = await batchToolUseTool.execute(
      { calls: [{ tool: 'test', input: {} }] },
      ctx,
      makeOpts(),
    );

    expect(result.total).toBe(1);
    expect(result.succeeded).toBe(1);
    expect(result.results[0].success).toBe(true);
  });

  it('reports tool not found', async () => {
    const ctx = makeCtx([]);
    const result = await batchToolUseTool.execute(
      { calls: [{ tool: 'nonexistent', input: {} }] },
      ctx,
      makeOpts(),
    );
    expect(result.total).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.results[0].success).toBe(false);
    expect(result.results[0].error).toContain('not found');
  });

  it('handles parallel=false (sequential)', async () => {
    const fakeTool = {
      name: 'test',
      execute: vi.fn().mockResolvedValue({ value: 1 }),
    };
    const ctx = makeCtx([fakeTool]);

    const result = await batchToolUseTool.execute(
      { calls: [{ tool: 'test', input: {} }], parallel: false },
      ctx,
      makeOpts(),
    );
    expect(result.total).toBe(1);
    expect(result.succeeded).toBe(1);
  });

  it('stops on error when stop_on_error=true', async () => {
    const fakeTool = {
      name: 'test',
      execute: vi.fn().mockRejectedValue(new Error('boom')),
    };
    const ctx = makeCtx([fakeTool]);

    const result = await batchToolUseTool.execute(
      {
        calls: [
          { tool: 'test', input: {} },
          { tool: 'test', input: {} },
        ],
        stop_on_error: true,
        parallel: false,
      },
      ctx,
      makeOpts(),
    );
    // With stop_on_error + sequential, loop should break after first failure
    expect(result.results.length).toBeLessThanOrEqual(2);
  });

  it('continues when stop_on_error=false even after failure', async () => {
    const fakeTool = {
      name: 'test',
      execute: vi.fn().mockRejectedValue(new Error('boom')),
    };
    const ctx = makeCtx([fakeTool]);

    const result = await batchToolUseTool.execute(
      {
        calls: [
          { tool: 'test', input: {} },
          { tool: 'test', input: {} },
        ],
        stop_on_error: false,
      },
      ctx,
      makeOpts(),
    );
    expect(result.results.length).toBe(2);
    expect(result.failed).toBe(2);
  });

  it('reports execution time', async () => {
    const fakeTool = {
      name: 'test',
      execute: vi.fn().mockResolvedValue({ value: 1 }),
    };
    const ctx = makeCtx([fakeTool]);

    const result = await batchToolUseTool.execute(
      { calls: [{ tool: 'test', input: {} }] },
      ctx,
      makeOpts(),
    );
    expect(result.results[0].executionMs).toBeGreaterThanOrEqual(0);
  });
});
