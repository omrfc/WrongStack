import { type RefObject, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { type DOMElement, measureElement } from '../ink.js';
import { ALT_SCREEN_OFF, ALT_SCREEN_ON, MOUSE_CLICK_ON, MOUSE_OFF } from '../mouse.js';

/** Stable shape of the terminal-tracking surface consumed by App. */
export interface MouseModeRefs {
  /** Ref attached to the bottom region (input + pickers + status bar + panels). */
  bottomRegionRef: RefObject<DOMElement | null>;
  /** Ref attached to the status-bar wrapper, used to locate clickable chips. */
  statusBarWrapRef: RefObject<DOMElement | null>;
  /** Ref attached to the panel region *below* the status bar. */
  belowStatusBarRef: RefObject<DOMElement | null>;
  /** Live terminal row count (updates on SIGWINCH). */
  termRows: number;
}

export interface UseMouseModeOptions {
  /** Stable pointer to the current state, used to avoid an infinite
   *  measure → dispatch → re-measure loop in the viewport layout effect. */
  stateRef: { current: { viewportRows: number } };
  /** Stable dispatcher (e.g. `(a: Action) => void`). */
  dispatch: (action: { type: 'setViewportRows'; rows: number }) => void;
  /** `true` while a picker overlay is open (file/model/slash/autonomy/settings/resume). */
  pickerOverlayOpen: boolean;
  /** `true` when the global mouse prop is on (full mouse mode). */
  mouseMode: boolean;
  /** Optional stdout rows fallback (defaults to 24). */
  initialRows?: number | undefined;
}

/**
 * Terminal-mode owner hook. Centralizes:
 *
 * 1. SGR mouse tracking on/off (driven by `mouseMode || pickerOverlayOpen`).
 * 2. Alt-screen buffer entry/exit (driven by `mouseMode` only).
 * 3. SIGWINCH listening and `termRows` state.
 * 4. `ScrollableHistory` viewport measurement (only when `mouseMode` is on).
 *
 * The alt-screen cleanup is dual: a real teardown effect, plus a ref-guarded
 * unmount effect that catches transitions during shutdown. `run-tui` also
 * emits `MOUSE_OFF` / `ALT_SCREEN_OFF` on process exit as belt-and-suspenders.
 */
export function useMouseMode({
  stateRef,
  dispatch,
  pickerOverlayOpen,
  mouseMode,
  initialRows,
}: UseMouseModeOptions): MouseModeRefs {
  const mouseTrackingOn = mouseMode || pickerOverlayOpen;

  // --- SGR mouse tracking ---------------------------------------------------
  const mouseWrittenRef = useRef(false);
  useEffect(() => {
    if (mouseWrittenRef.current === mouseTrackingOn) return;
    mouseWrittenRef.current = mouseTrackingOn;
    try {
      process.stdout.write(mouseTrackingOn ? MOUSE_CLICK_ON : MOUSE_OFF);
    } catch {
      // stdout closed during shutdown — ignore.
    }
  }, [mouseTrackingOn]);
  useEffect(
    () => () => {
      try {
        process.stdout.write(MOUSE_OFF);
      } catch {
        // ignore — process tearing down.
      }
    },
    [],
  );

  // --- Alt screen buffer ----------------------------------------------------
  const altWrittenRef = useRef(mouseMode);
  useEffect(() => {
    if (altWrittenRef.current === mouseMode) return;
    altWrittenRef.current = mouseMode;
    try {
      process.stdout.write(mouseMode ? `${ALT_SCREEN_ON}\x1b[2J\x1b[H` : ALT_SCREEN_OFF);
    } catch {
      // stdout closed during shutdown — ignore.
    }
  }, [mouseMode]);
  useEffect(
    () => () => {
      try {
        if (altWrittenRef.current) process.stdout.write(ALT_SCREEN_OFF);
      } catch {
        // ignore — process tearing down.
      }
    },
    [],
  );

  // --- Resize + viewport ----------------------------------------------------
  const bottomRegionRef = useRef<DOMElement | null>(null);
  const statusBarWrapRef = useRef<DOMElement | null>(null);
  const belowStatusBarRef = useRef<DOMElement | null>(null);
  const [termRows, setTermRows] = useState(initialRows ?? 24);
  useEffect(() => {
    const onResize = () => setTermRows(process.stdout.rows ?? 24);
    process.stdout.on('resize', onResize);
    return () => {
      process.stdout.off('resize', onResize);
    };
  }, []);
  useLayoutEffect(() => {
    if (!mouseMode) return;
    const node = bottomRegionRef.current;
    if (!node) return;
    const { height } = measureElement(node);
    // A transient 0-height measure (mid-layout) would swing the viewport to the
    // full screen and back, flickering the history — skip until it's real.
    if (height <= 0) return;
    const vp = Math.max(1, termRows - height);
    if (vp !== stateRef.current.viewportRows) {
      dispatch({ type: 'setViewportRows', rows: vp });
    }
  });

  return { bottomRegionRef, statusBarWrapRef, belowStatusBarRef, termRows };
}
