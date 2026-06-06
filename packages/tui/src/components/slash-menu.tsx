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

  // Group matches by category while preserving the flat order needed for
  // keyboard navigation. We emit category headers when the category changes.
  const rows: Array<{ type: 'header'; category: string } | { type: 'item'; match: SlashCommandMatch; index: number }> = [];
  let lastCategory = '';
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i] as SlashCommandMatch;
    if (m.category !== lastCategory) {
      lastCategory = m.category;
      rows.push({ type: 'header', category: m.category });
    }
    rows.push({ type: 'item', match: m, index: i });
  }

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text dimColor>
        {placeholder || '/'} — ↑/↓ select, Enter dispatch, Tab autocomplete, Esc close
      </Text>
      {rows.map((row) => {
        if (row.type === 'header') {
          return (
            <Text key={`cat-${row.category}`} bold color="yellow" dimColor>
              {'  '}{row.category}
            </Text>
          );
        }
        const { match: m, index: i } = row;
        return (
          <Text key={m.name} color={i === selected ? 'cyan' : undefined} inverse={i === selected}>
            {i === selected ? '› ' : '  '}
            <Text bold>{m.name}</Text>
            {m.argsHint ? <Text dimColor> {m.argsHint}</Text> : null}
            <Text dimColor> — {m.description}</Text>
          </Text>
        );
      })}
      {matches.length === 0 && <Text dimColor>No matching commands</Text>}
    </Box>
  );
}
