import { Box, Text } from 'ink';
import type React from 'react';

/** Selectable presets for the auto-proceed delay, so the field is fully
 *  keyboard-cyclable (←/→) instead of needing typed numeric input. */
export const DELAY_PRESETS_MS = [0, 15_000, 30_000, 45_000, 60_000, 120_000];
export const SETTINGS_MODES = ['off', 'suggest', 'auto'] as const;
export type SettingsMode = (typeof SETTINGS_MODES)[number];

export const LOG_LEVELS = ['error', 'warn', 'info', 'debug', 'trace'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export const AUDIT_LEVELS = ['minimal', 'standard', 'full'] as const;
export type AuditLevel = (typeof AUDIT_LEVELS)[number];

export const COMPACTOR_STRATEGIES = ['hybrid', 'intelligent', 'selective'] as const;
export type CompactorStrategy = (typeof COMPACTOR_STRATEGIES)[number];

/** Presets for max iterations — cyclable via ←/→. 0 = unlimited. */
export const MAX_ITERATIONS_PRESETS = [100, 200, 500, 1000, 0];

/** Presets for prompt refinement preview countdown. */
export const ENHANCE_DELAY_PRESETS = [30_000, 45_000, 60_000, 90_000, 120_000];

export function formatSettingsDelay(ms: number): string {
  if (ms === 0) return 'disabled';
  if (ms >= 60_000) return `${Math.round(ms / 60_000)}m`;
  return `${Math.round(ms / 1000)}s`;
}

export function formatMaxIterations(n: number): string {
  if (n === 0) return 'unlimited';
  return String(n);
}

export function formatEnhanceDelay(ms: number): string {
  return `${Math.round(ms / 1000)}s`;
}

const MODE_DESC: Record<SettingsMode, string> = {
  off: 'Agent stops after each turn (normal)',
  suggest: 'Shows next-step suggestions after each turn',
  auto: 'Self-driving — agent continues automatically',
};

export interface SettingsPickerProps {
  /** Focused row index. */
  field: number;
  // ── Autonomy ──
  mode: SettingsMode;
  delayMs: number;
  // ── UX ──
  titleAnimation: boolean;
  yolo: boolean;
  streamFleet: boolean;
  chime: boolean;
  confirmExit: boolean;
  nextPrediction: boolean;
  // ── Features ──
  featureMcp: boolean;
  featurePlugins: boolean;
  featureMemory: boolean;
  featureSkills: boolean;
  featureModelsRegistry: boolean;
  // ── Context ──
  contextAutoCompact: boolean;
  contextStrategy: CompactorStrategy;
  // ── Logging ──
  logLevel: LogLevel;
  // ── Session ──
  auditLevel: AuditLevel;
  // ── Indexing ──
  indexOnStart: boolean;
  // ── Tools ──
  maxIterations: number;
  /** Prompt refinement preview countdown (ms). Cycled via ENHANCE_DELAY_PRESETS. */
  enhanceDelayMs: number;
  hint?: string | undefined;
}

/** Total number of settings rows (used for wrap-around navigation). */
export const SETTINGS_FIELD_COUNT = 20;

export function SettingsPicker({
  field,
  mode,
  delayMs,
  titleAnimation,
  yolo,
  streamFleet,
  chime,
  confirmExit,
  nextPrediction,
  featureMcp,
  featurePlugins,
  featureMemory,
  featureSkills,
  featureModelsRegistry,
  contextAutoCompact,
  contextStrategy,
  logLevel,
  auditLevel,
  indexOnStart,
  maxIterations,
  enhanceDelayMs,
  hint,
}: SettingsPickerProps): React.ReactElement {
  const boolVal = (v: boolean) => (v ? 'on' : 'off');

  interface Row {
    section?: string | undefined;
    label?: string | undefined;
    value?: string | undefined;
    detail?: string | undefined;
  }

  const rows: Row[] = [
    // ── Autonomy ──
    { section: 'Autonomy' },
    { label: 'Default autonomy mode', value: mode, detail: MODE_DESC[mode] },
    {
      label: 'Auto-proceed delay',
      value: formatSettingsDelay(delayMs),
      detail: 'Wait before auto-continuing in auto mode',
    },
    // ── UX ──
    { section: 'UX' },
    {
      label: 'Terminal title animation',
      value: boolVal(titleAnimation),
      detail: 'Animated window/tab title with status',
    },
    {
      label: 'YOLO mode',
      value: boolVal(yolo),
      detail: 'Skip all confirmation prompts',
    },
    {
      label: 'Stream fleet to chat',
      value: boolVal(streamFleet),
      detail: 'Show subagent messages in main chat',
    },
    {
      label: 'Completion chime',
      value: boolVal(chime),
      detail: 'Play a sound when agent finishes',
    },
    {
      label: 'Confirm before exit',
      value: boolVal(confirmExit),
      detail: 'Confirmation on Esc interrupt & Ctrl+C exit',
    },
    {
      label: 'Next-step prediction',
      value: boolVal(nextPrediction),
      detail: 'Show LLM-predicted next steps (/next)',
    },
    // ── Features ──
    { section: 'Features' },
    {
      label: 'MCP servers',
      value: boolVal(featureMcp),
      detail: 'Load MCP servers from config',
    },
    {
      label: 'Plugins',
      value: boolVal(featurePlugins),
      detail: 'Load npm plugins from config',
    },
    {
      label: 'Memory',
      value: boolVal(featureMemory),
      detail: 'Enable remember/forget tools',
    },
    {
      label: 'Skills',
      value: boolVal(featureSkills),
      detail: 'Discover and load skills from disk',
    },
    {
      label: 'Models registry',
      value: boolVal(featureModelsRegistry),
      detail: 'Fetch models.dev catalog at startup',
    },
    // ── Context ──
    { section: 'Context' },
    {
      label: 'Auto-compact',
      value: boolVal(contextAutoCompact),
      detail: 'Auto-compact context when thresholds crossed',
    },
    {
      label: 'Compactor strategy',
      value: contextStrategy,
      detail: 'hybrid (fast) | intelligent (LLM) | selective',
    },
    // ── Logging ──
    { section: 'Logging' },
    {
      label: 'Log level',
      value: logLevel,
      detail: 'Console log verbosity',
    },
    // ── Session ──
    { section: 'Session' },
    {
      label: 'Audit level',
      value: auditLevel,
      detail: 'minimal | standard | full (large)',
    },
    // ── Indexing ──
    { section: 'Indexing' },
    {
      label: 'Index on session start',
      value: boolVal(indexOnStart),
      detail: 'Run incremental index at session start',
    },
    // ── Tools ──
    { section: 'Tools' },
    {
      label: 'Max iterations',
      value: formatMaxIterations(maxIterations),
      detail: '100–1000 or unlimited (0)',
    },
    {
      label: 'Refine preview countdown',
      value: formatEnhanceDelay(enhanceDelayMs),
      detail: 'Timeout for prompt refinement preview (30s–120s)',
    },
  ];

  // Build field → row index mapping. `rows` includes section headers
  // that are NOT counted by `field`; without this mapping the highlight
  // lands on the wrong row (or never shows on the first field).
  const fieldRowIndex: number[] = [];
  for (let i = 0; i < rows.length; i++) {
    if (!rows[i]?.section) fieldRowIndex.push(i);
  }

  // Compute visible window. On small terminals, the picker can overflow;
  // we show at most VISIBLE_FIELDS around the current selection so every
  // field stays reachable.
  const VISIBLE_FIELDS = 8;
  const totalFields = fieldRowIndex.length; // = SETTINGS_FIELD_COUNT = 19
  const windowStart =
    totalFields <= VISIBLE_FIELDS
      ? 0
      : Math.max(0, Math.min(field - Math.floor(VISIBLE_FIELDS / 2), totalFields - VISIBLE_FIELDS));
  const windowEnd = Math.min(windowStart + VISIBLE_FIELDS, totalFields);
  const hasAbove = windowStart > 0;
  const hasBelow = windowEnd < totalFields;

  // Build section → field range map so we can decide whether to show
  // a section header (show it when ANY of its fields are in the window).
  const sectionFields: Array<{ headerIdx: number; fieldStart: number; fieldEnd: number }> = [];
  let curHeader = -1;
  for (let i = 0; i < rows.length; i++) {
    if (rows[i]?.section) curHeader = i;
    else if (curHeader >= 0) {
      const fieldIdx = fieldRowIndex.indexOf(i);
      if (fieldIdx === -1) continue;
      const entry = sectionFields.find((s) => s.headerIdx === curHeader);
      if (entry) {
        entry.fieldEnd = fieldIdx + 1;
      } else {
        sectionFields.push({ headerIdx: curHeader, fieldStart: fieldIdx, fieldEnd: fieldIdx + 1 });
      }
    }
  }
  const shouldShowSection = (headerIdx: number): boolean => {
    const sec = sectionFields.find((s) => s.headerIdx === headerIdx);
    if (!sec) return false;
    return sec.fieldStart < windowEnd && sec.fieldEnd > windowStart;
  };

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
      <Text color="cyan" bold>
        ━━ Settings ━━
      </Text>
      <Text dimColor>↑/↓ field · ←/→ change (instant save) · Esc close</Text>
      {hasAbove ? (
        <Text dimColor>{`  ↑ ${windowStart} field${windowStart === 1 ? '' : 's'} above`}</Text>
      ) : null}
      {rows.map((row, i) => {
        const fieldAtRow = fieldRowIndex.indexOf(i);
        // Section headers are always shown when they fall between visible fields.
        // Non-section rows are only shown when their field index is in the window.
        if (fieldAtRow === -1) {
          // Section header — show when any of its fields are in the window.
          if (shouldShowSection(i)) {
            return (
              <Text key={`section-${row.section ?? i}`} bold color="green">
                ── {row.section} ──
              </Text>
            );
          }
          return null;
        }
        if (fieldAtRow < windowStart || fieldAtRow >= windowEnd) return null;
        const selected = fieldAtRow === field;
        return (
          <Text key={`row-${row.label ?? fieldAtRow}`} inverse={selected} {...(selected ? { color: 'yellow' } : {})}>
            {selected ? '› ' : '  '}
            <Text bold>{(row.label ?? '').padEnd(26)}</Text>
            <Text color="cyan">{String(row.value ?? '').padEnd(12)}</Text>
            <Text dimColor>{row.detail ?? ''}</Text>
          </Text>
        );
      })}
      {hasBelow ? (
        <Text dimColor>{`  ↓ ${totalFields - windowEnd} field${totalFields - windowEnd === 1 ? '' : 's'} below`}</Text>
      ) : null}
      <Text dimColor>Persisted to ~/.wrongstack/config.json</Text>
      {hint ? <Text color="yellow">{hint}</Text> : null}
    </Box>
  );
}
