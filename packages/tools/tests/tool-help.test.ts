import { describe, expect, it, vi } from 'vitest';
import { toolHelpTool } from '../src/tool-help.js';

const makeCtx = (tools: any[] = []) => ({ cwd: '/fake', tools, projectRoot: '/fake' }) as any;

describe('toolHelpTool', () => {
  it('has correct metadata', () => {
    expect(toolHelpTool.name).toBe('tool_help');
    expect(toolHelpTool.permission).toBe('auto');
    expect(toolHelpTool.mutating).toBe(false);
  });

  it('returns error for unknown tool', async () => {
    const ctx = makeCtx([]);
    const result = await toolHelpTool.execute({ tool: 'nonexistent' }, ctx);
    expect(result.help).toContain('No tool found');
    expect(result.total).toBe(0);
  });

  it('returns help for known tool', async () => {
    const ctx = makeCtx([
      {
        name: 'test',
        description: 'A test tool',
        usageHint: 'Use it',
        permission: 'auto',
        mutating: false,
        inputSchema: {},
      },
    ]);
    const result = await toolHelpTool.execute({ tool: 'test' }, ctx);
    expect(result.total).toBe(1);
    expect(result.tools[0].name).toBe('test');
  });

  it('lists all tools when no tool specified', async () => {
    const ctx = makeCtx([
      {
        name: 'foo',
        description: 'Foo',
        usageHint: '',
        permission: 'auto',
        mutating: false,
        inputSchema: {},
      },
      {
        name: 'bar',
        description: 'Bar',
        usageHint: '',
        permission: 'auto',
        mutating: false,
        inputSchema: {},
      },
    ]);
    const result = await toolHelpTool.execute({}, ctx);
    expect(result.total).toBe(2);
    expect(result.tools).toHaveLength(2);
  });

  it('formats as short by default', async () => {
    const ctx = makeCtx([
      {
        name: 'foo',
        description: 'Foo',
        usageHint: 'Hint',
        permission: 'auto',
        mutating: false,
        inputSchema: {},
      },
    ]);
    const result = await toolHelpTool.execute({}, ctx);
    expect(result.help).toContain('foo');
    expect(result.help).toContain('Foo');
  });

  it('formats as markdown', async () => {
    const ctx = makeCtx([
      {
        name: 'foo',
        description: 'Foo',
        usageHint: '',
        permission: 'auto',
        mutating: false,
        inputSchema: {},
      },
    ]);
    const result = await toolHelpTool.execute({ format: 'markdown' }, ctx);
    expect(result.help).toContain('##');
    expect(result.help).toContain('|');
  });

  it('formats as full with schema', async () => {
    const ctx = makeCtx([
      {
        name: 'foo',
        description: 'Foo',
        usageHint: '',
        permission: 'auto',
        mutating: false,
        inputSchema: { type: 'object' },
      },
    ]);
    const result = await toolHelpTool.execute({ format: 'full' }, ctx);
    expect(result.tools[0].inputSchema).toBeDefined();
  });

  it('includes examples when requested', async () => {
    const ctx = makeCtx([
      {
        name: 'foo',
        description: 'Foo',
        usageHint: '',
        permission: 'auto',
        mutating: false,
        inputSchema: { type: 'object' },
      },
    ]);
    const result = await toolHelpTool.execute({ include_examples: true }, ctx);
    expect(result).toHaveProperty('total');
  });

  it('short format for a single tool renders name+desc+hint', async () => {
    const ctx = makeCtx([
      {
        name: 'foo',
        description: 'Foo desc',
        usageHint: 'do X',
        permission: 'auto',
        mutating: false,
        inputSchema: {},
      },
    ]);
    const result = await toolHelpTool.execute({ tool: 'foo', format: 'short' }, ctx);
    expect(result.help).toContain('foo: Foo desc');
    expect(result.help).toContain('Hint: do X');
  });

  it('short format for a single tool without hint omits the hint line', async () => {
    const ctx = makeCtx([
      { name: 'foo', description: 'desc', permission: 'auto', mutating: false, inputSchema: {} },
    ]);
    const result = await toolHelpTool.execute({ tool: 'foo' }, ctx);
    expect(result.help).not.toContain('Hint:');
  });

  it('markdown format for a single tool renders full block', async () => {
    const ctx = makeCtx([
      {
        name: 'foo',
        description: 'Foo desc',
        usageHint: 'use it',
        permission: 'confirm',
        mutating: true,
        inputSchema: { type: 'object' },
      },
    ]);
    const result = await toolHelpTool.execute(
      { tool: 'foo', format: 'markdown', include_examples: true },
      ctx,
    );
    expect(result.help).toContain('## foo');
    expect(result.help).toContain('**Permission:** confirm');
    expect(result.help).toContain('**Mutating:** yes');
    expect(result.help).toContain('### Usage Hint');
    expect(result.help).toContain('### Input Schema');
    expect(result.help).toContain('```json');
  });

  it('markdown format without hint or examples skips those sections', async () => {
    const ctx = makeCtx([
      {
        name: 'bar',
        description: 'Bar desc',
        permission: 'auto',
        mutating: false,
        inputSchema: {},
      },
    ]);
    const result = await toolHelpTool.execute({ tool: 'bar', format: 'markdown' }, ctx);
    expect(result.help).not.toContain('### Usage Hint');
    expect(result.help).not.toContain('### Input Schema');
    expect(result.help).toContain('**Mutating:** no');
  });

  it('full format for a single tool includes schema only with format=full', async () => {
    const ctx = makeCtx([
      {
        name: 'baz',
        description: 'Baz',
        usageHint: 'baz-hint',
        permission: 'auto',
        mutating: false,
        inputSchema: { type: 'object', properties: { x: { type: 'string' } } },
      },
    ]);
    const result = await toolHelpTool.execute({ tool: 'baz', format: 'full' }, ctx);
    expect(result.help).toContain('Tool: baz');
    expect(result.help).toContain('Permission: auto');
    expect(result.help).toContain('Usage: baz-hint');
    expect(result.help).toContain('Schema:');
  });

  it('full format without inputSchema omits the Schema line', async () => {
    const ctx = makeCtx([
      {
        name: 'qux',
        description: 'Q',
        permission: 'auto',
        mutating: false,
        inputSchema: undefined as never,
      },
    ]);
    const result = await toolHelpTool.execute({ tool: 'qux', format: 'full' }, ctx);
    expect(result.help).not.toContain('Schema:');
  });
});
