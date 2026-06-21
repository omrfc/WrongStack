/**
 * TUI Settings adapter — extracted from the runTui() options literal.
 *
 * Phase C step 1. The getSettings/saveSettings pair (~337 lines) reads
 * config from the ConfigStore and persists changes to disk. This module
 * owns both functions, receiving its dependencies through a typed context.
 *
 * `getSettings()` maps the full Config into the flat LiveSettingsInput
 * shape the TUI SettingsPicker consumes. `saveSettings()` does the
 * reverse: read → modify → encrypt → atomic-write for every section,
 * then syncs the in-memory store and applies live runtime effects.
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  type Config,
  type ConfigStore,
  type WstackPaths,
  atomicWrite,
  decryptConfigSecrets,
  encryptConfigSecrets,
  noOpVault,
  normalizeTokenSavingTier,
} from '@wrongstack/core';
import { persistAutonomySetting, filterSafeForProject } from '../settings-menu.js';
import type { LiveSettingsInput } from '../execution.js';

export interface SettingsAdapterContext {
  configStore: ConfigStore;
  wpaths: WstackPaths;
  fleetStreamController: { setEnabled: (enabled: boolean) => void } | undefined;
  applyLiveSettings: ((s: LiveSettingsInput) => void) | undefined;
}

export interface SettingsAdapter {
  getSettings: () => Record<string, unknown>;
  saveSettings: (s: LiveSettingsInput) => Promise<string | null>;
}

/**
 * Build the getSettings/saveSettings pair for the TUI SettingsPicker.
 *
 * `getSettings` reads from the live ConfigStore on every call.
 * `saveSettings` persists to disk (global or project-local config),
 * syncs the in-memory store, and applies runtime effects immediately.
 */
export function createSettingsAdapter(ctx: SettingsAdapterContext): SettingsAdapter {
  const { configStore, wpaths, fleetStreamController, applyLiveSettings } = ctx;

  function getSettings(): Record<string, unknown> {
    const cfg = configStore.get();
    const autonomy = cfg.autonomy as Record<string, unknown> | undefined;
    const rawMode = autonomy?.defaultMode as string | undefined;
    const mode: 'off' | 'suggest' | 'auto' =
      rawMode === 'suggest' || rawMode === 'auto' ? rawMode : 'off';
    const modelRuntime = (cfg as { modelRuntime?: { reasoning?: { mode?: string; effort?: string; preserve?: boolean }; cache?: { ttl?: string } } }).modelRuntime;
    const reasoningEffortRaw = modelRuntime?.reasoning?.effort;
    const reasoningEffort =
      reasoningEffortRaw === 'none' ||
      reasoningEffortRaw === 'minimal' ||
      reasoningEffortRaw === 'low' ||
      reasoningEffortRaw === 'medium' ||
      reasoningEffortRaw === 'high' ||
      reasoningEffortRaw === 'xhigh' ||
      reasoningEffortRaw === 'max'
        ? reasoningEffortRaw
        : 'high';
    return {
      mode,
      delayMs: (autonomy?.autoProceedDelayMs as number) ?? 45_000,
      titleAnimation: autonomy?.terminalTitleAnimation !== false,
      yolo: (autonomy?.yolo as boolean) ?? false,
      streamFleet: autonomy?.streamFleet !== false,
      chime: (autonomy?.chime as boolean) ?? false,
      confirmExit: autonomy?.confirmExit !== false,
      nextPrediction: cfg.nextPrediction ?? false,
      featureMcp: cfg.features?.mcp !== false,
      featurePlugins: cfg.features?.plugins !== false,
      featureMemory: cfg.features?.memory !== false,
      featureSkills: cfg.features?.skills !== false,
      featureModelsRegistry: cfg.features?.modelsRegistry !== false,
      featureTokenSaving: normalizeTokenSavingTier(cfg.features?.tokenSavingMode),
      allowOutsideProjectRoot: cfg.features?.allowOutsideProjectRoot ?? true,
      contextAutoCompact: cfg.context?.autoCompact !== false,
      contextStrategy: cfg.context?.strategy ?? 'hybrid',
      maxConcurrent: cfg.maxConcurrent ?? 0,
      logLevel: cfg.log?.level ?? 'info',
      auditLevel: cfg.session?.auditLevel ?? 'standard',
      indexOnStart: cfg.indexing?.onSessionStart !== false,
      maxIterations: cfg.tools?.maxIterations ?? 500,
      restrictFsToRoot: cfg.tools?.restrictToProjectRoot ?? false,
      autoProceedMaxIterations:
        ((cfg.autonomy as Record<string, unknown> | undefined)
          ?.autoProceedMaxIterations as number) ?? 50,
      debugStream: cfg.debugStream ?? false,
      statuslineMode: autonomy?.statuslineMode === 'minimum' ? 'minimum' : 'detailed',
      configScope: cfg.configScope ?? 'global',
      enhanceDelayMs:
        ((cfg.autonomy as Record<string, unknown> | undefined)?.enhanceDelayMs as number) ??
        60_000,
      enhanceEnabled:
        ((cfg.autonomy as Record<string, unknown> | undefined)?.enhance as boolean) ?? true,
      enhanceLanguage:
        (cfg.autonomy as Record<string, unknown> | undefined)?.enhanceLanguage === 'english'
          ? ('english' as const)
          : ('original' as const),
      mouseMode: (autonomy?.mouseMode as boolean) ?? false,
      autonomyNextPrompt:
        ((cfg.autonomy as Record<string, unknown> | undefined)
          ?.autonomyNextPrompt as string | undefined) ?? 'auto {{suggestion}}',
      reasoningMode:
        modelRuntime?.reasoning?.mode === 'on' || modelRuntime?.reasoning?.mode === 'off'
          ? modelRuntime.reasoning.mode
          : 'auto',
      reasoningEffort,
      reasoningPreserve: modelRuntime?.reasoning?.preserve === true,
      cacheTtl:
        modelRuntime?.cache?.ttl === '5m' || modelRuntime?.cache?.ttl === '1h'
          ? modelRuntime.cache.ttl
          : 'default',
      breakerEnabled: cfg.circuitBreaker?.enabled === true,
      breakerAutoKillResetMs: cfg.circuitBreaker?.autoKillResetMs ?? 60_000,
    };
  }

  async function saveSettings(s: LiveSettingsInput): Promise<string | null> {
    try {
      // Persist autonomy section (existing behaviour).
      await persistAutonomySetting(
        {
          configStore,
          globalConfigPath: wpaths.globalConfig,
          inProjectConfigPath: wpaths.inProjectConfig,
          vault: noOpVault,
        },
        (autonomy) => {
          autonomy.defaultMode = s.mode;
          autonomy.autoProceedDelayMs = s.delayMs;
          const a = autonomy as Record<string, unknown>;
          a['terminalTitleAnimation'] = s.titleAnimation ?? true;
          a['yolo'] = s.yolo ?? false;
          a['streamFleet'] = s.streamFleet ?? true;
          a['chime'] = s.chime ?? false;
          a['confirmExit'] = s.confirmExit ?? true;
          if (s.mouseMode !== undefined) a['mouseMode'] = s.mouseMode;
          if (s.enhanceEnabled !== undefined) a['enhance'] = s.enhanceEnabled;
          if (s.enhanceLanguage !== undefined) a['enhanceLanguage'] = s.enhanceLanguage;
          if (s.statuslineMode !== undefined) a['statuslineMode'] = s.statuslineMode;
          if (s.autonomyNextPrompt !== undefined) a['autonomyNextPrompt'] = s.autonomyNextPrompt;
          if (s.autoProceedMaxIterations !== undefined)
            a['autoProceedMaxIterations'] = s.autoProceedMaxIterations;
        },
      );

      // Persist other config sections that the SettingsPicker now exposes.
      if (
        s.featureMcp !== undefined ||
        s.featurePlugins !== undefined ||
        s.featureMemory !== undefined ||
        s.featureSkills !== undefined ||
        s.featureModelsRegistry !== undefined ||
        s.featureTokenSaving !== undefined ||
        s.allowOutsideProjectRoot !== undefined ||
        s.contextAutoCompact !== undefined ||
        s.contextStrategy !== undefined ||
        s.logLevel !== undefined ||
        s.auditLevel !== undefined ||
        s.indexOnStart !== undefined ||
        s.maxIterations !== undefined ||
        s.restrictFsToRoot !== undefined ||
        s.nextPrediction !== undefined ||
        s.debugStream !== undefined ||
        s.configScope !== undefined ||
        s.enhanceDelayMs !== undefined
      ) {
        const configScope = s.configScope ?? configStore.get().configScope ?? 'global';
        const targetPath =
          configScope === 'project' && wpaths.inProjectConfig
            ? wpaths.inProjectConfig
            : wpaths.globalConfig;
        let raw: string;
        try {
          raw = await fs.readFile(targetPath, 'utf8');
        } catch (err) {
          throw new Error(
            `Failed to read config at ${targetPath}: ${err instanceof Error ? err.message : String(err)}`,
            { cause: err },
          );
        }
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        const decrypted = decryptConfigSecrets(parsed, noOpVault) as Record<string, unknown>;

        if (s.nextPrediction !== undefined) decrypted.nextPrediction = s.nextPrediction;
        if (
          s.featureMcp !== undefined ||
          s.featurePlugins !== undefined ||
          s.featureMemory !== undefined ||
          s.featureSkills !== undefined ||
          s.featureModelsRegistry !== undefined ||
          s.featureTokenSaving !== undefined ||
          s.allowOutsideProjectRoot !== undefined
        ) {
          const feats = (decrypted.features as Record<string, unknown>) ?? {};
          if (s.featureMcp !== undefined) feats.mcp = s.featureMcp;
          if (s.featurePlugins !== undefined) feats.plugins = s.featurePlugins;
          if (s.featureMemory !== undefined) feats.memory = s.featureMemory;
          if (s.featureSkills !== undefined) feats.skills = s.featureSkills;
          if (s.featureModelsRegistry !== undefined) feats.modelsRegistry = s.featureModelsRegistry;
          if (s.featureTokenSaving !== undefined) feats.tokenSavingMode = s.featureTokenSaving;
          if (s.allowOutsideProjectRoot !== undefined) feats.allowOutsideProjectRoot = s.allowOutsideProjectRoot;
          decrypted.features = feats;
        }
        if (s.contextAutoCompact !== undefined || s.contextStrategy !== undefined) {
          const c = (decrypted.context as Record<string, unknown>) ?? {};
          if (s.contextAutoCompact !== undefined) c.autoCompact = s.contextAutoCompact;
          if (s.contextStrategy !== undefined) c.strategy = s.contextStrategy;
          decrypted.context = c;
        }
        if (s.logLevel !== undefined) {
          const log = (decrypted.log as Record<string, unknown>) ?? {};
          log.level = s.logLevel;
          decrypted.log = log;
        }
        if (s.auditLevel !== undefined) {
          const sess = (decrypted.session as Record<string, unknown>) ?? {};
          sess.auditLevel = s.auditLevel;
          decrypted.session = sess;
        }
        if (s.indexOnStart !== undefined) {
          const idx = (decrypted.indexing as Record<string, unknown>) ?? {};
          idx.onSessionStart = s.indexOnStart;
          decrypted.indexing = idx;
        }
        if (s.maxIterations !== undefined || s.restrictFsToRoot !== undefined) {
          const tools = (decrypted.tools as Record<string, unknown>) ?? {};
          if (s.maxIterations !== undefined) tools.maxIterations = s.maxIterations;
          if (s.restrictFsToRoot !== undefined) tools.restrictToProjectRoot = s.restrictFsToRoot;
          decrypted.tools = tools;
        }
        if (s.restrictFsToRoot !== undefined) {
          const features = (decrypted.features as Record<string, unknown>) ?? {};
          features.allowOutsideProjectRoot = !s.restrictFsToRoot;
          decrypted.features = features;
        }
        if (s.debugStream !== undefined) {
          decrypted.debugStream = s.debugStream;
          const { setDebugStreamEnabled } = await import('@wrongstack/providers');
          setDebugStreamEnabled(s.debugStream);
        }
        if (s.configScope !== undefined) decrypted.configScope = s.configScope;
        if (s.enhanceDelayMs !== undefined) {
          const autonomy = (decrypted.autonomy as Record<string, unknown>) ?? {};
          autonomy.enhanceDelayMs = s.enhanceDelayMs;
          decrypted.autonomy = autonomy;
        }
        if (s.autoProceedMaxIterations !== undefined) {
          const autonomy = (decrypted.autonomy as Record<string, unknown>) ?? {};
          autonomy.autoProceedMaxIterations = s.autoProceedMaxIterations;
          decrypted.autonomy = autonomy;
        }
        const toWrite = targetPath === wpaths.globalConfig ? decrypted : filterSafeForProject(decrypted);
        const encrypted = encryptConfigSecrets(toWrite, noOpVault);
        if (targetPath !== wpaths.globalConfig) {
          await fs.mkdir(path.dirname(targetPath), { recursive: true });
        }
        await atomicWrite(targetPath, JSON.stringify(encrypted, null, 2), { mode: 0o600 });

        configStore.update({
          ...(s.nextPrediction !== undefined ? { nextPrediction: s.nextPrediction } : {}),
          ...(s.featureMcp !== undefined ||
          s.featurePlugins !== undefined ||
          s.featureMemory !== undefined ||
          s.featureSkills !== undefined ||
          s.featureModelsRegistry !== undefined
            ? { features: decrypted.features as Config['features'] }
            : {}),
          ...(s.contextAutoCompact !== undefined || s.contextStrategy !== undefined
            ? { context: decrypted.context as Config['context'] }
            : {}),
          ...(s.logLevel !== undefined ? { log: decrypted.log as Config['log'] } : {}),
          ...(s.auditLevel !== undefined ? { session: decrypted.session as Config['session'] } : {}),
          ...(s.indexOnStart !== undefined ? { indexing: decrypted.indexing as Config['indexing'] } : {}),
          ...(s.maxIterations !== undefined || s.restrictFsToRoot !== undefined
            ? { tools: decrypted.tools as Config['tools'] }
            : {}),
          ...(s.debugStream !== undefined ? { debugStream: s.debugStream } : {}),
          ...(s.configScope !== undefined ? { configScope: s.configScope as 'global' | 'project' } : {}),
          ...(s.enhanceDelayMs !== undefined
            ? { autonomy: { ...((configStore.get().autonomy as Record<string, unknown>) ?? {}), enhanceDelayMs: s.enhanceDelayMs } as Config['autonomy'] }
            : {}),
          ...(s.enhanceEnabled !== undefined
            ? { autonomy: { ...((configStore.get().autonomy as Record<string, unknown>) ?? {}), enhance: s.enhanceEnabled } as Config['autonomy'] }
            : {}),
          ...(s.enhanceLanguage !== undefined
            ? { autonomy: { ...((configStore.get().autonomy as Record<string, unknown>) ?? {}), enhanceLanguage: s.enhanceLanguage } as Config['autonomy'] }
            : {}),
        });
      }

      if (s.streamFleet !== undefined) fleetStreamController?.setEnabled(s.streamFleet);
      applyLiveSettings?.(s);
      return null;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.debug(
        JSON.stringify({
          level: 'error',
          event: 'execution.settings_persist_failed',
          message,
          errorName: err instanceof Error ? err.name : undefined,
          timestamp: new Date().toISOString(),
        }),
      );
      return message;
    }
  }

  return { getSettings, saveSettings };
}
