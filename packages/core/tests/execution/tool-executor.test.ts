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

  describe('dangerous-capability net is waived under yolo', () => {
    const bashish = (): Tool =>
      makeTool({
        name: 'bash',
        permission: 'auto',
        capabilities: ['shell.arbitrary'],
        execute: vi.fn().mockResolvedValue('ran'),
      } as Partial<Tool> & { name: string });

    const runWith = async (policyExtra: Record<string, unknown>) => {
      const tool = bashish();
      const executor = makeExecutor([tool], {
        permissionPolicy: { evaluate: vi.fn().mockResolvedValue(autoPermit()), ...policyExtra } as never,
        confirmAwaiter: undefined,
      });
      const r = await executor.executeBatch([makeUse('bash')], makeCtx(), 'sequential');
      return { tool, result: r.outputs[0]!.result };
    };

    it('forces confirm for a dangerous-capability tool when NOT in any yolo', async () => {
      const { result } = await runWith({ getYolo: () => false, getYoloDestructive: () => false });
      // Forced to confirm + no awaiter → pending sentinel (the tool did NOT auto-run).
      expect(result.type).toBe('tool_confirm_pending');
    });

    it('skips the confirm net under regular --yolo (no prompt for shell)', async () => {
      const { tool, result } = await runWith({ getYolo: () => true, getYoloDestructive: () => false });
      expect(result.type).toBe('tool_result');
      expect((result as ToolResultBlock).content).toContain('ran');
      expect(tool.execute).toHaveBeenCalledTimes(1);
    });

    it('skips the confirm net under --yolo-destructive', async () => {
      const { result } = await runWith({ getYoloDestructive: () => true });
      expect(result.type).toBe('tool_result');
    });

    it('still forces confirm when the policy exposes no yolo getters (safe default)', async () => {
      const { result } = await runWith({});
      expect(result.type).toBe('tool_confirm_pending');
    });

    it('waives the net for an authoritative auto (source "yolo") — subagent allowlist path', async () => {
      // A subagent's AutoApprovePermissionPolicy returns { permission:'auto',
      // source:'yolo' } only after enforcing its capability allowlist (every
      // dangerous cap explicitly granted). The executor must trust that and
      // skip the downgrade — otherwise a granted write becomes a confirm no
      // non-interactive subagent can answer. No yolo getters here on purpose.
      const tool = bashish();
      const executor = makeExecutor([tool], {
        permissionPolicy: {
          evaluate: vi.fn().mockResolvedValue({ permission: 'auto', source: 'yolo' }),
        } as never,
        confirmAwaiter: undefined,
      });
      const r = await executor.executeBatch([makeUse('bash')], makeCtx(), 'sequential');
      const result = r.outputs[0]!.result;
      expect(result.type).toBe('tool_result');
      expect((result as ToolResultBlock).content).toContain('ran');
      expect(tool.execute).toHaveBeenCalledTimes(1);
    });

    it('does NOT waive the net for a trust-file auto (source "trust")', async () => {
      // A single trusted pattern must not silently widen into arbitrary
      // dangerous-capability execution — only authoritative yolo/allowlist autos do.
      const tool = bashish();
      const executor = makeExecutor([tool], {
        permissionPolicy: {
          evaluate: vi.fn().mockResolvedValue({ permission: 'auto', source: 'trust' }),
        } as never,
        confirmAwaiter: undefined,
      });
      const r = await executor.executeBatch([makeUse('bash')], makeCtx(), 'sequential');
      expect(r.outputs[0]!.result.type).toBe('tool_confirm_pending');
    });
  });

  describe('executeBatch — malformed arguments', () => {
    it.each([['__raw'], ['__raw_arguments'], ['_raw']])(
      'returns an actionable error when input is wrapped under %s and never executes the tool',
      async (marker) => {
        const tool = makeTool({ name: 'edit', execute: vi.fn() });
        const executor = makeExecutor([tool]);
        const result = await executor.executeBatch(
          [makeUse('edit', { [marker]: 'path=a.ts old=foo' })],
          makeCtx(),
          'sequential',
        );
        const output = result.outputs[0]!;
        expect((output.result as ToolResultBlock).is_error).toBe(true);
        expect((output.result as ToolResultBlock).content).toContain('not a valid JSON object');
        // Echo the raw payload back so the model can self-correct instead of
        // resending the identical malformed call in a loop.
        expect((output.result as ToolResultBlock).content).toContain('path=a.ts old=foo');
        expect(tool.execute).not.toHaveBeenCalled();
        expect(policy.evaluate).not.toHaveBeenCalled();
      },
    );

    it('truncates an oversized raw payload in the feedback message', async () => {
      const tool = makeTool({ name: 'edit', execute: vi.fn() });
      const executor = makeExecutor([tool]);
      const huge = 'x'.repeat(2000);
      const result = await executor.executeBatch(
        [makeUse('edit', { __raw: huge })],
        makeCtx(),
        'sequential',
      );
      const content = (result.outputs[0]!.result as ToolResultBlock).content as string;
      expect(content).toContain('truncated, 2000 chars total');
      expect(content.length).toBeLessThan(huge.length);
    });

    it('still executes when a sentinel-looking key is one of several real keys', async () => {
      const tool = makeTool({
        name: 'edit',
        execute: vi.fn().mockResolvedValue({ ok: true }),
      });
      const executor = makeExecutor([tool]);
      const result = await executor.executeBatch(
        [makeUse('edit', { path: 'a.ts', _raw: 'legit' })],
        makeCtx(),
        'sequential',
      );
      const output = result.outputs[0]!;
      expect((output.result as ToolResultBlock).is_error).toBe(false);
      expect(tool.execute).toHaveBeenCalled();
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

    it('falls back to the tool name when no subject key is present', async () => {
      policy.evaluate.mockResolvedValue(confirmDecision());
      const tool = makeTool({ name: 'custom' });
      const executor = makeExecutor([tool]);
      // Valid object input (passes schema validation) but with no path/url/name
      // key for subjectFor to latch onto → suggestedPattern falls back to the
      // tool name so a trust entry can still be offered.
      const result = await executor.executeBatch(
        [makeUse('custom', { detail: 'no recognizable subject' })],
        makeCtx(),
        'sequential',
      );
      expect(result.outputs[0]!.result.suggestedPattern).toBe('custom');
    });
  });

  describe('executeBatch — safeRun catch coverage', () => {
    it('catches permission policy evaluation that throws synchronously', async () => {
      // safeRun wraps runOne in a try/catch. runOne calls permissionPolicy.evaluate()
      // which is an async function. If it throws rather than returning, safeRun's
      // catch block handles it and returns an error result instead of propagating.
      const throwingPolicy = {
        evaluate: vi.fn().mockRejectedValue(new Error('policy exploded')),
      };
      const tool = makeTool({ name: 'bash' });
      const executor = makeExecutor([tool], { permissionPolicy: throwingPolicy as never });
      const result = await executor.executeBatch(
        [makeUse('bash', { command: 'ls' })],
        makeCtx(),
        'sequential',
      );
      const output = result.outputs[0]!;
      expect((output.result as ToolResultBlock).is_error).toBe(true);
      expect((output.result as ToolResultBlock).content).toContain('policy exploded');
    });

    it('catches permission policy evaluation that throws after a few calls', async () => {
      // First call succeeds, second throws — verify budget decrement still happens
      let callCount = 0;
      const flakyPolicy = {
        evaluate: vi.fn().mockImplementation(() => {
          callCount++;
          if (callCount === 1) return Promise.resolve(autoPermit());
          return Promise.reject(new Error('flaky policy'));
        }),
      };
      const tool1 = makeTool({ name: 'a', execute: vi.fn().mockResolvedValue({ ok: true }) });
      const tool2 = makeTool({ name: 'b', execute: vi.fn().mockResolvedValue({ ok: true }) });
      const executor = makeExecutor([tool1, tool2], { permissionPolicy: flakyPolicy as never });
      const result = await executor.executeBatch(
        [makeUse('a'), makeUse('b')],
        makeCtx(),
        'parallel',
      );
      expect(result.outputs).toHaveLength(2);
      const errors = result.outputs.filter(
        (o) => (o.result as ToolResultBlock).is_error === true,
      );
      expect(errors.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('executeTool — abort reason propagation', () => {
    it('re-throws string abort reason as Error with that message', async () => {
      const tool = makeTool({ name: 'slow', execute: vi.fn().mockResolvedValue('ok') });
      const executor = makeExecutor([tool]);
      const ctrl = new AbortController();
      ctrl.abort('user cancelled');
      const ctx = makeCtx();
      ctx.signal = ctrl.signal;
      const result = await executor.executeBatch([makeUse('slow')], ctx, 'sequential');
      const output = result.outputs[0]!;
      expect((output.result as ToolResultBlock).is_error).toBe(true);
      expect((output.result as ToolResultBlock).content).toContain('user cancelled');
    });

    it('re-throws Error abort reason as-is', async () => {
      const tool = makeTool({ name: 'slow', execute: vi.fn().mockResolvedValue('ok') });
      const executor = makeExecutor([tool]);
      const ctrl = new AbortController();
      const abortErr = new Error('operational limit');
      ctrl.abort(abortErr);
      const ctx = makeCtx();
      ctx.signal = ctrl.signal;
      const result = await executor.executeBatch([makeUse('slow')], ctx, 'sequential');
      const output = result.outputs[0]!;
      expect((output.result as ToolResultBlock).is_error).toBe(true);
      expect((output.result as ToolResultBlock).content).toContain('operational limit');
    });

    it('re-throws undefined abort reason as default message', async () => {
      const tool = makeTool({ name: 'slow', execute: vi.fn().mockResolvedValue('ok') });
      const executor = makeExecutor([tool]);
      const ctrl = new AbortController();
      ctrl.abort(); // no reason
      const ctx = makeCtx();
      ctx.signal = ctrl.signal;
      const result = await executor.executeBatch([makeUse('slow')], ctx, 'sequential');
      const output = result.outputs[0]!;
      expect((output.result as ToolResultBlock).is_error).toBe(true);
      expect((output.result as ToolResultBlock).content).toContain('aborted');
    });
  });

  describe('executeTool — tool.cleanup called on abort', () => {
    it('calls cleanup when tool times out', async () => {
      const cleanup = vi.fn().mockResolvedValue(undefined);
      const tool = makeTool({
        name: 'timed',
        timeoutMs: 10,
        execute: vi.fn().mockImplementation(async () => {
          await new Promise((r) => setTimeout(r, 200));
          return 'done';
        }),
        cleanup,
      });
      const executor = makeExecutor([tool]);
      const result = await executor.executeBatch([makeUse('timed')], makeCtx(), 'sequential');
      expect(cleanup).toHaveBeenCalled();
      expect((result.outputs[0]!.result as ToolResultBlock).is_error).toBe(true);
    });
  });

  describe('subjectFor — backfill path when subjectKey is not path/file/files', () => {
    it('escapes value when subjectKey is a non-path key like "query"', async () => {
      policy.evaluate.mockResolvedValue(confirmDecision());
      const tool = makeTool({ name: 'search', subjectKey: 'query' });
      const executor = makeExecutor([tool]);
      const result = await executor.executeBatch(
        [makeUse('search', { query: 'hello*world' })],
        makeCtx(),
        'sequential',
      );
      // subjectKey 'query' → not a path key → escapeGlob only
      expect(result.outputs[0]!.result.suggestedPattern).toBe('hello\\*world');
    });

    it('normalizes backslash in path when subjectKey is "file"', async () => {
      policy.evaluate.mockResolvedValue(confirmDecision());
      const tool = makeTool({ name: 'edit', subjectKey: 'file' });
      const executor = makeExecutor([tool]);
      const result = await executor.executeBatch(
        [makeUse('edit', { file: 'C:\\Users\\dev\\project\\a.ts' })],
        makeCtx(),
        'sequential',
      );
      const pattern = result.outputs[0]!.result.suggestedPattern;
      expect(pattern).toContain('C:/Users/dev/project/a.ts'); // backslashes normalized to forward slashes
    });

    it('escapes glob chars in subjectKey value even when it looks like a path', async () => {
      policy.evaluate.mockResolvedValue(confirmDecision());
      const tool = makeTool({ name: 'custom' });
      const executor = makeExecutor([tool]);
      const result = await executor.executeBatch(
        [makeUse('custom', { path: '/tmp/test[1].txt' })],
        makeCtx(),
        'sequential',
      );
      expect(result.outputs[0]!.result.suggestedPattern).toContain('\\[1\\]');
    });
  });

  describe('executeBatch — budget never goes negative', () => {
    it('Math.max(0, budget - bytes) on huge output', async () => {
      const huge = 'x'.repeat(200_000);
      const tool = makeTool({
        name: 'echo',
        execute: vi.fn().mockResolvedValue(huge),
      });
      const executor = makeExecutor([tool], { perIterationOutputCapBytes: 50_000 });
      const result = await executor.executeBatch([makeUse('echo')], makeCtx(), 'sequential');
      expect(result.remainingBudget).toBeGreaterThanOrEqual(0);
      expect(result.remainingBudget).toBeLessThanOrEqual(50_000);
    });
  });

  describe('executeBatch — null/undefined toolUse skipped in sequential', () => {
    it('filters out nulls in sequential strategy', async () => {
      const tool = makeTool({ name: 'a', execute: vi.fn().mockResolvedValue({ ok: true }) });
      const executor = makeExecutor([tool]);
      // @ts-expect-error intentionally testing with null entry
      const result = await executor.executeBatch([null, makeUse('a'), undefined], makeCtx(), 'sequential');
      expect(result.outputs).toHaveLength(1); // only 'a' was executed
      expect(tool.execute).toHaveBeenCalledTimes(1);
    });
  });
});
