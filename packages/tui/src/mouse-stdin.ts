import { Readable } from 'node:stream';
import { type MouseEvent, parseSgrMouse, stripSgrMouse } from './mouse.js';

/**
 * Mouse-mode stdin interception, factored out of run-tui so it can be unit
 * tested end to end (feed bytes → assert mouse fan-out + keyboard forwarding).
 *
 * With mouse mode on we consume the real TTY here: every chunk is scanned for
 * SGR mouse sequences (decoded + fanned out to subscribers) and the REMAINING
 * keyboard bytes are forwarded to a push-driven Readable that Ink reads instead
 * of process.stdin. That keeps mouse bytes from ever reaching Ink's keypress
 * parser (which would otherwise inject `<0;..M` junk into the input).
 */

/**
 * Push-driven keyboard-only stream.
 *
 * PassThrough was tried first but its `_read(0)` override destabilises the
 * internal `needReadable` state machine — `_read(0)` calls `this.read(0)` which
 * returns null on an empty buffer, so PassThrough never emits the 'readable'
 * event Ink waits on (deadlock: mouse AND keyboard freeze). A minimal custom
 * Readable avoids this: `_read()` never blocks, and `push()` from the stdin
 * data handler is what signals availability.
 *
 * `_read()` is intentionally a no-op: this stream is push-driven, so there is
 * nothing to pull on demand. `push()` already buffers internally past the high-
 * water mark (its `false` return is advisory backpressure, not a hard cap), and
 * keyboard input volume is tiny, so we never risk an unbounded buffer. This is
 * deliberately the simplest correct shape — an earlier version queued chunks on
 * backpressure and dropped the oldest at 100, which could reorder or silently
 * DROP keystrokes; plain push() can do neither.
 */
class KeyboardReadable extends Readable {
  constructor() {
    super({ encoding: 'utf8' });
  }

  override _read(_size: number): void {
    void _size;
  }

  /** Called by the stdin data handler when keyboard bytes are available. */
  doPush(chunk: string): void {
    if (chunk.length === 0) return;
    this.push(chunk);
  }

  /** Called on shutdown so the stream closes cleanly. */
  doEnd(): void {
    this.push(null); // null = EOF
  }
}

export interface MouseStdinProxy {
  /** Stream to hand to Ink in place of process.stdin (keyboard bytes only). */
  inkStdin: NodeJS.ReadStream;
  /** Subscribe to decoded mouse events; returns an unsubscribe fn. */
  subscribeMouse: (fn: (ev: MouseEvent) => void) => () => void;
  /** Detach the stdin listener and close the keyboard stream. */
  detach: () => void;
}

export interface MouseStdinProxyOptions {
  /**
   * Invoked AFTER the real stdin's raw mode is toggled, with the new value.
   * run-tui uses this to layer Windows VT input on after Ink enables raw mode
   * (which would otherwise clear it) so mouse bytes are actually delivered.
   */
  onRawMode?: (enabled: boolean) => void;
}

/**
 * Wrap `stdin` so SGR mouse sequences are split off and fanned out to
 * subscribers while keyboard bytes flow to a stream Ink can read. `isTTY`,
 * `setRawMode`, `ref`, `unref` are delegated to the real terminal so Ink's
 * raw-mode / ref bookkeeping behaves exactly as if it owned process.stdin.
 */
export function createMouseStdinProxy(
  stdin: NodeJS.ReadStream,
  opts: MouseStdinProxyOptions = {},
): MouseStdinProxy {
  const mouseListeners = new Set<(ev: MouseEvent) => void>();
  const keyboardStream = new KeyboardReadable();
  const p = keyboardStream as unknown as NodeJS.ReadStream;
  // Ink probes isTTY and drives raw mode / ref bookkeeping on its stdin;
  // delegate those to the real terminal so its behavior is unchanged.
  p.isTTY = true;
  p.setRawMode = (mode: boolean): NodeJS.ReadStream => {
    try {
      stdin.setRawMode?.(mode);
    } catch {
      // real stdin may not support raw mode in some shells — ignore.
    }
    // Fire AFTER the real toggle so listeners (e.g. the Windows VT-input
    // enabler) layer on top of libuv's raw mode rather than being clobbered.
    try {
      opts.onRawMode?.(mode);
    } catch {
      // a hook throwing must not break input routing — ignore.
    }
    return p;
  };
  const realRef = stdin.ref?.bind(stdin);
  const realUnref = stdin.unref?.bind(stdin);
  p.ref = (): NodeJS.ReadStream => {
    realRef?.();
    return p;
  };
  p.unref = (): NodeJS.ReadStream => {
    realUnref?.();
    return p;
  };
  stdin.setEncoding('utf8');
  const onData = (chunk: string) => {
    for (const ev of parseSgrMouse(chunk)) {
      for (const fn of mouseListeners) {
        try {
          fn(ev);
        } catch {
          // a listener throwing must not break input routing — ignore.
        }
      }
    }
    keyboardStream.doPush(stripSgrMouse(chunk));
  };
  stdin.on('data', onData);

  return {
    inkStdin: p,
    subscribeMouse: (fn) => {
      mouseListeners.add(fn);
      return () => {
        mouseListeners.delete(fn);
      };
    },
    detach: () => {
      stdin.off('data', onData);
      keyboardStream.doEnd();
    },
  };
}
