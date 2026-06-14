import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { EventBus } from '../../src/kernel/events.js';
import { QueueStore } from '../../src/storage/queue-store.js';

async function mktmp(): Promise<string> {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'wstack-queue-'));
}

describe('QueueStore', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mktmp();
  });
  afterEach(async () => {
    await fsp.rm(dir, { recursive: true, force: true });
  });

  it('read() returns [] when the file is missing', async () => {
    const store = new QueueStore({ dir });
    expect(await store.read()).toEqual([]);
  });

  it('write() then read() round-trips items', async () => {
    const store = new QueueStore({ dir });
    const items = [
      { displayText: 'first', blocks: [{ type: 'text' as const, text: 'first' }] },
      { displayText: 'second', blocks: [{ type: 'text' as const, text: 'second' }] },
    ];
    await store.write(items);
    const out = await store.read();
    expect(out).toEqual(items);
  });

  it('write([]) removes the file (clean idle state)', async () => {
    const store = new QueueStore({ dir });
    await store.write([{ displayText: 'a', blocks: [{ type: 'text', text: 'a' }] }]);
    await store.write([]);
    await expect(fsp.access(path.join(dir, 'queue.json'))).rejects.toThrow();
    expect(await store.read()).toEqual([]);
  });

  it('clear() is idempotent when the file is already gone', async () => {
    const store = new QueueStore({ dir });
    await expect(store.clear()).resolves.toBeUndefined();
  });

  it('write() is atomic — no .tmp residue after a successful write', async () => {
    const store = new QueueStore({ dir });
    await store.write([{ displayText: 'one', blocks: [{ type: 'text', text: 'one' }] }]);
    const files = await fsp.readdir(dir);
    expect(files.filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('read() tolerates malformed JSON (returns [])', async () => {
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, 'queue.json'), '{not json');
    const store = new QueueStore({ dir });
    expect(await store.read()).toEqual([]);
  });

  it('read() tolerates a non-array root (returns [])', async () => {
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, 'queue.json'), '{"queue": []}');
    const store = new QueueStore({ dir });
    expect(await store.read()).toEqual([]);
  });

  it('read() drops items missing required fields', async () => {
    const valid = { displayText: 'ok', blocks: [{ type: 'text', text: 'ok' }] };
    const missingText = { blocks: [] };
    const missingBlocks = { displayText: 'no blocks' };
    const notObject = 'string-item';
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(
      path.join(dir, 'queue.json'),
      JSON.stringify([valid, missingText, missingBlocks, notObject]),
    );
    const store = new QueueStore({ dir });
    expect(await store.read()).toEqual([valid]);
  });

  it('overwrites prior contents on each write', async () => {
    const store = new QueueStore({ dir });
    await store.write([
      { displayText: 'first', blocks: [{ type: 'text', text: 'first' }] },
      { displayText: 'second', blocks: [{ type: 'text', text: 'second' }] },
    ]);
    await store.write([{ displayText: 'only', blocks: [{ type: 'text', text: 'only' }] }]);
    const out = await store.read();
    expect(out).toHaveLength(1);
    expect(out[0]?.displayText).toBe('only');
  });

  // ── storage.* event tests ─────────────────────────────────────────────────

  it('emits storage.read with outcome success when read() finds no file (ENOENT)', async () => {
    const events: EventBus = { emit: vi.fn() } as never;
    const store = new QueueStore({ dir, events });
    const out = await store.read();
    expect(out).toEqual([]);
    expect(events.emit).toHaveBeenCalledWith('storage.read', expect.objectContaining({
      store: 'queue',
      operation: 'read',
      outcome: 'success',
    }));
  });

  it('emits storage.read with outcome failure when read() finds malformed JSON', async () => {
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, 'queue.json'), '{not json');
    const events: EventBus = { emit: vi.fn() } as never;
    const store = new QueueStore({ dir, events });
    const out = await store.read();
    expect(out).toEqual([]);
    expect(events.emit).toHaveBeenCalledWith('storage.read', expect.objectContaining({
      store: 'queue',
      operation: 'read',
      outcome: 'failure',
      error: 'parse_failed',
    }));
  });

  it('emits storage.read with outcome failure when read() finds non-array root', async () => {
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, 'queue.json'), '{"queue": []}');
    const events: EventBus = { emit: vi.fn() } as never;
    const store = new QueueStore({ dir, events });
    const out = await store.read();
    expect(out).toEqual([]);
    expect(events.emit).toHaveBeenCalledWith('storage.read', expect.objectContaining({
      store: 'queue',
      operation: 'read',
      outcome: 'failure',
      error: 'invalid_schema',
    }));
  });

  it('emits storage.error when read() encounters a disk I/O error', async () => {
    const events: EventBus = { emit: vi.fn() } as never;
    const store = new QueueStore({ dir, events });
    const spy = vi.spyOn(fsp, 'readFile');
    spy.mockRejectedValueOnce(Object.assign(new Error('EACCES permission denied'), { code: 'EACCES' }));
    try {
      const out = await store.read();
      expect(out).toEqual([]);
      expect(events.emit).toHaveBeenCalledWith('storage.error', expect.objectContaining({
        store: 'queue',
        operation: 'read',
        outcome: 'failure',
        error: expect.stringContaining('EACCES'),
      }));
    } finally {
      spy.mockRestore();
    }
  });

  it('emits storage.write with outcome success when write() succeeds', async () => {
    const events: EventBus = { emit: vi.fn() } as never;
    const store = new QueueStore({ dir, events });
    await store.write([{ displayText: 'hello', blocks: [{ type: 'text', text: 'hello' }] }]);
    expect(events.emit).toHaveBeenCalledWith('storage.write', expect.objectContaining({
      store: 'queue',
      operation: 'write',
      outcome: 'success',
    }));
  });

  it('emits storage.error when write() encounters a disk I/O error', async () => {
    const events: EventBus = { emit: vi.fn() } as never;
    const store = new QueueStore({ dir, events });
    const spy = vi.spyOn(fsp, 'writeFile');
    spy.mockRejectedValueOnce(Object.assign(new Error('ENOSPC no space left'), { code: 'ENOSPC' }));
    try {
      await store.write([{ displayText: 'hello', blocks: [{ type: 'text', text: 'hello' }] }]);
      expect(events.emit).toHaveBeenCalledWith('storage.error', expect.objectContaining({
        store: 'queue',
        operation: 'write',
        outcome: 'failure',
        error: expect.stringContaining('ENOSPC'),
      }));
    } finally {
      spy.mockRestore();
    }
  });

  it('emits storage.write with outcome success when clear() succeeds', async () => {
    // clear() is only emitted when the file exists — write then clear
    const events: EventBus = { emit: vi.fn() } as never;
    const store = new QueueStore({ dir, events });
    await store.write([{ displayText: 'x', blocks: [{ type: 'text', text: 'x' }] }]);
    events.emit = vi.fn(); // reset after write's emission
    await store.clear();
    expect(events.emit).toHaveBeenCalledWith('storage.write', expect.objectContaining({
      store: 'queue',
      operation: 'clear',
      outcome: 'success',
    }));
  });
});
