import { expectDefined } from '@wrongstack/core';
import { Box, Text, useInput, useStdin, useStdout } from 'ink';
import type React from 'react';
import { memo, useEffect, useRef, useState } from 'react';
import { fnKey } from '../fn-keys.js';
import { type InputCell, layoutInputRows } from '../input-tokens.js';
export interface InputProps {
  prompt?: string | undefined;
  value: string;
  cursor: number;
  disabled?: boolean | undefined;
  hint?: string | undefined;
  /**
   * When true the visible prompt rows are replaced by an empty placeholder of
   * `placeholderHeight` rows, but BOTH keyboard listeners (the Ink `useInput`
   * and the raw-stdin parser that produces F-keys / Home / End / wheel) stay
   * mounted. This is what keeps the central `handleKey` router — and therefore
   * the F-key/Esc toggles that open and CLOSE the monitor overlays — alive
   * while an overlay occupies the bottom region. Unmounting the Input here is
   * what previously left overlays (e.g. the F3 agents monitor) un-closable.
   */
  hidden?: boolean | undefined;
  /** Row count for the hidden placeholder so the bottom region never resizes. */
  placeholderHeight?: number | undefined;
  onKey: (input: string, key: KeyEvent) => void;
}

/**
 * Render one wrapped row of input cells into styled `<Text>` spans. Consecutive
 * cells with the same style are coalesced into a single span; the cursor cell is
 * always emitted on its own (inverse). `promptColor` styles the leading prompt.
 */
function renderRow(cells: InputCell[], rowKey: string, promptColor: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  let run = '';
  let runStart = 0;
  let runStyle: 'prompt' | 'chip' | 'plain' | null = null;
  const flush = (end: number) => {
    if (run === '' || runStyle === null) return;
    const key = `${rowKey}-${runStart}`;
    if (runStyle === 'prompt')
      out.push(
        <Text key={key} color={promptColor}>
          {run}
        </Text>,
      );
    else if (runStyle === 'chip')
      out.push(
        <Text key={key} color="cyan" dimColor>
          {run}
        </Text>,
      );
    else out.push(<Text key={key}>{run}</Text>);
    run = '';
    runStart = end;
  };
  for (let i = 0; i < cells.length; i++) {
    const cell = cells[i] as InputCell;
    if (cell.cursor) {
      flush(i);
      out.push(
        <Text key={`${rowKey}-c${i}`} inverse>
          {cell.ch}
        </Text>,
      );
      runStart = i + 1;
      continue;
    }
    const style = cell.prompt ? 'prompt' : cell.chip ? 'chip' : 'plain';
    if (style !== runStyle) {
      flush(i);
      runStyle = style;
      runStart = i;
    }
    run += cell.ch;
  }
  flush(cells.length);
  return out;
}

export interface KeyEvent {
  upArrow: boolean;
  downArrow: boolean;
  leftArrow: boolean;
  rightArrow: boolean;
  return: boolean;
  escape: boolean;
  ctrl: boolean;
  meta: boolean;
  shift: boolean;
  tab: boolean;
  backspace: boolean;
  delete: boolean;
  pageUp: boolean;
  pageDown: boolean;
  home: boolean;
  end: boolean;
  /** Mouse wheel scroll: positive = up (away from user), negative = down. */
  wheelDeltaY?: number | undefined;
  /** Function-key number 1–12 when a plain F-key was pressed, else undefined.
   *  Ink's useInput does not decode F-keys, so these are caught from raw stdin
   *  (same mechanism as Home/End) and surfaced here. F-keys are terminal-safe
   *  aliases for chords some terminals intercept (e.g. Windows Terminal eats
   *  Ctrl+F for "Find"). */
  fn?: number | undefined;
}

// Ink 5.x useInput does not expose home/end as boolean flags even though
// parseKeypress recognizes them. We subscribe to raw stdin to catch these.
function isHomeEnd(data: string): 'home' | 'end' | null {
  // Common terminal sequences for Home/End.
  // CSI H / CSI F are the most universal; the longer variants are fallbacks.
  if (data === '\x1b[H' || data === '\x1b[1~' || data === '\x1bOH' || data === '\x1b[7~')
    return 'home';
  if (data === '\x1b[F' || data === '\x1b[4~' || data === '\x1bOF' || data === '\x1b[8~')
    return 'end';
  return null;
}

/**
 * Detect Backspace / Delete from raw stdin bytes. Ink 5.x `useInput` may
 * miss these on Windows Terminal — Backspace often sends `\x08` (BS / Ctrl+H)
 * while most Unix terminals send `\x7f` (DEL). We catch both so the key works
 * regardless of terminal configuration. Delete sends the escape sequence
 * `\x1b[3~` which Ink usually handles, but we include it here for completeness
 * and to avoid relying on Ink internals.
 *
 * Also aliases `\x1b\x7f` and `\x1b\x08` (ESC+Backspace / Meta+Backspace) to
 * Ctrl+Backspace behaviour — delete the previous word. On macOS, Opt+Backspace
 * sends this sequence, and on Linux, Alt+Backspace does as well.
 */
function isBackspaceOrDelete(data: string): 'backspace' | 'delete' | 'metaBackspace' | null {
  if (data === '\x1b\x7f' || data === '\x1b\x08') return 'metaBackspace';
  if (data === '\x7f' || data === '\x08') return 'backspace';
  if (data === '\x1b[3~') return 'delete';
  return null;
}

/**
 * Parse SGR mouse protocol (\x1b[?1006h) wheel events from raw stdin.
 * Format: \x1b[<Cb;Cx;CyM (press) or \x1b[<Cb;Cx;Cym (release, ignored).
 * Cb=64 → wheel up (positive delta), Cb=65 → wheel down (negative delta).
 * Returns null when the data is not a mouse event or not a wheel event.
 */
function parseMouseWheel(data: string): number | null {
  // SGR mouse: ESC [ < Cb ; Cx ; Cy (M|m)
  const m = data.match(new RegExp(`^${String.fromCharCode(27)}\\[<(\\d+);(\\d+);(\\d+)([Mm])$`, 'u'));
  if (!m) return null;
  const cb = Number.parseInt(expectDefined(m[1]), 10);
  if (cb === 64) return 1;  // wheel up
  if (cb === 65) return -1; // wheel down
  return null;
}

export const EMPTY_KEY: KeyEvent = {
  upArrow: false,
  downArrow: false,
  leftArrow: false,
  rightArrow: false,
  return: false,
  escape: false,
  ctrl: false,
  meta: false,
  shift: false,
  tab: false,
  backspace: false,
  delete: false,
  pageUp: false,
  pageDown: false,
  home: false,
  end: false,
};

export const Input = memo(function Input({
  prompt = '› ',
  value,
  cursor,
  disabled,
  hint,
  hidden,
  placeholderHeight,
  onKey,
}: InputProps): React.ReactElement {
  // Suppress duplicate key events: when our raw-stdin handler catches a key
  // before Ink's useInput does, we set a suppression flag so Ink doesn't
  // fire a duplicate event. Without this, Backspace deletes two characters
  // — both the raw-stdin handler AND Ink fire onKey() for the same keystroke.
  const suppressInkEscRef = useRef(false);
  const suppressInkBackspaceRef = useRef(false);
  const suppressInkDeleteRef = useRef(false);

  useInput((input, key) => {
    if (disabled) return;
    if (key.escape && suppressInkEscRef.current) {
      suppressInkEscRef.current = false;
      return;
    }
    if (key.backspace && suppressInkBackspaceRef.current) {
      suppressInkBackspaceRef.current = false;
      return;
    }
    if (key.delete && suppressInkDeleteRef.current) {
      suppressInkDeleteRef.current = false;
      return;
    }
    onKey(input, key as KeyEvent);
  });

  // Catch Home/End/Backspace/Delete that Ink's useInput may not surface
  // (especially on Windows Terminal where Backspace sends \x08 not \x7f).
  //
  // Also buffers a bare ESC for 10ms: if Backspace follows immediately,
  // it's ALT+Backspace / Opt+Backspace (delete previous word). Arrow keys,
  // Home, End, and other CSI sequences arrive within microseconds of the
  // ESC byte so the 10ms window is wide enough to catch split sequences
  // without introducing perceptible Esc latency. After 10ms with no
  // follow-up, a real Esc press is emitted.
  const { stdin } = useStdin();
  useEffect(() => {
    if (!stdin || disabled) return;
    let escTimer: ReturnType<typeof setTimeout> | null = null;

    const handleData = (data: Buffer) => {
      const s = data.toString();

      // ESC buffering: see comment block above.
      if (s === '\x1b') {
        escTimer = setTimeout(() => {
          escTimer = null;
          suppressInkEscRef.current = true;
          onKey('', { ...EMPTY_KEY, escape: true });
        }, 10);
        return;
      }
      if (escTimer !== null) {
        clearTimeout(escTimer);
        escTimer = null;
        if (s === '\x7f' || s === '\x08') {
          suppressInkBackspaceRef.current = true;
          onKey('', { ...EMPTY_KEY, backspace: true, ctrl: true });
          return;
        }
        // Not Backspace — let Ink handle the full sequence.
        return;
      }

      // Home / End
      const homeEnd = isHomeEnd(s);
      if (homeEnd === 'home') {
        onKey('', { ...EMPTY_KEY, home: true });
        return;
      }
      if (homeEnd === 'end') {
        onKey('', { ...EMPTY_KEY, end: true });
        return;
      }

      // Backspace / Delete — caught here because Ink's useInput may miss
      // \x08 (BS) on Windows Terminal. We fire before Ink so the key is never lost.
      // Set suppression flags so Ink's useInput doesn't fire a duplicate event
      // (Backspace would delete two characters otherwise — both handlers fire onKey).
      const bsdel = isBackspaceOrDelete(s);
      if (bsdel === 'backspace') {
        suppressInkBackspaceRef.current = true;
        onKey('', { ...EMPTY_KEY, backspace: true });
        return;
      }
      if (bsdel === 'delete') {
        suppressInkDeleteRef.current = true;
        onKey('', { ...EMPTY_KEY, delete: true });
        return;
      }
      if (bsdel === 'metaBackspace') {
        // ALT+Backspace / Opt+Backspace — delete previous word.
        // Translate to Ctrl+Backspace which the handleKey router already
        // handles by slicing from the last space to the cursor.
        suppressInkBackspaceRef.current = true;
        onKey('', { ...EMPTY_KEY, backspace: true, ctrl: true });
        return;
      }

      // Mouse wheel (SGR protocol — terminal must have \x1b[?1000h + \x1b[?1006h set).
      // Wheel events scroll the chat viewport; button events are ignored here.
      const wheelDelta = parseMouseWheel(s);
      if (wheelDelta !== null) {
        onKey('', { ...EMPTY_KEY, wheelDeltaY: wheelDelta });
        return;
      }

      // Function keys (F1–F12)
      const fn = fnKey(s);
      if (fn !== null) onKey('', { ...EMPTY_KEY, fn });
    };
    stdin.on('data', handleData);
    return () => {
      if (escTimer !== null) clearTimeout(escTimer);
      stdin.off('data', handleData);
    };
  }, [stdin, disabled, onKey]);

  // Track terminal width so the input wraps at the real column count and the
  // box grows to exactly the number of visual rows the content needs.
  const { stdout } = useStdout();
  const [cols, setCols] = useState(stdout?.columns ?? 80);
  useEffect(() => {
    if (!stdout) return;
    const onResize = () => setCols(stdout.columns ?? 80);
    onResize();
    stdout.on('resize', onResize);
    return () => {
      stdout.off('resize', onResize);
    };
  }, [stdout]);

  // Disabled (aborting an iteration) is the only signal that needs a
  // hard visual cue — paint the prompt red.
  const promptColor = disabled ? 'red' : 'cyan';

  // One <Text> per wrapped row: the column box's height becomes the row count,
  // so a long message that soft-wraps (or any embedded newlines) gives the
  // input area a correct, line-count-driven height instead of clipping or
  // overflowing. layoutInputRows keeps the cursor on the right row/column.
  const rows = layoutInputRows(prompt, value, cursor, cols);

  // Hidden mode: keep the listeners above mounted, but render only an empty
  // placeholder of the same height the visible input would occupy. The bottom
  // region stays a constant height (so Ink's log-update never bleeds the live
  // region into native scrollback) while keyboard handling stays alive.
  if (hidden) {
    return <Box height={Math.max(1, placeholderHeight ?? rows.length)} />;
  }

  return (
    <Box flexDirection="column">
      {rows.map((row, i) =>
        row.length === 0 ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: rows are positional and re-laid out every render
          <Text key={i}> </Text> // keep blank lines one row tall
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: rows are positional and re-laid out every render
          <Text key={i}>{renderRow(row, `r${i}`, promptColor)}</Text>
        ),
      )}
      {hint ? <Text dimColor>{hint}</Text> : null}
    </Box>
  );
});
