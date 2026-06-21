/**
 * TUI debug-stream callbacks — extracted from the runTui() options literal.
 *
 * Phase C step 6. registerDebugStreamCallback swaps the debug-stream
 * callback from stderr → TUI reducer; restoreDebugStreamCallback reverts
 * to the default on TUI unmount. Both are pure delegates to
 * @wrongstack/providers with structured error logging.
 */

/**
 * Swap the debug-stream callback to the TUI reducer.
 * Restored on TUI unmount via restoreDebugStreamCallback.
 */
export async function registerDebugStreamCallback(
  cb: import('@wrongstack/providers').DebugStreamCallback,
): Promise<void> {
  try {
    const { setDebugStreamCallback } = await import('@wrongstack/providers');
    setDebugStreamCallback(cb);
  } catch (err) {
    console.error(
      JSON.stringify({
        level: 'error',
        event: 'execution.debug_stream_register_failed',
        message: err instanceof Error ? err.message : String(err),
        timestamp: new Date().toISOString(),
      }),
    );
  }
}

/**
 * Restore the default debug-stream callback (stderr).
 */
export async function restoreDebugStreamCallback(): Promise<void> {
  try {
    const { setDebugStreamCallback, defaultDebugStreamCallback } = await import(
      '@wrongstack/providers'
    );
    setDebugStreamCallback(defaultDebugStreamCallback);
  } catch (err) {
    console.error(
      JSON.stringify({
        level: 'error',
        event: 'execution.debug_stream_restore_failed',
        message: err instanceof Error ? err.message : String(err),
        timestamp: new Date().toISOString(),
      }),
    );
  }
}
