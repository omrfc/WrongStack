import { Box, Text } from 'ink';
import type React from 'react';
import type { SlashCommandMatch } from '../app.js';

export interface SlashMenuProps {
  query: string;
  matches: SlashCommandMatch[];
  selected: number;
}

export function SlashMenu({ query, matches, selected }: SlashMenuProps): React.ReactElement {
  const placeholder = query ? `/${query}` : '/';
  return (
    <Box flexDirection="column" paddingX={1}>
      <Text dimColor>
        {placeholder || '/'} — ↑/↓ select, Enter dispatch, Tab autocomplete, Esc close
      </Text>
      {matches.map((m, i) => (
        <Text key={m.name} color={i === selected ? 'cyan' : undefined} inverse={i === selected}>
          {i === selected ? '› ' : '  '}
          <Text bold>{m.name}</Text>
          {m.argsHint ? <Text dimColor> {m.argsHint}</Text> : null}
          <Text dimColor> — {m.description}</Text>
        </Text>
      ))}
      {matches.length === 0 && <Text dimColor>No matching commands</Text>}
    </Box>
  );
}
