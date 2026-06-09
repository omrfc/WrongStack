// Pastel-aware Ink shim.
//
// Ink resolves bare color names (`color="red"`) against the terminal's own
// 16-color palette — typically dark and harsh. Rather than rewrite the ~300
// hardcoded color attributes scattered across the TUI, we wrap Ink's `Text`
// and `Box` so every `color` / `backgroundColor` / `borderColor` they receive
// is routed through `softColor` and remapped to a soft pastel hex (see
// theme.ts). This catches *both* static literals and dynamic values (syntax
// highlight tokens, per-subagent colors, status-chip ternaries) with a single
// import swap per component (`from 'ink'` → `from './ink.js'`).
//
// Everything else from Ink is re-exported untouched so callers can switch that
// one import line without losing hooks.

import {
  Box as InkBox,
  type BoxProps,
  type DOMElement,
  Text as InkText,
  type TextProps,
} from 'ink';
import { forwardRef, type PropsWithChildren, type ReactElement } from 'react';
import { softColor } from './theme.js';

export {
  Static,
  measureElement,
  useApp,
  useFocus,
  useFocusManager,
  useInput,
  useStdin,
  useStdout,
} from 'ink';
export type { BoxProps, DOMElement, TextProps, Key } from 'ink';

// `exactOptionalPropertyTypes` forbids passing `color={undefined}`, so we only
// attach a color prop when it actually resolves to a value.
const colorProps = (color?: string, backgroundColor?: string) => {
  const c = softColor(color);
  const bg = softColor(backgroundColor);
  return { ...(c ? { color: c } : {}), ...(bg ? { backgroundColor: bg } : {}) };
};

/** Ink `Text` with `color`/`backgroundColor` remapped to the pastel palette. */
export function Text({ color, backgroundColor, ...rest }: TextProps): ReactElement {
  return <InkText {...rest} {...colorProps(color, backgroundColor)} />;
}

/**
 * Ink `Box` with `borderColor`/`backgroundColor` remapped to pastels. Forwards
 * `ref` so `measureElement` (used by the scrollable history) keeps working.
 */
export const Box = forwardRef<DOMElement, PropsWithChildren<BoxProps>>(function Box(
  { borderColor, backgroundColor, ...rest },
  ref,
) {
  const bc = softColor(borderColor);
  const bg = softColor(backgroundColor);
  return (
    <InkBox
      ref={ref}
      {...rest}
      {...(bc ? { borderColor: bc } : {})}
      {...(bg ? { backgroundColor: bg } : {})}
    />
  );
});
