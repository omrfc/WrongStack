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
