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

describe('Context.workingDir', () => {
  it('defaults to cwd when workingDir is not provided', () => {
    const ctx = mkContext();
    expect(ctx.workingDir).toBe('/tmp');
  });

  it('accepts an explicit workingDir in init', () => {
    const ctx = new Context({
      systemPrompt: [{ type: 'text', text: 'hi' } as TextBlock],
      provider: fakeProvider,
      session: fakeSession,
      signal: new AbortController().signal,
      tokenCounter: new DefaultTokenCounter(),
      cwd: '/tmp',
      projectRoot: '/proj',
      workingDir: '/proj/src',
      model: 'm',
    });
    expect(ctx.workingDir).toBe('/proj/src');
  });
});

describe('Context.setWorkingDir', () => {
  it('changes workingDir to a subdirectory', () => {
    const ctx = new Context({
      systemPrompt: [{ type: 'text', text: 'hi' } as TextBlock],
      provider: fakeProvider,
      session: fakeSession,
      signal: new AbortController().signal,
      tokenCounter: new DefaultTokenCounter(),
      cwd: '/proj',
      projectRoot: '/proj',
      model: 'm',
    });
    const result = ctx.setWorkingDir('/proj/src');
    expect(result).toBe('/proj/src');
    expect(ctx.workingDir).toBe('/proj/src');
  });

  it('resolves relative paths against projectRoot', () => {
    const ctx = new Context({
      systemPrompt: [{ type: 'text', text: 'hi' } as TextBlock],
      provider: fakeProvider,
      session: fakeSession,
      signal: new AbortController().signal,
      tokenCounter: new DefaultTokenCounter(),
      cwd: '/other',
      projectRoot: '/proj',
      model: 'm',
    });
    // 'src' relative → /proj/src
    const result = ctx.setWorkingDir('src');
    expect(result).toBe('/proj/src');
    expect(ctx.workingDir).toBe('/proj/src');
  });

  it('rejects paths outside projectRoot', () => {
    const ctx = new Context({
      systemPrompt: [{ type: 'text', text: 'hi' } as TextBlock],
      provider: fakeProvider,
      session: fakeSession,
      signal: new AbortController().signal,
      tokenCounter: new DefaultTokenCounter(),
      cwd: '/proj',
      projectRoot: '/proj',
      model: 'm',
    });
    expect(() => ctx.setWorkingDir('/etc')).toThrow(/outside project root/);
  });

  it('rejects relative paths that escape via ..', () => {
    const ctx = new Context({
      systemPrompt: [{ type: 'text', text: 'hi' } as TextBlock],
      provider: fakeProvider,
      session: fakeSession,
      signal: new AbortController().signal,
      tokenCounter: new DefaultTokenCounter(),
      cwd: '/proj',
      projectRoot: '/proj',
      model: 'm',
    });
    expect(() => ctx.setWorkingDir('../etc')).toThrow(/outside project root/);
  });

  it('returns the resolved path', () => {
    const ctx = new Context({
      systemPrompt: [{ type: 'text', text: 'hi' } as TextBlock],
      provider: fakeProvider,
      session: fakeSession,
      signal: new AbortController().signal,
      tokenCounter: new DefaultTokenCounter(),
      cwd: '/proj',
      projectRoot: '/proj',
      model: 'm',
    });
    const result = ctx.setWorkingDir('/proj/src/lib');
    expect(result).toBe('/proj/src/lib');
  });
});

describe('Context.onWorkingDirChanged', () => {
  it('fires callback when setWorkingDir is called', () => {
    const ctx = new Context({
      systemPrompt: [{ type: 'text', text: 'hi' } as TextBlock],
      provider: fakeProvider,
      session: fakeSession,
      signal: new AbortController().signal,
      tokenCounter: new DefaultTokenCounter(),
      cwd: '/proj',
      projectRoot: '/proj',
      model: 'm',
    });

    let newDir = '';
    let oldDir = '';
    ctx.onWorkingDirChanged((n, o) => { newDir = n; oldDir = o; });

    ctx.setWorkingDir('/proj/src');
    expect(newDir).toBe('/proj/src');
    expect(oldDir).toBe('/proj');
  });

  it('returns an unsubscribe function', () => {
    const ctx = new Context({
      systemPrompt: [{ type: 'text', text: 'hi' } as TextBlock],
      provider: fakeProvider,
      session: fakeSession,
      signal: new AbortController().signal,
      tokenCounter: new DefaultTokenCounter(),
      cwd: '/proj',
      projectRoot: '/proj',
      model: 'm',
    });

    let called = false;
    const unsub = ctx.onWorkingDirChanged(() => { called = true; });

    // Unsubscribe before the change
    unsub();

    ctx.setWorkingDir('/proj/src');
    expect(called).toBe(false);
  });

  it('calls multiple subscribers', () => {
    const ctx = new Context({
      systemPrompt: [{ type: 'text', text: 'hi' } as TextBlock],
      provider: fakeProvider,
      session: fakeSession,
      signal: new AbortController().signal,
      tokenCounter: new DefaultTokenCounter(),
      cwd: '/proj',
      projectRoot: '/proj',
      model: 'm',
    });

    let count = 0;
    ctx.onWorkingDirChanged(() => { count++; });
    ctx.onWorkingDirChanged(() => { count++; });

    ctx.setWorkingDir('/proj/src');
    expect(count).toBe(2);
  });

  it('swallows errors in callbacks so other listeners still fire', () => {
    const ctx = new Context({
      systemPrompt: [{ type: 'text', text: 'hi' } as TextBlock],
      provider: fakeProvider,
      session: fakeSession,
      signal: new AbortController().signal,
      tokenCounter: new DefaultTokenCounter(),
      cwd: '/proj',
      projectRoot: '/proj',
      model: 'm',
    });

    let secondCalled = false;
    ctx.onWorkingDirChanged(() => { throw new Error('boom'); });
    ctx.onWorkingDirChanged(() => { secondCalled = true; });

    // Should not throw — errors are swallowed
    expect(() => ctx.setWorkingDir('/proj/src')).not.toThrow();
    expect(secondCalled).toBe(true);
  });
});
