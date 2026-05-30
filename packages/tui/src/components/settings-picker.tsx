import { Box, Text } from 'ink';
import type React from 'react';

/** Selectable presets for the auto-proceed delay, so the field is fully
 *  keyboard-cyclable (←/→) instead of needing typed numeric input. */
export const DELAY_PRESETS_MS = [0, 15_000, 30_000, 45_000, 60_000, 120_000];
export const SETTINGS_MODES = ['off', 'suggest', 'auto'] as const;
export type SettingsMode = (typeof SETTINGS_MODES)[number];

export function formatSettingsDelay(ms: number): string {
  if (ms === 0) return 'disabled';
  if (ms >= 60_000) return `${Math.round(ms / 60_000)}m`;
  return `${Math.round(ms / 1000)}s`;
}

const MODE_DESC: Record<SettingsMode, string> = {
  off: 'Agent stops after each turn (normal)',
  suggest: 'Shows next-step suggestions after each turn',
  auto: 'Self-driving — agent continues automatically',
};

export interface SettingsPickerProps {
  /** Focused row: 0 = mode, 1 = delay. */
  field: number;
  mode: SettingsMode;
  delayMs: number;
  hint?: string;
}

export function SettingsPicker({
  field,
  mode,
  delayMs,
  hint,
}: SettingsPickerProps): React.ReactElement {
  const rows = [
    { label: 'Default autonomy mode', value: mode, detail: MODE_DESC[mode] },
    {
      label: 'Auto-proceed delay',
      value: formatSettingsDelay(delayMs),
      detail: 'Wait before auto-continuing in auto mode',
    },
  ];
  return (
    <Box flexDirection="column" paddingX={1}>
      <Text color="cyan" bold>
        ━━ Settings ━━
      </Text>
      <Text dimColor>↑/↓ field · ←/→ change · Enter save · Esc cancel</Text>
      {rows.map((row, i) => (
        <Text key={row.label} color={i === field ? 'yellow' : undefined} inverse={i === field}>
          {i === field ? '› ' : '  '}
          <Text bold>{row.label.padEnd(22)}</Text>
          <Text color="cyan">{String(row.value).padEnd(10)}</Text>
          <Text dimColor>{row.detail}</Text>
        </Text>
      ))}
      <Text dimColor>Persisted to ~/.wrongstack/config.json</Text>
      {hint ? <Text color="yellow">{hint}</Text> : null}
    </Box>
  );
}
