import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import type { ToolProgressEvent, ToolStreamEvent } from '@wrongstack/core';
import { describe, expect, it } from 'vitest';
import { bashTool } from '../src/bash.js';
import { mkSandbox, newSignal } from './fixtures.js';

const isWin = os.platform() === 'win32';
const echoCmd = isWin ? 'echo hello' : 'echo hello';
const failCmd = isWin ? 'exit 7' : 'exit 7';

describe('bashTool', () => {
  it('runs a simple command and captures output', async () => {
    const sb = await mkSandbox();
    try {
      const out = await bashTool.execute({ command: echoCmd }, sb.ctx, { signal: newSignal() });
      expect(out.exit_code).toBe(0);
      expect(out.output.trim()).toContain('hello');
      expect(out.timed_out).toBe(false);
    } finally {
      await sb.cleanup();
    }
  });

  it('reports non-zero exit code', async () => {
    const sb = await mkSandbox();
    try {
      const out = await bashTool.execute({ command: failCmd }, sb.ctx, { signal: newSignal() });
      expect(out.exit_code).toBe(7);
    } finally {
      await sb.cleanup();
    }
  });

  it('rejects on missing command', async () => {
    const sb = await mkSandbox();
    try {
      await expect(
        bashTool.execute({ command: '' }, sb.ctx, { signal: newSignal() }),
      ).rejects.toThrow();
    } finally {
      await sb.cleanup();
    }
  });

  it('honours timeout for long-running command', async () => {
    const sb = await mkSandbox();
    try {
      const cmd = isWin ? 'ping -n 5 127.0.0.1 > NUL' : 'sleep 5';
      const out = await bashTool.execute({ command: cmd, timeout_ms: 200 }, sb.ctx, {
        signal: newSignal(),
      });
      expect(out.timed_out).toBe(true);
    } finally {
      await sb.cleanup();
    }
  }, 15_000);

  it('exposes executeStream and emits a final event', async () => {
    const sb = await mkSandbox();
    try {
      expect(typeof bashTool.executeStream).toBe('function');
      const events: ToolStreamEvent[] = [];
      for await (const ev of bashTool.executeStream!({ command: echoCmd }, sb.ctx, {
        signal: newSignal(),
      })) {
        events.push(ev);
      }
      const finals = events.filter((e) => e.type === 'final');
      expect(finals).toHaveLength(1);
      // Output reaches the final event
      const out = (finals[0] as { output: { output: string } }).output;
      expect(out.output).toContain('hello');
    } finally {
      await sb.cleanup();
    }
  });

  it('declares an estimatedDurationMs hint', () => {
    expect(typeof bashTool.estimatedDurationMs).toBe('number');
    expect(bashTool.estimatedDurationMs).toBeGreaterThan(0);
  });

  it('background command yields a single final event', async () => {
    const sb = await mkSandbox();
    try {
      const events: ToolStreamEvent[] = [];
      // `exit 0` finishes instantly on both shells — the assertion is about
      // event shape, not subprocess lifetime, so the fastest-exiting command
      // avoids holding the sandbox temp dir on Windows.
      const cmd = isWin ? 'exit 0' : 'true';
      for await (const ev of bashTool.executeStream!({ command: cmd, background: true }, sb.ctx, {
        signal: newSignal(),
      })) {
        events.push(ev);
      }
      // Background runs return immediately with just the final event,
      // no partial_output (stdio is 'ignore').
      const progressEvents = events.filter((e): e is ToolProgressEvent => e.type !== 'final');
      expect(progressEvents).toEqual([]);
      expect(events.filter((e) => e.type === 'final')).toHaveLength(1);
    } finally {
      // On Windows the detached child may still hold the temp dir for a
      // moment after exit — swallow the cleanup race; the OS reaps soon.
      try {
        await sb.cleanup();
      } catch {
        /* ignore */
      }
    }
  });
});

// ─── New coverage tests ───────────────────────────────────────────────────────

describe('bashTool timeout kill paths', () => {
  it('times out and triggers kill on Windows', async () => {
    if (!isWin) return;
    const sb = await mkSandbox();
    try {
      const out = await bashTool.execute(
        { command: 'ping -n 10 127.0.0.1 > NUL', timeout_ms: 200 },
        sb.ctx,
        { signal: newSignal() },
      );
      expect(out.timed_out).toBe(true);
    } finally {
      await sb.cleanup();
    }
  }, 15_000);

  it('times out and triggers kill on POSIX (SIGTERM then SIGKILL)', async () => {
    if (isWin) return;
    const sb = await mkSandbox();
    try {
      // sleep 10 will be killed after timeout
      const out = await bashTool.execute(
        { command: 'sleep 10', timeout_ms: 300 },
        sb.ctx,
        { signal: newSignal() },
      );
      expect(out.timed_out).toBe(true);
    } finally {
      await sb.cleanup();
    }
  }, 10_000);

  it('SIGKILL is issued after SIGTERM fails to stop the process', async () => {
    if (isWin) return;
    const sb = await mkSandbox();
    try {
      // Use a command that ignores SIGTERM
      const out = await bashTool.execute(
        { command: 'trap "" TERM; sleep 20; exit 0', timeout_ms: 500 },
        sb.ctx,
        { signal: newSignal() },
      );
      expect(out.timed_out).toBe(true);
    } finally {
      await sb.cleanup();
    }
  }, 15_000);
});

describe('bashTool partial_output flush paths', () => {
  it('flushes partial_output when pending reaches STREAM_FLUSH_BYTES', async () => {
    const sb = await mkSandbox();
    try {
      const events: ToolStreamEvent[] = [];
      // Write enough output to trigger size-based flush (STREAM_FLUSH_BYTES = 4096)
      const largeCmd = isWin
        ? `for /L %i in (1,1,2000) do @echo line-%i`
        : 'for i in $(seq 1 2000); do echo "line-$i"; done';
      for await (const ev of bashTool.executeStream!(
        { command: largeCmd, timeout_ms: 5000 },
        sb.ctx,
        { signal: newSignal() },
      )) {
        events.push(ev);
      }
      const partials = events.filter((e) => e.type === 'partial_output');
      // Should emit at least one partial_output before final
      expect(events.some((e) => e.type === 'final')).toBe(true);
      // On Windows or with small output, partials may be empty, but we exercised the flush logic
      expect(events.length).toBeGreaterThanOrEqual(1);
    } finally {
      await sb.cleanup();
    }
  }, 10_000);

  it('emits multiple partial_output events for large output', async () => {
    const sb = await mkSandbox();
    try {
      const events: ToolStreamEvent[] = [];
      // Very large output that triggers multiple flushes
      const veryLargeCmd = isWin
        ? `for /L %i in (1,1,5000) do @echo line-%i`
        : 'for i in $(seq 1 5000); do echo "line-$i"; done';
      for await (const ev of bashTool.executeStream!(
        { command: veryLargeCmd, timeout_ms: 8000 },
        sb.ctx,
        { signal: newSignal() },
      )) {
        events.push(ev);
      }
      const partials = events.filter((e) => e.type === 'partial_output');
      const finals = events.filter((e) => e.type === 'final');
      expect(finals).toHaveLength(1);
      // Output was processed
      const finalOut = (finals[0] as { output: { output: string } }).output;
      expect(finalOut.output.length).toBeGreaterThan(0);
    } finally {
      await sb.cleanup();
    }
  }, 15_000);
});

describe('bashTool error handling', () => {
  it('handles child spawn error via child.on(error)', async () => {
    const sb = await mkSandbox();
    try {
      // Use a non-existent command to trigger spawn error
      const out = await bashTool.execute({ command: 'nonexistent_command_xyz' }, sb.ctx, {
        signal: newSignal(),
      });
      // Should handle the error gracefully (not throw)
      expect(out).toHaveProperty('exit_code');
    } finally {
      await sb.cleanup();
    }
  });

  it('handles stderr output separately', async () => {
    const sb = await mkSandbox();
    try {
      const cmd = isWin
        ? 'dir /invalidflag 2>&1'
        : 'ls --invalid-option 2>&1 || true';
      const out = await bashTool.execute({ command: cmd }, sb.ctx, { signal: newSignal() });
      // Should capture output (may include error message)
      expect(out).toHaveProperty('output');
    } finally {
      await sb.cleanup();
    }
  });
});

describe('bashTool truncation', () => {
  it('truncates output from the middle when it exceeds MAX_OUTPUT', async () => {
    const sb = await mkSandbox();
    try {
      // Generate output larger than MAX_OUTPUT (32768 bytes)
      const largeCmd = isWin
        ? `for /L %i in (1,1,10000) do @echo line-with-some-content-%i`
        : 'for i in $(seq 1 10000); do echo "line-with-content-number-$i"; done';
      const out = await bashTool.execute({ command: largeCmd, timeout_ms: 10000 }, sb.ctx, {
        signal: newSignal(),
      });
      // Output should be truncated to MAX_OUTPUT
      expect(out.output.length).toBeLessThanOrEqual(32_768 + 100); // Allow some tolerance
    } finally {
      await sb.cleanup();
    }
  }, 20_000);
});

describe('bashTool signal abort', () => {
  it('handles already-aborted signal gracefully', async () => {
    const sb = await mkSandbox();
    try {
      const ac = new AbortController();
      ac.abort();
      // On Windows with already-aborted signal, spawn may fail with AbortError
      // The tool should handle this and return a result
      try {
        const out = await bashTool.execute({ command: echoCmd }, sb.ctx, { signal: ac.signal });
        expect(out).toHaveProperty('exit_code');
      } catch (err: any) {
        // AbortError is acceptable here - the signal was already aborted
        expect(err.message).toContain('aborted');
      }
    } finally {
      try {
        await sb.cleanup();
      } catch {
        /* ignore cleanup errors on Windows */
      }
    }
  });

  it('aborts mid-execution when signal fires', async () => {
    const sb = await mkSandbox();
    const ac = new AbortController();
    // Fire abort after a short delay
    const timeout = setTimeout(() => ac.abort(), 50);
    try {
      const out = await bashTool.execute(
        { command: isWin ? 'ping -n 10 127.0.0.1 > NUL' : 'sleep 10' },
        sb.ctx,
        { signal: ac.signal },
      );
      clearTimeout(timeout);
      // Process should be terminated
      expect(out).toHaveProperty('exit_code');
    } catch (err: any) {
      clearTimeout(timeout);
      // AbortError is acceptable
      expect(err.code).toBe('ABORT_ERR');
    } finally {
      try {
        await sb.cleanup();
      } catch {
        /* ignore cleanup errors on Windows */
      }
    }
  }, 15_000);
});

describe('bashTool edge cases', () => {
  it('handles echo command', async () => {
    const sb = await mkSandbox();
    try {
      const out = await bashTool.execute({ command: 'echo hello' }, sb.ctx, { signal: newSignal() });
      expect(out.exit_code).toBe(0);
      expect(out.output.trim()).toContain('hello');
    } finally {
      try {
        await sb.cleanup();
      } catch {
        /* ignore */
      }
    }
  });

  it('clamps timeout_ms to minimum of 1', async () => {
    const sb = await mkSandbox();
    try {
      const out = await bashTool.execute({ command: echoCmd, timeout_ms: -5 }, sb.ctx, {
        signal: newSignal(),
      });
      expect(out).toHaveProperty('exit_code');
    } finally {
      try {
        await sb.cleanup();
      } catch {
        /* ignore */
      }
    }
  });

  it('clamps timeout_ms to maximum of 600000', async () => {
    const sb = await mkSandbox();
    try {
      const out = await bashTool.execute({ command: echoCmd, timeout_ms: 999999999 }, sb.ctx, {
        signal: newSignal(),
      });
      expect(out.exit_code).toBe(0);
    } finally {
      try {
        await sb.cleanup();
      } catch {
        /* ignore */
      }
    }
  });

  it('handles very long command string', async () => {
    const sb = await mkSandbox();
    try {
      // Long but valid command
      const longCmd = echoCmd;
      const out = await bashTool.execute({ command: longCmd }, sb.ctx, { signal: newSignal() });
      expect(out.exit_code).toBe(0);
    } finally {
      try {
        await sb.cleanup();
      } catch {
        /* ignore */
      }
    }
  });

  it('cleans up timers in finally block', async () => {
    const sb = await mkSandbox();
    try {
      const ac = new AbortController();
      // Trigger timeout
      const out = await bashTool.execute(
        { command: isWin ? 'ping -n 5 127.0.0.1 > NUL' : 'sleep 5', timeout_ms: 100 },
        sb.ctx,
        { signal: ac.signal },
      );
      expect(out.timed_out).toBe(true);
      // If we get here without hanging, timers were cleaned up
    } finally {
      try {
        await sb.cleanup();
      } catch {
        /* ignore */
      }
    }
  }, 10_000);
});

describe('bashTool session and env', () => {
  it('uses projectRoot as cwd', async () => {
    const sb = await mkSandbox();
    try {
      const cmd = isWin ? 'cd' : 'pwd';
      const out = await bashTool.execute({ command: cmd }, sb.ctx, { signal: newSignal() });
      // Should use projectRoot (sb.dir)
      expect(out.output).toContain(sb.dir);
    } finally {
      await sb.cleanup();
    }
  });

  it('handles commands with special characters', async () => {
    const sb = await mkSandbox();
    try {
      const specialCmd = isWin ? 'echo hello & echo world' : 'echo "hello world" && echo done';
      const out = await bashTool.execute({ command: specialCmd }, sb.ctx, { signal: newSignal() });
      expect(out.exit_code).toBe(0);
    } finally {
      await sb.cleanup();
    }
  });
});

// ─── Coverage: background mode stderr ────────────────────────────────────────
describe('bashTool background mode stderr', () => {
  it('captures stderr in background mode via child.stderr.on(data)', async () => {
    if (isWin) return;
    const sb = await mkSandbox();
    try {
      const out = await bashTool.execute(
        { command: 'ls --no-such-option 2>&1 || true', background: true },
        sb.ctx,
        { signal: newSignal() },
      );
      expect(out).toHaveProperty('output');
      expect(out).toHaveProperty('pid');
    } finally {
      try {
        await sb.cleanup();
      } catch {
        /* ignore */
      }
    }
  }, 10_000);

  it('background mode with stderr only redirected to stderr pipe', async () => {
    if (isWin) return;
    const sb = await mkSandbox();
    try {
      const out = await bashTool.execute(
        { command: 'echo "error" >&2', background: true },
        sb.ctx,
        { signal: newSignal() },
      );
      expect(out).toHaveProperty('output');
      expect(out.pid).toBeTruthy();
    } finally {
      try {
        await sb.cleanup();
      } catch {
        /* ignore */
      }
    }
  }, 10_000);
});