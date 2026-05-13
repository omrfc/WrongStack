import { describe, it, expect, vi } from 'vitest';
import {
  SlashCommandRegistry,
  ToolRegistry,
  DefaultTokenCounter,
  HybridCompactor,
  type Context,
} from '@wrongstack/core';
import { buildBuiltinSlashCommands } from '../src/slash-commands/index.js';

class FakeRenderer {
  output = '';
  warnings: string[] = [];
  errors: string[] = [];
  infos: string[] = [];
  write(s: unknown): void {
    this.output += typeof s === 'string' ? s : ((s as { text?: string }).text ?? '');
  }
  writeLine(s = ''): void {
    this.output += `${s}\n`;
  }
  writeBlock(): void {}
  writeToolCall(): void {}
  writeToolResult(): void {}
  writeDiff(): void {}
  writeWarning(s: string): void {
    this.warnings.push(s);
  }
  writeError(s: string): void {
    this.errors.push(s);
  }
  writeInfo(s: string): void {
    this.infos.push(s);
  }
  clear(): void {
    this.output = '';
  }
}

function makeRig() {
  const registry = new SlashCommandRegistry();
  const toolRegistry = new ToolRegistry();
  const renderer = new FakeRenderer();
  const tokenCounter = new DefaultTokenCounter();
  const compactor = new HybridCompactor({ preserveK: 5 });
  const cmds = buildBuiltinSlashCommands({
    registry,
    toolRegistry,
    compactor,
    tokenCounter,
    renderer: renderer as unknown as Parameters<typeof buildBuiltinSlashCommands>[0]['renderer'],
  });
  for (const c of cmds) registry.register(c);
  return { registry, renderer, toolRegistry, tokenCounter };
}

const fakeCtx = {
  messages: [],
  todos: [],
  systemPrompt: [],
  readFiles: new Set(),
  fileMtimes: new Map(),
  model: 'test-model',
  cwd: '/tmp',
  projectRoot: '/proj',
} as unknown as Context;

describe('built-in slash commands', () => {
  it('/help lists all commands', async () => {
    const { registry } = makeRig();
    const result = await registry.dispatch('/help', fakeCtx);
    expect(result?.message).toContain('/help');
    expect(result?.message).toContain('/exit');
  });

  it('/tools lists registered tools', async () => {
    const { registry, renderer, toolRegistry } = makeRig();
    toolRegistry.register({
      name: 'echo',
      description: 'echo',
      inputSchema: { type: 'object' },
      permission: 'auto',
      mutating: false,
      async execute() {
        return '';
      },
    });
    await registry.dispatch('/tools', fakeCtx);
    expect(renderer.output).toContain('echo');
  });

  it('/exit signals exit', async () => {
    const { registry } = makeRig();
    const res = await registry.dispatch('/exit', fakeCtx);
    expect(res?.exit).toBe(true);
  });

  it('/quit aliases /exit', async () => {
    const { registry } = makeRig();
    const res = await registry.dispatch('/quit', fakeCtx);
    expect(res?.exit).toBe(true);
  });

  it('/clear triggers onClear and clears renderer and context', async () => {
    const onClear = vi.fn();
    const registry = new SlashCommandRegistry();
    const renderer = new FakeRenderer();
    renderer.output = 'something';
    const ctx = {
      messages: [{ role: 'user', content: 'old message' }],
      todos: [{ id: '1', content: 'old todo', status: 'pending' }],
      readFiles: new Set(['old.txt']),
      fileMtimes: new Map([['old.txt', 123]]),
      meta: { old: 'meta' },
    } as unknown as Context;
    const cmds = buildBuiltinSlashCommands({
      registry,
      toolRegistry: new ToolRegistry(),
      compactor: new HybridCompactor(),
      tokenCounter: new DefaultTokenCounter(),
      renderer: renderer as unknown as Parameters<typeof buildBuiltinSlashCommands>[0]['renderer'],
      onClear,
      memoryStore: {
        async clear() {},
      },
    });
    for (const c of cmds) registry.register(c);
    await registry.dispatch('/clear', ctx);
    expect(onClear).toHaveBeenCalled();
    expect(ctx.messages).toEqual([]);
    expect(ctx.todos).toEqual([]);
    expect(ctx.readFiles.size).toBe(0);
    expect(ctx.fileMtimes.size).toBe(0);
    expect(ctx.meta).toEqual({});
    expect(renderer.output).toBe('');
  });

  it('/compact runs the compactor', async () => {
    const { registry, renderer } = makeRig();
    const ctx = { messages: [] } as unknown as Context;
    await registry.dispatch('/compact', ctx);
    expect(renderer.infos.some((i) => i.includes('Compaction'))).toBe(true);
  });

  it('/context shows context window summary', async () => {
    const { registry, renderer } = makeRig();
    const ctx = {
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'hello' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
        { role: 'user', content: [{ type: 'text', text: 'world' }] },
        { role: 'assistant', content: [{ type: 'tool_use', id: '1', name: 'bash', input: {} }, { type: 'text', text: 'done' }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: '1', content: 'ok' }] },
      ],
      todos: [
        { id: '1', content: 'fix bug', status: 'in_progress' },
        { id: '2', content: 'write test', status: 'pending' },
        { id: '3', content: 'done', status: 'completed' },
      ],
      systemPrompt: [{ type: 'text', text: 'You are helpful' }],
      readFiles: new Set(['a.ts', 'b.ts']),
      fileMtimes: new Map(),
      model: 'claude-sonnet-4-6',
      cwd: '/tmp',
      projectRoot: '/proj',
    } as unknown as Context;
    await registry.dispatch('/context', ctx);
    expect(renderer.output).toContain('Context Window');
    expect(renderer.output).toContain('messages:');
    expect(renderer.output).toContain('in_progress');
    expect(renderer.output).toContain('pending');
  });

  it('/ctx aliases /context', async () => {
    const { registry, renderer } = makeRig();
    const ctx = { messages: [], todos: [], systemPrompt: [], readFiles: new Set(), fileMtimes: new Map() } as unknown as Context;
    await registry.dispatch('/ctx', ctx);
    expect(renderer.output).toContain('Context Window');
  });

  it('/context detail shows extra fields', async () => {
    const { registry, renderer } = makeRig();
    const ctx = {
      messages: [],
      todos: [],
      systemPrompt: [],
      readFiles: new Set(),
      fileMtimes: new Map(),
      model: 'claude-sonnet-4-6',
      cwd: '/tmp',
      projectRoot: '/proj',
    } as unknown as Context;
    await registry.dispatch('/context detail', ctx);
    expect(renderer.output).toContain('model:');
    expect(renderer.output).toContain('cwd:');
  });
});
