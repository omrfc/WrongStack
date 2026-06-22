import { describe, expect, it, vi } from 'vitest';
import { buildDiagCommand, buildStatsCommand } from '../src/slash-commands/diag-stats.js';
import { buildMemoryCommand } from '../src/slash-commands/memory.js';
import { buildTodosCommand } from '../src/slash-commands/todos.js';
import type { SlashCommandContext } from '../src/slash-commands/index.js';
import type { MemoryStore } from '@wrongstack/core';

function emptyCtx(overrides: Partial<SlashCommandContext> = {}): SlashCommandContext {
  return {
    config: {} as never,
    container: {} as never,
    onDiag: undefined,
    onStats: undefined,
    memoryStore: undefined,
    context: undefined,
    ...overrides,
  } as never as SlashCommandContext;
}

// ── /diag ────────────────────────────────────────────────────────────────────

describe('buildDiagCommand', () => {
  it('reports unavailable when onDiag missing', async () => {
    const cmd = buildDiagCommand(emptyCtx());
    expect(cmd.name).toBe('diag');
    const res = await cmd.run('');
    expect(res?.message ?? '').toContain('not available');
  });

  it('returns onDiag output when handler provided', async () => {
    const cmd = buildDiagCommand(emptyCtx({ onDiag: () => 'DIAG_OUT' as never }));
    const res = await cmd.run('');
    expect(res?.message ?? '').toBe('DIAG_OUT');
  });
});

// ── /stats ───────────────────────────────────────────────────────────────────

describe('buildStatsCommand', () => {
  it('reports unavailable when onStats missing', async () => {
    const cmd = buildStatsCommand(emptyCtx());
    const res = await cmd.run('');
    expect(res?.message ?? '').toContain('not available');
  });

  it('returns onStats output when handler returns text', async () => {
    const cmd = buildStatsCommand(emptyCtx({ onStats: () => 'STATS' as never }));
    const res = await cmd.run('');
    expect(res?.message ?? '').toBe('STATS');
  });

  it('falls back to placeholder when onStats returns undefined', async () => {
    const cmd = buildStatsCommand(emptyCtx({ onStats: () => undefined as never }));
    const res = await cmd.run('');
    expect(res?.message ?? '').toContain('No session activity');
  });
});

// ── /memory ──────────────────────────────────────────────────────────────────

function makeMemStore(initial = '') {
  const state = { text: initial };
  return {
    readAll: vi.fn(async () => state.text),
    remember: vi.fn(async (s: string) => {
      state.text += (state.text ? '\n' : '') + s;
    }),
    forget: vi.fn(async (q: string) => {
      const before = state.text.split('\n').length;
      state.text = state.text
        .split('\n')
        .filter((l) => !l.includes(q))
        .join('\n');
      return Math.max(0, before - state.text.split('\n').filter(Boolean).length);
    }),
    clear: vi.fn(async () => {
      state.text = '';
    }),
    _state: state,
  } as never as MemoryStore;
}

describe('buildMemoryCommand', () => {
  it('reports "no memory store" when undefined', async () => {
    const cmd = buildMemoryCommand(emptyCtx());
    const res = await cmd.run('show');
    expect(res?.message ?? '').toContain('No memory store');
  });

  it('show returns empty message when nothing remembered', async () => {
    const store = makeMemStore('');
    const cmd = buildMemoryCommand(emptyCtx({ memoryStore: store }));
    const res = await cmd.run('');
    expect(res?.message ?? '').toContain('Memory is empty');
  });

  it('show returns existing content', async () => {
    const cmd = buildMemoryCommand(emptyCtx({ memoryStore: makeMemStore('apples\noranges') }));
    const res = await cmd.run('list');
    expect(res?.message ?? '').toContain('apples');
  });

  it('remember without args returns usage hint', async () => {
    const cmd = buildMemoryCommand(emptyCtx({ memoryStore: makeMemStore() }));
    const res = await cmd.run('remember');
    expect(res?.message ?? '').toContain('Usage:');
  });

  it('remember stores the rest as a single entry', async () => {
    const store = makeMemStore();
    const cmd = buildMemoryCommand(emptyCtx({ memoryStore: store }));
    const res = await cmd.run('add  user likes tabs ');
    expect(res?.message ?? '').toContain('Remembered: user likes tabs');
    expect(store.remember).toHaveBeenCalledWith('user likes tabs');
  });

  it('forget without args returns usage', async () => {
    const cmd = buildMemoryCommand(emptyCtx({ memoryStore: makeMemStore() }));
    const res = await cmd.run('forget');
    expect(res?.message ?? '').toContain('Usage:');
  });

  it('forget reports "no entries matched" on miss', async () => {
    const store = makeMemStore('apples');
    const cmd = buildMemoryCommand(emptyCtx({ memoryStore: store }));
    const res = await cmd.run('rm unicorns');
    expect(res?.message ?? '').toContain('No entries matched');
  });

  it('forget reports number removed when matched', async () => {
    const store = makeMemStore('apples\noranges');
    const cmd = buildMemoryCommand(emptyCtx({ memoryStore: store }));
    const res = await cmd.run('forget apples');
    expect(res?.message ?? '').toMatch(/Forgot \d+ entr/);
  });

  it('clear empties the store', async () => {
    const store = makeMemStore('xx');
    const cmd = buildMemoryCommand(emptyCtx({ memoryStore: store }));
    const res = await cmd.run('clear');
    expect(res?.message ?? '').toContain('Cleared');
    expect(store.clear).toHaveBeenCalled();
  });

  it('unknown subcommand reports usage', async () => {
    const cmd = buildMemoryCommand(emptyCtx({ memoryStore: makeMemStore() }));
    const res = await cmd.run('wat');
    expect(res?.message ?? '').toContain('Unknown subcommand "wat"');
  });
});

// ── /todos ──────────────────────────────────────────────────────────────────

function makeCtx(initialTodos: Array<{ id: string; content: string; status: string; activeForm?: string }> = []) {
  const todos = [...initialTodos];
  return {
    todos,
    state: {
      replaceTodos(next: typeof todos) {
        todos.length = 0;
        todos.push(...next);
      },
    },
  };
}

describe('buildTodosCommand', () => {
  it('returns "no active context" when none provided', async () => {
    const cmd = buildTodosCommand(emptyCtx());
    const res = await cmd.run('show');
    expect(res?.message ?? '').toContain('No active context');
  });

  it('show renders the formatted list', async () => {
    const cmd = buildTodosCommand(emptyCtx({ context: makeCtx([{ id: 't1', content: 'do thing', status: 'pending' }]) as never }));
    const res = await cmd.run('');
    expect(res?.message ?? '').toContain('do thing');
  });

  it('clear empties the array', async () => {
    const ctxState = makeCtx([{ id: 't1', content: 'x', status: 'pending' }]);
    const cmd = buildTodosCommand(emptyCtx({ context: ctxState as never }));
    const res = await cmd.run('clear');
    expect(res?.message ?? '').toContain('Cleared 1 todo');
    expect(ctxState.todos).toEqual([]);
  });

  it('clear on empty notes "already empty"', async () => {
    const cmd = buildTodosCommand(emptyCtx({ context: makeCtx() as never }));
    const res = await cmd.run('clear');
    expect(res?.message ?? '').toContain('already empty');
  });

  it('add without text returns usage', async () => {
    const cmd = buildTodosCommand(emptyCtx({ context: makeCtx() as never }));
    const res = await cmd.run('add');
    expect(res?.message ?? '').toContain('Usage:');
  });

  it('add inserts a new pending todo with stable shape', async () => {
    const ctxState = makeCtx();
    const cmd = buildTodosCommand(emptyCtx({ context: ctxState as never }));
    const res = await cmd.run('add ship the thing');
    expect(res?.message ?? '').toBe('Added: ship the thing');
    expect(ctxState.todos).toHaveLength(1);
    expect(ctxState.todos[0]?.content).toBe('ship the thing');
    expect(ctxState.todos[0]?.status).toBe('pending');
    expect(ctxState.todos[0]?.id).toMatch(/^todo_\d+_/);
  });

  it('done without arg returns usage', async () => {
    const cmd = buildTodosCommand(emptyCtx({ context: makeCtx() as never }));
    const res = await cmd.run('done');
    expect(res?.message ?? '').toContain('Usage:');
  });

  it('done by 1-based index marks the entry completed', async () => {
    const ctxState = makeCtx([
      { id: 'a', content: 'first', status: 'pending' },
      { id: 'b', content: 'second', status: 'pending' },
    ]);
    const cmd = buildTodosCommand(emptyCtx({ context: ctxState as never }));
    const res = await cmd.run('done 2');
    expect(res?.message ?? '').toContain('Marked done: second');
    expect(ctxState.todos[1]?.status).toBe('completed');
  });

  it('done by id marks the entry completed', async () => {
    const ctxState = makeCtx([{ id: 'todo_xyz', content: 'one', status: 'pending' }]);
    const cmd = buildTodosCommand(emptyCtx({ context: ctxState as never }));
    const res = await cmd.run('complete todo_xyz');
    expect(res?.message ?? '').toContain('Marked done: one');
  });

  it('done by substring match falls through', async () => {
    const ctxState = makeCtx([{ id: 'x', content: 'fix the bug', status: 'pending' }]);
    const cmd = buildTodosCommand(emptyCtx({ context: ctxState as never }));
    const res = await cmd.run('done THE Bug');
    expect(res?.message ?? '').toContain('Marked done: fix the bug');
  });

  it('done with no match reports not found', async () => {
    const cmd = buildTodosCommand(emptyCtx({ context: makeCtx() as never }));
    const res = await cmd.run('done nope');
    expect(res?.message ?? '').toContain('No todo matched');
  });

  // ── /todos remove ──

  it('remove without arg returns usage', async () => {
    const cmd = buildTodosCommand(emptyCtx({ context: makeCtx() as never }));
    const res = await cmd.run('remove');
    expect(res?.message ?? '').toContain('Usage:');
  });

  it('rm alias works', async () => {
    const ctxState = makeCtx([{ id: 'x', content: 'junk', status: 'pending' }]);
    const cmd = buildTodosCommand(emptyCtx({ context: ctxState as never }));
    const res = await cmd.run('rm 1');
    expect(res?.message ?? '').toContain('Removed: junk');
  });

  it('remove by index deletes the item', async () => {
    const ctxState = makeCtx([
      { id: 'a', content: 'first', status: 'pending' },
      { id: 'b', content: 'second', status: 'in_progress' },
    ]);
    const cmd = buildTodosCommand(emptyCtx({ context: ctxState as never }));
    const res = await cmd.run('remove 2');
    expect(res?.message ?? '').toBe('Removed: second');
    expect(ctxState.todos).toHaveLength(1);
    expect(ctxState.todos[0]?.content).toBe('first');
  });

  it('remove by id deletes the item', async () => {
    const ctxState = makeCtx([{ id: 'todo_z', content: 'bye', status: 'pending' }]);
    const cmd = buildTodosCommand(emptyCtx({ context: ctxState as never }));
    const res = await cmd.run('remove todo_z');
    expect(res?.message ?? '').toContain('Removed: bye');
    expect(ctxState.todos).toHaveLength(0);
  });

  it('remove with no match reports not found', async () => {
    const cmd = buildTodosCommand(emptyCtx({ context: makeCtx() as never }));
    const res = await cmd.run('delete nope');
    expect(res?.message ?? '').toContain('No todo matched');
  });

  it('unknown subcommand reports usage', async () => {
    const cmd = buildTodosCommand(emptyCtx({ context: makeCtx() as never }));
    const res = await cmd.run('frobulate');
    expect(res?.message ?? '').toContain('Unknown subcommand "frobulate"');
  });
});
