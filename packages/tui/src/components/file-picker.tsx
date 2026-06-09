import { Box, Text } from '../ink.js';
import type React from 'react';

export interface FilePickerProps {
  query: string;
  matches: string[];
  selected: number;
}

export function FilePicker({ query, matches, selected }: FilePickerProps): React.ReactElement {
  if (matches.length === 0) {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
        <Text dimColor>@{query} — no matches</Text>
      </Box>
    );
  }
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text dimColor>@{query || '…'} — ↑/↓ select, Enter attach, Esc cancel</Text>
      {matches.map((m, i) => (
        <Text key={m} inverse={i === selected} {...(i === selected ? { color: 'cyan' } : {})}>
          {i === selected ? '› ' : '  '}
          {highlight(m, query)}
        </Text>
      ))}
    </Box>
  );
}

function highlight(path: string, _query: string): string {
  // Visual highlight is omitted for terseness; ink Text styling at char level
  // requires splitting into segments. Keep the path verbatim for now.
  return path;
}
