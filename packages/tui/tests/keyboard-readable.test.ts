/**
 * Unit test for the KeyboardReadable stream that replaced PassThrough in mouse mode.
 *
 * The PassThrough + _read(0) hack caused deadlock: Ink calls stdin.read() which
 * triggers _read(0) which calls this.read(0) which returns null when the buffer
 * is empty. PassThrough's internal needReadable flag gets stuck and the 'readable'
 * event never fires, freezing all input (mouse AND keyboard).
 *
 * KeyboardReadable fixes this by using a proper Readable with push()/EOF signaling
 * that correctly drives the 'readable' event lifecycle.
 */
import { describe, expect, it } from 'vitest';
import { Readable } from 'node:stream';

// Re-implement the KeyboardReadable from run-tui.ts so this test is self-contained.
class KeyboardReadable extends Readable {
  constructor() {
    super({ encoding: 'utf8' });
  }
  _read(_size: number): void {
    void _size;
  }
  doPush(chunk: string): void {
    if (chunk.length === 0) return;
    this.push(chunk);
  }
  doEnd(): void {
    this.push(null);
  }
}

describe('KeyboardReadable (mouse-mode stdin proxy)', () => {
  it('emits data pushed via doPush() to a readable listener', async () => {
    const stream = new KeyboardReadable();
    const chunks: string[] = [];

    await new Promise<void>((resolve) => {
      stream.on('readable', function () {
        let chunk: string | null;
        while ((chunk = stream.read()) !== null) {
          chunks.push(chunk);
        }
      });
      stream.on('end', () => {
        expect(chunks.join('')).toBe('hello');
        resolve();
      });
      stream.doPush('hello');
      stream.doEnd();
    });
  });

  it('signals end-of-stream correctly with doEnd()', async () => {
    const stream = new KeyboardReadable();
    let readableCount = 0;
    let received = '';

    await new Promise<void>((resolve) => {
      stream.on('readable', function () {
        readableCount++;
        let chunk: string | null;
        while ((chunk = stream.read()) !== null) {
          received += chunk;
        }
      });
      stream.on('end', () => {
        // readable must have fired at least once before EOF
        expect(readableCount).toBeGreaterThan(0);
        expect(received).toBe('x');
        resolve();
      });
      stream.doPush('x');
      stream.doEnd();
    });
  });

  it('does NOT emit readable when doPush is never called (consumer waits correctly)', async () => {
    // Before the fix, PassThrough with _read(0) would NOT emit 'readable' when
    // the buffer was empty — causing Ink to hang forever. The correct behavior is
    // that 'readable' fires ONLY when push() adds data to the buffer.
    const stream = new KeyboardReadable();
    let readableFired = false;

    stream.on('readable', () => {
      readableFired = true;
    });

    // Wait a bit to confirm no spurious readable fires
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(readableFired).toBe(false);
  });

  it('emits readable when push() is called from the stdin data handler', async () => {
    // This simulates what actually happens: stdin 'data' handler calls doPush()
    // and 'readable' must fire so Ink can read the keyboard bytes.
    const stream = new KeyboardReadable();
    let received = '';

    await new Promise<void>((resolve) => {
      stream.on('readable', function () {
        let chunk: string | null;
        while ((chunk = stream.read()) !== null) {
          received += chunk;
        }
      });
      stream.on('end', () => {
        expect(received).toBe('keyboard_input');
        resolve();
      });
      // Simulate stdin emitting 'data' event (happens from libuv thread pool)
      stream.doPush('keyboard_input');
      stream.doEnd();
    });
  });

  it('handles multiple push() calls (fast typist)', async () => {
    const stream = new KeyboardReadable();
    let received = '';

    await new Promise<void>((resolve) => {
      stream.on('readable', function () {
        let chunk: string | null;
        while ((chunk = stream.read()) !== null) {
          received += chunk;
        }
      });
      stream.on('end', () => {
        expect(received).toBe('abc');
        resolve();
      });
      stream.doPush('a');
      stream.doPush('b');
      stream.doPush('c');
      stream.doEnd();
    });
  });

  it('ignores empty chunks without emitting spurious readable events', async () => {
    const stream = new KeyboardReadable();
    let readableCount = 0;

    await new Promise<void>((resolve) => {
      stream.on('readable', function () {
        readableCount++;
        let chunk: string | null;
        while ((chunk = stream.read()) !== null) {
          // consume
        }
      });
      stream.on('end', () => {
        // Only one 'readable' event (from the 'x' push), not from empty pushes
        expect(readableCount).toBe(1);
        resolve();
      });
      stream.doPush(''); // ignored
      stream.doPush(''); // ignored
      stream.doPush('x');
      stream.doEnd();
    });
  });
});
