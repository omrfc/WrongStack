import { create } from 'zustand';
import { persist } from 'zustand/middleware';

/**
 * Local preference store — persisted in localStorage.
 * Mirrors the TUI's SettingsPicker fields that don't require
 * a live WS server connection. The server can still override
 * these via WS events when connected.
 */
export interface LocalPrefs {
  /** Autonomy mode */
  autonomy: 'off' | 'suggest' | 'auto' | 'eternal' | 'eternal-parallel';
  /** Auto-proceed delay in ms */
  autonomyDelayMs: number;
  /** Stop auto-proceed after N iterations (0 = unlimited). */
  autoProceedMaxIterations: number;
  /** YOLO mode — bypass tool confirmations */
  yolo: boolean;
  /** Maximum agent iterations per run */
  maxIterations: number;
  /** Chime on run completion */
  chime: boolean;
  /** Confirm before exit (Ctrl+C) */
  confirmExit: boolean;
  /** Stream fleet events in realtime */
  streamFleet: boolean;
  /** Predict next steps after turn completes */
  nextPrediction: boolean;

  // --- Feature flags ---
  featureMcp: boolean;
  featurePlugins: boolean;
  featureMemory: boolean;
  featureSkills: boolean;
  featureModelsRegistry: boolean;
  indexOnStart: boolean;

  // --- Context ---
  contextAutoCompact: boolean;
  /** Compactor strategy — matches core's config.context.strategy. */
  contextStrategy: 'hybrid' | 'intelligent' | 'selective';
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  /** Session audit detail — matches core's config.session.auditLevel. */
  auditLevel: 'minimal' | 'standard' | 'full';

  // --- Refine ---
  enhanceEnabled: boolean;
  enhanceDelayMs: number;
  enhanceLanguage: 'original' | 'english';

  // --- Telegram notifications ---
  /** Plugin configured with a bot token (gates the whole section). */
  tgConfigured: boolean;
  tgSessionEnd: boolean;
  tgDelegate: boolean;
  /** Long-tool threshold in ms. 0 = disabled. */
  tgLongToolMs: number;

  set: (patch: Partial<LocalPrefs>) => void;
  reset: () => void;
}

const DEFAULTS: Omit<LocalPrefs, 'set' | 'reset'> = {
  autonomy: 'off',
  autonomyDelayMs: 45_000,
  autoProceedMaxIterations: 50,
  yolo: false,
  maxIterations: 500,
  chime: false,
  confirmExit: true,
  streamFleet: true,
  nextPrediction: false,
  featureMcp: true,
  featurePlugins: true,
  featureMemory: true,
  featureSkills: true,
  featureModelsRegistry: true,
  indexOnStart: true,
  contextAutoCompact: true,
  contextStrategy: 'hybrid',
  logLevel: 'info',
  auditLevel: 'standard',
  enhanceEnabled: true,
  enhanceDelayMs: 60_000,
  enhanceLanguage: 'original',
  tgConfigured: false,
  tgSessionEnd: false,
  tgDelegate: true,
  tgLongToolMs: 30_000,
};

export const useLocalPrefs = create<LocalPrefs>()(
  persist(
    (set) => ({
      ...DEFAULTS,
      set: (patch) => set(patch),
      reset: () => set(DEFAULTS),
    }),
    {
      name: 'wrongstack-local-prefs',
      version: 3,
      // v1 stored option values that don't exist in core's config schema —
      // contextStrategy frugal/balanced/deep/archival (context-window modes,
      // a different setting) and auditLevel 'verbose'. Map them onto the
      // canonical values so persisted stores don't resurrect invalid prefs.
      //
      // v2 added autoProceedMaxIterations.
      //
      // v3 added Telegram notification prefs (tgConfigured, tgSessionEnd,
      // tgDelegate, tgLongToolMs). Older stores simply get the defaults via
      // the spread of DEFAULTS; no explicit remap is needed.
      migrate: (persisted) => {
        const p = (persisted ?? {}) as Record<string, unknown>;
        const validStrategies = ['hybrid', 'intelligent', 'selective'];
        if (!validStrategies.includes(p.contextStrategy as string)) {
          p.contextStrategy = 'hybrid';
        }
        if (p.auditLevel === 'verbose') p.auditLevel = 'full';
        if (!['minimal', 'standard', 'full'].includes(p.auditLevel as string)) {
          p.auditLevel = 'standard';
        }
        if (typeof p.autoProceedMaxIterations !== 'number') {
          p.autoProceedMaxIterations = 50;
        }
        return p as unknown as LocalPrefs;
      },
    },
  ),
);
