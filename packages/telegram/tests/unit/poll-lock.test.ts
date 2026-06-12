import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { lockPathForToken, PollLock } from '../../src/poll-lock.js';

describe('lockPathForToken', () => {
  it('is deterministic and never contains the raw token', () => {
    const token = '123456789:ABCdefSECRET';
    const a = lockPathForToken(token, '/tmp/root');
    const b = lockPathForToken(token, '/tmp/root');
    expect(a).toBe(b);
    expect(a).not.toContain('ABCdefSECRET');
    expect(a).toContain('telegram');
  });

  it('differs per token', () => {
    expect(lockPathForToken('token-a', '/tmp/root')).not.toBe(
      lockPathForToken('token-b', '/tmp/root'),
    );
  });
});

describe('PollLock', () => {
  let dir: string;
  const locks: PollLock[] = [];

  function makeLock(opts?: { heartbeatMs?: number; staleMs?: number }) {
    const lock = new PollLock(join(dir, 'nested', 'poll.lock'), opts);
    locks.push(lock);
    return lock;
  }

  afterEach(() => {
    for (const lock of locks.splice(0)) lock.release();
    rmSync(dir, { recursive: true, force: true });
  });

  function setup() {
    dir = mkdtempSync(join(tmpdir(), 'wstack-poll-lock-'));
    mkdirSync(join(dir, 'nested'), { recursive: true });
  }

  it('acquires when no lock file exists (creates parent dirs)', () => {
    setup();
    const lock = makeLock();
    expect(lock.tryAcquire()).toBe(true);
    expect(lock.held).toBe(true);
  });

  it('tryAcquire is idempotent for the holder', () => {
    setup();
    const lock = makeLock();
    expect(lock.tryAcquire()).toBe(true);
    expect(lock.tryAcquire()).toBe(true);
  });

  it('a second instance cannot acquire while the first holds', () => {
    setup();
    const first = makeLock();
    const second = makeLock();
    expect(first.tryAcquire()).toBe(true);
    expect(second.tryAcquire()).toBe(false);
    expect(second.held).toBe(false);
  });

  it('a second instance acquires after release', () => {
    setup();
    const first = makeLock();
    const second = makeLock();
    first.tryAcquire();
    first.release();
    expect(first.held).toBe(false);
    expect(second.tryAcquire()).toBe(true);
  });

  it('release is idempotent and only removes own lock', () => {
    setup();
    const first = makeLock();
    const second = makeLock();
    first.tryAcquire();
    second.release(); // never held — must not delete first's file
    expect(second.tryAcquire()).toBe(false);
    first.release();
    first.release();
  });

  it('steals a lock with a stale heartbeat', () => {
    setup();
    const lock = makeLock({ staleMs: 50 });
    const path = join(dir, 'nested', 'poll.lock');
    // Simulate a holder (alive pid) whose heartbeat stopped long ago.
    writeFileSync(
      path,
      JSON.stringify({
        id: 'other:instance',
        pid: process.pid,
        acquiredAt: Date.now() - 10_000,
        heartbeatAt: Date.now() - 10_000,
      }),
    );
    expect(lock.tryAcquire()).toBe(true);
  });

  it('steals a lock held by a dead pid even with a fresh heartbeat', () => {
    setup();
    const lock = makeLock();
    const path = join(dir, 'nested', 'poll.lock');
    writeFileSync(
      path,
      JSON.stringify({
        id: 'dead:instance',
        pid: 2 ** 30, // not a real pid
        acquiredAt: Date.now(),
        heartbeatAt: Date.now(),
      }),
    );
    expect(lock.tryAcquire()).toBe(true);
  });

  it('treats a corrupt lock file as absent', () => {
    setup();
    const lock = makeLock();
    const path = join(dir, 'nested', 'poll.lock');
    writeFileSync(path, 'not json at all');
    expect(lock.tryAcquire()).toBe(true);
  });

  it('refreshes the heartbeat while held', async () => {
    setup();
    const lock = makeLock({ heartbeatMs: 20 });
    lock.tryAcquire();
    const path = join(dir, 'nested', 'poll.lock');
    const before = JSON.parse(readFileSync(path, 'utf8')).heartbeatAt as number;
    await new Promise((r) => setTimeout(r, 80));
    const after = JSON.parse(readFileSync(path, 'utf8')).heartbeatAt as number;
    expect(after).toBeGreaterThan(before);
  });

  it('fires onLost when another instance takes over the file', async () => {
    setup();
    const lock = makeLock({ heartbeatMs: 20 });
    const onLost = vi.fn();
    lock.onLost = onLost;
    lock.tryAcquire();
    const path = join(dir, 'nested', 'poll.lock');
    writeFileSync(
      path,
      JSON.stringify({
        id: 'thief:instance',
        pid: process.pid,
        acquiredAt: Date.now(),
        heartbeatAt: Date.now(),
      }),
    );
    await new Promise((r) => setTimeout(r, 100));
    expect(onLost).toHaveBeenCalled();
    expect(lock.held).toBe(false);
  });
});
