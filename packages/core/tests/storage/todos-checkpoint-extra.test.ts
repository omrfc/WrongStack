import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadTodosCheckpoint } from '../../src/storage/todos-checkpoint.js';

// Covers loadTodosCheckpoint's parse-failure branch (valid read, invalid JSON).

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-todos-cp-'));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('todos-checkpoint — extra coverage', () => {
  it('emits storage.read parse_failed and returns null on invalid JSON', async () => {
    const events = { emit: vi.fn() };
    const fp = path.join(dir, 'todos.json');
    await fs.writeFile(fp, '{ not valid json', 'utf8');
    expect(await loadTodosCheckpoint(fp, events as never, 'tr-1')).toBeNull();
    const read = events.emit.mock.calls.find(
      (c) => c[0] === 'storage.read' && (c[1] as { error?: string }).error === 'parse_failed',
    );
    expect(read).toBeDefined();
    expect((read?.[1] as { traceId?: string }).traceId).toBe('tr-1');
  });
});
