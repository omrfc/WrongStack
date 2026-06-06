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

/**
 * Bracket installed by the interactive input reader while a `readline`
 * prompt is on screen. Out-of-band terminal writes — logger WARN/INFO
 * lines, async activity from the Telegram bridge, etc. — go to the same
 * physical terminal as the half-typed prompt but readline has no idea they
 * happened, so it never repaints. The result is the classic corruption the
 * user sees: every async line strands the in-progress draft as a fresh
 * scrollback row (sometimes with its cursor underline).
 *
 * The guard closes that gap. `suspend()` wipes the draft row so the message
 * prints clean; `resume()` repaints the prompt + draft (cursor preserved).
 * When no prompt is active the guard is `null` and writes pass straight
 * through — so agent-turn output (spinner, renderer) is untouched.
 */
export interface OutputLineGuard {
  /** Clear the current input row right before an out-of-band write. */
  suspend(): void;
  /** Repaint the prompt + in-progress draft right after the write. */
  resume(): void;
}

let activeOutputGuard: OutputLineGuard | null = null;

/**
 * Register (or clear, with `null`) the guard that brackets out-of-band
 * writes. Installed by {@link writeOut}/{@link writeErr} consumers — in
 * practice the CLI's readline input reader — only while a prompt is live.
 * Idempotent; the most recent caller wins.
 */
export function setOutputLineGuard(guard: OutputLineGuard | null): void {
  activeOutputGuard = guard;
}

/**
 * Stream-agnostic write primitive. Returns `false` when the stream is
 * missing or doesn't expose `write` so callers can degrade silently under
 * hostile host environments (closed pipe, mock injects `null`, test
 * replaces the stream with a stub).
 *
 * When an {@link OutputLineGuard} is installed (a readline prompt is on
 * screen) the write is bracketed by `suspend()`/`resume()` so the user's
 * half-typed input survives the interruption instead of being stranded in
 * scrollback. The guard's own redraw uses raw stream writes — never
 * `writeOut`/`writeErr` — so there is no re-entrancy here.
 *
 * **Not exported in the public API.** Exposed only inside `term.ts` for
 * `writeOut` / `writeErr` to share a single implementation. If a caller
 * needs to write to an arbitrary stream, they should call `writeOut` (or
 * `writeErr`) with an explicit `stream` argument — the named functions
 * are the public surface so the "this is the standard error stream"
 * intent stays visible at every call site.
 */
function writeTo(
  s: string,
  stream: NodeJS.WriteStream | undefined,
): boolean {
  if (!stream || typeof stream.write !== 'function') return false;
  const guard = activeOutputGuard;
  if (!guard) {
    stream.write(s);
    return true;
  }
  // A prompt is live — wipe the draft row, emit the message, repaint.
  guard.suspend();
  stream.write(s);
  guard.resume();
  return true;
}

/**
 * Write `s` to `stream` (defaults to `process.stdout`). Returns `false`
 * when the stream is missing or doesn't expose `write` so callers can
 * degrade silently under hostile host environments (closed pipe, mock
 * injects `null`, test replaces the stream with a stub).
 *
 * Why a helper:
 *   1. **Single seam for output capture in tests** — stub `writeOut` once
 *      and assert on what the rest of the codebase intended to print,
 *      without spying on `process.stdout.write` (which is brittle and
 *      leaks across parallel test files).
 *   2. **Stream swap without grep** — routing the CLI's output to a
 *      logger or `out.log` becomes a one-line change at process boot.
 *   3. **Defensive default** — closes the "what if `process.stdout` is
 *      `null`" gap that currently exists at ~50 call sites that just
 *      call `process.stdout.write(s)` and crash on certain Windows
 *      redirect invocations.
 *
 * Call-site migration is staged: this commit introduces the helper, a
 * follow-up commit replaces the 50+ `process.stdout.write(...)` sites
 * with `writeOut(...)`. Until that migration lands, both forms coexist
 * and `writeOut` is the preferred form for new code.
 */
export function writeOut(
  s: string,
  stream: NodeJS.WriteStream = process.stdout,
): boolean {
  return writeTo(s, stream);
}

/**
 * Symmetric partner of `writeOut` for the standard error stream. Same shape,
 * same defensive contract, same single-seam-for-tests story — just defaults to
 * `process.stderr` instead of `process.stdout`.
 *
 * Use this in code paths that emit error/diagnostic/warning text. Keeping
 * these two helpers split (rather than a single `writeTo(s, stream)`) means
 * the call site reads as a clear intent signal: "I am writing an error" vs.
 * "I am writing a result" — which matters for callers that decide between
 * stdout/stderr routing (e.g. `--quiet` flags, log-level filtering,
 * structured-log rewriters that fork on stream).
 *
 * Stderr writes from the core logger (see `infrastructure/logger.ts`) and from
 * the TUI guard (see `tui/run-tui.ts`) used to call `process.stderr.write`
 * directly. Routing them through this helper lets tests stub the stream at
 * one boundary and lets future logging middleware (e.g. a JSON-line rewriter)
 * swap the destination for the entire process in one place.
 */
export function writeErr(
  s: string,
  stream: NodeJS.WriteStream = process.stderr,
): boolean {
  return writeTo(s, stream);
}
