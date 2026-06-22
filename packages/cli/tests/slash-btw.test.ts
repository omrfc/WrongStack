import type { Context } from '@wrongstack/core';
import { describe, expect, it } from 'vitest';
import { buildBtwCommand } from '../src/slash-commands/btw.js';
import type { SlashCommandContext } from '../src/slash-commands/index.js';

function build(ctx?: Partial<Context>) {
  return buildBtwCommand({ context: ctx as Context } as SlashCommandContext);
}

describe('buildBtwCommand', () => {
  it('reports no active session when context is missing', async () => {
    const res = await build(undefined).run('hello', {} as Context);
    expect(res?.message).toMatch(/No active session/i);
  });

  it('stashes a note on ctx.meta and confirms', async () => {
    const ctx = { meta: {} } as never as Context;
    const res = await build(ctx).run('check the auth module', {} as Context);
    expect(res?.message).toContain('check the auth module');
    expect(res?.message).toMatch(/1 pending/);
    expect((ctx.meta as Record<string, unknown>)._btwNotes).toEqual(['check the auth module']);
  });

  it('accumulates multiple notes', async () => {
    const ctx = { meta: {} } as never as Context;
    await build(ctx).run('first', {} as Context);
    const res = await build(ctx).run('second', {} as Context);
    expect(res?.message).toMatch(/2 pending/);
    expect((ctx.meta as Record<string, unknown>)._btwNotes).toEqual(['first', 'second']);
  });

  it('with no args reports pending count', async () => {
    const ctx = { meta: {} } as never as Context;
    const empty = await build(ctx).run('', {} as Context);
    expect(empty?.message).toMatch(/No notes pending/i);

    await build(ctx).run('a note', {} as Context);
    const withPending = await build(ctx).run('', {} as Context);
    expect(withPending?.message).toMatch(/1 note\(s\) pending/);
  });

  it('ignores a blank note', async () => {
    const ctx = { meta: {} } as never as Context;
    const res = await build(ctx).run('    ', {} as Context);
    expect(res?.message).toMatch(/No notes pending/i);
    expect((ctx.meta as Record<string, unknown>)._btwNotes).toBeUndefined();
  });
});
