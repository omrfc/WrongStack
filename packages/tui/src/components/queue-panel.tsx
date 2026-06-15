import type { ContentBlock } from '@wrongstack/core';
import { Box, Text, useStdout } from '../ink.js';
import type React from 'react';

export interface QueueItem {
  id: number;
  displayText: string;
  blocks: ContentBlock[];
}

/**
 * Compact queue panel. Shows pending messages with position numbers,
 * auto-truncated labels, and a "+N more" overflow indicator. Designed
 * to sit beside the chat area like the CompactTodosPanel.
 */
export function QueuePanel({ items }: { items: QueueItem[] }): React.ReactElement {
  const { stdout } = useStdout();
  const w = stdout?.columns ?? 80;
  const h = stdout?.rows ?? 24;

  const avail = Math.max(10, Math.floor(w * 0.3) - 4);
  const labelMax = Math.max(4, avail - 7);

  const trunc = (s: string): string => {
    if (s.length <= labelMax) return s;
    return s.slice(0, labelMax - 1) + '\u2026';
  };

  const OVERHEAD = 7;
  const maxVisible = Math.max(4, h - OVERHEAD);
  const visible = items.slice(0, maxVisible);
  const overflow = items.length - visible.length;

  return (
    <Box flexDirection="column" flexGrow={1} borderStyle="round" borderColor="cyan" paddingX={1}>
      <Box flexDirection="column" marginBottom={1}>
        <Box flexDirection="row" gap={1}>
          <Text bold color="cyan">
            QUEUE
          </Text>
          <Text dimColor>
            {items.length}
          </Text>
          {overflow > 0 ? (
            <Text color="cyan">+{overflow}</Text>
          ) : null}
          <Text dimColor>│ F7 to close</Text>
        </Box>
      </Box>

      {items.length === 0 ? (
        <Text dimColor>No queued messages</Text>
      ) : (
        <Box flexDirection="column">
          {visible.map((item, i) => (
            <Box key={item.id} flexDirection="row" flexShrink={0}>
              <Text dimColor>{String(i + 1).padStart(2)}.</Text>
              <Text dimColor> {trunc(item.displayText)}</Text>
            </Box>
          ))}
          {overflow > 0 ? (
            <Box flexDirection="row" flexShrink={0} marginTop={0}>
              <Text dimColor>…</Text>
              <Text dimColor> +{overflow} more</Text>
            </Box>
          ) : null}
        </Box>
      )}
    </Box>
  );
}
