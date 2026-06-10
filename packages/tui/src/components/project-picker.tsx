import { Box, Text } from '../ink.js';
import type React from 'react';

/** A single row in the project picker. Matches the CLI's PickerItem shape. */
export interface ProjectPickerItem {
  key: string;
  label: string;
  subtitle?: string | undefined;
  meta?: string | undefined;
  kind: 'project' | 'action';
}

export interface ProjectPickerProps {
  /** Already-filtered items. Navigation indices target this list directly. */
  items: ProjectPickerItem[];
  /** Index into `items`. Guaranteed to never point at a divider. */
  selected: number;
  /** Current filter text (for the filter bar display only). */
  filter: string;
  /** Optional status/error hint shown below the list. */
  hint?: string | undefined;
}

const MAX_VISIBLE = 12;

/**
 * Compute the visible window around `selected` so the cursor stays centered.
 * Returns [start, end) indices into `total`.
 */
function visibleWindow(selected: number, total: number): { start: number; end: number } {
  if (total <= MAX_VISIBLE) return { start: 0, end: total };
  const half = Math.floor(MAX_VISIBLE / 2);
  let start = selected - half;
  let end = start + MAX_VISIBLE;
  if (start < 0) {
    start = 0;
    end = MAX_VISIBLE;
  }
  if (end > total) {
    end = total;
    start = total - MAX_VISIBLE;
  }
  return { start, end };
}

export function ProjectPicker({
  items,
  selected,
  filter,
  hint,
}: ProjectPickerProps): React.ReactElement {
  const total = items.length;
  const { start, end } = visibleWindow(selected, total);
  const visible = items.slice(start, end);

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1} flexShrink={0}>
      <Text color="cyan" bold>
        ━━ Switch Project ━━
      </Text>

      {filter ? (
        <Box>
          <Text color="yellow">Filter: </Text>
          <Text>{filter}</Text>
          <Text dimColor>█</Text>
        </Box>
      ) : (
        <Text dimColor>
          type to filter · ↑↓ navigate · Enter select · Esc cancel
        </Text>
      )}

      {/* Scroll indicator — top */}
      {start > 0 ? (
        <Text dimColor>
          ↑ {start} more above
        </Text>
      ) : null}

      {visible.map((item) => {
        const idx = items.indexOf(item);
        const isSelected = idx === selected;
        const isDivider = item.key === '__divider__';

        if (isDivider) {
          return (
            <Text key={item.key} dimColor>
              {'─'.repeat(36)}
            </Text>
          );
        }

        const marker = isSelected ? '▸' : ' ';
        const labelColor = isSelected ? 'cyan' : undefined;
        const metaColor = 'grey';

        return (
          <Box key={item.key} flexDirection="column">
            <Box>
              <Text inverse={isSelected} color={labelColor}>
                {` ${marker} `}
                <Text bold={isSelected}>{item.label}</Text>
              </Text>
              {item.meta ? (
                <Text dimColor={!isSelected} color={isSelected ? 'cyan' : metaColor}>
                  {'  '}
                  {item.meta}
                </Text>
              ) : null}
            </Box>
            {item.subtitle ? (
              <Text dimColor={!isSelected} color={isSelected ? 'cyan' : metaColor}>
                {'     '}
                {item.subtitle}
              </Text>
            ) : null}
          </Box>
        );
      })}

      {/* Scroll indicator — bottom */}
      {end < total ? (
        <Text dimColor>
          ↓ {total - end} more below · {total} total
        </Text>
      ) : null}

      {hint ? (
        <Box marginTop={1}>
          <Text color="yellow">{hint}</Text>
        </Box>
      ) : null}
    </Box>
  );
}
