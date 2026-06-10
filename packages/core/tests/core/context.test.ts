import { describe, expect, it } from 'vitest';
import { Context, DefaultTokenCounter } from '../../src/index.js';
import type { Provider, SessionWriter, TextBlock } from '../../src/index.js';

const fakeProvider = {} as Provider;
const fakeSession: SessionWriter = {
  id: 't',
  pendingToolUses: [],
  append: async () => undefined,
  appendBatch: async () => undefined,
  flush: async () => undefined,
  close: async () => undefined,
};

function mkContext(): Context {
  return new Context({
    systemPrompt: [{ type: 'text', text: 'hi' } as TextBlock],
    provider: fakeProvider,
    session: fakeSession,
    signal: new AbortController().signal,
    tokenCounter: new DefaultTokenCounter(),
    cwd: '/tmp',
    projectRoot: '/tmp',
    model: 'm',
  });
}

describe('Context', () => {
  it('starts empty', () => {
    const ctx = mkContext();
    expect(ctx.messages).toEqual([]);
    expect(ctx.todos).toEqual([]);
    expect(ctx.readFiles.size).toBe(0);
    expect(ctx.meta).toEqual({});
  });

  it('recordRead tracks files + mtimes', () => {
    const ctx = mkContext();
    ctx.recordRead('/a/b.ts', 100);
    expect(ctx.hasRead('/a/b.ts')).toBe(true);
    expect(ctx.hasRead('/other')).toBe(false);
    expect(ctx.lastReadMtime('/a/b.ts')).toBe(100);
    expect(ctx.lastReadMtime('/missing')).toBeUndefined();
  });

  it('usage delegates to tokenCounter', () => {
    const ctx = mkContext();
    ctx.tokenCounter.account({ input: 7, output: 3 }, 'm');
    const u = ctx.usage();
    expect(u.input).toBe(7);
    expect(u.output).toBe(3);
  });
});
