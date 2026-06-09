import { Box, Text } from '../../ink.js';
import * as path from 'node:path';
import type React from 'react';
import type { HistoryEntry } from './types.js';
import { shortenPath } from './utils.js';

/**
 * Startup splash. Renders into the Static area on mount and never
 * re-renders, so it's safe to use rich layout without worrying about
 * Ink's redraw cursor math.
 */
export function Banner({
  entry,
}: {
  entry: Extract<HistoryEntry, { kind: 'banner' }>;
}): React.ReactElement {
  const cwdShort = shortenPath(entry.cwd, 48);
  const projectLabel = path.basename(entry.cwd);
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="magenta" paddingX={2} paddingY={0}>
      <Text>
        <Text color="magenta" bold>
          {'  ▟▛  '}
        </Text>
        <Text color="magenta" bold>
          {projectLabel}
        </Text>
        <Text dimColor>{'  v'}</Text>
        <Text>{entry.version}</Text>
      </Text>
      <Text dimColor italic>
        {'      Built on the wrong stack. Shipped anyway.'}
      </Text>
      <Text>
        <Text color="cyan">{'      provider  '}</Text>
        <Text>
          {entry.provider}/{entry.model}
        </Text>
      </Text>
      {entry.family ? (
        <Text>
          <Text color="cyan">{'      family    '}</Text>
          <Text dimColor>{entry.family}</Text>
        </Text>
      ) : null}
      {entry.keyTail ? (
        <Text>
          <Text color="cyan">{'      key       '}</Text>
          <Text dimColor>{'●●●…'}</Text>
          <Text>{entry.keyTail}</Text>
        </Text>
      ) : null}
      <Text>
        <Text color="cyan">{'      cwd       '}</Text>
        <Text dimColor>{cwdShort}</Text>
      </Text>
      <Text>
        <Text color="cyan">{'      hints     '}</Text>
        <Text dimColor>/help · /init · /memory · /queue · /exit</Text>
      </Text>
    </Box>
  );
}
