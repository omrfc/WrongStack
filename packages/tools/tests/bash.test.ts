import * as os from 'node:os';
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
