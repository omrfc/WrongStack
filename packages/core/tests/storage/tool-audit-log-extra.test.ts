import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToolAuditLog } from '../../src/storage/tool-audit-log.js';

// Real-fs coverage for the fsync/flush path, the cache-miss re-read, the
// chain reset when the file is removed, the load error emit, and the sortKeys
// array branch — none of which the in-memory-mocked main suite exercises.

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-audit-extra-'));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(dir, { recursive: true, force: true });
});

const rec = (sessionId: string, input: unknown) => ({
  sessionId,
  toolName: 'bash',
  toolUseId: 'u1',
  input,
  output: { ok: true },
  isError: false,
});

describe('tool-audit-log — extra coverage', () => {
  it('fsyncs on the configured cadence and via explicit flush (array input → sortKeys)', async () => {
    const log = new ToolAuditLog({ dir, fsyncEvery: 1 });
    await log.record(rec('s1', { args: ['a', 'b', { nested: 1 }] }));
    await log.flush('s1');
    const entries = await log.load('s1');
    expect(entries).toHaveLength(1);
  });

  it('re-reads the tail (cache-miss with an existing file) for a fresh instance', async () => {
    const log1 = new ToolAuditLog({ dir });
    await log1.record(rec('s2', { x: 1 }));
    const log2 = new ToolAuditLog({ dir });
    const e = await log2.record(rec('s2', { x: 2 }));
    expect(e.index).toBe(1);
  });

  it('resets the chain when the audit file is removed out from under the cache', async () => {
    const log = new ToolAuditLog({ dir });
    await log.record(rec('s3', { x: 1 }));
    await log.record(rec('s3', { x: 2 }));
    await log.record(rec('s3', { x: 3 }));
    await fs.rm(path.join(dir, 's3.audit.jsonl'), { force: true });
    const e = await log.record(rec('s3', { x: 4 }));
    expect(e.index).toBe(0);
  });

  it('emits storage.read failure and rethrows when load hits a non-ENOENT error', async () => {
    const events = { emit: vi.fn() };
    const log = new ToolAuditLog({ dir, events: events as never, traceId: 'tr-a' });
    await fs.mkdir(path.join(dir, 'bad.audit.jsonl'), { recursive: true });
    await expect(log.load('bad')).rejects.toBeDefined();
    const err = events.emit.mock.calls.find(
      (c) => c[0] === 'storage.read' && (c[1] as { outcome?: string }).outcome === 'failure',
    );
    expect(err).toBeDefined();
    expect((err?.[1] as { traceId?: string }).traceId).toBe('tr-a');
  });
});
