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
  contextStrategy: 'frugal' | 'balanced' | 'deep' | 'archival';
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  auditLevel: 'minimal' | 'standard' | 'verbose';

  // --- Refine ---
  enhanceEnabled: boolean;
  enhanceDelayMs: number;
  enhanceLanguage: 'original' | 'english';

  set: (patch: Partial<LocalPrefs>) => void;
  reset: () => void;
}

const DEFAULTS: Omit<LocalPrefs, 'set' | 'reset'> = {
  autonomy: 'off',
  autonomyDelayMs: 0,
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
  contextStrategy: 'balanced',
  logLevel: 'info',
  auditLevel: 'minimal',
  enhanceEnabled: true,
  enhanceDelayMs: 60_000,
  enhanceLanguage: 'original',
};

export const useLocalPrefs = create<LocalPrefs>()(
  persist(
    (set) => ({
      ...DEFAULTS,
      set: (patch) => set(patch),
      reset: () => set(DEFAULTS),
    }),
    { name: 'wrongstack-local-prefs' },
  ),
);
