import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Context } from '../../src/core/context.js';
import { ToolExecutor } from '../../src/execution/tool-executor.js';
import { EventBus } from '../../src/kernel/events.js';
import type { ToolResultBlock, ToolUseBlock } from '../../src/types/blocks.js';
import type { PermissionDecision } from '../../src/types/permission.js';
import type { Tool } from '../../src/types/tool.js';

// --- Test helpers ---

function makeTool(overrides: Partial<Tool> & { name: string }): Tool {
  return {
    description: `test tool: ${overrides.name}`,
    inputSchema: { type: 'object' },
    permission: 'auto',
    mutating: false,
    execute: vi.fn().mockResolvedValue({ ok: true }),
    ...overrides,
  };
}

function makeUse(name: string, input: Record<string, unknown> = {}): ToolUseBlock {
  return { type: 'tool_use', id: `id_${name}`, name, input };
}

function makeCtx(): Context {
  const session = {
    id: 'test-session',
    append: vi.fn(),
    close: vi.fn(),
  };
  return {
    messages: [],
    todos: [],
    readFiles: new Set(),
    fileMtimes: new Map(),
    systemPrompt: [],
    provider: { id: 'test', capabilities: {}, complete: vi.fn(), stream: vi.fn() } as never,
    session: session as never,
    signal: new AbortController().signal,
    tokenCounter: {
      account: vi.fn(),
      total: vi.fn().mockReturnValue({ input: 0, output: 0 }),
      estimateCost: vi.fn().mockReturnValue({ total: 0 }),
    } as never,
    cwd: '/test',
    projectRoot: '/test',
    model: 'test-model',
    tools: [],
    meta: {},
    registerAbortHook: vi.fn().mockReturnValue(() => {}),
    drainAbortHooks: vi.fn(),
    recordRead: vi.fn(),
    hasRead: vi.fn(),
    lastReadMtime: vi.fn(),
    usage: vi.fn().mockReturnValue({ input: 0, output: 0 }),
  } as unknown as Context;
}

function autoPermit(): PermissionDecision {
  return { permission: 'auto', source: 'default' };
}

function confirmDecision(): PermissionDecision {
  return { permission: 'confirm', source: 'trust' };
}

function denyDecision(reason?: string): PermissionDecision {
  return { permission: 'deny', reason: reason ?? 'policy', source: 'deny' };
}

// --- Tests ---

describe('ToolExecutor', () => {
  const scrubber = { scrub: (s: string) => s };
  const policy = { evaluate: vi.fn().mockResolvedValue(autoPermit()) };

  function makeExecutor(tools: Tool[], opts?: Partial<Parameters<typeof ToolExecutor>[1]>) {
    const registry = {
      get: (name: string) => tools.find((t) => t.name === name),
      list: () => tools,
    };
    return new ToolExecutor(registry, {
      permissionPolicy: policy.evaluate.mockResolvedValue ? policy : (policy as never),
      secretScrubber: scrubber as never,
      perIterationOutputCapBytes: 50_000,
      ...opts,
    });
  }

  beforeEach(() => {
    policy.evaluate.mockReset().mockResolvedValue(autoPermit());
  });

  describe('executeBatch — unknown tool', () => {
    it('returns an error for unregistered tools', async () => {
      const executor = makeExecutor([]);
      const result = await executor.executeBatch([makeUse('nonexistent')], makeCtx(), 'sequential');
      const output = result.outputs[0]!;
      expect(output.result).toMatchObject({
        type: 'tool_result',
        is_error: true,
      });
      expect((output.result as ToolResultBlock).content).toContain('not registered');
      expect(output.tool).toBeUndefined();
    });
  });

  describe('executeBatch — permission deny', () => {
    it('returns denied result when policy rejects', async () => {
      policy.evaluate.mockResolvedValue(denyDecision('forbidden'));
      const tool = makeTool({ name: 'bash' });
      const executor = makeExecutor([tool]);
      const result = await executor.executeBatch(
        [makeUse('bash', { command: 'rm -rf /' })],
        makeCtx(),
        'sequential',
      );
      const output = result.outputs[0]!;
      expect((output.result as ToolResultBlock).content).toContain('denied');
      expect((output.result as ToolResultBlock).is_error).toBe(true);
    });
  });

  describe('executeBatch — confirm with awaiter', () => {
    it('executes when user confirms via awaiter', async () => {
      policy.evaluate.mockResolvedValue(confirmDecision());
      const tool = makeTool({
        name: 'edit',
        execute: vi.fn().mockResolvedValue({ path: 'a.ts', replacements: 1 }),
      });
      const awaiter = vi.fn().mockResolvedValue('yes');
      const executor = makeExecutor([tool], { confirmAwaiter: awaiter });
      const result = await executor.executeBatch(
        [makeUse('edit', { path: 'a.ts' })],
        makeCtx(),
        'sequential',
      );
      expect(awaiter).toHaveBeenCalled();
      const output = result.outputs[0]!;
      expect((output.result as ToolResultBlock).is_error).toBe(false);
    });

    it('denies when user rejects via awaiter', async () => {
      policy.evaluate.mockResolvedValue(confirmDecision());
      const tool = makeTool({ name: 'edit' });
      const awaiter = vi.fn().mockResolvedValue('no');
      const executor = makeExecutor([tool], { confirmAwaiter: awaiter });
      const result = await executor.executeBatch(
        [makeUse('edit', { path: 'a.ts' })],
        makeCtx(),
        'sequential',
      );
      const output = result.outputs[0]!;
      expect((output.result as ToolResultBlock).is_error).toBe(true);
      expect((output.result as ToolResultBlock).content).toContain('denied by user');
    });

    it('accepts "always" as approval', async () => {
      policy.evaluate.mockResolvedValue(confirmDecision());
      const tool = makeTool({ name: 'edit', execute: vi.fn().mockResolvedValue({ ok: true }) });
      const awaiter = vi.fn().mockResolvedValue('always');
      const executor = makeExecutor([tool], { confirmAwaiter: awaiter });
      const result = await executor.executeBatch(
        [makeUse('edit', { path: 'a.ts' })],
        makeCtx(),
        'sequential',
      );
      expect((result.outputs[0]!.result as ToolResultBlock).is_error).toBe(false);
    });
  });

  describe('executeBatch — confirm without awaiter (TUI path)', () => {
    it('returns tool_confirm_pending when no awaiter', async () => {
      policy.evaluate.mockResolvedValue(confirmDecision());
      const tool = makeTool({ name: 'edit' });
      const executor = makeExecutor([tool]);
      const result = await executor.executeBatch(
        [makeUse('edit', { path: 'a.ts' })],
        makeCtx(),
        'sequential',
      );
      const output = result.outputs[0]!;
      expect(output.result.type).toBe('tool_confirm_pending');
      expect(output.result).toMatchObject({
        type: 'tool_confirm_pending',
        toolName: 'edit',
        suggestedPattern: 'a.ts',
      });
    });

    it('uses tool name as suggestedPattern when no path/url/name in input', async () => {
      policy.evaluate.mockResolvedValue(confirmDecision());
      const tool = makeTool({ name: 'custom' });
      const executor = makeExecutor([tool]);
      const result = await executor.executeBatch(
        [makeUse('custom', { data: 42 })],
        makeCtx(),
        'sequential',
      );
      const output = result.outputs[0]!;
      expect(output.result.suggestedPattern).toBe('custom');
    });
  });

  describe('clearConfirmAwaiter', () => {
    it('switches from awaiter to pending result', async () => {
      policy.evaluate.mockResolvedValue(confirmDecision());
      const tool = makeTool({ name: 'edit' });
      const awaiter = vi.fn().mockResolvedValue('yes');
      const executor = makeExecutor([tool], { confirmAwaiter: awaiter as never });

      // With awaiter: calls it directly
      const r1 = await executor.executeBatch(
        [makeUse('edit', { path: 'a.ts' })],
        makeCtx(),
        'sequential',
      );
      expect(awaiter).toHaveBeenCalled();
      expect((r1.outputs[0]!.result as ToolResultBlock).type).toBe('tool_result');

      // After clear: returns pending result
      executor.clearConfirmAwaiter();
      awaiter.mockClear();
      const r2 = await executor.executeBatch(
        [makeUse('edit', { path: 'a.ts' })],
        makeCtx(),
        'sequential',
      );
      expect(awaiter).not.toHaveBeenCalled();
      expect(r2.outputs[0]!.result.type).toBe('tool_confirm_pending');
    });
  });

  describe('executeBatch — tool execution error', () => {
    it('catches tool errors and returns error result', async () => {
      const tool = makeTool({
        name: 'bash',
        execute: vi.fn().mockRejectedValue(new Error('boom')),
      });
      const executor = makeExecutor([tool]);
      const result = await executor.executeBatch(
        [makeUse('bash', { command: 'fail' })],
        makeCtx(),
        'sequential',
      );
      const output = result.outputs[0]!;
      expect((output.result as ToolResultBlock).is_error).toBe(true);
      expect((output.result as ToolResultBlock).content).toContain('threw');
      expect((output.result as ToolResultBlock).content).toContain('boom');
    });

    it('scrubs secrets from error messages', async () => {
      const scrubbingPolicy = { evaluate: vi.fn().mockResolvedValue(autoPermit()) };
      const scrubbingScrubber = { scrub: vi.fn().mockReturnValue('[REDACTED]') };
      const tool = makeTool({
        name: 'bash',
        execute: vi.fn().mockRejectedValue(new Error('key=secret123')),
      });
      const executor = makeExecutor([tool], {
        permissionPolicy: scrubbingPolicy as never,
        secretScrubber: scrubbingScrubber as never,
      });
      const result = await executor.executeBatch(
        [makeUse('bash', { command: 'fail' })],
        makeCtx(),
        'sequential',
      );
      const content = (result.outputs[0]!.result as ToolResultBlock).content as string;
      expect(scrubbingScrubber.scrub).toHaveBeenCalled();
      expect(content).toContain('[REDACTED]');
      expect(content).not.toContain('secret123');
    });
  });

  describe('executeBatch — sequential strategy', () => {
    it('runs tools one at a time', async () => {
      const order: string[] = [];
      const tool1 = makeTool({
        name: 'a',
        execute: vi.fn().mockImplementation(async () => {
          order.push('a');
          return { ok: true };
        }),
      });
      const tool2 = makeTool({
        name: 'b',
        execute: vi.fn().mockImplementation(async () => {
          order.push('b');
          return { ok: true };
        }),
      });
      const executor = makeExecutor([tool1, tool2]);
      await executor.executeBatch([makeUse('a'), makeUse('b')], makeCtx(), 'sequential');
      expect(order).toEqual(['a', 'b']);
    });
  });

  describe('executeBatch — parallel strategy', () => {
    it('runs all tools concurrently', async () => {
      const tool1 = makeTool({ name: 'a', execute: vi.fn().mockResolvedValue({ ok: 1 }) });
      const tool2 = makeTool({ name: 'b', execute: vi.fn().mockResolvedValue({ ok: 2 }) });
      const executor = makeExecutor([tool1, tool2]);
      const result = await executor.executeBatch(
        [makeUse('a'), makeUse('b')],
        makeCtx(),
        'parallel',
      );
      expect(result.outputs).toHaveLength(2);
      // Both should have executed
      expect(tool1.execute).toHaveBeenCalled();
      expect(tool2.execute).toHaveBeenCalled();
    });
  });

  describe('executeBatch — smart strategy', () => {
    it('runs non-mutating in parallel, mutating sequentially', async () => {
      const order: string[] = [];
      const read = makeTool({
        name: 'read',
        mutating: false,
        execute: vi.fn().mockImplementation(async () => {
          order.push('read');
          return { ok: true };
        }),
      });
      const grep = makeTool({
        name: 'grep',
        mutating: false,
        execute: vi.fn().mockImplementation(async () => {
          order.push('grep');
          return { ok: true };
        }),
      });
      const edit = makeTool({
        name: 'edit',
        mutating: true,
        execute: vi.fn().mockImplementation(async () => {
          order.push('edit');
          return { ok: true };
        }),
      });
      const write = makeTool({
        name: 'write',
        mutating: true,
        execute: vi.fn().mockImplementation(async () => {
          order.push('write');
          return { ok: true };
        }),
      });
      const executor = makeExecutor([read, grep, edit, write]);

      const result = await executor.executeBatch(
        [makeUse('edit'), makeUse('read'), makeUse('write'), makeUse('grep')],
        makeCtx(),
        'smart',
      );

      expect(result.outputs).toHaveLength(4);
      // read and grep must come before edit and write
      const names = result.outputs.map((o) =>
        o.result.type === 'tool_result' ? (o.result as ToolResultBlock).name : undefined,
      );
      const readIdx = names.indexOf('read');
      const grepIdx = names.indexOf('grep');
      const editIdx = names.indexOf('edit');
      const writeIdx = names.indexOf('write');
      expect(readIdx).toBeLessThan(editIdx!);
      expect(grepIdx).toBeLessThan(editIdx!);
      expect(readIdx).toBeLessThan(writeIdx!);
      expect(grepIdx).toBeLessThan(writeIdx!);
    });
  });

  describe('executeBatch — budget decrement', () => {
    it('decrements remaining budget after each tool', async () => {
      const tool = makeTool({ name: 'echo', execute: vi.fn().mockResolvedValue('hello world') });
      const executor = makeExecutor([tool], { perIterationOutputCapBytes: 100_000 });
      const result = await executor.executeBatch([makeUse('echo')], makeCtx(), 'sequential');
      expect(result.remainingBudget).toBeLessThan(100_000);
      expect(result.remainingBudget).toBeGreaterThanOrEqual(0);
    });
  });

  describe('executeTool — events', () => {
    it('emits tool.started event', async () => {
      const events = new EventBus();
      const started = vi.fn();
      events.on('tool.started', started);
      const tool = makeTool({ name: 'test', execute: vi.fn().mockResolvedValue('ok') });
      const executor = makeExecutor([tool], { events });
      await executor.executeBatch([makeUse('test')], makeCtx(), 'sequential');
      expect(started).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'test',
          id: 'id_test',
        }),
      );
    });
  });

  describe('executeTool — renderer calls', () => {
    it('calls writeToolCall and writeToolResult on renderer', async () => {
      const renderer = { writeToolCall: vi.fn(), writeToolResult: vi.fn() };
      const tool = makeTool({ name: 'read', execute: vi.fn().mockResolvedValue('content') });
      const executor = makeExecutor([tool], { renderer: renderer as never });
      await executor.executeBatch([makeUse('read', { path: '/tmp/a' })], makeCtx(), 'sequential');
      expect(renderer.writeToolCall).toHaveBeenCalledWith('read', expect.anything());
      expect(renderer.writeToolResult).toHaveBeenCalledWith('read', expect.anything(), false);
    });
  });

  describe('executeTool — pre-aborted signal', () => {
    it('throws immediately if signal is already aborted', async () => {
      const tool = makeTool({ name: 'slow', execute: vi.fn() });
      const executor = makeExecutor([tool]);
      const ctrl = new AbortController();
      ctrl.abort('cancelled');
      const ctx = makeCtx();
      ctx.signal = ctrl.signal;
      // The error from aborted signal is caught and returned as error result
      const result = await executor.executeBatch([makeUse('slow')], ctx, 'sequential');
      expect(tool.execute).not.toHaveBeenCalled();
      expect((result.outputs[0]!.result as ToolResultBlock).is_error).toBe(true);
    });
  });

  describe('subjectFor — suggested patterns', () => {
    it('derives pattern from bash command', async () => {
      policy.evaluate.mockResolvedValue(confirmDecision());
      const tool = makeTool({ name: 'bash' });
      const executor = makeExecutor([tool]);
      const result = await executor.executeBatch(
        [makeUse('bash', { command: 'echo test' })],
        makeCtx(),
        'sequential',
      );
      expect(result.outputs[0]!.result.suggestedPattern).toBe('echo test');
    });

    it('derives pattern from path input', async () => {
      policy.evaluate.mockResolvedValue(confirmDecision());
      const tool = makeTool({ name: 'edit' });
      const executor = makeExecutor([tool]);
      const result = await executor.executeBatch(
        [makeUse('edit', { path: '/tmp/test.ts' })],
        makeCtx(),
        'sequential',
      );
      expect(result.outputs[0]!.result.suggestedPattern).toBe('/tmp/test.ts');
    });

    it('derives pattern from url input', async () => {
      policy.evaluate.mockResolvedValue(confirmDecision());
      const tool = makeTool({ name: 'fetch' });
      const executor = makeExecutor([tool]);
      const result = await executor.executeBatch(
        [makeUse('fetch', { url: 'https://example.com' })],
        makeCtx(),
        'sequential',
      );
      expect(result.outputs[0]!.result.suggestedPattern).toBe('https://example.com');
    });

    it('derives pattern from name input', async () => {
      policy.evaluate.mockResolvedValue(confirmDecision());
      const tool = makeTool({ name: 'install' });
      const executor = makeExecutor([tool]);
      const result = await executor.executeBatch(
        [makeUse('install', { name: 'lodash' })],
        makeCtx(),
        'sequential',
      );
      expect(result.outputs[0]!.result.suggestedPattern).toBe('lodash');
    });

    it('escapes glob characters in paths', async () => {
      policy.evaluate.mockResolvedValue(confirmDecision());
      const tool = makeTool({ name: 'edit' });
      const executor = makeExecutor([tool]);
      const result = await executor.executeBatch(
        [makeUse('edit', { path: '/tmp/*.ts' })],
        makeCtx(),
        'sequential',
      );
      expect(result.outputs[0]!.result.suggestedPattern).toContain('\\*.ts');
    });

    it('returns undefined for primitive input', async () => {
      policy.evaluate.mockResolvedValue(confirmDecision());
      const tool = makeTool({ name: 'custom' });
      const executor = makeExecutor([tool]);
      const result = await executor.executeBatch(
        [{ type: 'tool_use', id: 'x', name: 'custom', input: 'just a string' }],
        makeCtx(),
        'sequential',
      );
      // Falls back to tool name
      expect(result.outputs[0]!.result.suggestedPattern).toBe('custom');
    });
  });

  describe('executeBatch — empty batch', () => {
    it('returns empty outputs with full budget', async () => {
      const executor = makeExecutor([]);
      const result = await executor.executeBatch([], makeCtx(), 'sequential');
      expect(result.outputs).toHaveLength(0);
      expect(result.remainingBudget).toBe(50_000);
    });
  });
});
