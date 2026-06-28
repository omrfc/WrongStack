/**
 * Preference key list, snapshot, persistence, and config-seeding.
 *
 * ## What lives here
 *
 * - `PREF_KEYS`           – the canonical list of browser-setting ↔ config-file keys.
 * - `createPrefsSeeding`  – factory that returns `{ prefSnapshot, persistPrefs }`
 *                           with file I/O captured in closure.
 * - `seedConfigToMeta`    – one-time call at startup: reads config.json and seeds
 *                           `agent.ctx.meta` so the settings panel shows the real
 *                           persisted values instead of localStorage defaults.
 *
 * ## Extraction history
 *
 * PR 9 of Issue #30 – extracted from webui-server.ts (was inline between the
 * `PREF_KEYS` array and the `PrefsContext` construction).
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

// Minimal shape of what seedConfigToMeta / createPrefsSeeding need from runWebUI's opts.
// CliWebUIOptions is defined in webui-server.ts; importing it directly would create a
// cycle since webui-server.ts imports from this module.
interface CliWebUIOptions {
  agent: { ctx: { meta: Record<string, unknown> } };
  globalConfigPath?: string | undefined;
  appConfig?: {
    fallbackModels?: string[] | undefined;
    fallbackProfiles?: Record<string, string[]> | undefined;
    favoriteModels?: string[] | undefined;
    favoriteModelsOnly?: boolean | undefined;
    fallbackAuto?: boolean | undefined;
    modelMatrix?:
      | Record<
          string,
          {
            provider?: string | undefined;
            model?: string | undefined;
            fallbackProfile?: string | undefined;
          }
        >
      | undefined;
  } | undefined;
}

import {
  atomicWrite,
  DefaultSecretVault,
  decryptConfigSecrets,
  encryptConfigSecrets,
} from '@wrongstack/core';

// ── PREF_KEYS ─────────────────────────────────────────────────────────────────

/** Keys synced between `agent.ctx.meta` and `config.json`. */
export const PREF_KEYS = [
  'autonomy',
  'autonomyDelayMs',
  'autoProceedMaxIterations',
  'yolo',
  'maxIterations',
  'chime',
  'confirmExit',
  'streamFleet',
  'nextPrediction',
  'fallbackModels',
  'fallbackProfiles',
  'favoriteModels',
  'favoriteModelsOnly',
  'modelMatrix',
  'fallbackAuto',
  'enhanceEnabled',
  'enhanceDelayMs',
  'enhanceLanguage',
  'featureMcp',
  'featurePlugins',
  'featureMemory',
  'featureSkills',
  'featureModelsRegistry',
  'indexOnStart',
  'contextAutoCompact',
  'contextStrategy',
  'contextMode',
  'tokenSavingTier',
  'maxConcurrent',
  'titleAnimation',
  // Model-runtime reasoning/cache — parity with the standalone server, which
  // already persists these. Without them, `wrongstack --webui` silently drops
  // reasoning/cache changes made in the browser (lost on restart).
  'reasoningMode',
  'reasoningEffort',
  'reasoningPreserve',
  'cacheTtl',
  'logLevel',
  'auditLevel',
  'hqEnabled',
  'hqUrl',
  'hqToken',
  'hqRawContent',
  // Telegram plugin notification settings (parity with the standalone server).
  'tgConfigured',
  'tgSessionEnd',
  'tgDelegate',
  'tgLongToolMs',
] as const;

// ── Helpers ───────────────────────────────────────────────────────────────────

type PrefSnapshot = Record<string, unknown>;

// ── seedConfigToMeta ──────────────────────────────────────────────────────────

/**
 * One-time startup seed: reads `globalConfigPath` and copies recognised fields
 * into `agent.ctx.meta` so the browser settings panel starts with the real
 * persisted values instead of blank/undefined.
 *
 * Best-effort – missing or corrupt config leaves prefs unseeded.
 */
export async function seedConfigToMeta(opts: CliWebUIOptions): Promise<void> {
  const configPath = opts.globalConfigPath;
  if (!configPath) return;

  try {
    const raw = await fs.readFile(configPath, 'utf8');
    const cfg = JSON.parse(raw) as Record<string, unknown>;
    const autonomyCfg = (cfg.autonomy as Record<string, unknown>) ?? {};
    const features = (cfg.features as Record<string, unknown>) ?? {};
    const meta = opts.agent.ctx.meta;

    const rawMode = autonomyCfg['defaultMode'];
    meta['autonomy'] = rawMode === 'suggest' || rawMode === 'auto' ? rawMode : 'off';
    meta['autonomyDelayMs'] = (autonomyCfg['autoProceedDelayMs'] as number) ?? 45_000;
    meta['autoProceedMaxIterations'] = (autonomyCfg['autoProceedMaxIterations'] as number) ?? 50;
    meta['yolo'] = (autonomyCfg['yolo'] as boolean) ?? (cfg.yolo as boolean) ?? false;
    meta['chime'] = (autonomyCfg['chime'] as boolean) ?? false;
    meta['confirmExit'] = autonomyCfg['confirmExit'] !== false;
    meta['streamFleet'] = autonomyCfg['streamFleet'] !== false;
    meta['enhanceEnabled'] = (autonomyCfg['enhance'] as boolean) ?? true;
    meta['enhanceDelayMs'] = (autonomyCfg['enhanceDelayMs'] as number) ?? 60_000;
    meta['enhanceLanguage'] = (autonomyCfg['enhanceLanguage'] as string) ?? 'original';
    meta['nextPrediction'] = (cfg.nextPrediction as boolean) ?? false;
    meta['fallbackModels'] = (cfg.fallbackModels as string[]) ?? [];
    meta['fallbackProfiles'] =
      (cfg.fallbackProfiles as Record<string, string[]> | undefined) ?? {};
    meta['favoriteModels'] = (cfg.favoriteModels as string[]) ?? [];
    meta['favoriteModelsOnly'] = cfg.favoriteModelsOnly === true;
    meta['modelMatrix'] =
      (cfg.modelMatrix as Record<string, { provider?: string; model?: string; fallbackProfile?: string }> | undefined) ??
      {};
    meta['fallbackAuto'] = cfg.fallbackAuto !== false;
    meta['featureMcp'] = features['mcp'] !== false;
    meta['featurePlugins'] = features['plugins'] !== false;
    meta['featureMemory'] = features['memory'] !== false;
    meta['featureSkills'] = features['skills'] !== false;
    meta['featureModelsRegistry'] = features['modelsRegistry'] !== false;
    meta['indexOnStart'] = (cfg.indexing as Record<string, unknown>)?.['onSessionStart'] !== false;
    meta['contextAutoCompact'] =
      (cfg.context as Record<string, unknown>)?.['autoCompact'] !== false;
    meta['contextStrategy'] = (cfg.context as Record<string, unknown>)?.['strategy'] ?? 'hybrid';
    meta['contextMode'] = (cfg.context as Record<string, unknown>)?.['mode'] ?? 'balanced';
    {
      const tsm = (features as Record<string, unknown>)['tokenSavingMode'];
      meta['tokenSavingTier'] = typeof tsm === 'string' ? tsm : tsm ? 'medium' : 'off';
    }
    meta['maxConcurrent'] = typeof cfg.maxConcurrent === 'number' ? cfg.maxConcurrent : 10;
    meta['titleAnimation'] = autonomyCfg['terminalTitleAnimation'] !== false;
    {
      const mr = (cfg.modelRuntime as Record<string, unknown> | undefined) ?? {};
      const reasoning = (mr['reasoning'] as Record<string, unknown> | undefined) ?? {};
      const cache = (mr['cache'] as Record<string, unknown> | undefined) ?? {};
      meta['reasoningMode'] = (reasoning['mode'] as string) ?? 'auto';
      meta['reasoningEffort'] = (reasoning['effort'] as string) ?? 'high';
      meta['reasoningPreserve'] = reasoning['preserve'] === true;
      meta['cacheTtl'] = (cache['ttl'] as string) ?? 'default';
    }
    meta['logLevel'] = (cfg.log as Record<string, unknown>)?.['level'] ?? 'info';
    meta['auditLevel'] = (cfg.session as Record<string, unknown>)?.['auditLevel'] ?? 'standard';
    meta['maxIterations'] = (cfg.tools as Record<string, unknown>)?.['maxIterations'] ?? 500;
    const hqCfg = (cfg.hq as Record<string, unknown>) ?? {};
    meta['hqEnabled'] = hqCfg['enabled'] === true;
    meta['hqUrl'] = typeof hqCfg['url'] === 'string' ? (hqCfg['url'] as string) : '';
    meta['hqToken'] = typeof hqCfg['token'] === 'string' ? (hqCfg['token'] as string) : '';
    meta['hqRawContent'] = hqCfg['rawContent'] === true;
    // Telegram plugin notification settings live under extensions.telegram —
    // same path the standalone server seeds and /telegram-settings writes.
    const tgExt = (cfg.extensions as Record<string, Record<string, unknown>> | undefined)?.[
      'telegram'
    ];
    meta['tgConfigured'] =
      typeof tgExt?.['botToken'] === 'string' && (tgExt['botToken'] as string).length > 0;
    meta['tgSessionEnd'] = tgExt?.['notifyOnSessionEnd'] === true;
    meta['tgDelegate'] = tgExt?.['notifyOnDelegate'] !== false; // default true
    const tgMs = tgExt?.['longToolThresholdMs'];
    meta['tgLongToolMs'] = typeof tgMs === 'number' ? (tgMs as number) : 30_000;
  } catch {
    // best-effort — missing/corrupt config just leaves prefs unseeded
  }
}

// ── createPrefsSeeding ────────────────────────────────────────────────────────

interface PrefsSeeding {
  prefSnapshot: () => PrefSnapshot;
  persistPrefs: (payload: PrefSnapshot) => Promise<void>;
}

/**
 * Factory – returns `prefSnapshot` and `persistPrefs` with file I/O captured
 * in closure. Call once per `runWebUI` instance.
 */
export function createPrefsSeeding(opts: CliWebUIOptions): PrefsSeeding {
  let prefWriteLock: Promise<unknown> = Promise.resolve();

  const patchLiveAppConfig = (patch: NonNullable<CliWebUIOptions['appConfig']>): void => {
    if (!opts.appConfig) return;
    opts.appConfig = { ...opts.appConfig, ...patch };
  };

  /** Capture the current set of live preference values from agent.ctx.meta. */
  const prefSnapshot = (): PrefSnapshot => {
    const snapshot: PrefSnapshot = {};
    for (const k of PREF_KEYS) {
      if (k in opts.agent.ctx.meta) snapshot[k] = opts.agent.ctx.meta[k];
    }
    return snapshot;
  };

  /** Persist a preference diff back to config.json. */
  const persistPrefs = async (payload: PrefSnapshot): Promise<void> => {
    const configPath = opts.globalConfigPath;
    if (Array.isArray(payload['fallbackModels']))
      patchLiveAppConfig({ fallbackModels: payload['fallbackModels'] as string[] });
    if (
      payload['fallbackProfiles'] &&
      typeof payload['fallbackProfiles'] === 'object' &&
      !Array.isArray(payload['fallbackProfiles'])
    ) {
      patchLiveAppConfig({
        fallbackProfiles: payload['fallbackProfiles'] as Record<string, string[]>,
      });
    }
    if (Array.isArray(payload['favoriteModels']))
      patchLiveAppConfig({ favoriteModels: payload['favoriteModels'] as string[] });
    if (typeof payload['favoriteModelsOnly'] === 'boolean')
      patchLiveAppConfig({ favoriteModelsOnly: payload['favoriteModelsOnly'] });
    if (typeof payload['fallbackAuto'] === 'boolean')
      patchLiveAppConfig({ fallbackAuto: payload['fallbackAuto'] });
    if (
      payload['modelMatrix'] &&
      typeof payload['modelMatrix'] === 'object' &&
      !Array.isArray(payload['modelMatrix'])
    ) {
      patchLiveAppConfig({
        modelMatrix: payload['modelMatrix'] as Record<
          string,
          {
            provider?: string | undefined;
            model?: string | undefined;
            fallbackProfile?: string | undefined;
          }
        >,
      });
    }
    if (!configPath) return;

    const write = async (): Promise<void> => {
      const raw = await fs.readFile(configPath, 'utf8');
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const vault = new DefaultSecretVault({
        keyFile: path.join(path.dirname(configPath), '.key'),
      });
      const decrypted = decryptConfigSecrets(parsed, vault) as Record<string, unknown>;

      // Map meta keys back to their config-file paths.
      const autonomy = (decrypted.autonomy as Record<string, unknown>) ?? {};
      if ('autonomy' in payload) autonomy['defaultMode'] = payload['autonomy'];
      if ('autonomyDelayMs' in payload) autonomy['autoProceedDelayMs'] = payload['autonomyDelayMs'];
      if ('autoProceedMaxIterations' in payload)
        autonomy['autoProceedMaxIterations'] = payload['autoProceedMaxIterations'];
      if ('yolo' in payload) {
        autonomy['yolo'] = payload['yolo'];
        decrypted['yolo'] = payload['yolo'];
      }
      if ('chime' in payload) autonomy['chime'] = payload['chime'];
      if ('confirmExit' in payload) autonomy['confirmExit'] = payload['confirmExit'];
      if ('streamFleet' in payload) autonomy['streamFleet'] = payload['streamFleet'];
      if ('enhanceEnabled' in payload) autonomy['enhance'] = payload['enhanceEnabled'];
      if ('enhanceDelayMs' in payload) autonomy['enhanceDelayMs'] = payload['enhanceDelayMs'];
      if ('enhanceLanguage' in payload) autonomy['enhanceLanguage'] = payload['enhanceLanguage'];
      if ('nextPrediction' in payload) decrypted['nextPrediction'] = payload['nextPrediction'];
      // Active provider/model — written by model.switch so a browser model
      // change survives restart (parity with the standalone server, which
      // persists provider+model in its model.switch handler).
      if (typeof payload['provider'] === 'string') decrypted['provider'] = payload['provider'];
      if (typeof payload['model'] === 'string') decrypted['model'] = payload['model'];
      if ('fallbackModels' in payload) decrypted['fallbackModels'] = payload['fallbackModels'];
      if ('fallbackProfiles' in payload)
        decrypted['fallbackProfiles'] = payload['fallbackProfiles'];
      if ('favoriteModels' in payload) decrypted['favoriteModels'] = payload['favoriteModels'];
      if ('favoriteModelsOnly' in payload)
        decrypted['favoriteModelsOnly'] = payload['favoriteModelsOnly'];
      if ('modelMatrix' in payload) decrypted['modelMatrix'] = payload['modelMatrix'];
      if ('fallbackAuto' in payload) decrypted['fallbackAuto'] = payload['fallbackAuto'];
      decrypted['autonomy'] = autonomy;

      if (
        'featureMcp' in payload ||
        'featurePlugins' in payload ||
        'featureMemory' in payload ||
        'featureSkills' in payload ||
        'featureModelsRegistry' in payload
      ) {
        const features = (decrypted.features as Record<string, unknown>) ?? {};
        if ('featureMcp' in payload) features['mcp'] = payload['featureMcp'];
        if ('featurePlugins' in payload) features['plugins'] = payload['featurePlugins'];
        if ('featureMemory' in payload) features['memory'] = payload['featureMemory'];
        if ('featureSkills' in payload) features['skills'] = payload['featureSkills'];
        if ('featureModelsRegistry' in payload)
          features['modelsRegistry'] = payload['featureModelsRegistry'];
        decrypted['features'] = features;
      }

      if ('indexOnStart' in payload) {
        const idx = (decrypted.indexing as Record<string, unknown>) ?? {};
        idx['onSessionStart'] = payload['indexOnStart'];
        decrypted['indexing'] = idx;
      }

      if ('contextAutoCompact' in payload || 'contextStrategy' in payload || 'contextMode' in payload) {
        const ctx2 = (decrypted.context as Record<string, unknown>) ?? {};
        if ('contextAutoCompact' in payload) ctx2['autoCompact'] = payload['contextAutoCompact'];
        if ('contextStrategy' in payload) ctx2['strategy'] = payload['contextStrategy'];
        if ('contextMode' in payload) ctx2['mode'] = payload['contextMode'];
        decrypted['context'] = ctx2;
      }

      if ('tokenSavingTier' in payload) {
        const feats = (decrypted.features as Record<string, unknown>) ?? {};
        feats['tokenSavingMode'] = payload['tokenSavingTier'];
        decrypted['features'] = feats;
      }

      if ('maxConcurrent' in payload) decrypted['maxConcurrent'] = payload['maxConcurrent'];

      if ('titleAnimation' in payload) {
        autonomy['terminalTitleAnimation'] = payload['titleAnimation'];
        decrypted['autonomy'] = autonomy;
      }

      if (
        'reasoningMode' in payload ||
        'reasoningEffort' in payload ||
        'reasoningPreserve' in payload ||
        'cacheTtl' in payload
      ) {
        const mr = (decrypted.modelRuntime as Record<string, unknown>) ?? {};
        const reasoning = (mr['reasoning'] as Record<string, unknown>) ?? {};
        if ('reasoningMode' in payload) reasoning['mode'] = payload['reasoningMode'];
        if ('reasoningEffort' in payload) reasoning['effort'] = payload['reasoningEffort'];
        if ('reasoningPreserve' in payload) reasoning['preserve'] = payload['reasoningPreserve'];
        mr['reasoning'] = reasoning;
        if ('cacheTtl' in payload) {
          if (payload['cacheTtl'] === 'default') delete mr['cache'];
          else mr['cache'] = { ttl: payload['cacheTtl'] };
        }
        decrypted['modelRuntime'] = mr;
      }

      if ('logLevel' in payload) {
        const log = (decrypted.log as Record<string, unknown>) ?? {};
        log['level'] = payload['logLevel'];
        decrypted['log'] = log;
      }

      if ('auditLevel' in payload) {
        const session = (decrypted.session as Record<string, unknown>) ?? {};
        session['auditLevel'] = payload['auditLevel'];
        decrypted['session'] = session;
      }

      if ('maxIterations' in payload) {
        const tools = (decrypted.tools as Record<string, unknown>) ?? {};
        tools['maxIterations'] = payload['maxIterations'];
        decrypted['tools'] = tools;
      }

      // HQ settings → top-level `hq` key.
      if (
        'hqEnabled' in payload ||
        'hqUrl' in payload ||
        'hqToken' in payload ||
        'hqRawContent' in payload
      ) {
        const hqCfg = (decrypted.hq as Record<string, unknown>) ?? {};
        if (typeof payload['hqEnabled'] === 'boolean') hqCfg['enabled'] = payload['hqEnabled'];
        if (typeof payload['hqUrl'] === 'string') hqCfg['url'] = payload['hqUrl'];
        if (typeof payload['hqToken'] === 'string') hqCfg['token'] = payload['hqToken'];
        if (typeof payload['hqRawContent'] === 'boolean')
          hqCfg['rawContent'] = payload['hqRawContent'];
        decrypted.hq = hqCfg;
      }

      // Telegram plugin notification settings → extensions.telegram (parity
      // with the standalone server / the path /telegram-settings writes).
      const tgTouched =
        typeof payload['tgSessionEnd'] === 'boolean' ||
        typeof payload['tgDelegate'] === 'boolean' ||
        typeof payload['tgLongToolMs'] === 'number';
      if (tgTouched) {
        const ext = (decrypted.extensions as Record<string, Record<string, unknown>>) ?? {};
        const tg = ext['telegram'] ?? {};
        if (typeof payload['tgSessionEnd'] === 'boolean')
          tg['notifyOnSessionEnd'] = payload['tgSessionEnd'];
        if (typeof payload['tgDelegate'] === 'boolean')
          tg['notifyOnDelegate'] = payload['tgDelegate'];
        if (typeof payload['tgLongToolMs'] === 'number')
          tg['longToolThresholdMs'] = payload['tgLongToolMs'];
        ext['telegram'] = tg;
        decrypted.extensions = ext;
      }

      const encrypted = encryptConfigSecrets(decrypted, vault);
      await atomicWrite(configPath, JSON.stringify(encrypted, null, 2), { mode: 0o600 });
    };

    // Chain onto any in-flight write so two concurrent pref updates don't race.
    const next = prefWriteLock.then(write);
    prefWriteLock = next.then(
      () => undefined,
      () => undefined,
    );
    try {
      await next;
    } catch (err) {
      console.error(
        JSON.stringify({
          level: 'warn',
          event: 'webui.prefs.persist_failed',
          message: err instanceof Error ? err.message : String(err),
          timestamp: new Date().toISOString(),
        }),
      );
    }
  };

  return { prefSnapshot, persistPrefs };
}
