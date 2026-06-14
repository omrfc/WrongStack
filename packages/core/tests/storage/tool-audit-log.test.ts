import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { EventBus } from '../../src/kernel/events.js';
import { ToolAuditLog } from '../../src/storage/tool-audit-log.js';

let dir: string;
let log: ToolAuditLog;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tool-audit-'));
  log = new ToolAuditLog({ dir });
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('ToolAuditLog', () => {
  it('starts empty and verifies cleanly', async () => {
    expect(await log.verify('s1')).toEqual({ ok: true, entries: 0 });
    expect(await log.load('s1')).toEqual([]);
  });

  it('appends entries with monotonically increasing indices', async () => {
    const e0 = await log.record({
      sessionId: 's1',
      toolName: 'read',
      toolUseId: 'tu-1',
      input: { path: '/a' },
      output: 'hello',
      isError: false,
    });
    const e1 = await log.record({
      sessionId: 's1',
      toolName: 'write',
      toolUseId: 'tu-2',
      input: { path: '/b', content: 'x' },
      output: 'ok',
      isError: false,
    });
    expect(e0.index).toBe(0);
    expect(e1.index).toBe(1);
    expect(e0.hash).not.toBe(e1.hash);
    // Chain: e1.prevHash === e0.hash
    expect(e1.prevHash).toBe(e0.hash);
  });

  it('the first entry has the all-zeros genesis prevHash', async () => {
    const e0 = await log.record({
      sessionId: 's1',
      toolName: 'read',
      toolUseId: 'tu-1',
      input: {},
      output: 'x',
      isError: false,
    });
    expect(e0.prevHash).toBe('0'.repeat(64));
  });

  it('verify passes for an unmodified chain', async () => {
    for (let i = 0; i < 5; i++) {
      await log.record({
        sessionId: 's1',
        toolName: 'read',
        toolUseId: `tu-${i}`,
        input: { i },
        output: `result ${i}`,
        isError: false,
      });
    }
    const result = await log.verify('s1');
    expect(result).toEqual({ ok: true, entries: 5 });
  });

  it('verify fails when an entry is tampered (content changed)', async () => {
    await log.record({
      sessionId: 's1',
      toolName: 'read',
      toolUseId: 'tu-1',
      input: { path: '/a' },
      output: 'original',
      isError: false,
    });
    await log.record({
      sessionId: 's1',
      toolName: 'write',
      toolUseId: 'tu-2',
      input: { path: '/b' },
      output: 'ok',
      isError: false,
    });
    // Tamper: rewrite the file with the second entry's output changed.
    const fp = path.join(dir, 's1.audit.jsonl');
    const raw = await fs.readFile(fp, 'utf8');
    const lines = raw.split('\n').filter(Boolean);
    const second = JSON.parse(lines[1]!);
    second.output = 'TAMPERED';
    lines[1] = JSON.stringify(second);
    await fs.writeFile(fp, lines.join('\n') + '\n', 'utf8');
    // Wipe the in-memory cache so verify re-reads from disk.
    const fresh = new ToolAuditLog({ dir });
    const result = await fresh.verify('s1');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.brokenAt).toBe(1);
      expect(result.reason).toMatch(/hash mismatch at entry 1/);
    }
  });

  it('verify fails when an entry is deleted (chain breaks)', async () => {
    for (let i = 0; i < 3; i++) {
      await log.record({
        sessionId: 's1',
        toolName: 'read',
        toolUseId: `tu-${i}`,
        input: {},
        output: `r${i}`,
        isError: false,
      });
    }
    // Delete the middle entry.
    const fp = path.join(dir, 's1.audit.jsonl');
    const raw = await fs.readFile(fp, 'utf8');
    const lines = raw.split('\n').filter(Boolean);
    lines.splice(1, 1);
    await fs.writeFile(fp, lines.join('\n') + '\n', 'utf8');
    const fresh = new ToolAuditLog({ dir });
    const result = await fresh.verify('s1');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // After deletion, the now-second entry's prevHash (which was
      // the deleted entry's hash) doesn't match the first entry's hash.
      expect(result.brokenAt).toBe(1);
    }
  });

  it('verify fails when the genesis prevHash is corrupted', async () => {
    await log.record({
      sessionId: 's1',
      toolName: 'read',
      toolUseId: 'tu-1',
      input: {},
      output: 'x',
      isError: false,
    });
    const fp = path.join(dir, 's1.audit.jsonl');
    const raw = await fs.readFile(fp, 'utf8');
    const lines = raw.split('\n').filter(Boolean);
    const first = JSON.parse(lines[0]!);
    first.prevHash = 'f'.repeat(64);
    lines[0] = JSON.stringify(first);
    await fs.writeFile(fp, lines.join('\n') + '\n', 'utf8');
    const fresh = new ToolAuditLog({ dir });
    const result = await fresh.verify('s1');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.brokenAt).toBe(0);
      expect(result.reason).toMatch(/genesis/);
    }
  });

  it('serializes concurrent records without losing entries', async () => {
    const N = 20;
    await Promise.all(
      Array.from({ length: N }, (_, i) =>
        log.record({
          sessionId: 's1',
          toolName: 'read',
          toolUseId: `tu-${i}`,
          input: { i },
          output: `r${i}`,
          isError: false,
        }),
      ),
    );
    const result = await log.verify('s1');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.entries).toBe(N);
  });

  it('survives a fresh store instance and re-verifies cleanly', async () => {
    for (let i = 0; i < 4; i++) {
      await log.record({
        sessionId: 's1',
        toolName: 'read',
        toolUseId: `tu-${i}`,
        input: {},
        output: `r${i}`,
        isError: false,
      });
    }
    const fresh = new ToolAuditLog({ dir });
    expect(await fresh.verify('s1')).toEqual({ ok: true, entries: 4 });
  });

  it('isolates sessions — corrupting one does not affect the other', async () => {
    await log.record({ sessionId: 's1', toolName: 'a', toolUseId: 'tu', input: {}, output: 1, isError: false });
    await log.record({ sessionId: 's2', toolName: 'b', toolUseId: 'tu', input: {}, output: 2, isError: false });
    // Corrupt s2.
    const fp = path.join(dir, 's2.audit.jsonl');
    await fs.writeFile(fp, '{not json\n', 'utf8');
    const fresh = new ToolAuditLog({ dir });
    // s1 still verifies.
    expect(await fresh.verify('s1')).toEqual({ ok: true, entries: 1 });
    // s2 has no parseable entries → empty → ok.
    expect(await fresh.verify('s2')).toEqual({ ok: true, entries: 0 });
  });

  it('rejects path-traversal session ids', async () => {
    await expect(
      log.record({
        sessionId: '../escape',
        toolName: 'x',
        toolUseId: 'tu',
        input: {},
        output: 'x',
        isError: false,
      }),
    ).rejects.toThrow(/invalid sessionid/i);
  });

  it('records and verifies under a date-sharded session id', async () => {
    // Modern session ids contain a shard slash ("2026-06-11/<base>") —
    // the audit chain must follow them into the shard dir, not throw.
    const shardedId = '2026-06-11/12-00-00Z_model_ab12';
    await log.record({
      sessionId: shardedId,
      toolName: 'read',
      toolUseId: 'tu-1',
      input: { path: 'a.ts' },
      output: 'ok',
      isError: false,
    });
    expect(await log.verify(shardedId)).toEqual({ ok: true, entries: 1 });
    await expect(
      fs.access(path.join(dir, '2026-06-11', '12-00-00Z_model_ab12.audit.jsonl')),
    ).resolves.toBeUndefined();
  });

  it('emits storage.read with outcome failure when verify finds a broken chain', async () => {
    const events = new EventBus();
    const emitSpy = vi.spyOn(events, 'emit');
    const loggedLog = new ToolAuditLog({ dir, events });

    // Record a few entries.
    await loggedLog.record({
      sessionId: 's1',
      toolName: 'read',
      toolUseId: 'tu-1',
      input: {},
      output: 'ok',
      isError: false,
    });

    // Tamper with the audit file — rewrite an entry's output to break the hash chain.
    const fp = path.join(dir, 's1.audit.jsonl');
    const raw = await fs.readFile(fp, 'utf8');
    const lines = raw.split('\n').filter(Boolean);
    const first = JSON.parse(lines[0]!);
    first.output = 'TAMPERED';
    lines[0] = JSON.stringify(first);
    await fs.writeFile(fp, lines.join('\n') + '\n', 'utf8');

    // Create a fresh instance (clears in-memory cache) and verify.
    const fresh = new ToolAuditLog({ dir, events });
    const result = await fresh.verify('s1');

    // verify() must detect the broken chain.
    expect(result.ok).toBe(false);

    // A storage.read event must have been emitted with outcome=failure.
    expect(emitSpy).toHaveBeenCalledWith(
      'storage.read',
      expect.objectContaining({
        store: 'audit',
        operation: 'verify',
        outcome: 'failure',
        sessionId: 's1',
      }),
    );
  });

  it('emits storage.read with outcome success when verify passes on a clean chain', async () => {
    const events = new EventBus();
    const emitSpy = vi.spyOn(events, 'emit');
    const loggedLog = new ToolAuditLog({ dir, events });

    await loggedLog.record({
      sessionId: 's1',
      toolName: 'read',
      toolUseId: 'tu-1',
      input: {},
      output: 'ok',
      isError: false,
    });

    const fresh = new ToolAuditLog({ dir, events });
    const result = await fresh.verify('s1');

    expect(result.ok).toBe(true);
    expect(emitSpy).toHaveBeenCalledWith(
      'storage.read',
      expect.objectContaining({
        store: 'audit',
        operation: 'verify',
        outcome: 'success',
        sessionId: 's1',
      }),
    );
  });

  it('emits storage.read with outcome failure when verify() encounters an unreadable file', async () => {
    const events = new EventBus();
    const emitSpy = vi.spyOn(events, 'emit');
    const loggedLog = new ToolAuditLog({ dir, events });

    // Write a real audit file so readAll's fs.readFile finds it,
    // then make it unreadable by mocking fs.readFile to throw EACCES.
    await loggedLog.record({
      sessionId: 's1',
      toolName: 'read',
      toolUseId: 'tu-1',
      input: {},
      output: 'x',
      isError: false,
    });

    const { realReadFile } = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    vi.spyOn(fs, 'readFile').mockImplementation(async (p: string | Buffer | URL) => {
      if (String(p).endsWith('s1.audit.jsonl')) {
        const err = new Error('EACCES: permission denied');
        (err as NodeJS.ErrnoException).code = 'EACCES';
        throw err;
      }
      return realReadFile(p, 'utf8');
    });

    try {
      const result = await loggedLog.verify('s1');
      // verify() catches the error and returns { ok: true, entries: 0 }.
      expect(result).toEqual({ ok: true, entries: 0 });
      // But the storage.read event reports the failure.
      expect(emitSpy).toHaveBeenCalledWith(
        'storage.read',
        expect.objectContaining({
          store: 'audit',
          operation: 'verify',
          outcome: 'failure',
          sessionId: 's1',
          error: expect.stringContaining('EACCES'),
        }),
      );
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('emits storage.read with outcome failure when load() encounters an unreadable file', async () => {
    const events = new EventBus();
    const emitSpy = vi.spyOn(events, 'emit');
    const loggedLog = new ToolAuditLog({ dir, events });

    // Write a real audit file so the path is valid, then make it unreadable.
    await loggedLog.record({
      sessionId: 's1',
      toolName: 'read',
      toolUseId: 'tu-1',
      input: {},
      output: 'x',
      isError: false,
    });

    const { realReadFile } = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    vi.spyOn(fs, 'readFile').mockImplementation(async (p: string | Buffer | URL) => {
      if (String(p).endsWith('s1.audit.jsonl')) {
        const err = new Error('EACCES: permission denied');
        (err as NodeJS.ErrnoException).code = 'EACCES';
        throw err;
      }
      return realReadFile(p, 'utf8');
    });

    try {
      await expect(loggedLog.load('s1')).rejects.toThrow('EACCES');
      expect(emitSpy).toHaveBeenCalledWith(
        'storage.read',
        expect.objectContaining({
          store: 'audit',
          operation: 'load',
          outcome: 'failure',
          sessionId: 's1',
          error: expect.stringContaining('EACCES'),
        }),
      );
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('emits storage.write with operation record on successful record()', async () => {
    const events = new EventBus();
    const emitSpy = vi.spyOn(events, 'emit');
    const loggedLog = new ToolAuditLog({ dir, events });

    const entry = await loggedLog.record({
      sessionId: 's1',
      toolName: 'read',
      toolUseId: 'tu-1',
      input: { path: '/a' },
      output: 'result',
      isError: false,
    });

    expect(entry.id).toBeDefined();
    expect(entry.hash).toHaveLength(64);
    expect(emitSpy).toHaveBeenCalledWith(
      'storage.write',
      expect.objectContaining({
        store: 'audit',
        operation: 'record',
        outcome: 'success',
        sessionId: 's1',
      }),
    );
  });

  it('emits storage.error when record() encounters a write failure', async () => {
    const events = new EventBus();
    const emitSpy = vi.spyOn(events, 'emit');
    const loggedLog = new ToolAuditLog({ dir, events });

    // Intercept fs.writeFile to throw a persistent I/O error for 's1'.
    const { realWriteFile } = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    vi.spyOn(fs, 'writeFile').mockImplementation(async (p: string | Buffer | URL) => {
      if (String(p).endsWith('s1.audit.jsonl') || String(p).includes('s1.audit.jsonl')) {
        const err = new Error('ENOSPC: no space left on device');
        (err as NodeJS.ErrnoException).code = 'ENOSPC';
        throw err;
      }
      return realWriteFile(p, 'utf8');
    });

    try {
      await expect(
        loggedLog.record({
          sessionId: 's1',
          toolName: 'read',
          toolUseId: 'tu-1',
          input: {},
          output: 'x',
          isError: false,
        }),
      ).rejects.toThrow();
      expect(emitSpy).toHaveBeenCalledWith(
        'storage.error',
        expect.objectContaining({
          store: 'audit',
          operation: 'record',
          outcome: 'failure',
          sessionId: 's1',
          error: expect.stringContaining('ENOSPC'),
        }),
      );
    } finally {
      vi.restoreAllMocks();
    }
  });
});
