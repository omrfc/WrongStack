import { Box, Text } from 'ink';
import type React from 'react';

export interface AutonomyOption {
  mode: 'off' | 'suggest' | 'auto' | 'eternal' | 'eternal-parallel';
  label: string;
  description: string;
  color: string;
}

export interface AutonomyPickerProps {
  options: AutonomyOption[];
  selected: number;
  hint?: string;
}

export const AUTONOMY_OPTIONS: AutonomyOption[] = [
  { mode: 'off', label: 'OFF', description: 'Agent stops after each turn (normal interactive mode)', color: 'green' },
  { mode: 'suggest', label: 'SUGGEST', description: 'Shows next-step suggestions after each turn', color: 'cyan' },
  { mode: 'auto', label: 'AUTO', description: 'Self-driving — agent picks next step and continues', color: 'yellow' },
  { mode: 'eternal', label: 'ETERNAL', description: 'Goal-driven loop — requires /goal set first', color: 'red' },
  { mode: 'eternal-parallel', label: 'PARALLEL', description: 'Fan-out 4–8 subagents per tick — requires /goal', color: 'magenta' },
];

export function AutonomyPicker({ options, selected, hint }: AutonomyPickerProps): React.ReactElement {
  return (
    <Box flexDirection="column" paddingX={1}>
      <Text color="cyan" bold>
        ━━ Autonomy Mode ━━
      </Text>
      <Text dimColor>↑/↓ navigate · Enter select · Esc cancel · Ctrl+C exit</Text>
      {options.map((opt, i) => (
        <Text key={opt.mode} color={i === selected ? opt.color : undefined} inverse={i === selected}>
          {i === selected ? '› ' : '  '}
          <Text bold>{opt.label.padEnd(12)}</Text>
          <Text dimColor>{opt.description}</Text>
        </Text>
      ))}
      {hint ? <Text color="yellow">{hint}</Text> : null}
    </Box>
  );
}