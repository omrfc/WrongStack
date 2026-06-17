import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueueStore } from '../../src/storage/queue-store.js';

// Covers QueueStore.clear()'s non-ENOENT error branch (storage.error emit +
// throttled warning). Uses real fs with the queue file replaced by a directory
// so unlink() throws EISDIR/EPERM rather than ENOENT.

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-queue-clearerr-'));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(dir, { recursive: true, force: true });
});

describe('QueueStore.clear — non-ENOENT failure', () => {
  it('emits storage.error and warns but does not throw', async () => {
    const events = { emit: vi.fn() };
    const store = new QueueStore({ dir, events: events as never, traceId: 'tr-q' });
    await fs.mkdir(path.join(dir, 'queue.json'), { recursive: true });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await expect(store.clear()).resolves.toBeUndefined();

    const err = events.emit.mock.calls.find(
      (c) => c[0] === 'storage.error' && (c[1] as { operation?: string }).operation === 'clear',
    );
    expect(err).toBeDefined();
    expect((err?.[1] as { traceId?: string }).traceId).toBe('tr-q');
    expect(warn).toHaveBeenCalled();
  });
});
