import { Box, Text, useInput } from '../ink.js';
import type React from 'react';

export interface CheckpointTimelineProps {
  checkpoints: Array<{
    promptIndex: number;
    promptPreview: string;
    ts: string;
    fileCount: number;
  }>;
  selected: number;
  onSelect: (index: number) => void;
  onConfirm: (index: number) => void;
  onClose: () => void;
}

/**
 * Full-screen checkpoint timeline overlay for the /rewind command.
 * Arrow keys to navigate, Enter to rewind to selected, Esc to close.
 */
export function CheckpointTimeline({
  checkpoints,
  selected,
  onSelect,
  onConfirm,
  onClose,
}: CheckpointTimelineProps): React.ReactElement {
  useInput((_, key) => {
    if (key.escape) {
      onClose();
    } else if (key.upArrow) {
      onSelect(Math.max(0, selected - 1));
    } else if (key.downArrow) {
      onSelect(Math.min(checkpoints.length - 1, selected + 1));
    } else if (key.return) {
      onConfirm(selected);
    }
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" padding={1}>
      <Box marginBottom={1}>
        <Text bold color="cyan">
          ⟲ Session Rewind
        </Text>
        <Text dimColor> — ↑/↓ navigate · Enter rewind · Esc cancel</Text>
      </Box>
      {checkpoints.length === 0 ? (
        <Text dimColor>No checkpoints in this session.</Text>
      ) : (
        checkpoints.map((cp, i) => {
          const isSelected = i === selected;
          const label = `[${cp.promptIndex}] ${cp.promptPreview}`;
          return (
            <Box key={cp.promptIndex}>
              <Text bold={isSelected} {...(isSelected ? { color: 'cyan' } : {})}>
                {isSelected ? '▸ ' : '  '}
              </Text>
              <Text bold={isSelected} {...(isSelected ? { color: 'cyan' } : {})}>
                {label}
              </Text>
              <Text dimColor> {new Date(cp.ts).toLocaleTimeString()}</Text>
              {cp.fileCount > 0 && (
                <Text dimColor>
                  {' '}
                  · {cp.fileCount} file{cp.fileCount !== 1 ? 's' : ''}
                </Text>
              )}
            </Box>
          );
        })
      )}
    </Box>
  );
}
