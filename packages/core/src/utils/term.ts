/**
 * TTY detection helpers — the single source of truth for "is this process
 * running against a real terminal?". Replaces ad-hoc `process.stdin.isTTY`
 * / `process.stdout.isTTY` checks scattered across the codebase so that:
 *
 *   1. test code can mock a single module instead of stubbing `isTTY` on
 *      every ReadStream/WriteStream the test happens to touch;
 *   2. a future TTY-detection source (an env var override, a Windows
 *      ConPTY workaround, …) lands in one place;
 *   3. `isInteractive()` encodes the rule the project already used inline
 *      ("both streams are TTYs AND we're not running under CI") in one
 *      testable helper instead of the same 3-condition check in two
 *      different files.
 *
 * Scope: detection only. Raw-mode control (`setRawMode`), resize
 * subscriptions, and write-injection belong to a future, larger TTY
 * abstraction; this module is the smallest pull that gives us a
 * testable seam and dedups 20+ call sites.
 */

const hasStdout = (): boolean => typeof process !== 'undefined' && !!process.stdout;
const hasStdin = (): boolean => typeof process !== 'undefined' && !!process.stdin;

/** True when `process.stdout` is attached to a terminal (not a pipe/file). */
export function isStdoutTTY(): boolean {
  return hasStdout() && Boolean(process.stdout.isTTY);
}

/** True when `process.stdin` is attached to a terminal (not a pipe/file). */
export function isStdinTTY(): boolean {
  return hasStdin() && Boolean(process.stdin.isTTY);
}

/**
 * True when the current process is an interactive session: both stdin and
 * stdout are TTYs. Callers that also need a "not a single-shot invocation"
 * or "not under CI" check should layer that on top — keeping this helper
 * minimal preserves the original inline checks it replaces.
 */
export function isInteractive(): boolean {
  return isStdinTTY() && isStdoutTTY();
}

/** Current terminal size in characters, with a 24×80 fallback for non-TTYs. */
export function getTermSize(): { rows: number; cols: number } {
  if (!hasStdout()) return { rows: 24, cols: 80 };
  return {
    rows: process.stdout.rows ?? 24,
    cols: process.stdout.columns ?? 80,
  };
}

/**
 * Subscribe to terminal resize events. `cb` is called with the new size each
 * time the underlying stream emits `resize`. Returns a cleanup function the
 * caller MUST call on dispose to remove the listener — leaving a stale
 * `resize` listener on a disposed component leaks the closure (and the
 * component itself, transitively) until the process exits.
 *
 * The stream argument defaults to `process.stdout`. Pass an explicit
 * `NodeJS.WriteStream` when the caller already owns one (e.g. a status line
 * that targets an injected `out` for testability). For non-TTY streams no
 * listener is registered and the returned cleanup is a no-op.
 */
export function onResize(
  cb: (size: { rows: number; cols: number }) => void,
  stream: NodeJS.WriteStream = process.stdout,
): () => void {
  if (!stream || typeof stream.on !== 'function') return () => {};
  const handler = (): void => {
    cb({
      rows: stream.rows ?? 24,
      cols: stream.columns ?? 80,
    });
  };
  stream.on('resize', handler);
  return () => {
    stream.off('resize', handler);
  };
}

/**
 * Toggle raw mode on a TTY stdin stream. Returns `true` when the toggle was
 * applied, `false` when the stream is null, not a TTY, or doesn't expose
 * `setRawMode` (pipes, file descriptors, Windows ConPTY edge cases). Callers
 * that need to restore the previous mode should snapshot `input.isRaw`
 * BEFORE the call and pass the value to a second call to flip back.
 *
 * Use this helper to drop the now-redundant
 * `if (input.isTTY) input.setRawMode(...)` ceremony at every call site.
 */
export function setRawMode(input: NodeJS.ReadStream, mode: boolean): boolean {
  if (!input || input.isTTY !== true) return false;
  if (typeof input.setRawMode !== 'function') return false;
  input.setRawMode(mode);
  return true;
}
