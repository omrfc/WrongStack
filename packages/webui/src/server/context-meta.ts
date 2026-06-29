/**
 * Context-meta seeding for the standalone WebUI server.
 *
 * Phase 1c of the god-module split (issue: God-modules >1500 lines).
 * `startWebUI` in `./index.ts` previously inlined a ~70-line block that
 * mirrored the CLI's `getSettings()` mapping: it reads the persisted
 * `config.json` shape and projects the relevant fields onto `context.meta`
 * so the settings panel, autonomy engine, fallback chain, feature toggles,
 * and Telegram extension state all reflect the persisted config on first
 * connect — before any `prefs.update` arrives.
 *
 * Pure config → meta projection. No behaviour change.
 */
import type { Config } from '@wrongstack/core/types';

/**
 * Seed `context.meta` from the loaded config. Mirrors the CLI's
 * `getSettings()` mapping so TUI and WebUI agree. Without this the snapshot
 * is empty and every browser shows localStorage defaults (autonomy "off",
 * etc.) regardless of what config.json says.
 *
 * The `context` is typed structurally so this module does not take a
 * dependency on the higher `Context` class — anything with a writable
 * `meta: Record<string, unknown>` works.
 */
export function seedContextMeta(
  config: Config,
  context: { meta: Record<string, unknown> },
): void {
  const meta = context.meta;
  const autonomyCfg = (config.autonomy ?? {}) as Record<string, unknown>;
  const rawMode = autonomyCfg['defaultMode'];
  meta['autonomy'] = rawMode === 'suggest' || rawMode === 'auto' ? rawMode : 'off';
  meta['autonomyDelayMs'] = (autonomyCfg['autoProceedDelayMs'] as number) ?? 45_000;
  meta['autoProceedMaxIterations'] = (autonomyCfg['autoProceedMaxIterations'] as number) ?? 50;
  meta['yolo'] = (autonomyCfg['yolo'] as boolean) ?? config.yolo ?? false;
  meta['chime'] = (autonomyCfg['chime'] as boolean) ?? false;
  meta['confirmExit'] = autonomyCfg['confirmExit'] !== false;
  meta['streamFleet'] = autonomyCfg['streamFleet'] !== false;
  meta['enhanceEnabled'] = (autonomyCfg['enhance'] as boolean) ?? true;
  meta['enhanceDelayMs'] = (autonomyCfg['enhanceDelayMs'] as number) ?? 60_000;
  meta['enhanceLanguage'] = (autonomyCfg['enhanceLanguage'] as string) ?? 'original';
  meta['nextPrediction'] = config.nextPrediction ?? false;
  meta['fallbackModels'] = config.fallbackModels ?? [];
  meta['fallbackProfiles'] = config.fallbackProfiles ?? {};
  meta['favoriteModels'] = config.favoriteModels ?? [];
  meta['favoriteModelsOnly'] = config.favoriteModelsOnly === true;
  meta['modelMatrix'] = config.modelMatrix ?? {};
  meta['fallbackAuto'] = config.fallbackAuto !== false;
  meta['featureMcp'] = config.features.mcp !== false;
  meta['featurePlugins'] = config.features.plugins !== false;
  meta['featureMemory'] = config.features.memory !== false;
  meta['featureSkills'] = config.features.skills !== false;
  meta['featureModelsRegistry'] = config.features.modelsRegistry !== false;
  meta['indexOnStart'] = config.indexing?.onSessionStart !== false;
  meta['contextAutoCompact'] = config.context?.autoCompact !== false;
  meta['contextStrategy'] = config.context?.strategy ?? 'hybrid';
  meta['logLevel'] = config.log?.level ?? 'info';
  meta['auditLevel'] = config.session?.auditLevel ?? 'standard';
  meta['maxIterations'] = config.tools?.maxIterations ?? 500;
  meta['contextMode'] = config.context?.mode ?? 'balanced';
  {
    const tsm = config.features?.tokenSavingMode;
    meta['tokenSavingTier'] = typeof tsm === 'string' ? tsm : tsm ? 'medium' : 'off';
  }
  meta['maxConcurrent'] = typeof config.maxConcurrent === 'number' ? config.maxConcurrent : 10;
  meta['titleAnimation'] = autonomyCfg['terminalTitleAnimation'] !== false;
  {
    const mr = (config.modelRuntime ?? {}) as {
      reasoning?: { mode?: string; effort?: string; preserve?: boolean };
      cache?: { ttl?: string };
    };
    meta['reasoningMode'] = mr.reasoning?.mode ?? 'auto';
    meta['reasoningEffort'] = mr.reasoning?.effort ?? 'high';
    meta['reasoningPreserve'] = mr.reasoning?.preserve === true;
    meta['cacheTtl'] = mr.cache?.ttl ?? 'default';
  }
  const hqConfig = (
    config as { hq?: { enabled?: boolean; url?: string; token?: string; rawContent?: boolean } }
  ).hq;
  meta['hqEnabled'] = hqConfig?.enabled === true;
  meta['hqUrl'] = hqConfig?.url ?? '';
  meta['hqToken'] = hqConfig?.token ?? '';
  meta['hqRawContent'] = hqConfig?.rawContent === true;

  // Telegram plugin notification settings live under extensions.telegram —
  // same path the CLI's /telegram-settings writes. Seed the meta so the
  // SettingsPanel reflects the persisted config on first connect, before
  // any prefs.update arrives.
  const tgExt = (config.extensions as Record<string, Record<string, unknown>> | undefined)?.[
    'telegram'
  ];
  meta['tgConfigured'] =
    typeof tgExt?.['botToken'] === 'string' && tgExt['botToken'].length > 0;
  meta['tgSessionEnd'] = tgExt?.['notifyOnSessionEnd'] === true;
  meta['tgDelegate'] = tgExt?.['notifyOnDelegate'] !== false; // default true
  const tgMs = tgExt?.['longToolThresholdMs'];
  meta['tgLongToolMs'] = typeof tgMs === 'number' ? tgMs : 30_000;
}
