import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createPrefsSeeding, seedConfigToMeta } from '../../src/webui-server/prefs-seeding.js';

describe('createPrefsSeeding', () => {
  it('updates live app config prefs without mutating a frozen config object', async () => {
    const frozenConfig = Object.freeze({});
    const opts = {
      agent: { ctx: { meta: {} } },
      appConfig: frozenConfig,
    } as never;

    const { persistPrefs } = createPrefsSeeding(opts);

    await expect(
      persistPrefs({
        fallbackProfiles: { default: ['anthropic/claude-sonnet-4'] },
      }),
    ).resolves.toBeUndefined();
    expect((opts as { appConfig: unknown }).appConfig).not.toBe(frozenConfig);
    expect((opts as { appConfig: { fallbackProfiles?: unknown } }).appConfig.fallbackProfiles).toEqual({
      default: ['anthropic/claude-sonnet-4'],
    });
    expect(Object.isExtensible(frozenConfig)).toBe(false);
  });

  it('persists reasoning/cache + contextMode/tokenSavingTier/maxConcurrent/titleAnimation to config.json (parity with the standalone server)', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'wstack-prefs-seed-'));
    const globalConfigPath = path.join(dir, 'config.json');
    writeFileSync(globalConfigPath, JSON.stringify({ version: 1 }), 'utf8');

    const opts = {
      agent: { ctx: { meta: {} } },
      globalConfigPath,
      appConfig: {},
    } as never;

    const { persistPrefs } = createPrefsSeeding(opts);
    await persistPrefs({
      reasoningMode: 'on',
      reasoningEffort: 'low',
      reasoningPreserve: true,
      cacheTtl: '1h',
      contextMode: 'frugal',
      tokenSavingTier: 'light',
      maxConcurrent: 7,
      titleAnimation: false,
    });

    const written = JSON.parse(readFileSync(globalConfigPath, 'utf8'));
    expect(written.modelRuntime.reasoning).toEqual({ mode: 'on', effort: 'low', preserve: true });
    expect(written.modelRuntime.cache).toEqual({ ttl: '1h' });
    expect(written.context.mode).toBe('frugal');
    expect(written.features.tokenSavingMode).toBe('light');
    expect(written.maxConcurrent).toBe(7);
    expect(written.autonomy.terminalTitleAnimation).toBe(false);
  });

  it('persists provider+model to config.json (model.switch path)', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'wstack-prefs-model-'));
    const globalConfigPath = path.join(dir, 'config.json');
    writeFileSync(
      globalConfigPath,
      JSON.stringify({ version: 1, provider: 'anthropic', model: 'old-model' }),
      'utf8',
    );
    const opts = { agent: { ctx: { meta: {} } }, globalConfigPath, appConfig: {} } as never;
    const { persistPrefs } = createPrefsSeeding(opts);
    await persistPrefs({ provider: 'openai', model: 'gpt-5-codex' });
    const written = JSON.parse(readFileSync(globalConfigPath, 'utf8'));
    expect(written.provider).toBe('openai');
    expect(written.model).toBe('gpt-5-codex');
  });

  it('cacheTtl "default" removes the cache override', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'wstack-prefs-cache-'));
    const globalConfigPath = path.join(dir, 'config.json');
    writeFileSync(
      globalConfigPath,
      JSON.stringify({ version: 1, modelRuntime: { cache: { ttl: '1h' } } }),
      'utf8',
    );
    const opts = { agent: { ctx: { meta: {} } }, globalConfigPath, appConfig: {} } as never;
    const { persistPrefs } = createPrefsSeeding(opts);
    await persistPrefs({ cacheTtl: 'default' });
    const written = JSON.parse(readFileSync(globalConfigPath, 'utf8'));
    expect(written.modelRuntime.cache).toBeUndefined();
  });
});

describe('seedConfigToMeta', () => {
  it('seeds reasoning/cache + contextMode/tokenSavingTier/maxConcurrent/titleAnimation from config.json', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'wstack-prefs-meta-'));
    const globalConfigPath = path.join(dir, 'config.json');
    writeFileSync(
      globalConfigPath,
      JSON.stringify({
        version: 1,
        maxConcurrent: 3,
        context: { mode: 'deep' },
        features: { tokenSavingMode: 'medium' },
        autonomy: { terminalTitleAnimation: false },
        modelRuntime: { reasoning: { mode: 'off', effort: 'max', preserve: true }, cache: { ttl: '5m' } },
      }),
      'utf8',
    );
    const meta: Record<string, unknown> = {};
    await seedConfigToMeta({ agent: { ctx: { meta } }, globalConfigPath } as never);

    expect(meta['maxConcurrent']).toBe(3);
    expect(meta['contextMode']).toBe('deep');
    expect(meta['tokenSavingTier']).toBe('medium');
    expect(meta['titleAnimation']).toBe(false);
    expect(meta['reasoningMode']).toBe('off');
    expect(meta['reasoningEffort']).toBe('max');
    expect(meta['reasoningPreserve']).toBe(true);
    expect(meta['cacheTtl']).toBe('5m');
  });
});
