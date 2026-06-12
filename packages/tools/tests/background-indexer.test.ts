/**
 * Tests for the background indexing coordinator (debounce + mutex).
 *
 * `runIndexer` itself is mocked here — its real behavior is covered by
 * codebase-index.test.ts. These tests only assert background-indexer's own
 * responsibilities: coalescing rapid edits, dropping non-indexable files, and
 * serializing concurrent runs onto a single mutex.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the indexer module BEFORE importing the unit under test. The mock is
// declared via vi.hoisted so it's initialized before the hoisted vi.mock factory.
const { runIndexerMock } = vi.hoisted(() => ({ runIndexerMock: vi.fn() }));
vi.mock('../src/codebase-index/indexer.js', () => ({
  runIndexer: runIndexerMock,
}));

const OK_RESULT = { filesIndexed: 1, symbolsIndexed: 0, langStats: {}, durationMs: 0, errors: [] };

import {
  cancelPendingReindexes,
  enqueueReindex,
  isIndexableFile,
  isIndexing,
  runStartupIndex,
} from '../src/codebase-index/background-indexer.js';
import {
  CircuitOpenError,
  IndexTimeoutError,
  indexCircuitBreaker,
  resetIndexCircuitBreaker,
} from '../src/codebase-index/circuit-breaker.js';

beforeEach(() => {
  runIndexerMock.mockReset();
  runIndexerMock.mockResolvedValue(OK_RESULT);
  // The breaker is process-wide module state — start every test closed.
  resetIndexCircuitBreaker();
});

afterEach(() => {
  cancelPendingReindexes();
  vi.useRealTimers();
});

describe('isIndexableFile', () => {
  it('accepts known source extensions', () => {
    for (const f of ['a.ts', 'b.tsx', 'c.js', 'd.jsx', 'e.go', 'f.py', 'g.rs']) {
      expect(isIndexableFile(`/proj/${f}`)).toBe(true);
    }
  });

  it('rejects non-source files', () => {
    for (const f of ['README.md', 'notes.txt', 'image.png', 'Makefile']) {
      expect(isIndexableFile(`/proj/${f}`)).toBe(false);
    }
  });
});

describe('enqueueReindex (debounce)', () => {
  it('coalesces rapid edits to the same file into one reindex', async () => {
    vi.useFakeTimers();
    for (let i = 0; i < 3; i++) {
      enqueueReindex({ projectRoot: '/proj', files: ['/proj/a.ts'], debounceMs: 20 });
    }
    await vi.advanceTimersByTimeAsync(30);
    expect(runIndexerMock).toHaveBeenCalledTimes(1);
    expect(runIndexerMock.mock.calls[0]?.[1]).toMatchObject({ files: ['/proj/a.ts'] });
  });

  it('reindexes distinct files separately', async () => {
    vi.useFakeTimers();
    enqueueReindex({ projectRoot: '/proj', files: ['/proj/a.ts'], debounceMs: 20 });
    enqueueReindex({ projectRoot: '/proj', files: ['/proj/b.ts'], debounceMs: 20 });
    await vi.advanceTimersByTimeAsync(30);
    expect(runIndexerMock).toHaveBeenCalledTimes(2);
  });

  it('drops non-indexable files before scheduling', async () => {
    vi.useFakeTimers();
    enqueueReindex({ projectRoot: '/proj', files: ['/proj/README.md'], debounceMs: 20 });
    await vi.advanceTimersByTimeAsync(30);
    expect(runIndexerMock).not.toHaveBeenCalled();
  });

  it('routes reindex failures to onError, never throwing', async () => {
    vi.useFakeTimers();
    runIndexerMock.mockRejectedValueOnce(new Error('boom'));
    const onError = vi.fn();
    enqueueReindex({ projectRoot: '/proj', files: ['/proj/a.ts'], debounceMs: 10, onError });
    await vi.advanceTimersByTimeAsync(20);
    expect(onError).toHaveBeenCalledTimes(1);
  });
});

describe('mutex serialization', () => {
  it('never runs two indexer passes concurrently', async () => {
    let active = 0;
    let maxActive = 0;
    runIndexerMock.mockImplementation(async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 10));
      active--;
      return { filesIndexed: 1, symbolsIndexed: 0, langStats: {}, durationMs: 0, errors: [] };
    });

    await Promise.all([
      runStartupIndex({ projectRoot: '/proj' }),
      runStartupIndex({ projectRoot: '/proj' }),
      runStartupIndex({ projectRoot: '/proj' }),
    ]);

    expect(runIndexerMock).toHaveBeenCalledTimes(3);
    expect(maxActive).toBe(1);
  });

  it('a failing job does not wedge the mutex chain', async () => {
    runIndexerMock.mockRejectedValueOnce(new Error('first fails'));
    await expect(runStartupIndex({ projectRoot: '/proj' })).rejects.toThrow('first fails');
    // The next run still proceeds.
    await expect(runStartupIndex({ projectRoot: '/proj' })).resolves.toMatchObject({
      filesIndexed: 1,
    });
  });
});

describe('watchdog timeout', () => {
  it('a hung index run times out and does not wedge the mutex chain', async () => {
    // Never settles — simulates a wedged FS / cross-process SQLite lock.
    runIndexerMock.mockImplementationOnce(() => new Promise(() => {}));
    await expect(runStartupIndex({ projectRoot: '/proj', timeoutMs: 30 })).rejects.toThrow(
      IndexTimeoutError,
    );
    // The indexing flag is released and the next run proceeds normally.
    expect(isIndexing()).toBe(false);
    await expect(runStartupIndex({ projectRoot: '/proj' })).resolves.toMatchObject({
      filesIndexed: 1,
    });
  });

  it('aborts the run signal when the watchdog fires', async () => {
    let seenSignal: AbortSignal | undefined;
    runIndexerMock.mockImplementationOnce((_ctx: unknown, opts: { signal?: AbortSignal }) => {
      seenSignal = opts.signal;
      return new Promise(() => {});
    });
    await expect(runStartupIndex({ projectRoot: '/proj', timeoutMs: 30 })).rejects.toThrow(
      IndexTimeoutError,
    );
    expect(seenSignal?.aborted).toBe(true);
  });
});

describe('circuit breaker integration', () => {
  it('opens after repeated failures and then fails fast without running the indexer', async () => {
    runIndexerMock.mockRejectedValue(new Error('boom'));
    for (let i = 0; i < 3; i++) {
      await expect(runStartupIndex({ projectRoot: '/proj' })).rejects.toThrow('boom');
    }
    runIndexerMock.mockClear();
    await expect(runStartupIndex({ projectRoot: '/proj' })).rejects.toThrow(CircuitOpenError);
    expect(runIndexerMock).not.toHaveBeenCalled();
  });

  it('drops debounced reindexes while the circuit is open', async () => {
    vi.useFakeTimers();
    for (let i = 0; i < 3; i++) indexCircuitBreaker.recordFailure(new Error('boom'));
    const onError = vi.fn();
    enqueueReindex({ projectRoot: '/proj', files: ['/proj/a.ts'], debounceMs: 10, onError });
    await vi.advanceTimersByTimeAsync(20);
    expect(runIndexerMock).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[0]).toBeInstanceOf(CircuitOpenError);
  });

  it('caller-initiated aborts do not count toward the breaker', async () => {
    const ac = new AbortController();
    runIndexerMock.mockImplementationOnce(
      (_ctx: unknown, opts: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          const s = opts.signal;
          // The abort may land before the mutex even starts this job — honor
          // an already-aborted signal, like the real runIndexer's yield points.
          if (s?.aborted) {
            reject(s.reason);
            return;
          }
          s?.addEventListener('abort', () => reject(s.reason), { once: true });
        }),
    );
    const run = runStartupIndex({ projectRoot: '/proj', signal: ac.signal });
    ac.abort(new Error('session teardown'));
    await expect(run).rejects.toThrow('session teardown');
    expect(indexCircuitBreaker.snapshot().consecutiveFailures).toBe(0);
  });

  it('a successful run closes a tripped (cooled-down) circuit again', async () => {
    runIndexerMock.mockRejectedValueOnce(new Error('one-off'));
    await expect(runStartupIndex({ projectRoot: '/proj' })).rejects.toThrow('one-off');
    await expect(runStartupIndex({ projectRoot: '/proj' })).resolves.toMatchObject({
      filesIndexed: 1,
    });
    expect(indexCircuitBreaker.snapshot()).toMatchObject({
      state: 'closed',
      consecutiveFailures: 0,
    });
  });
});
