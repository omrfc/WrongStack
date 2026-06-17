import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ReplayLogStore } from '../../src/index.js';

// Covers list() (flat + sharded scan, skips, readdir errors), the readAll
// envelope form, and the record/lookup/load error emit paths that the main
// replay.test.ts does not reach.

let dir: string;
let store: ReplayLogStore;

const ENTRY = (hash: string) =>
  JSON.stringify({
    hash,
    ts: '2026-01-01T00:00:00.000Z',
    request: { model: 'm', messages: [], maxTokens: 1 },
    response: { content: [], stopReason: 'end_turn', usage: { input: 0, output: 0 }, model: 'm' },
  }) + '\n';

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'replay-log-extra-'));
  store = new ReplayLogStore({ dir });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(dir, { recursive: true, force: true });
});

describe('ReplayLogStore.list', () => {
  it('lists flat and date-sharded sessions, sorted, with entry counts', async () => {
    await fs.writeFile(path.join(dir, 'flat.replay.jsonl'), ENTRY('sha256:a1') + ENTRY('sha256:a2'), 'utf8');
    await fs.mkdir(path.join(dir, '2026-06-11'), { recursive: true });
    await fs.writeFile(path.join(dir, '2026-06-11', 'base.replay.jsonl'), ENTRY('sha256:b1'), 'utf8');
    await fs.writeFile(path.join(dir, '.hidden.replay.jsonl'), ENTRY('sha256:c1'), 'utf8');
    await fs.writeFile(path.join(dir, 'notes.txt'), 'ignore me', 'utf8');

    const listed = await store.list();
    expect(listed.map((e) => e.sessionId)).toEqual(['2026-06-11/base', 'flat']);
    const flat = listed.find((e) => e.sessionId === 'flat');
    expect(flat?.entryCount).toBe(2);
    expect(flat?.path.endsWith('flat.replay.jsonl')).toBe(true);
  });

  it('returns [] when the store directory does not exist (ENOENT)', async () => {
    const missing = new ReplayLogStore({ dir: path.join(dir, 'nope') });
    expect(await missing.list()).toEqual([]);
  });

  it('warns and returns [] when the store dir is unreadable (non-ENOENT)', async () => {
    const filePath = path.join(dir, 'a-file');
    await fs.writeFile(filePath, 'not a dir', 'utf8');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const bad = new ReplayLogStore({ dir: filePath });
    expect(await bad.list()).toEqual([]);
    expect(warn).toHaveBeenCalled();
  });
});

describe('ReplayLogStore — readAll envelope + error emits', () => {
  it('reads the forward-compat {version, entry} envelope form', async () => {
    const envelope =
      JSON.stringify({
        version: 1,
        entry: {
          hash: 'sha256:env',
          ts: '2026-01-01T00:00:00.000Z',
          request: { model: 'm', messages: [], maxTokens: 1 },
          response: { content: [], stopReason: 'end_turn', usage: { input: 0, output: 0 }, model: 'm' },
        },
      }) + '\n';
    await fs.writeFile(path.join(dir, 'env.replay.jsonl'), envelope, 'utf8');
    const entries = await store.load('env');
    expect(entries).toHaveLength(1);
    expect(entries[0]?.hash).toBe('sha256:env');
  });

  it('emits storage.error and rethrows when load hits a non-ENOENT I/O error', async () => {
    const events = { emit: vi.fn() };
    const s = new ReplayLogStore({ dir, events: events as never, traceId: 'tr-1' });
    await fs.mkdir(path.join(dir, 'bad.replay.jsonl'), { recursive: true });
    await expect(s.load('bad')).rejects.toBeDefined();
    const err = events.emit.mock.calls.find(
      (c) => c[0] === 'storage.read' && (c[1] as { outcome?: string }).outcome === 'failure',
    );
    expect(err).toBeDefined();
    expect((err?.[1] as { traceId?: string }).traceId).toBe('tr-1');
  });

  it('emits storage.error and rethrows when lookup hits a non-ENOENT I/O error', async () => {
    const events = { emit: vi.fn() };
    const s = new ReplayLogStore({ dir, events: events as never });
    await fs.mkdir(path.join(dir, 'bad2.replay.jsonl'), { recursive: true });
    await expect(s.lookup('bad2', 'sha256:x')).rejects.toBeDefined();
    expect(events.emit.mock.calls.some((c) => c[0] === 'storage.read')).toBe(true);
  });

  it('emits storage.error and rethrows when record hits a non-ENOENT I/O error', async () => {
    const events = { emit: vi.fn() };
    const s = new ReplayLogStore({ dir, events: events as never });
    await fs.mkdir(path.join(dir, 'bad3.replay.jsonl'), { recursive: true });
    await expect(
      s.record({
        sessionId: 'bad3',
        request: { model: 'm', messages: [], maxTokens: 1 } as never,
        response: { content: [], stopReason: 'end_turn', usage: { input: 0, output: 0 }, model: 'm' } as never,
      }),
    ).rejects.toBeDefined();
    expect(events.emit.mock.calls.some((c) => c[0] === 'storage.error')).toBe(true);
  });

  it('evicts the oldest entries once maxEntries is exceeded (compact path)', async () => {
    const s = new ReplayLogStore({ dir, maxEntries: 2 });
    for (let i = 0; i < 4; i++) {
      await s.record({
        sessionId: 'cap',
        request: { model: 'm', messages: [{ role: 'user', content: [{ type: 'text', text: `m${i}` }] }], maxTokens: 1 } as never,
        response: { content: [], stopReason: 'end_turn', usage: { input: 0, output: 0 }, model: 'm' } as never,
      });
    }
    const entries = await s.load('cap');
    expect(entries).toHaveLength(2);
  });
});
