// SGR (1006) mouse-sequence parser, factored out of the TUI input path so the
// (fiddly) byte decoding can be unit-tested in isolation.
//
// With mouse tracking enabled (DECSET ?1000h ?1006h) the terminal emits, for
// every press / release / wheel tick:
//
//     ESC [ < Cb ; Cx ; Cy M     (press / wheel / motion)
//     ESC [ < Cb ; Cx ; Cy m     (release)
//
// Cx / Cy are 1-based column / row. Cb packs the button in its low bits plus
// modifier and event-class flags:
//
//   bits 0-1  button      0 = left, 1 = middle, 2 = right, 3 = none/release
//   bit  2    (4)  shift
//   bit  3    (8)  alt / meta
//   bit  4    (16) ctrl
//   bit  5    (32) motion (drag) — set while a button is held and the pointer moves
//   bit  6    (64) wheel        — 64 = wheel up, 65 = wheel down, 66/67 = wheel left/right
//
// Like bracketed-paste markers, Ink's keypress parser can strip the leading
// ESC byte, leaving a bare `[<…`. We match the ESC optionally so both forms
// decode. A single stdin chunk can carry several sequences (fast wheel
// spins) — parseSgrMouse returns every event it finds, in order.

export type MouseButton = 'left' | 'middle' | 'right' | 'wheelUp' | 'wheelDown' | 'other';

export interface MouseEvent {
  /** press = button down (or wheel tick), release = button up, wheel = scroll. */
  type: 'press' | 'release' | 'wheel';
  button: MouseButton;
  /** 1-based terminal column. */
  x: number;
  /** 1-based terminal row. */
  y: number;
  shift: boolean;
  alt: boolean;
  ctrl: boolean;
  /** Pointer moved with a button held (motion flag, bit 5). */
  drag: boolean;
}

// ESC is optional: Ink sometimes strips it from CSI sequences (same reason the
// paste accumulator matches a bare `[200~`). Global flag so matchAll yields
// every sequence in a chunk.
// biome-ignore lint/suspicious/noControlCharactersInRegex: SGR mouse sequences carry a literal ESC
const SGR_MOUSE_RE = /\x1b?\[<(\d+);(\d+);(\d+)([Mm])/g;

/** True when the chunk contains at least one SGR mouse sequence. Cheap guard
 *  used to drop mouse bytes before they reach a text input. */
export function hasSgrMouse(s: string): boolean {
  // Build a fresh non-stateful matcher so repeated calls are independent.
  return new RegExp(SGR_MOUSE_RE.source).test(s);
}

/** Strip every SGR mouse sequence out of a chunk, returning the remaining
 *  (keyboard) bytes. Used by the stdin proxy so Ink never sees mouse data. */
export function stripSgrMouse(s: string): string {
  return s.replace(SGR_MOUSE_RE, '');
}

/** Decode every SGR mouse sequence in `s`, in order. Non-mouse bytes are
 *  ignored. Returns [] when there are none. */
export function parseSgrMouse(s: string): MouseEvent[] {
  const events: MouseEvent[] = [];
  for (const m of s.matchAll(SGR_MOUSE_RE)) {
    const cb = Number.parseInt(m[1] ?? '', 10);
    const x = Number.parseInt(m[2] ?? '', 10);
    const y = Number.parseInt(m[3] ?? '', 10);
    const final = m[4];
    if (!Number.isFinite(cb) || !Number.isFinite(x) || !Number.isFinite(y)) continue;
    const isWheel = (cb & 64) !== 0;
    const drag = (cb & 32) !== 0;
    const low = cb & 3;
    let button: MouseButton;
    let type: MouseEvent['type'];
    if (isWheel) {
      type = 'wheel';
      button = low === 0 ? 'wheelUp' : low === 1 ? 'wheelDown' : 'other';
    } else if (final === 'm') {
      // Lowercase terminator = button release.
      type = 'release';
      button = low === 0 ? 'left' : low === 1 ? 'middle' : low === 2 ? 'right' : 'other';
    } else {
      type = 'press';
      button = low === 0 ? 'left' : low === 1 ? 'middle' : low === 2 ? 'right' : 'other';
    }
    events.push({
      type,
      button,
      x,
      y,
      shift: (cb & 4) !== 0,
      alt: (cb & 8) !== 0,
      ctrl: (cb & 16) !== 0,
      drag,
    });
  }
  return events;
}
