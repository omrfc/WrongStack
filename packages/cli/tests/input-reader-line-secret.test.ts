/**
 * Coverage for the two `ReadlineInputReader` methods the readKey test left as
 * follow-up (see input-reader.test.ts header):
 *
 *  - `readLine` goes through `readline.createInterface`. We mock `node:readline`
 *    so the test owns the interface and can drive `question`'s callback / the
 *    `close` (Ctrl+C → cancel) path without a real TTY.
 *  - `readSecret` toggles raw mode and masks each byte with a bullet routed
 *    through `writeOut` → `process.stdout.write`. We stand in for stdin with a
 *    fake TTY stream and spy on `process.stdout.write` to assert the masking
 *    and the post-Enter raw-mode restore.
 *
 * Every reader is constructed with a throwaway temp `historyFile` so the tests
 * never read or clobber the developer's real `~/.wrongstack/history`.
 */
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── node:readline mock ───────────────────────────────────────────────────────
// createInterface returns a controllable fake interface; the most recent one is
// exposed via `currentIface()` so a test can fire its question callback / close.
const { createInterfaceMock, currentIface, resetReadline } = vi.hoisted(() => {
  const state: { iface?: FakeInterface } = {};
  type FakeInterface = EventEmitter & {
    question: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
    __cb?: (line: string) => void;
    closed?: boolean;
  };
  const createInterfaceMock = vi.fn(() => {
    const iface = new EventEmitter() as FakeInterface;
    iface.question = vi.fn((_prompt: string, cb: (line: string) => void) => {
      iface.__cb = cb;
    });
    iface.close = vi.fn(() => {
      iface.closed = true;
    });
    state.iface = iface;
    return iface;
  });
  // `state.iface` is module-level and leaks across tests; reset it (and the
  // call history) per-test so `currentIface()` only ever returns the interface
  // created during the current test, never the previous one.
  const resetReadline = () => {
    createInterfaceMock.mockClear();
    delete state.iface;
  };
  return { createInterfaceMock, currentIface: () => state.iface, resetReadline };
});

vi.mock('node:readline', () => ({ createInterface: createInterfaceMock }));

import { ReadlineInputReader } from '../src/input-reader.js';

async function tempHistoryFile(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-ir-'));
  return path.join(dir, 'history');
}

/**
 * Wait until the reader (which suspends on `await loadHistory()` before
 * touching readline) has created its interface for THIS call, then return it.
 * `createInterfaceMock` is reset per-test so this never races onto a stale one.
 */
async function activeInterface() {
  await vi.waitFor(() => expect(createInterfaceMock).toHaveBeenCalled());
  return currentIface()!;
}

describe('ReadlineInputReader.readLine', () => {
  beforeEach(() => {
    resetReadline();
  });

  it('resolves with the entered line and uses the supplied prompt', async () => {
    const reader = new ReadlineInputReader({ historyFile: await tempHistoryFile() });
    const promise = reader.readLine('prompt> ');
    const iface = await activeInterface();
    expect(iface.question).toHaveBeenCalledWith('prompt> ', expect.any(Function));
    iface.__cb!('hello world');
    await expect(promise).resolves.toBe('hello world');
  });

  it('defaults the prompt to "> " when none is given', async () => {
    const reader = new ReadlineInputReader({ historyFile: await tempHistoryFile() });
    const promise = reader.readLine();
    const iface = await activeInterface();
    expect(iface.question).toHaveBeenCalledWith('> ', expect.any(Function));
    iface.__cb!('');
    await expect(promise).resolves.toBe('');
  });

  it('resolves with empty string when the interface closes (Ctrl+C / EOF)', async () => {
    const reader = new ReadlineInputReader({ historyFile: await tempHistoryFile() });
    const promise = reader.readLine('> ');
    const iface = await activeInterface();
    iface.emit('close');
    await expect(promise).resolves.toBe('');
  });

  it('persists a non-empty line to the history file', async () => {
    const historyFile = await tempHistoryFile();
    const reader = new ReadlineInputReader({ historyFile });
    const promise = reader.readLine('> ');
    const iface = await activeInterface();
    iface.__cb!('remembered');
    await promise;
    await vi.waitFor(async () => {
      const raw = await fs.readFile(historyFile, 'utf8');
      expect(raw).toContain('remembered');
    });
  });
});

// ── readSecret ───────────────────────────────────────────────────────────────
type FakeStdin = NodeJS.ReadStream & {
  setRawMode: ReturnType<typeof vi.fn>;
  pause: ReturnType<typeof vi.fn>;
  resume: ReturnType<typeof vi.fn>;
  setEncoding: ReturnType<typeof vi.fn>;
};

function makeFakeStdin(isTTY: boolean): FakeStdin {
  const ee = new EventEmitter();
  const stdin = Object.assign(ee, {
    isTTY,
    isRaw: false,
    isPaused: () => false,
    pause: vi.fn(),
    resume: vi.fn(),
    setEncoding: vi.fn(),
    setRawMode: vi.fn((mode: boolean) => {
      (stdin as never as { isRaw: boolean }).isRaw = mode;
    }),
  }) as never as FakeStdin;
  return stdin;
}

describe('ReadlineInputReader.readSecret', () => {
  let originalStdin: NodeJS.ReadStream;
  let writeSpy: ReturnType<typeof vi.spyOn>;
  let writes: string[];

  function installStdin(stdin: NodeJS.ReadStream): void {
    Object.defineProperty(process, 'stdin', { value: stdin, configurable: true, writable: true });
  }

  beforeEach(() => {
    resetReadline();
    originalStdin = process.stdin;
    writes = [];
    writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      writes.push(typeof chunk === 'string' ? chunk : String(chunk));
      return true;
    });
  });

  afterEach(() => {
    writeSpy.mockRestore();
    Object.defineProperty(process, 'stdin', {
      value: originalStdin,
      configurable: true,
      writable: true,
    });
  });

  const bulletCount = () => writes.filter((w) => w === '•').length;

  it('masks each typed character with a bullet and resolves with the raw string', async () => {
    const stdin = makeFakeStdin(true);
    installStdin(stdin);
    const reader = new ReadlineInputReader({ historyFile: await tempHistoryFile() });
    const promise = reader.readSecret('pw> ');
    stdin.emit('data', 'abc');
    expect(bulletCount()).toBe(3);
    stdin.emit('data', '\r');
    await expect(promise).resolves.toBe('abc');
  });

  it('erases the last character on backspace (DEL)', async () => {
    const stdin = makeFakeStdin(true);
    installStdin(stdin);
    const reader = new ReadlineInputReader({ historyFile: await tempHistoryFile() });
    const promise = reader.readSecret('pw> ');
    stdin.emit('data', 'ab');
    stdin.emit('data', '\x7f'); // DEL → erase one
    expect(writes).toContain('\b \b'); // erase sequence emitted
    stdin.emit('data', '\r');
    await expect(promise).resolves.toBe('a');
  });

  it('clears the whole line on Ctrl+U', async () => {
    const stdin = makeFakeStdin(true);
    installStdin(stdin);
    const reader = new ReadlineInputReader({ historyFile: await tempHistoryFile() });
    const promise = reader.readSecret('pw> ');
    stdin.emit('data', 'secret');
    stdin.emit('data', '\x15'); // Ctrl+U → clear
    stdin.emit('data', 'x');
    stdin.emit('data', '\r');
    await expect(promise).resolves.toBe('x');
  });

  it('restores the previous raw mode and pauses stdin after Enter', async () => {
    const stdin = makeFakeStdin(true);
    installStdin(stdin);
    const reader = new ReadlineInputReader({ historyFile: await tempHistoryFile() });
    const promise = reader.readSecret('pw> ');
    stdin.emit('data', 'pw');
    stdin.emit('data', '\r');
    await promise;
    // Toggled on (true) then restored to the snapshotted previous mode (false).
    expect(stdin.setRawMode).toHaveBeenNthCalledWith(1, true);
    expect(stdin.setRawMode).toHaveBeenLastCalledWith(false);
    expect(stdin.pause).toHaveBeenCalled();
  });

  it('falls back to readLine for non-TTY stdin (no masking)', async () => {
    const stdin = makeFakeStdin(false);
    installStdin(stdin);
    const reader = new ReadlineInputReader({ historyFile: await tempHistoryFile() });
    const promise = reader.readSecret('pw> ');
    const iface = await activeInterface();
    iface.__cb!('piped-secret');
    await expect(promise).resolves.toBe('piped-secret');
    expect(bulletCount()).toBe(0);
  });
});
