import { describe, it, expect } from 'vitest';
import { createContextManagerTool, contextManagerTool } from '../../src/defaults/context-manager.js';

const makeCtx = (messages: any[] = []) => ({
  cwd: '/fake',
  projectRoot: '/fake',
  readFiles: new Set<string>(),
  fileMtimes: new Map<string, number>(),
  hasRead: () => false,
  lastReadMtime: () => undefined,
  recordRead: () => {},
  todos: [],
  messages,
} as any);

describe('createContextManagerTool', () => {
  it('has correct metadata', () => {
    const tool = createContextManagerTool();
    expect(tool.name).toBe('context_manager');
    expect(tool.permission).toBe('auto');
    expect(tool.mutating).toBe(true);
  });

  it('check action returns budget info', async () => {
    const tool = createContextManagerTool();
    const ctx = makeCtx([
      { role: 'user', content: 'hello world' },
    ]);
    const result = await tool.execute({ action: 'check' }, ctx);
    expect(result.action).toBe('check');
    expect(result.messageCount).toBe(1);
    expect(result.beforeTokens).toBeGreaterThan(0);
    expect(result.notes).toBeDefined();
  });

  it('prune removes messages in range', async () => {
    const tool = createContextManagerTool();
    const ctx = makeCtx([
      { role: 'user', content: 'a' },
      { role: 'user', content: 'b' },
      { role: 'user', content: 'c' },
    ]);
    const result = await tool.execute({ action: 'prune', from: 0, to: 1 }, ctx);
    expect(result.action).toBe('prune');
    expect(result.removedCount).toBe(2);
    expect(result.messageCount).toBe(1);
    expect(ctx.messages).toHaveLength(1);
  });

  it('prune rejects invalid range', async () => {
    const tool = createContextManagerTool();
    const ctx = makeCtx([{ role: 'user', content: 'a' }]);
    const result = await tool.execute({ action: 'prune', from: 5, to: 10 }, ctx);
    expect(result.notes).toContain('Invalid range');
    expect(result.removedCount).toBeUndefined();
  });

  it('prune uses defaults when from/to omitted', async () => {
    const tool = createContextManagerTool();
    const ctx = makeCtx([
      { role: 'user', content: 'a' },
      { role: 'user', content: 'b' },
    ]);
    const result = await tool.execute({ action: 'prune' }, ctx);
    expect(result.removedCount).toBe(2);
  });

  it('add_note injects a note at beginning by default', async () => {
    const tool = createContextManagerTool();
    const ctx = makeCtx([{ role: 'user', content: 'a' }]);
    const result = await tool.execute({ action: 'add_note', text: 'important!' }, ctx);
    expect(result.action).toBe('add_note');
    expect(result.summary).toBe('important!');
    expect(ctx.messages).toHaveLength(2);
    // afterIndex defaults to 0, so note is prepended at index 0
    expect(ctx.messages[0].content).toContain('important!');
  });

  it('add_note defaults text to (no summary)', async () => {
    const tool = createContextManagerTool();
    const ctx = makeCtx([{ role: 'user', content: 'a' }]);
    const result = await tool.execute({ action: 'add_note' }, ctx);
    expect(result.summary).toBe('(no summary)');
  });

  it('add_note respects afterIndex', async () => {
    const tool = createContextManagerTool();
    const ctx = makeCtx([{ role: 'user', content: 'a' }, { role: 'user', content: 'b' }]);
    const result = await tool.execute({ action: 'add_note', text: 'inserted', afterIndex: 1 }, ctx);
    expect(ctx.messages[1].content).toContain('inserted');
  });

  it('summary replaces range with summary message', async () => {
    const tool = createContextManagerTool();
    const ctx = makeCtx([
      { role: 'user', content: 'hello' },
      { role: 'user', content: 'world' },
    ]);
    const result = await tool.execute({ action: 'summary', from: 0, to: 1, text: 'greeting' }, ctx);
    expect(result.action).toBe('summary');
    expect(result.summary).toBe('greeting');
    expect(ctx.messages).toHaveLength(1);
    expect(ctx.messages[0].content).toContain('greeting');
  });

  it('summary rejects invalid range', async () => {
    const tool = createContextManagerTool();
    const ctx = makeCtx([{ role: 'user', content: 'a' }]);
    const result = await tool.execute({ action: 'summary', from: -1, to: 5 }, ctx);
    expect(result.notes).toContain('Invalid range');
  });

  it('summary uses placeholder when text not provided', async () => {
    const tool = createContextManagerTool();
    const ctx = makeCtx([{ role: 'user', content: 'a' }]);
    const result = await tool.execute({ action: 'summary', from: 0, to: 0 }, ctx);
    expect(result.summary).toContain('placeholder');
  });

  it('compact returns error when no compactor registered', async () => {
    const tool = createContextManagerTool();
    const ctx = makeCtx([]);
    const result = await tool.execute({ action: 'compact' }, ctx);
    expect(result.notes).toContain('No compactor registered');
    expect(result.afterTokens).toBeUndefined();
  });

  it('compact uses registered compactor', async () => {
    const tool = createContextManagerTool({
      compactor: {
        compact: async (ctx: any) => ({ after: 100, removed: 5 }),
      },
    });
    const ctx = makeCtx([{ role: 'user', content: 'a'.repeat(1000) }]);
    const result = await tool.execute({ action: 'compact' }, ctx);
    expect(result.action).toBe('compact');
    expect(result.afterTokens).toBeDefined();
  });

  it('returns unknown action for unrecognized actions', async () => {
    const tool = createContextManagerTool();
    const ctx = makeCtx([]);
    const result = await tool.execute({ action: 'unknown' as any }, ctx);
    expect(result.notes).toContain('Unknown action');
  });

  it('exports default instance without compactor', () => {
    expect(contextManagerTool.name).toBe('context_manager');
  });
});
