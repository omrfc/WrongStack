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

export function formatSettingsDelay(ms: number): string {
  if (ms === 0) return 'disabled';
  if (ms >= 60_000) return `${Math.round(ms / 60_000)}m`;
  return `${Math.round(ms / 1000)}s`;
}

export function formatMaxIterations(n: number): string {
  if (n === 0) return 'unlimited';
  return String(n);
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
  hint?: string;
}

/** Total number of settings rows (used for wrap-around navigation). */
export const SETTINGS_FIELD_COUNT = 19;

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
  hint,
}: SettingsPickerProps): React.ReactElement {
  const boolVal = (v: boolean) => (v ? 'on' : 'off');

  interface Row {
    section?: string;
    label?: string;
    value?: string;
    detail?: string;
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
      detail: 'Ask for confirmation on Ctrl+C exit',
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
  ];

  return (
    <Box flexDirection="column" paddingX={1}>
      <Text color="cyan" bold>
        ━━ Settings ━━
      </Text>
      <Text dimColor>↑/↓ field · ←/→ change · Enter save · Esc cancel</Text>
      {rows.map((row, i) => {
        if (row.section) {
          return (
            <Text key={`section-${i}`} bold color="green">
              ── {row.section} ──
            </Text>
          );
        }
        return (
          <Text key={`row-${i}`} color={i === field ? 'yellow' : undefined} inverse={i === field}>
            {i === field ? '› ' : '  '}
            <Text bold>{(row.label ?? '').padEnd(26)}</Text>
            <Text color="cyan">{String(row.value ?? '').padEnd(12)}</Text>
            <Text dimColor>{row.detail ?? ''}</Text>
          </Text>
        );
      })}
      <Text dimColor>Persisted to ~/.wrongstack/config.json</Text>
      {hint ? <Text color="yellow">{hint}</Text> : null}
    </Box>
  );
}
