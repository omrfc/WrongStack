import { Box, Text } from '../ink.js';
import type React from 'react';

/** All possible statusline chip keys. */
export type StatuslineItem =
  | 'version'
  | 'state'
  | 'model'
  | 'tokens'
  | 'cache'
  | 'queue'
  | 'processes'
  | 'hint'
  | 'index'
  | 'breaker'
  | 'todos'
  | 'plan'
  | 'tasks'
  | 'fleet'
  | 'fleet_agents'
  | 'git'
  | 'elapsed'
  | 'context'
  | 'cost'
  | 'working_dir'
  | 'project'
  | 'yolo'
  | 'autonomy'
  | 'eternal_stage'
  | 'goal'
  | 'mode'
  | 'auto_proceed'
  | 'sessions'
  | 'tools'
  | 'token_saving'
  | 'brain'
  | 'mailbox'
  | 'enhance'
  | 'debug_stream'
  | 'next_steps';

/**
 * Metadata for a temporarily-visible chip (one that appeared due to data,
 * not user toggle). Tracked so the chip can auto-expire.
 */
export interface ChipMeta {
  key: StatuslineItem;
  /** Unix timestamp (ms) when the chip was shown. */
  shownAt: number;
  /**
   * Optional expiration time in minutes. Null/undefined = permanent (only
   * hidden when user toggles it off). Stream chips get a default 5 min.
   */
  expiresIn?: number;
}

/** Default expiration for stream-triggered chips (5 minutes). */
export const STREAM_CHIP_EXPIRES_IN_MINUTES = 5;

/**
 * Returns true if a chip with the given metadata has expired.
 * Chips with no `expiresIn` never expire on their own.
 */
export function isChipExpired(meta: ChipMeta, now = Date.now()): boolean {
  if (meta.expiresIn == null || meta.expiresIn === 0) return false;
  if (meta.shownAt == null || meta.shownAt === 0) return false;
  return now >= meta.shownAt + meta.expiresIn * 60 * 1000;
}

/**
 * Returns a human-readable countdown label for a chip with expiration.
 * Returns null if the chip has no expiration or has already expired.
 */
export function getExpiresInLabel(meta: ChipMeta, now = Date.now()): string | null {
  if (meta.expiresIn == null || meta.expiresIn === 0 || meta.shownAt == null) return null;
  const remainingMs = meta.shownAt + meta.expiresIn * 60 * 1000 - now;
  if (remainingMs <= 0) return null;
  if (remainingMs < 60_000) return 'expires in <1 m';
  const remainingMin = Math.ceil(remainingMs / 60_000);
  return `expires in ${remainingMin} m`;
}

/** Item descriptions for display. */
const ITEM_DESCRIPTIONS: Record<StatuslineItem, string> = {
  version: 'WrongStack version chip',
  state: 'Agent run state / thinking spinner',
  model: 'Current provider/model id',
  tokens: 'Input/output token counters',
  cache: 'Prompt cache hit ratio',
  queue: 'Queued prompt count',
  processes: 'Tracked shell/process count',
  hint: 'Transient status hint text',
  index: 'Codebase indexing status',
  breaker: 'Process breaker countdown',
  todos: 'Todo items (pending/in-progress/done)',
  plan: 'Plan board items',
  tasks: 'Task board items',
  fleet: 'Fleet agent status',
  fleet_agents: 'Per-agent live detail row',
  git: 'Git branch name',
  elapsed: 'Session elapsed time',
  context: 'Context window usage %',
  cost: 'Token cost estimate',
  working_dir: 'Current working directory',
  project: 'Project name',
  yolo: 'YOLO permission mode',
  autonomy: 'Autonomy mode',
  eternal_stage: 'Autonomy stage',
  goal: 'Active goal summary',
  mode: 'Active agent mode label',
  auto_proceed: 'Auto-proceed countdown',
  sessions: 'Live session count',
  tools: 'Registered tool count',
  token_saving: 'Token-saving mode indicator',
  brain: 'Brain arbiter decisions',
  mailbox: 'Mailbox unread messages',
  enhance: 'Prompt-enhance countdown',
  debug_stream: 'Stream debug telemetry',
  next_steps: 'Next-step auto-submit countdown',
};

/**
 * Which TUI status bar line each chip appears on. Used to group chips
 * visually in the picker. MUST mirror the actual render lines in
 * `status-bar.tsx`: line 1 = runtime essentials, line 2 = session context,
 * line 3 = active work, line 4 = mailbox + fleet-agent detail. Exported so
 * the navigation-order test guards against drift instead of duplicating it.
 */
export const ITEM_LINE: Record<StatuslineItem, number> = {
  breaker: 1,
  cache: 1,
  context: 1,
  cost: 1,
  hint: 1,
  index: 1,
  model: 1,
  processes: 1,
  queue: 1,
  state: 1,
  tokens: 1,
  version: 1,
  auto_proceed: 2,
  autonomy: 2,
  elapsed: 2,
  eternal_stage: 2,
  git: 2,
  goal: 2,
  mode: 2,
  project: 2,
  sessions: 2,
  token_saving: 2,
  tools: 2,
  working_dir: 2,
  yolo: 2,
  brain: 3,
  debug_stream: 3,
  enhance: 3,
  fleet: 3,
  next_steps: 3,
  todos: 3,
  plan: 3,
  tasks: 3,
  fleet_agents: 4,
  mailbox: 4,
};

export interface StatuslinePickerProps {
  /** Focused field index. */
  field: number;
  /** Current hidden-items list. */
  hiddenItems: StatuslineItem[];
  /** Temporarily-visible chips with expiration metadata. */
  visibleChips?: ChipMeta[] | undefined;
  /** Optional hint message from the reducer. */
  hint?: string | undefined;
}

/** Total number of statusline fields. */
export const STATUSLINE_FIELD_COUNT = Object.keys(ITEM_LINE).length;

/** Ordered list of statusline items — grouped by display line, then alphabetically within each line for consistent navigation. */
export const STATUSLINE_ITEMS: StatuslineItem[] = [
  // Line 1
  'breaker',
  'cache',
  'context',
  'cost',
  'hint',
  'index',
  'model',
  'processes',
  'queue',
  'state',
  'tokens',
  'version',
  // Line 2
  'auto_proceed',
  'autonomy',
  'elapsed',
  'eternal_stage',
  'git',
  'goal',
  'mode',
  'project',
  'sessions',
  'token_saving',
  'tools',
  'working_dir',
  'yolo',
  // Line 3
  'brain',
  'debug_stream',
  'enhance',
  'fleet',
  'next_steps',
  'plan',
  'tasks',
  'todos',
  // Line 4
  'fleet_agents',
  'mailbox',
];

/** Stream-triggered chips — these auto-expire unless the user has toggled them on permanently. */
export const STREAM_CHIP_KEYS: StatuslineItem[] = ['brain', 'mailbox', 'enhance', 'debug_stream'];

/** Group items by their display line (1-4). */
function groupByLine(items: StatuslineItem[]): Map<number, StatuslineItem[]> {
  const map = new Map<number, StatuslineItem[]>();
  for (const item of items) {
    const line = ITEM_LINE[item];
    if (!map.has(line)) map.set(line, []);
    map.get(line)!.push(item);
  }
  return map;
}

export function StatuslinePicker({
  field,
  hiddenItems,
  visibleChips = [],
  hint,
}: StatuslinePickerProps): React.ReactElement {
  const hiddenSet = new Set(hiddenItems);
  const visibleChipsMap = new Map(visibleChips.map((c) => [c.key, c]));
  const totalFields = STATUSLINE_ITEMS.length;

  const byLine = groupByLine(STATUSLINE_ITEMS);

  // Build section-aware row list: section headers + items.
  interface Row {
    section?: string | undefined;
    item?: StatuslineItem | undefined;
    fieldIdx?: number | undefined;
  }

  const rows: Row[] = [];
  for (const [line, items] of [...byLine.entries()].sort((a, b) => a[0] - b[0])) {
    rows.push({ section: `Line ${line}` });
    for (const item of items) {
      const fieldIdx = STATUSLINE_ITEMS.indexOf(item);
      rows.push({ item, fieldIdx });
    }
  }

  // Compute which field indices are visible in the window.
  const VISIBLE_FIELDS = 7;
  const windowStart = Math.max(0, Math.min(field - Math.floor(VISIBLE_FIELDS / 2), totalFields - VISIBLE_FIELDS));
  const windowEnd = Math.min(windowStart + VISIBLE_FIELDS, totalFields);
  const hasAbove = windowStart > 0;
  const hasBelow = windowEnd < totalFields;

  const boolVal = (item: StatuslineItem): string => {
    if (hiddenSet.has(item)) return 'off';
    if (STREAM_CHIP_KEYS.includes(item)) {
      const meta = visibleChipsMap.get(item);
      if (!meta) return 'auto';
      if (meta.expiresIn == null) return 'on '; // permanently shown
      const remainingMs = meta.shownAt + meta.expiresIn * 60_000 - Date.now();
      if (remainingMs <= 0) return 'auto';
      const remainingMin = Math.max(1, Math.ceil(remainingMs / 60_000));
      return `~${remainingMin}m`;
    }
    return 'on ';
  };
  const valColor = (item: StatuslineItem) => {
    if (hiddenSet.has(item)) return 'red';
    if (STREAM_CHIP_KEYS.includes(item)) {
      const meta = visibleChipsMap.get(item);
      if (!meta) return 'cyan';
      if (isChipExpired(meta)) return 'cyan';
      return 'yellow'; // stream chip active — yellow to signal it may disappear
    }
    return 'green';
  };

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
      <Text color="cyan" bold>
        ━━ Statusline ━━
      </Text>
      <Text dimColor>↑/↓ move · ←/→ toggle · Esc to close</Text>
      {hasAbove ? (
        <Text dimColor>{`  ↑ ${windowStart} item${windowStart === 1 ? '' : 's'} above`}</Text>
      ) : null}
      {rows.map((row) => {
        if (row.section) {
          return (
            <Text key={`section-${row.section}`} bold color="green">
              ── {row.section} ──
            </Text>
          );
        }
        const item = row.item!;
        const fieldIdx = row.fieldIdx!;
        const selected = fieldIdx === field;
        return (
          <Text key={`row-${item}`} inverse={selected} {...(selected ? { color: 'yellow' } : {})}>
            {selected ? '› ' : '  '}
            <Text bold>{(item as string).padEnd(12)}</Text>
            <Text color={valColor(item)}>{boolVal(item).padEnd(4)}</Text>
            <Text dimColor>{ITEM_DESCRIPTIONS[item]}</Text>
            {selected ? (
              <Text dimColor>  ←/→ toggle</Text>
            ) : null}
          </Text>
        );
      })}
      {hasBelow ? (
        <Text dimColor>{`  ↓ ${totalFields - windowEnd} item${totalFields - windowEnd === 1 ? '' : 's'} below`}</Text>
      ) : null}
      <Text dimColor>Changes apply instantly · persisted to ~/.wrongstack/statusline.json · auto chips show when data exists</Text>
      {hint ? <Text color="yellow">{hint}</Text> : null}
    </Box>
  );
}
