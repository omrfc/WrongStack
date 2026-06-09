/**
 * SGR mouse protocol (xterm DEC private modes). These are INDEPENDENT of the
 * alternate screen buffer (?1049h): we enable tracking while staying in the
 * normal buffer so the terminal's native scrollback survives.
 *
 *   ?1000h — button press/release tracking (clicks + wheel)
 *   ?1002h — button-event tracking: adds drag (motion while a button is held)
 *   ?1003h — any-event tracking: adds hover (motion with no button) — EXPENSIVE,
 *            one event per cell the cursor crosses; gate behind a setting.
 *   ?1006h — SGR extended coordinates: `ESC [ < b ; x ; y (M|m)`, no 223-col cap.
 *
 * Trade-off: with ANY of these on, the terminal reports the wheel to us as
 * buttons 64/65 instead of scrolling its own scrollback. Shift+wheel (and
 * Shift+PgUp) still reach native scrollback in every mainstream terminal, so
 * users keep a way to scroll history — but plain wheel-scroll of history is
 * gone while tracking is active. Keep tracking opt-in / overlay-scoped.
 */

const ESC = String.fromCharCode(27);

/** Click + wheel only (mode 1000). Cheapest; no motion events. */
export const MOUSE_CLICK_ON = `${ESC}[?1000h${ESC}[?1006h`;
/** Click + wheel + drag (motion while a button is held; mode 1002). */
export const MOUSE_DRAG_ON = `${ESC}[?1000h${ESC}[?1002h${ESC}[?1006h`;
/** Click + wheel + free hover (motion with no button; mode 1003). Expensive. */
export const MOUSE_HOVER_ON = `${ESC}[?1000h${ESC}[?1003h${ESC}[?1006h`;
/**
 * Disable every tracking mode. Disabling a mode that was never set is a no-op,
 * so this is safe to send unconditionally on cleanup regardless of which
 * *_ON sequence (if any) was emitted.
 */
export const MOUSE_OFF = `${ESC}[?1003l${ESC}[?1002l${ESC}[?1000l${ESC}[?1006l`;

export type MouseEventKind = 'press' | 'release' | 'move' | 'wheel';
export type MouseButton = 'left' | 'middle' | 'right' | 'none';

export interface MouseEventInfo {
  kind: MouseEventKind;
  button: MouseButton;
  /** 1-based terminal column (matches the SGR report; column 1 = leftmost). */
  x: number;
  /** 1-based terminal row (column 1 = topmost visible row). */
  y: number;
  /** Wheel direction: +1 = up (away from user), -1 = down, 0 = not a wheel event. */
  wheel: number;
  shift: boolean;
  /** Alt/Meta modifier. */
  meta: boolean;
  ctrl: boolean;
  /** True for motion events (button-held drag, or free hover). */
  motion: boolean;
}

// SGR mouse report: ESC [ < Cb ; Cx ; Cy (M|m)
// M = press / motion, m = release. Cb is a bitfield (see decode below).
const SGR_MOUSE_RE = new RegExp(`^${ESC}\\[<(\\d+);(\\d+);(\\d+)([Mm])$`, 'u');

/**
 * Parse a single SGR mouse report from raw stdin into a structured event.
 * Returns null when `data` is not a (complete) SGR mouse report.
 *
 * Cb bitfield:
 *   bits 0-1 — button (0 left, 1 middle, 2 right, 3 none/released)
 *   bit  2   — shift          (+4)
 *   bit  3   — meta/alt       (+8)
 *   bit  4   — ctrl           (+16)
 *   bit  5   — motion         (+32)
 *   bit  6   — wheel          (+64; then bits 0-1: 0 up, 1 down, 2/3 horizontal)
 */
export function parseMouseEvent(data: string): MouseEventInfo | null {
  const m = data.match(SGR_MOUSE_RE);
  if (!m) return null;
  const cb = Number.parseInt(m[1] as string, 10);
  const x = Number.parseInt(m[2] as string, 10);
  const y = Number.parseInt(m[3] as string, 10);
  const released = m[4] === 'm';

  const shift = (cb & 4) !== 0;
  const meta = (cb & 8) !== 0;
  const ctrl = (cb & 16) !== 0;
  const motion = (cb & 32) !== 0;
  const wheel = (cb & 64) !== 0;
  const low = cb & 3;

  if (wheel) {
    // 64 = up, 65 = down, 66/67 = horizontal scroll (no vertical delta).
    const dir = low === 0 ? 1 : low === 1 ? -1 : 0;
    return { kind: 'wheel', button: 'none', x, y, wheel: dir, shift, meta, ctrl, motion: false };
  }

  const button: MouseButton =
    low === 0 ? 'left' : low === 1 ? 'middle' : low === 2 ? 'right' : 'none';
  const kind: MouseEventKind = motion ? 'move' : released ? 'release' : 'press';
  return { kind, button, x, y, wheel: 0, shift, meta, ctrl, motion };
}
