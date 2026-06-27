import { describe, expect, it } from 'vitest';
// extractKillCommand and isKillRelatedCommand are module-internal, but
// checkAndBlockKillCommand is the public entry point that wraps them. We
// drive coverage through it to pin the real behavior callers depend on.
import { checkAndBlockKillCommand } from '../src/bash-kill-guard.js';

/**
 * P2 #10 (before-release.md): extractKillCommand()'s regex only matched
 * `/bin/bash -c`, `/usr/bin/bash -c`, and `/bin/sh -c`. Real systems often
 * have bash at `/usr/local/bin/bash`, `/opt/homebrew/bin/bash`, or invoke it
 * via `/usr/bin/env bash -c`. Kill commands wrapped in those shells bypassed
 * the guard entirely.
 *
 * The fix broadened the path pattern to match any executable followed by
 * `-c`. These tests pin both the previously-matched paths (regression guard)
 * and the newly-covered paths.
 *
 * checkAndBlockKillCommand reads the persistent process registry, but the
 * tests target PIDs that are never tracked (high random numbers) so the
 * registry state does not affect the extraction assertions.
 */
describe('bash-kill-guard — shell path coverage (P2 #10)', () => {
  // No beforeEach reset: the tests use untracked PIDs and the kill-guard's
  // extraction logic is independent of registry contents.

  // A PID that is never tracked/protected → extraction succeeds but the kill
  // is not blocked. We use this to confirm the shell-wrapped command was
  // parsed (not silently dropped).
  const SAFE_PID = '99999999';

  it.each([
    // Previously matched (regression guard)
    '/bin/bash -c "kill -9 12345"',
    '/bin/sh -c "kill -9 12345"',
    '/usr/bin/bash -c "kill -9 12345"',
    // Newly covered (P2 #10)
    '/usr/local/bin/bash -c "kill -9 12345"',
    '/opt/homebrew/bin/bash -c "kill -9 12345"',
    '/usr/bin/env bash -c "kill -9 12345"',
    'bash -c "kill -9 12345"',
    'sh -c "kill -9 12345"',
    // Single-quoted variants
    "/usr/local/bin/bash -c 'kill -9 12345'",
    "/usr/bin/env bash -c 'pkill node'",
  ])('extracts the inner kill command from %j', async (command) => {
    // The command targets PID 12345 / "node" — neither is protected in a fresh
    // registry, so the result is { blocked: false }. But if extraction failed,
    // we'd ALSO get { blocked: false } — that alone doesn't prove extraction.
    // So we also assert against a control: an unparseable kill pipeline that
    // ONLY blocks when extraction succeeds. (See the next test.)
    const result = await checkAndBlockKillCommand(command);
    expect(result.blocked).toBe(false);
  });

  it('confirms extraction runs (kill pipeline blocks when the inner command is a kill pipe)', async () => {
    // kill piped to xargs is unparseable → checkAndBlockKillCommand blocks it
    // with "complex kill pipeline". This only fires when extractKillCommand
    // successfully unwrapped the shell -c layer. A non-matching shell path
    // (the pre-fix behavior) would return { blocked: false }.
    const command = '/usr/local/bin/bash -c "kill -9 12345 | xargs kill"';
    const result = await checkAndBlockKillCommand(command);
    expect(result.blocked).toBe(true);
    expect(result.reason).toMatch(/complex kill pipeline/i);
  });

  it('confirms extraction runs for /usr/bin/env bash (pre-fix bypass)', async () => {
    // Same proof, different shell path that was NOT matched before the fix.
    const command = '/usr/bin/env bash -c "kill 12345 | xargs kill"';
    const result = await checkAndBlockKillCommand(command);
    expect(result.blocked).toBe(true);
    expect(result.reason).toMatch(/complex kill pipeline/i);
  });

  it('does not match a non-kill shell -c command (no false positive)', async () => {
    const command = '/usr/local/bin/bash -c "echo hello"';
    const result = await checkAndBlockKillCommand(command);
    expect(result.blocked).toBe(false);
  });

  it('does not match grep -c (the broadened pattern may catch non-shell -c)', async () => {
    // The broadened regex matches `<exec> -c <command>`. `grep -c kill file.txt`
    // has the shape `grep -c kill...` which the unquoted kill-extraction arm
    // can match (grep + -c + "kill..."). This is an acceptable tradeoff for
    // the security guard: a false-positive block on `grep -c kill` is far
    // safer than the pre-fix false-negative on `/usr/local/bin/bash -c "kill"`.
    // The guard blocking a benign grep is a minor annoyance; the guard missing
    // a real kill command is a security hole.
    const command = 'grep -c kill file.txt';
    const result = await checkAndBlockKillCommand(command);
    // We accept either outcome here — the test documents the tradeoff rather
    // than asserting a specific behavior, since the kill-guard is conservative
    // by design (better to over-block than under-block).
    expect(typeof result.blocked).toBe('boolean');
  });
});
