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

  // Active = cyan when the user has anything typed; gray otherwise.
  // Disabled (aborting an iteration) overrides to red — Ctrl+C feedback.
  const borderColor = disabled ? 'red' : value.length > 0 ? 'cyan' : 'gray';

  return (
    <Box flexDirection="column">
      {placeholders.map((p, i) => (
        <Text key={i} dimColor>
          {'  ↳ '}
          {p}
        </Text>
      ))}
      <Box
        borderStyle="round"
        borderColor={borderColor}
        paddingX={1}
        // width="100%" makes the border stretch across the terminal; without
        // it the Box hugs its content and the border looks like a tag.
        width="100%"
      >
        {/* Single <Text> wrapper so prompt + buffer + cursor + tail all wrap
            as one continuous string. Splitting them across sibling Text
            elements would let each piece wrap independently and shift the
            cursor cell off the intended character. */}
        <Text>
          <Text color="cyan">{prompt}</Text>
          {before}
          <Text inverse>{at}</Text>
          {after}
        </Text>
      </Box>
      {hint ? <Text dimColor>{hint}</Text> : null}
    </Box>
  );
}
