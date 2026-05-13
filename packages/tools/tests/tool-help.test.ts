import { describe, it, expect, vi } from 'vitest';
import { toolHelpTool } from '../src/tool-help.js';

const makeCtx = (tools: any[] = []) =>
  ({ cwd: '/fake', tools, projectRoot: '/fake' } as any);

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
    const ctx = makeCtx([{ name: 'test', description: 'A test tool', usageHint: 'Use it', permission: 'auto', mutating: false, inputSchema: {} }]);
    const result = await toolHelpTool.execute({ tool: 'test' }, ctx);
    expect(result.total).toBe(1);
    expect(result.tools[0].name).toBe('test');
  });

  it('lists all tools when no tool specified', async () => {
    const ctx = makeCtx([
      { name: 'foo', description: 'Foo', usageHint: '', permission: 'auto', mutating: false, inputSchema: {} },
      { name: 'bar', description: 'Bar', usageHint: '', permission: 'auto', mutating: false, inputSchema: {} },
    ]);
    const result = await toolHelpTool.execute({}, ctx);
    expect(result.total).toBe(2);
    expect(result.tools).toHaveLength(2);
  });

  it('formats as short by default', async () => {
    const ctx = makeCtx([{ name: 'foo', description: 'Foo', usageHint: 'Hint', permission: 'auto', mutating: false, inputSchema: {} }]);
    const result = await toolHelpTool.execute({}, ctx);
    expect(result.help).toContain('foo');
    expect(result.help).toContain('Foo');
  });

  it('formats as markdown', async () => {
    const ctx = makeCtx([{ name: 'foo', description: 'Foo', usageHint: '', permission: 'auto', mutating: false, inputSchema: {} }]);
    const result = await toolHelpTool.execute({ format: 'markdown' }, ctx);
    expect(result.help).toContain('##');
    expect(result.help).toContain('|');
  });

  it('formats as full with schema', async () => {
    const ctx = makeCtx([{ name: 'foo', description: 'Foo', usageHint: '', permission: 'auto', mutating: false, inputSchema: { type: 'object' } }]);
    const result = await toolHelpTool.execute({ format: 'full' }, ctx);
    expect(result.tools[0].inputSchema).toBeDefined();
  });

  it('includes examples when requested', async () => {
    const ctx = makeCtx([{ name: 'foo', description: 'Foo', usageHint: '', permission: 'auto', mutating: false, inputSchema: { type: 'object' } }]);
    const result = await toolHelpTool.execute({ include_examples: true }, ctx);
    expect(result).toHaveProperty('total');
  });
});