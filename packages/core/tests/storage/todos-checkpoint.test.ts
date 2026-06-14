import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Context } from '../../src/core/context.js';
import type { EventBus } from '../../src/kernel/events.js';
import type { SessionWriter } from '../../src/types/session.js';
import {
  attachTodosCheckpoint,
  loadTodosCheckpoint,
  saveTodosCheckpoint,
} from '../../src/storage/todos-checkpoint.js';

function makeContext(): Context {
  return new Context({
    systemPrompt: [],
    provider: {} as never,
    session: { id: 'sess', pendingToolUses: [], append: async () => {}, appendBatch: async () => {}, flush: async () => {}, close: async () => {}, recordFileChange: () => {}, writeCheckpoint: async () => {}, writeFileSnapshot: async () => {}, truncateToCheckpoint: async () => 0, clearSession: async () => {}, writeInFlightMarker: async () => {}, clearInFlightMarker: async () => {} } as unknown as SessionWriter,
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

  // ── storage.* event tests ─────────────────────────────────────────────────

  it('emits storage.read with outcome success when loadTodosCheckpoint finds a valid file', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-todos-'));
    const file = path.join(dir, 'sess.todos.json');
    const events: EventBus = { emit: vi.fn() } as never;
    try {
      await fs.writeFile(file, JSON.stringify({ version: 1, sessionId: 'sess', updatedAt: new Date().toISOString(), todos: [{ id: 't1', content: 'first', status: 'pending' }] }));
      await loadTodosCheckpoint(file, events);
      expect(events.emit).toHaveBeenCalledWith('storage.read', expect.objectContaining({
        store: 'todos',
        operation: 'load',
        outcome: 'success',
        sessionId: '~boot~',
      }));
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('emits storage.read with outcome failure when loadTodosCheckpoint finds invalid schema', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-todos-'));
    const file = path.join(dir, 'bad.todos.json');
    const events: EventBus = { emit: vi.fn() } as never;
    try {
      // version 999 is not valid — filter rejects it
      await fs.writeFile(file, JSON.stringify({ version: 999, sessionId: 'sess', updatedAt: new Date().toISOString(), todos: [] }));
      await loadTodosCheckpoint(file, events);
      expect(events.emit).toHaveBeenCalledWith('storage.read', expect.objectContaining({
        store: 'todos',
        operation: 'load',
        outcome: 'failure',
        error: 'invalid_schema',
      }));
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('emits storage.error when loadTodosCheckpoint encounters a disk I/O error', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-todos-'));
    const file = path.join(dir, 'io-error.todos.json');
    const events: EventBus = { emit: vi.fn() } as never;
    const spy = vi.spyOn(fs, 'readFile');
    spy.mockRejectedValueOnce(Object.assign(new Error('EACCES permission denied'), { code: 'EACCES' }));
    try {
      const result = await loadTodosCheckpoint(file, events);
      expect(result).toBeNull();
      expect(events.emit).toHaveBeenCalledWith('storage.error', expect.objectContaining({
        store: 'todos',
        operation: 'load',
        outcome: 'failure',
        error: expect.stringContaining('EACCES'),
      }));
    } finally {
      spy.mockRestore();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('emits storage.write with outcome success when saveTodosCheckpoint succeeds', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-todos-'));
    const file = path.join(dir, 'sess.todos.json');
    const events: EventBus = { emit: vi.fn() } as never;
    try {
      await saveTodosCheckpoint(file, 'sess', [{ id: 't1', content: 'first', status: 'pending' }], events);
      expect(events.emit).toHaveBeenCalledWith('storage.write', expect.objectContaining({
        store: 'todos',
        operation: 'save',
        outcome: 'success',
        sessionId: 'sess',
      }));
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('emits storage.error when saveTodosCheckpoint encounters a write failure', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-todos-'));
    const file = path.join(dir, 'io-error.todos.json');
    const events: EventBus = { emit: vi.fn() } as never;
    const spy = vi.spyOn(fs, 'writeFile');
    // atomicWrite uses writeFile then rename — mock at the writeFile level
    spy.mockRejectedValueOnce(Object.assign(new Error('ENOSPC no space left'), { code: 'ENOSPC' }));
    try {
      await saveTodosCheckpoint(file, 'sess', [{ id: 't1', content: 'first', status: 'pending' }], events);
      expect(events.emit).toHaveBeenCalledWith('storage.error', expect.objectContaining({
        store: 'todos',
        operation: 'save',
        outcome: 'failure',
        error: expect.stringContaining('ENOSPC'),
      }));
    } finally {
      spy.mockRestore();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
