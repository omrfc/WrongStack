import { Box, Text, useInput, useStdin, useStdout } from 'ink';
import type React from 'react';
import { useEffect, useState } from 'react';
import { type InputCell, layoutInputRows } from '../input-tokens.js';

export interface InputProps {
  prompt?: string;
  value: string;
  cursor: number;
  disabled?: boolean;
  hint?: string;
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

export function Input({
  prompt = '› ',
  value,
  cursor,
  disabled,
  hint,
  onKey,
}: InputProps): React.ReactElement {
  useInput((input, key) => {
    if (disabled) return;
    onKey(input, key as KeyEvent);
  });

  // Catch Home/End that Ink's useInput doesn't surface.
  const { stdin } = useStdin();
  useEffect(() => {
    if (!stdin || disabled) return;
    const handleData = (data: Buffer) => {
      const kind = isHomeEnd(data.toString());
      if (kind === 'home') onKey('', { ...EMPTY_KEY, home: true });
      else if (kind === 'end') onKey('', { ...EMPTY_KEY, end: true });
    };
    stdin.on('data', handleData);
    return () => {
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
  // hard visual cue — paint the prompt red. We avoid wrapping the input
  // in a border Box: Ink redraws the live area on every state change,
  // and in non-altScreen mode the previous frame's border is left in
  // the terminal's scrollback. A `> ` prompt + inverse cursor is enough
  // to indicate the input row.
  const promptColor = disabled ? 'red' : 'cyan';

  // One <Text> per wrapped row: the column box's height becomes the row count,
  // so a long message that soft-wraps (or any embedded newlines) gives the
  // input area a correct, line-count-driven height instead of clipping or
  // overflowing. layoutInputRows keeps the cursor on the right row/column.
  const rows = layoutInputRows(prompt, value, cursor, cols);

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
}
