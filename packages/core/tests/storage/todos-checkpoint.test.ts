import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Context } from '../../src/core/context.js';
import {
  attachTodosCheckpoint,
  loadTodosCheckpoint,
  saveTodosCheckpoint,
} from '../../src/storage/todos-checkpoint.js';

function makeContext(): Context {
  return new Context({
    systemPrompt: [],
    provider: {} as never,
    session: { id: 'sess', pendingToolUses: [], append: async () => {}, flush: async () => {}, close: async () => {} },
    signal: new AbortController().signal,
    tokenCounter: { total: () => ({ input: 0, output: 0 }), record: () => {} } as never,
    cwd: process.cwd(),
    projectRoot: process.cwd(),
    model: 'test',
  });
}

async function waitForTodosCheckpoint(file: string, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const loaded = await loadTodosCheckpoint(file);
    if (loaded) return loaded;
    await new Promise((r) => setTimeout(r, 25));
  }
  return loadTodosCheckpoint(file);
}

describe('todos-checkpoint', () => {
  it('round-trips todos through save and load', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-todos-'));
    const file = path.join(dir, 'sess.todos.json');
    try {
      await saveTodosCheckpoint(file, 'sess', [
        { id: 't1', content: 'first', status: 'pending' },
        { id: 't2', content: 'second', status: 'in_progress' },
      ]);
      const loaded = await loadTodosCheckpoint(file);
      expect(loaded).toEqual([
        { id: 't1', content: 'first', status: 'pending' },
        { id: 't2', content: 'second', status: 'in_progress' },
      ]);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('returns null when file is missing', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-todos-'));
    try {
      const loaded = await loadTodosCheckpoint(path.join(dir, 'missing.json'));
      expect(loaded).toBeNull();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('returns null when version is wrong', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-todos-'));
    const file = path.join(dir, 'bad.json');
    try {
      await fs.writeFile(file, JSON.stringify({ version: 999, todos: [] }));
      expect(await loadTodosCheckpoint(file)).toBeNull();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('attachTodosCheckpoint persists state mutations to disk', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-todos-'));
    const file = path.join(dir, 'sess.todos.json');
    try {
      const ctx = makeContext();
      const detach = attachTodosCheckpoint(ctx.state, file, 'sess');
      ctx.state.replaceTodos([
        { id: 'a', content: 'alpha', status: 'pending' },
      ]);
      // The save is debounced 150ms — wait then verify.
      const loaded = await waitForTodosCheckpoint(file);
      expect(loaded).toEqual([{ id: 'a', content: 'alpha', status: 'pending' }]);
      await detach();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('detach flushes pending write before unsubscribe', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-todos-'));
    const file = path.join(dir, 'sess.todos.json');
    try {
      const ctx = makeContext();
      const detach = attachTodosCheckpoint(ctx.state, file, 'sess');
      // Include a pending item alongside a completed one — when ALL items
      // are completed the board auto-clears (by design), but a mixed board
      // should persist fully.
      ctx.state.replaceTodos([
        { id: 'b', content: 'beta', status: 'completed' },
        { id: 'c', content: 'gamma', status: 'pending' },
      ]);
      // Detach immediately — the debounced write should still land.
      await detach();
      const loaded = await loadTodosCheckpoint(file);
      expect(loaded).toEqual([
        { id: 'b', content: 'beta', status: 'completed' },
        { id: 'c', content: 'gamma', status: 'pending' },
      ]);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
