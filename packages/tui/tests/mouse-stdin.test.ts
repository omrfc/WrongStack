import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { createMouseStdinProxy } from '../src/mouse-stdin.js';
import type { MouseEvent } from '../src/mouse.js';

const ESC = '\x1b';

/** Minimal TTY-ish stdin: an EventEmitter with the methods the proxy delegates to. */
function fakeStdin() {
  const ee = new EventEmitter() as unknown as NodeJS.ReadStream & {
    setRawMode: ReturnType<typeof vi.fn>;
    setEncoding: ReturnType<typeof vi.fn>;
    ref: ReturnType<typeof vi.fn>;
    unref: ReturnType<typeof vi.fn>;
  };
  ee.isTTY = true;
  ee.setRawMode = vi.fn(() => ee);
  ee.setEncoding = vi.fn(() => ee);
  ee.ref = vi.fn(() => ee);
  ee.unref = vi.fn(() => ee);
  return ee;
}

describe('createMouseStdinProxy', () => {
  it('fans out decoded mouse events and strips them from the keyboard stream', async () => {
    const stdin = fakeStdin();
    const proxy = createMouseStdinProxy(stdin);
    const events: MouseEvent[] = [];
    proxy.subscribeMouse((ev) => events.push(ev));

    const kbChunks: string[] = [];
    proxy.inkStdin.on('data', (c) => kbChunks.push(String(c)));

    // A chunk with keyboard bytes wrapping a left-click mouse sequence.
    stdin.emit('data', `ab${ESC}[<0;12;5Mcd`);
    await new Promise((r) => setTimeout(r, 10));

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'press', button: 'left', x: 12, y: 5 });
    // Ink only ever sees the keyboard bytes, never the mouse sequence.
    expect(kbChunks.join('')).toBe('abcd');
  });

  it('forwards pure-keyboard chunks unchanged and emits no mouse events', async () => {
    const stdin = fakeStdin();
    const proxy = createMouseStdinProxy(stdin);
    const events: MouseEvent[] = [];
    proxy.subscribeMouse((ev) => events.push(ev));
    const kbChunks: string[] = [];
    proxy.inkStdin.on('data', (c) => kbChunks.push(String(c)));

    stdin.emit('data', 'hello');
    stdin.emit('data', ' world');
    await new Promise((r) => setTimeout(r, 10));

    expect(events).toHaveLength(0);
    expect(kbChunks.join('')).toBe('hello world');
  });

  it('preserves keyboard byte ORDER across many rapid chunks (no reorder/drop)', async () => {
    const stdin = fakeStdin();
    const proxy = createMouseStdinProxy(stdin);
    const kbChunks: string[] = [];
    proxy.inkStdin.on('data', (c) => kbChunks.push(String(c)));

    let expected = '';
    for (let i = 0; i < 500; i++) {
      const ch = String.fromCharCode(97 + (i % 26));
      expected += ch;
      stdin.emit('data', ch);
    }
    await new Promise((r) => setTimeout(r, 20));
    expect(kbChunks.join('')).toBe(expected);
  });

  it('decodes a fast wheel spin (multiple sequences in one chunk) in order', async () => {
    const stdin = fakeStdin();
    const proxy = createMouseStdinProxy(stdin);
    const events: MouseEvent[] = [];
    proxy.subscribeMouse((ev) => events.push(ev));

    stdin.emit('data', `${ESC}[<64;1;1M${ESC}[<64;1;1M${ESC}[<65;1;1M`);
    await new Promise((r) => setTimeout(r, 10));

    expect(events.map((e) => e.button)).toEqual(['wheelUp', 'wheelUp', 'wheelDown']);
  });

  it('fires onRawMode AFTER delegating to the real stdin (for the Windows VT-input fix)', () => {
    const stdin = fakeStdin();
    const calls: Array<{ rawSet: unknown; enabled: boolean }> = [];
    const proxy = createMouseStdinProxy(stdin, {
      onRawMode: (enabled) => {
        // setRawMode must already have been called by the time the hook fires.
        calls.push({ rawSet: stdin.setRawMode.mock.calls.at(-1)?.[0], enabled });
      },
    });
    proxy.inkStdin.setRawMode(true);
    proxy.inkStdin.setRawMode(false);
    expect(calls).toEqual([
      { rawSet: true, enabled: true },
      { rawSet: false, enabled: false },
    ]);
  });

  it('delegates isTTY / setRawMode / ref / unref to the real stdin', () => {
    const stdin = fakeStdin();
    const proxy = createMouseStdinProxy(stdin);
    expect(proxy.inkStdin.isTTY).toBe(true);
    proxy.inkStdin.setRawMode(true);
    expect(stdin.setRawMode).toHaveBeenCalledWith(true);
    proxy.inkStdin.ref();
    expect(stdin.ref).toHaveBeenCalled();
    proxy.inkStdin.unref();
    expect(stdin.unref).toHaveBeenCalled();
  });

  it('detach() stops routing and ends the keyboard stream', async () => {
    const stdin = fakeStdin();
    const proxy = createMouseStdinProxy(stdin);
    const events: MouseEvent[] = [];
    proxy.subscribeMouse((ev) => events.push(ev));
    let ended = false;
    proxy.inkStdin.on('end', () => {
      ended = true;
    });
    // Drain so 'end' can fire.
    proxy.inkStdin.on('data', () => {});

    proxy.detach();
    stdin.emit('data', `${ESC}[<0;1;1M`); // ignored after detach
    await new Promise((r) => setTimeout(r, 10));

    expect(events).toHaveLength(0);
    expect(ended).toBe(true);
  });

  it('unsubscribe stops a single listener without affecting others', async () => {
    const stdin = fakeStdin();
    const proxy = createMouseStdinProxy(stdin);
    const a: MouseEvent[] = [];
    const b: MouseEvent[] = [];
    const offA = proxy.subscribeMouse((ev) => a.push(ev));
    proxy.subscribeMouse((ev) => b.push(ev));

    stdin.emit('data', `${ESC}[<0;1;1M`);
    offA();
    stdin.emit('data', `${ESC}[<0;2;2M`);
    await new Promise((r) => setTimeout(r, 10));

    expect(a).toHaveLength(1);
    expect(b).toHaveLength(2);
  });
});
