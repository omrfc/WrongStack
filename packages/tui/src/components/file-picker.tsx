import { Box, Text } from 'ink';
import type React from 'react';

export interface FilePickerProps {
  query: string;
  matches: string[];
  selected: number;
}

export function FilePicker({ query, matches, selected }: FilePickerProps): React.ReactElement {
  if (matches.length === 0) {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text dimColor>@{query} — no matches</Text>
      </Box>
    );
  }
  return (
    <Box flexDirection="column" paddingX={1}>
      <Text dimColor>@{query || '…'} — ↑/↓ select, Enter attach, Esc cancel</Text>
      {matches.map((m, i) => (
        <Text key={m} color={i === selected ? 'cyan' : undefined} inverse={i === selected}>
          {i === selected ? '› ' : '  '}
          {highlight(m, query)}
        </Text>
      ))}
    </Box>
  );
}

function highlight(path: string, query: string): string {
  // Visual highlight is omitted for terseness; ink Text styling at char level
  // requires splitting into segments. Keep the path verbatim for now.
  return path;
}
