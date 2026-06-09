import { Box, Text } from '../ink.js';
import type React from 'react';

export interface ProviderOption {
  id: string;
  family: string;
  /** Model ids the picker offers in step 2 for this provider. */
  models: string[];
  /** Optional dim hint shown next to the model list (e.g. "from saved config"). */
  modelsLabel?: string | undefined;
}

export interface ModelPickerProps {
  step: 'provider' | 'model';
  providerOptions: ProviderOption[];
  /** All model options for the current provider. */
  modelOptions: string[];
  /** Filtered/searched model options (may differ when searchQuery is active). */
  filteredOptions: string[];
  selected: number;
  pickedProviderId?: string | undefined;
  /** Current search query (step 2 only). */
  searchQuery?: string | undefined;
  /** Status hint (e.g. error from a failed switch attempt) shown at the bottom. */
  hint?: string | undefined;
}

const MAX_VISIBLE = 10;

/** Compute the visible window, keeping `selected` centered when possible. */
function getVisibleWindow(selected: number, total: number): { start: number; end: number } {
  const half = Math.floor(MAX_VISIBLE / 2);
  let start = selected - half;
  let end = start + MAX_VISIBLE;
  if (start < 0) { start = 0; end = Math.min(total, MAX_VISIBLE); }
  if (end > total) { end = total; start = Math.max(0, end - MAX_VISIBLE); }
  return { start, end };
}

/**
 * Two-step Ink overlay for the TUI's `/model` command.
 *   Step 1: pick a provider that has a key.
 *   Step 2: pick a model bound to that provider (type to filter).
 *
 * Driven entirely by props — App owns cursor state, key events, and search.
 */
export function ModelPicker({
  step,
  providerOptions,
  filteredOptions,
  selected,
  pickedProviderId,
  searchQuery,
  hint,
}: ModelPickerProps): React.ReactElement {
  if (step === 'provider') {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
        <Text color="cyan" bold>
          {'━━ Switch model — Step 1/2: Pick provider ━━'}
        </Text>
        <Text dimColor>↑/↓ navigate · Enter select · Esc cancel · Ctrl+C exit</Text>
        {providerOptions.length === 0 ? (
          <Text dimColor>(no providers with keys — add one via `wstack auth`)</Text>
        ) : (
          providerOptions.map((p, i) => (
            <Text key={p.id} inverse={i === selected} {...(i === selected ? { color: 'cyan' } : {})}>
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

  // ── Step 2: model picker with scroll window + search ───────────────────────
  const total = filteredOptions.length;
  const { start, end } = getVisibleWindow(selected, total);
  const visibleItems = filteredOptions.slice(start, end);

  const searchHint = searchQuery
    ? ` | filter:"${searchQuery}" → ${total} match${total === 1 ? '' : 'es'}`
    : total > MAX_VISIBLE
      ? ` (${total} models — type to filter)`
      : '';

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
      <Text color="cyan" bold>
        {'━━ Switch model — Step 2/2: Pick model '}({pickedProviderId}
        {searchHint}){' ━━'}
      </Text>
      <Text dimColor>↑/↓ navigate · Enter select · Esc back · Ctrl+C exit · type to filter</Text>
      {total === 0 ? (
        <Text dimColor>
          {searchQuery ? `(no models match "${searchQuery}")` : '(no models known for this provider)'}
        </Text>
      ) : (
        <>
          {start > 0 && (
            <Text dimColor>▲ {start} above</Text>
          )}
          {visibleItems.map((id, vi) => {
            const absoluteIndex = start + vi;
            return (
              <Text
                key={id}
                inverse={absoluteIndex === selected}
                {...(absoluteIndex === selected ? { color: 'cyan' } : {})}
              >
                {absoluteIndex === selected ? '› ' : '  '}
                {id}
              </Text>
            );
          })}
          {end < total && (
            <Text dimColor>▼ {total - end} below</Text>
          )}
        </>
      )}
      {hint ? <Text color="yellow">{hint}</Text> : null}
    </Box>
  );
}
