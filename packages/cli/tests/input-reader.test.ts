/**
 * Tests for the keyboard-prompt path in `ReadlineInputReader.readKey`.
 *
 * readKey talks to process.stdin directly (raw mode + 'data' events)
 * rather than going through `readline.createInterface`, so the test
 * can stand in for stdin with a fake NodeJS.ReadStream and assert on
 * the resolved value.
 *
 * readLine (which uses readline.createInterface) and readSecret
 * (which uses raw mode + bullet masking) are not exercised here yet —
 * both depend on Node internal stream state that's awkward to mock
 * without pulling in a full `stream.passThrough` harness. The seams
 * for them are tagged for follow-up coverage.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { ReadlineInputReader } from '../src/input-reader.js';

/** Minimal fake of NodeJS.ReadStream — just enough for setRawMode + .on/.off. */
function makeFakeStdin(): NodeJS.ReadStream {
  const ee = new EventEmitter();
  const stdin = Object.assign(ee, {
    isTTY: true,
    isRaw: false,
    isPaused: () => false,
    pause: () => undefined,
    resume: () => undefined,
    setEncoding: () => undefined,
    setRawMode: vi.fn((mode: boolean) => {
      (stdin as unknown as { isRaw: boolean }).isRaw = mode;
    }),
  }) as unknown as NodeJS.ReadStream;
  return stdin;
}

describe('ReadlineInputReader.readKey', () => {
  let originalStdin: NodeJS.ReadStream;
  let originalIsTTY: boolean | undefined;

  beforeEach(() => {
    originalStdin = process.stdin;
    originalIsTTY = process.stdin.isTTY;
    Object.defineProperty(process, 'stdin', {
      value: makeFakeStdin(),
      configurable: true,
      writable: true,
    });
  });

  afterEach(() => {
    Object.defineProperty(process, 'stdin', {
      value: originalStdin,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(process.stdin, 'isTTY', {
      value: originalIsTTY,
      configurable: true,
    });
  });

  it('resolves with the option value when a matching key is pressed', async () => {
    const reader = new ReadlineInputReader();
    const promise = reader.readKey('> ', [
      { key: 'y', label: 'yes', value: 'resume' },
      { key: 'n', label: 'no', value: 'skip' },
    ]);
    // Fire `data` event asynchronously so the .on('data', ...) listener
    // is registered before the event arrives.
    setImmediate(() => {
      (process.stdin as unknown as EventEmitter).emit('data', Buffer.from('y'));
    });
    await expect(promise).resolves.toBe('resume');
  });

  it('matches case-insensitively (Y resolves to "yes" the same as y)', async () => {
    const reader = new ReadlineInputReader();
    const promise = reader.readKey('> ', [
      { key: 'y', label: 'yes', value: 'resume' },
    ]);
    setImmediate(() => {
      (process.stdin as unknown as EventEmitter).emit('data', Buffer.from('Y'));
    });
    await expect(promise).resolves.toBe('resume');
  });

  it('resolves to empty string on Ctrl+C and restores raw mode', async () => {
    const reader = new ReadlineInputReader();
    const promise = reader.readKey('> ', [
      { key: 'y', label: 'yes', value: 'resume' },
    ]);
    setImmediate(() => {
      (process.stdin as unknown as EventEmitter).emit('data', Buffer.from('\x03'));
    });
    await expect(promise).resolves.toBe('');
  });

  it('ignores non-matching keys until a match arrives', async () => {
    const reader = new ReadlineInputReader();
    const promise = reader.readKey('> ', [
      { key: 'y', label: 'yes', value: 'resume' },
    ]);
    // Schedule a wrong key first, then a right one. readKey must
    // keep listening and not resolve early.
    setImmediate(() => {
      const stdin = process.stdin as unknown as EventEmitter;
      stdin.emit('data', Buffer.from('q'));
      stdin.emit('data', Buffer.from('n'));
      stdin.emit('data', Buffer.from('y'));
    });
    await expect(promise).resolves.toBe('resume');
  });
});
