/**
 * Tests for TerminalServer.
 *
 * Uses `node` (resolved by spawn via $PATH) as the spawned command.
 * `node` is on every CI runner, and resolving by name sidesteps a
 * known Windows issue where some EDR / Defender policies block spawn
 * of binaries under `C:\Program Files\` even when the path is valid
 * and the process exists.
 *
 * The projectRoot directory is created in beforeEach because spawn
 * on Windows fails with ENOENT when the cwd doesn't exist (Linux is
 * more permissive).
 */
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { TerminalServer } from '../src/client/terminal-server.js';

let projectRoot: string;
let server: TerminalServer;

beforeEach(async () => {
  projectRoot = path.resolve(os.tmpdir(), 'wstack-term-' + Math.random().toString(36).slice(2));
  await fsp.mkdir(projectRoot, { recursive: true });
  server = new TerminalServer({ projectRoot, commandTimeoutMs: 10_000 });
});

afterEach(async () => {
  server.releaseAll();
  // Best-effort retry: on Windows the rmdir occasionally fails with
  // EBUSY when a child process still has the dir open for a moment.
  for (let i = 0; i < 3; i++) {
    try {
      await fsp.rm(projectRoot, { recursive: true, force: true });
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code !== 'EBUSY' && code !== 'ENOTEMPTY') throw err;
      await new Promise((r) => setTimeout(r, 50));
    }
  }
});

describe('TerminalServer', () => {
  it('runs a command, captures output, returns exit code', async () => {
    const { terminalId } = server.create({
      sessionId: 's1',
      command: 'node',
      args: ['-e', "console.log('hello'); console.error('world')"],
    });
    expect(terminalId).toMatch(/^term_/);
    const exit = await server.waitForExit(terminalId);
    expect(exit.exitCode).toBe(0);
    const out = server.output(terminalId);
    expect(out.output).toContain('hello');
    expect(out.output).toContain('world');
  });

  it('returns a non-zero exit code for a failing command', async () => {
    const { terminalId } = server.create({
      sessionId: 's1',
      command: 'node',
      args: ['-e', 'process.exit(7)'],
    });
    const exit = await server.waitForExit(terminalId);
    expect(exit.exitCode).toBe(7);
  });

  it('caps retained output to outputByteLimit', async () => {
    // Override the per-call byte limit to 256 bytes.
    const { terminalId } = server.create({
      sessionId: 's1',
      command: 'node',
      args: [
        '-e',
        // Emit 1024 bytes of 'A' so the buffer must truncate.
        "process.stdout.write('A'.repeat(1024))",
      ],
      outputByteLimit: 256,
    });
    await server.waitForExit(terminalId);
    const out = server.output(terminalId);
    // The truncation is FIFO — we keep the LAST 256 bytes (all 'A's
    // here, so the retained slice is just the tail).
    expect(out.output.length).toBeLessThanOrEqual(256);
    expect(out.truncated).toBe(true);
  });

  it('kill() terminates a long-running command', async () => {
    const { terminalId } = server.create({
      sessionId: 's1',
      command: 'node',
      args: ['-e', 'setInterval(() => {}, 1000)'],
    });
    // Give the process a moment to start
    await new Promise((r) => setTimeout(r, 100));
    server.kill(terminalId);
    const exit = await server.waitForExit(terminalId);
    // exitCode is null when killed by signal, signal is 'SIGTERM' on POSIX,
    // may be different on Windows. Just assert: not still running.
    expect(exit.exitCode === 0 || exit.exitCode === null || exit.signal !== null).toBe(true);
  });

  it('release() removes the terminal from the active set', async () => {
    const { terminalId } = server.create({
      sessionId: 's1',
      command: 'node',
      args: ['-e', 'process.exit(0)'],
    });
    await server.waitForExit(terminalId);
    server.release(terminalId);
    // After release, output() should throw
    expect(() => server.output(terminalId)).toThrow(/unknown terminal/);
  });

  it('spawn error (ENOENT) yields exitCode 127', async () => {
    const { terminalId } = server.create({
      sessionId: 's1',
      command: 'definitely-not-a-real-binary-xyz',
      args: [],
    });
    const exit = await server.waitForExit(terminalId);
    expect(exit.exitCode).toBe(127);
  });

  it('output() throws for an unknown terminal', () => {
    expect(() => server.output('term_does_not_exist')).toThrow();
  });
});
