/**
 * Process lifecycle for the WebUI server: graceful shutdown and the
 * SIGINT/SIGTERM wiring that triggers it.
 *
 * On a termination signal we (best-effort) flush + close the active session,
 * close every connected WebSocket, stop the HTTP and WS servers, then exit.
 * A re-entrancy guard makes a second signal during shutdown a no-op (rapid
 * double Ctrl+C no longer runs the teardown twice).
 *
 * Extracted from `index.ts` as a parameterized factory so the teardown
 * sequence can be unit tested without a real process signal, server, or
 * `process.exit` — `log` and `exit` are injectable seams.
 */

export interface LifecycleResources {
  /** Persist + close the active session (best-effort; errors are logged). */
  flushSession: () => Promise<void>;
  /**
   * Returns the currently-connected client sockets to close. A thunk (not a
   * snapshot) so shutdown closes whoever is connected *at signal time*, not
   * whoever was connected when the handler was registered.
   */
  clients: () => Iterable<{ close: () => void }>;
  /** Servers to stop (HTTP + WS). `null`/`undefined` entries are skipped. */
  servers: Array<{ close: () => void } | null | undefined>;
  /** Output sink. Defaults to `console.log`. */
  log?: (msg: string) => void;
  /** Process exit. Defaults to `process.exit`. Injectable for tests. */
  exit?: (code: number) => void;
}

/**
 * Build the graceful-shutdown handler. Returns an idempotent async function:
 * the first call runs the teardown, subsequent calls (e.g. a second SIGINT)
 * return immediately.
 */
export function createShutdown(res: LifecycleResources): () => Promise<void> {
  const log = res.log ?? ((m: string) => console.log(m));
  const exit = res.exit ?? ((code: number) => process.exit(code));
  let shuttingDown = false;

  return async () => {
    if (shuttingDown) return; // a second signal during teardown is a no-op
    shuttingDown = true;

    log('[WebUI] Shutting down...');
    try {
      await res.flushSession();
    } catch (e) {
      log(`[WebUI] Error closing session: ${e instanceof Error ? e.message : String(e)}`);
    }
    for (const ws of res.clients()) ws.close();
    for (const server of res.servers) server?.close();
    exit(0);
  };
}

/**
 * Register the shutdown handler on SIGINT and SIGTERM. Returns an unregister
 * function that detaches both listeners (useful for tests and clean restarts).
 */
export function registerShutdownHandlers(res: LifecycleResources): () => void {
  const shutdown = createShutdown(res);
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  return () => {
    process.off('SIGINT', shutdown);
    process.off('SIGTERM', shutdown);
  };
}
