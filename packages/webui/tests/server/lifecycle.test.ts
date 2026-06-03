import { afterEach, describe, expect, it, vi } from 'vitest';
import { createShutdown, registerShutdownHandlers } from '../../src/server/lifecycle.js';

/**
 * Graceful shutdown was previously an inline closure that called the real
 * `process.exit` — untestable without killing the runner. `lifecycle.ts`
 * exposes `log`/`exit` seams so the teardown order and idempotency can be
 * asserted directly.
 */

function makeResources(overrides: Partial<Parameters<typeof createShutdown>[0]> = {}) {
  const order: string[] = [];
  const clientA = { close: vi.fn(() => order.push('clientA')) };
  const clientB = { close: vi.fn(() => order.push('clientB')) };
  const httpServer = { close: vi.fn(() => order.push('http')) };
  const wssPrimary = { close: vi.fn(() => order.push('wssPrimary')) };
  const flushSession = vi.fn(async () => {
    order.push('flush');
  });
  const exit = vi.fn((_code: number) => {
    order.push('exit');
  });
  const log = vi.fn();
  const res = {
    flushSession,
    clients: () => [clientA, clientB],
    servers: [httpServer, wssPrimary, null],
    log,
    exit,
    ...overrides,
  };
  return { res, order, clientA, clientB, httpServer, wssPrimary, flushSession, exit, log };
}

describe('createShutdown', () => {
  it('flushes the session, closes clients + servers, then exits(0)', async () => {
    const { res, order, clientA, clientB, httpServer, wssPrimary, exit } = makeResources();
    await createShutdown(res)();
    expect(order).toEqual(['flush', 'clientA', 'clientB', 'http', 'wssPrimary', 'exit']);
    expect(clientA.close).toHaveBeenCalled();
    expect(clientB.close).toHaveBeenCalled();
    expect(httpServer.close).toHaveBeenCalled();
    expect(wssPrimary.close).toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('skips null/undefined servers without throwing', async () => {
    const { res, httpServer } = makeResources({ servers: [null, undefined, { close: vi.fn() }] });
    await expect(createShutdown(res)()).resolves.toBeUndefined();
    // (httpServer here is unused since we overrode servers; just assert no throw)
    expect(httpServer.close).not.toHaveBeenCalled();
  });

  it('still closes everything and exits when flushSession rejects', async () => {
    const flushSession = vi.fn(async () => {
      throw new Error('session locked');
    });
    const { res, clientA, httpServer, exit, log } = makeResources({ flushSession });
    await createShutdown(res)();
    expect(clientA.close).toHaveBeenCalled();
    expect(httpServer.close).toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(0);
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('Error closing session: session locked'),
    );
  });

  it('is idempotent — a second call (e.g. double SIGINT) is a no-op', async () => {
    const { res, exit, flushSession } = makeResources();
    const shutdown = createShutdown(res);
    await shutdown();
    await shutdown();
    expect(flushSession).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
  });
});

describe('registerShutdownHandlers', () => {
  let unregister: (() => void) | undefined;

  afterEach(() => {
    unregister?.();
    unregister = undefined;
  });

  it('attaches SIGINT/SIGTERM listeners and the unregister detaches them', () => {
    const before = { int: process.listenerCount('SIGINT'), term: process.listenerCount('SIGTERM') };
    const { res } = makeResources();
    unregister = registerShutdownHandlers(res);
    expect(process.listenerCount('SIGINT')).toBe(before.int + 1);
    expect(process.listenerCount('SIGTERM')).toBe(before.term + 1);
    unregister();
    unregister = undefined;
    expect(process.listenerCount('SIGINT')).toBe(before.int);
    expect(process.listenerCount('SIGTERM')).toBe(before.term);
  });

  it('runs the shutdown sequence when SIGINT fires', async () => {
    const { res, exit, flushSession } = makeResources();
    unregister = registerShutdownHandlers(res);
    process.emit('SIGINT');
    // shutdown is async; let its microtasks settle.
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
    expect(flushSession).toHaveBeenCalledTimes(1);
  });
});
