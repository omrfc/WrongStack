import { describe, expect, it, vi } from 'vitest';
import { runTui } from '../src/run-tui.js';

describe('runTui non-TTY guard', () => {
  it('returns exit code 2 with a clear stderr message when stdin is not a TTY', async () => {
    // Vitest's stdout/stdin in test runs is normally non-TTY already. Force
    // both flags off to remove ambiguity, then restore.
    const origIn = process.stdin.isTTY;
    const origOut = process.stdout.isTTY;
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true });
    const stderrWrites: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderrWrites.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      return true;
    }) as typeof process.stderr.write;

    try {
      const code = await runTui({
        // None of these are touched on the non-TTY path.
        agent: {} as never,
        slashRegistry: {} as never,
        attachments: {} as never,
        events: {} as never,
        model: 'm',
      });
      expect(code).toBe(2);
      expect(stderrWrites.join('')).toMatch(/--tui requires an interactive terminal/);
    } finally {
      process.stderr.write = origWrite;
      Object.defineProperty(process.stdin, 'isTTY', { value: origIn, configurable: true });
      Object.defineProperty(process.stdout, 'isTTY', { value: origOut, configurable: true });
    }
  });
});
