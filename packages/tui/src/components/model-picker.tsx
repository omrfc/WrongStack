import { Box, Text } from 'ink';
import type React from 'react';

export interface ProviderOption {
  id: string;
  family: string;
  /** Model ids the picker offers in step 2 for this provider. */
  models: string[];
  /** Optional dim hint shown next to the model list (e.g. "from saved config"). */
  modelsLabel?: string;
}

export interface ModelPickerProps {
  step: 'provider' | 'model';
  providerOptions: ProviderOption[];
  modelOptions: string[];
  selected: number;
  pickedProviderId?: string;
  /** Status hint (e.g. error from a failed switch attempt) shown at the bottom. */
  hint?: string;
}

/**
 * Two-step Ink overlay for the TUI's `/model` command.
 *   Step 1: pick a provider that has a key.
 *   Step 2: pick a model bound to that provider.
 *
 * Driven entirely by props — App owns the cursor state and key events.
 * Render is intentionally compact; the host frames it in a single Box.
 */
export function ModelPicker({
  step,
  providerOptions,
  modelOptions,
  selected,
  pickedProviderId,
  hint,
}: ModelPickerProps): React.ReactElement {
  if (step === 'provider') {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text color="cyan" bold>
          ━━ Switch model — Step 1/2: Pick provider ━━
        </Text>
        <Text dimColor>↑/↓ navigate · Enter select · Esc cancel · Ctrl+C exit</Text>
        {providerOptions.length === 0 ? (
          <Text dimColor>(no providers with keys — add one via `wstack auth`)</Text>
        ) : (
          providerOptions.map((p, i) => (
            <Text key={p.id} color={i === selected ? 'cyan' : undefined} inverse={i === selected}>
              {i === selected ? '› ' : '  '}
              <Text bold>{p.id.padEnd(28)}</Text>
              <Text dimColor> [{p.family}]</Text>
              <Text dimColor>
                {' '}
                {p.models.length} model{p.models.length === 1 ? '' : 's'}
              </Text>
            </Text>
          ))
        )}
        {hint ? <Text color="yellow">{hint}</Text> : null}
      </Box>
    );
  }
  return (
    <Box flexDirection="column" paddingX={1}>
      <Text color="cyan" bold>
        ━━ Switch model — Step 2/2: Pick model ({pickedProviderId}) ━━
      </Text>
      <Text dimColor>↑/↓ navigate · Enter select · Esc back · Ctrl+C exit</Text>
      {modelOptions.length === 0 ? (
        <Text dimColor>(no models known for this provider)</Text>
      ) : (
        modelOptions.map((id, i) => (
          <Text key={id} color={i === selected ? 'cyan' : undefined} inverse={i === selected}>
            {i === selected ? '› ' : '  '}
            {id}
          </Text>
        ))
      )}
      {hint ? <Text color="yellow">{hint}</Text> : null}
    </Box>
  );
}
