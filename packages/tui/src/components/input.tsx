import React from 'react';
import { Box, Text, useInput } from 'ink';

export interface InputProps {
  prompt?: string;
  value: string;
  cursor: number;
  placeholders: string[];
  disabled?: boolean;
  hint?: string;
  onKey: (input: string, key: KeyEvent) => void;
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
}

export function Input({
  prompt = '› ',
  value,
  cursor,
  placeholders,
  disabled,
  hint,
  onKey,
}: InputProps): React.ReactElement {
  useInput((input, key) => {
    if (disabled) return;
    onKey(input, key as KeyEvent);
  });

  const before = value.slice(0, cursor);
  const at = value.slice(cursor, cursor + 1) || ' ';
  const after = value.slice(cursor + 1);

  // Disabled (aborting an iteration) is the only signal that needs a
  // hard visual cue — paint the prompt red. We avoid wrapping the input
  // in a border Box: Ink redraws the live area on every state change,
  // and in non-altScreen mode the previous frame's border is left in
  // the terminal's scrollback. A `> ` prompt + inverse cursor is enough
  // to indicate the input row.
  const promptColor = disabled ? 'red' : 'cyan';

  return (
    <Box flexDirection="column">
      {placeholders.map((p, i) => (
        <Text key={i} dimColor>
          {'  ↳ '}
          {p}
        </Text>
      ))}
      {/* Single <Text> wrapper so prompt + buffer + cursor + tail all wrap
          as one continuous string. Splitting them across sibling Text
          elements would let each piece wrap independently and shift the
          cursor cell off the intended character. */}
      <Text>
        <Text color={promptColor}>{prompt}</Text>
        {before}
        <Text inverse>{at}</Text>
        {after}
      </Text>
      {hint ? <Text dimColor>{hint}</Text> : null}
    </Box>
  );
}
