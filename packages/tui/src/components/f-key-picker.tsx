import { Box, Text } from '../ink.js';
import type React from 'react';
import { F_KEY_PANEL_ENTRIES } from '../f-key-panels.js';

export { F_KEY_PANEL_ENTRIES as F_KEY_ENTRIES } from '../f-key-panels.js';
export type { FKeyPanelEntry as FKeyEntry } from '../f-key-panels.js';

export interface FKeyPickerProps {
  selected: number;
}

/**
 * Keyboard-navigable F-key panel picker.
 * Shown when the user types `/f` in the TUI.
 * Arrow keys navigate, Enter opens the selected panel, Esc closes.
 */
export function FKeyPicker({ selected }: FKeyPickerProps): React.ReactElement {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1} flexShrink={0}>
      <Text color="cyan" bold>
        ━━ F-Key Panels ━━
      </Text>
      <Text dimColor>↑↓ navigate · Enter open · Esc close</Text>

      {F_KEY_PANEL_ENTRIES.map((entry) => {
        const idx = entry.key - 1;
        const isSelected = idx === selected;
        const marker = isSelected ? '▸' : ' ';
        const labelColor = isSelected ? 'cyan' : undefined;

        return (
          <Box key={entry.key}>
            <Box width={4} flexShrink={0}>
              <Text color="dimColor">{marker}</Text>
            </Box>
            <Text color="dimColor">
              F{entry.key}
            </Text>
            <Text>  </Text>
            <Text color={labelColor}>{entry.label}</Text>
          </Box>
        );
      })}

      {selected > 0 ? (
        <Text dimColor>↑ Scroll up</Text>
      ) : null}
      {selected < 11 ? (
        <Text dimColor>↓ Scroll down</Text>
      ) : null}
    </Box>
  );
}
