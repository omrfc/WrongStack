import { Box, Text } from '../ink.js';
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

/** Context window mode options — cyclable via ←/→. */
export const CONTEXT_MODES = ['balanced', 'frugal', 'deep', 'archival'] as const;
export type ContextMode = (typeof CONTEXT_MODES)[number];

export const CONTEXT_MODE_DESCS: Record<ContextMode, string> = {
  balanced: 'Normal context usage (default)',
  frugal: 'Conservative token use',
  deep: 'Larger context for complex tasks',
  archival: 'Maximize context retention',
};

export const STATUSLINE_MODES = ['minimum', 'detailed'] as const;
export type StatuslineMode = (typeof STATUSLINE_MODES)[number];

export const REASONING_MODES = ['auto', 'on', 'off'] as const;
export type ReasoningMode = (typeof REASONING_MODES)[number];

export const REASONING_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

export const CACHE_TTLS = ['default', '5m', '1h'] as const;
export type CacheTtl = (typeof CACHE_TTLS)[number];

export const STATUSLINE_MODE_DESCS: Record<StatuslineMode, string> = {
  minimum: 'Single line with essential chips only',
  detailed: 'Full multi-line statusline (default)',
};

/** Presets for max iterations — cyclable via ←/→. 0 = unlimited. */
export const MAX_ITERATIONS_PRESETS = [100, 200, 500, 1000, 0];

/** Presets for max concurrent subagents. 0 = runtime default. */
export const MAX_CONCURRENT_PRESETS = [1, 3, 4, 5, 10, 25, 50, 0];

/** Presets for auto-proceed max iterations. 0 = unlimited, 50 default. */
export const AUTO_PROCEED_MAX_PRESETS = [10, 25, 50, 100, 250, 0];

/** Presets for prompt refinement preview countdown. */
export const ENHANCE_DELAY_PRESETS = [15_000, 30_000, 45_000, 60_000, 90_000, 120_000];

/** Language options for prompt refinement. */
export const ENHANCE_LANGUAGES = ['original', 'english'] as const;
export type EnhanceLanguage = (typeof ENHANCE_LANGUAGES)[number];

/** Token-saving tier options — cyclable via ←/→ in the settings picker. */
export const TOKEN_SAVING_TIERS = ['off', 'minimal', 'light', 'medium', 'aggressive'] as const;
export type TokenSavingTierTui = (typeof TOKEN_SAVING_TIERS)[number];

export const TOKEN_SAVING_TIER_DESCS: Record<TokenSavingTierTui, string> = {
  off: 'All tools enabled (full prompt)',
  minimal: '~3–4k tokens — core tools only',
  light: '~2–3k tokens — core + patterns',
  medium: '~1.5–2k tokens — most tools enabled',
  aggressive: '~4–5k tokens — trimmed prompt',
};

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
  /** Token-saving tier: off | minimal | light | medium | aggressive. */
  tokenSavingTier: TokenSavingTierTui;
  /** Allow tools to read/write paths outside the project root directory. Default: true. */
  allowOutsideProjectRoot: boolean;
  // ── Tools ──
  maxIterations: number;
  /** Maximum auto-proceed iterations before stopping (0 = unlimited). */
  autoProceedMaxIterations: number;
  /** Prompt refinement preview countdown (ms). Cycled via ENHANCE_DELAY_PRESETS. */
  enhanceDelayMs: number;
  /** Enable/disable prompt refinement. */
  enhanceEnabled: boolean;
  /** Default language for refinement: original (keep user's language) or english. */
  enhanceLanguage: EnhanceLanguage;
  /** Run incremental index at session start. */
  indexOnStart: boolean;
  // ── Reasoning ──
  /** Thinking word displayed in status bar while agent is working. */
  thinkingWord: string;
  /** Reasoning mode: auto (provider default) | on | off. */
  reasoningMode: ReasoningMode;
  /** Reasoning effort level. */
  reasoningEffort: ReasoningEffort;
  /** Preserve thinking across turns. */
  reasoningPreserve: boolean;
  /** Prompt cache TTL. */
  cacheTtl: CacheTtl;
  // ── Context ──
  contextAutoCompact: boolean;
  contextStrategy: CompactorStrategy;
  contextMode: ContextMode;
  // ── Fleet ──
  maxConcurrent: number;
  // ── Logging ──
  logLevel: LogLevel;
  auditLevel: AuditLevel;
  // ── Debug ──
  /** Raw SSE stream debugging toggle — hex-dump every byte received from providers. */
  debugStream: boolean;
  /** Statusline density: minimum single-line or detailed multi-line. */
  statuslineMode: StatuslineMode;
  /** Where settings are persisted. */
  configScope: ConfigScope;
  hint?: string | undefined;
}

/** Total number of settings rows (used for wrap-around navigation). */
export const SETTINGS_FIELD_COUNT = 35;

export const CONFIG_SCOPES = ['global', 'project'] as const;
export type ConfigScope = (typeof CONFIG_SCOPES)[number];

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
  tokenSavingTier,
  allowOutsideProjectRoot,
  maxIterations,
  autoProceedMaxIterations,
  enhanceDelayMs,
  enhanceEnabled,
  enhanceLanguage,
  indexOnStart,
  thinkingWord,
  reasoningMode,
  reasoningEffort,
  reasoningPreserve,
  cacheTtl,
  contextAutoCompact,
  contextStrategy,
  contextMode,
  maxConcurrent,
  logLevel,
  auditLevel,
  debugStream,
  statuslineMode,
  configScope,
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
    {
      label: 'Token-saving mode',
      value: tokenSavingTier,
      detail: TOKEN_SAVING_TIER_DESCS[tokenSavingTier],
    },
    {
      label: 'Allow outside project',
      value: boolVal(allowOutsideProjectRoot),
      detail: 'Allow tools to access paths outside project root',
    },
    // ── Tools ──
    { section: 'Tools' },
    {
      label: 'Max iterations',
      value: formatMaxIterations(maxIterations),
      detail: '100–1000 or unlimited (0)',
    },
    {
      label: 'Auto-proceed max iterations',
      value: formatMaxIterations(autoProceedMaxIterations),
      detail: 'Stop auto-proceed after N iterations (0 = unlimited, default 50)',
    },
    {
      label: 'Refine preview countdown',
      value: formatEnhanceDelay(enhanceDelayMs),
      detail: 'Timeout for prompt refinement preview (15s–120s)',
    },
    {
      label: 'Refine',
      value: boolVal(enhanceEnabled),
      detail: 'Enable prompt refinement before sending',
    },
    {
      label: 'Refine language',
      value: enhanceLanguage,
      detail: 'original (keep language) | english (translate)',
    },
    {
      label: 'Index on session start',
      value: boolVal(indexOnStart),
      detail: 'Run incremental index at session start',
    },
    // ── Reasoning ──
    { section: 'Reasoning' },
    {
      label: 'Thinking word',
      value: thinkingWord,
      detail: 'Word shown in status bar while agent works',
    },
    {
      label: 'Reasoning mode',
      value: reasoningMode,
      detail: 'auto (provider default) | on | off',
    },
    {
      label: 'Reasoning effort',
      value: reasoningEffort,
      detail: 'none–max (model-dependent)',
    },
    {
      label: 'Preserve thinking',
      value: boolVal(reasoningPreserve),
      detail: 'Keep reasoning across turns',
    },
    {
      label: 'Cache TTL',
      value: cacheTtl,
      detail: 'Prompt cache TTL (5m | 1h)',
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
    {
      label: 'Context mode',
      value: contextMode,
      detail: CONTEXT_MODE_DESCS[contextMode],
    },
    // ── Fleet ──
    { section: 'Fleet' },
    {
      label: 'Max concurrent',
      value: maxConcurrent === 0 ? 'default' : String(maxConcurrent),
      detail: 'Max subagents (0 = default)',
    },
    // ── Logging ──
    { section: 'Logging' },
    {
      label: 'Log level',
      value: logLevel,
      detail: 'Console log verbosity',
    },
    {
      label: 'Audit level',
      value: auditLevel,
      detail: 'minimal | standard | full (large)',
    },
    // ── Debug ──
    { section: 'Debug' },
    {
      label: 'Stream debug logging',
      value: boolVal(debugStream),
      detail: 'Hex-dump raw SSE bytes to stderr',
    },
    {
      label: 'Statusline',
      value: statuslineMode,
      detail: STATUSLINE_MODE_DESCS[statuslineMode],
    },
    {
      label: 'Config scope',
      value: configScope,
      detail: 'global (~/.wrongstack/) or project (.wrongstack/)',
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
  const totalFields = fieldRowIndex.length; // = SETTINGS_FIELD_COUNT
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
      <Text dimColor>↑/↓ field · ←/→ change + autosave · F5 to close</Text>
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
      <Text dimColor>
        {configScope === 'project'
          ? 'Persisted to <project>/.wrongstack/config.json'
          : 'Persisted to ~/.wrongstack/config.json'}
      </Text>
      {hint ? <Text color="yellow">{hint}</Text> : null}
    </Box>
  );
}
