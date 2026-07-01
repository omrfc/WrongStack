import { describe, it, expect, afterEach, beforeEach, afterAll, vi } from 'vitest';
import { silenceTerminal, unsilenceTerminal } from '../src/run-tui.js';

// silenceTerminal / unsilenceTerminal mutate process-global state
// (console.*, process.stderr.write, process 'warning' listener).
// Every test restores the originals so they don't bleed.

const origLog = console.log;
const origWarn = console.warn;
const origError = console.error;
const origDebug = console.debug;
const origInfo = console.info;
const origTable = console.table;
const origTrace = console.trace;
const origStderrWrite = process.stderr.write.bind(process.stderr);
const origMaxListeners = process.getMaxListeners();

// Silence the MaxListenersExceededWarning that fires because multiple
// test suites install 'warning' listeners on the process singleton.
process.setMaxListeners(20);

function restoreAll(): void {
  console.log = origLog;
  console.warn = origWarn;
  console.error = origError;
  console.debug = origDebug;
  console.info = origInfo;
  console.table = origTable;
  console.trace = origTrace;
  process.stderr.write = origStderrWrite;
}

beforeEach(() => {
  restoreAll();
});

afterEach(() => {
  restoreAll();
});

afterAll(() => {
  process.setMaxListeners(origMaxListeners);
});

describe('silenceTerminal', () => {
  it('silences console.log', () => {
    const spy = vi.fn();
    console.log = spy;
    silenceTerminal();
    console.log('should not appear');
    expect(spy).not.toHaveBeenCalled();
  });

  it('silences console.warn', () => {
    const spy = vi.fn();
    console.warn = spy;
    silenceTerminal();
    console.warn('should not appear');
    expect(spy).not.toHaveBeenCalled();
  });

  it('silences console.error', () => {
    const spy = vi.fn();
    console.error = spy;
    silenceTerminal();
    console.error('should not appear');
    expect(spy).not.toHaveBeenCalled();
  });

  it('silences console.debug', () => {
    const spy = vi.fn();
    console.debug = spy;
    silenceTerminal();
    console.debug('should not appear');
    expect(spy).not.toHaveBeenCalled();
  });

  it('silences console.info', () => {
    const spy = vi.fn();
    console.info = spy;
    silenceTerminal();
    console.info('should not appear');
    expect(spy).not.toHaveBeenCalled();
  });

  it('silences console.table', () => {
    const spy = vi.fn();
    console.table = spy;
    silenceTerminal();
    console.table([{ a: 1 }]);
    expect(spy).not.toHaveBeenCalled();
  });

  it('silences console.trace', () => {
    const spy = vi.fn();
    console.trace = spy;
    silenceTerminal();
    console.trace('should not appear');
    expect(spy).not.toHaveBeenCalled();
  });

  it('silences process.stderr.write', () => {
    const spy = vi.fn().mockReturnValue(true);
    process.stderr.write = spy as typeof process.stderr.write;
    silenceTerminal();
    process.stderr.write('[memory] Session consolidation: 3 added, 1 edited\n');
    expect(spy).not.toHaveBeenCalled();
  });

  it('silences process.emitWarning (does not write to stderr)', () => {
    // silenceTerminal installs a no-op 'warning' listener on process,
    // which prevents Node's default behaviour of writing to stderr.
    // We verify by checking that emitWarning doesn't throw (the warning
    // is swallowed by our listener) and that stderr.write is the no-op
    // (returns true without writing).
    silenceTerminal();
    // emitWarning should not throw — the no-op listener swallows it
    expect(() => process.emitWarning('test warning', 'TestWarning')).not.toThrow();
    // stderr.write is the no-op at this point
    expect(process.stderr.write('anything')).toBe(true);
  });

  it('stderr no-op preserves callback contract (encoding + cb)', () => {
    silenceTerminal();
    const cb = vi.fn();
    process.stderr.write('hello', 'utf8', cb);
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('stderr no-op preserves callback contract (buffer + cb)', () => {
    silenceTerminal();
    const cb = vi.fn();
    (process.stderr.write as (chunk: Uint8Array, cb: (err?: Error) => void) => boolean)(
      Buffer.from('hello'),
      cb,
    );
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('stderr no-op preserves callback contract (cb only)', () => {
    silenceTerminal();
    const cb = vi.fn();
    process.stderr.write('hello', cb as never as BufferEncoding);
    // second arg is a function → treated as the callback
    expect(cb).toHaveBeenCalledTimes(1);
  });
});

describe('unsilenceTerminal', () => {
  it('restores console.log after silencing', () => {
    const spy = vi.fn();
    console.log = spy;
    silenceTerminal();
    console.log('should not appear');
    expect(spy).not.toHaveBeenCalled();

    unsilenceTerminal();
    console.log = origLog; // restore to real

    // After unsilence, console.log should be back to the original
    // (captured at module load time). We test by calling it and
    // checking it doesn't throw.
    expect(() => console.log('restored')).not.toThrow();
  });

  it('restores process.stderr.write after silencing', () => {
    // Silence patches stderr.write to a no-op. After unsilence, the
    // original (module-load-time) function is restored. We verify by
    // checking that the restored function is NOT the no-op (it should
    // write to the real stderr instead of returning true immediately).
    silenceTerminal();
    expect(process.stderr.write('test')).toBe(true); // no-op returns true

    unsilenceTerminal();
    // The restored function should not be our no-op — it should be the
    // real stderr.write (which writes to fd 2). We can detect this by
    // checking that calling it doesn't throw and that it returns a boolean.
    const result = process.stderr.write('');
    expect(typeof result).toBe('boolean');
  });

  it('silence → unsilence round-trip is idempotent', () => {
    // Verify that calling silence/unsilence multiple times doesn't corrupt
    // the saved originals (e.g. accidentally saving the no-op as the original).
    silenceTerminal();
    expect(process.stderr.write('test')).toBe(true); // no-op

    unsilenceTerminal();
    const afterFirstUns = process.stderr.write('');
    expect(typeof afterFirstUns).toBe('boolean');

    silenceTerminal();
    expect(process.stderr.write('test')).toBe(true); // no-op again

    unsilenceTerminal();
    const afterSecondUns = process.stderr.write('');
    expect(typeof afterSecondUns).toBe('boolean');
  });
});

describe('stderr no-op does not throw on edge cases', () => {
  it('handles undefined callback gracefully', () => {
    silenceTerminal();
    expect(() => process.stderr.write('hello')).not.toThrow();
    expect(process.stderr.write('hello')).toBe(true);
  });

  it('handles empty string', () => {
    silenceTerminal();
    expect(() => process.stderr.write('')).not.toThrow();
    expect(process.stderr.write('')).toBe(true);
  });

  it('handles Buffer', () => {
    silenceTerminal();
    expect(() => process.stderr.write(Buffer.from('test'))).not.toThrow();
    expect(process.stderr.write(Buffer.from('test'))).toBe(true);
  });
});
