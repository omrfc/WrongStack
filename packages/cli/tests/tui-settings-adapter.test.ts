import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DefaultConfigStore, type Config } from '@wrongstack/core';
import { describe, expect, it } from 'vitest';
import { createSettingsAdapter } from '../src/boot/tui-settings-adapter.js';

function baseConfig(overrides: Partial<Config> = {}): Config {
  return {
    version: 1,
    provider: 'test',
    model: 'test-model',
    maxConcurrent: 4,
    context: {
      warnThreshold: 0.7,
      softThreshold: 0.8,
      hardThreshold: 0.95,
      preserveK: 10,
      eliseThreshold: 2000,
      autoCompact: true,
      strategy: 'hybrid',
      mode: 'balanced',
    },
    tools: {
      defaultExecutionStrategy: 'smart',
      maxIterations: 100,
      iterationTimeoutMs: 300_000,
      sessionTimeoutMs: 1_800_000,
      perIterationOutputCapBytes: 100_000,
      descriptionMode: {},
      autoExtendLimit: true,
      restrictToProjectRoot: false,
    },
    log: { level: 'info' },
    features: {
      mcp: true,
      plugins: true,
      memory: true,
      modelsRegistry: true,
      skills: true,
      tokenSavingMode: 'off',
      allowOutsideProjectRoot: true,
    },
    autonomy: {
      autoProceedDelayMs: 45_000,
    },
    indexing: {
      onSessionStart: true,
      onEdit: true,
      watchExternal: true,
      debounceMs: 400,
    },
    session: {
      auditLevel: 'standard',
    },
    modelRuntime: {
      reasoning: { mode: 'auto', effort: 'high', preserve: false },
      cache: { ttl: '1h' },
      parameters: { user: 'kept' },
    },
    ...overrides,
  };
}

function makeAdapter(initial = baseConfig()) {
  const dir = mkdtempSync(path.join(tmpdir(), 'wstack-tui-settings-'));
  const globalConfig = path.join(dir, 'global', 'config.json');
  const inProjectConfig = path.join(dir, 'project', '.wrongstack', 'config.json');
  mkdirSync(path.dirname(globalConfig), { recursive: true });
  writeFileSync(globalConfig, JSON.stringify(initial, null, 2), 'utf8');

  const configStore = new DefaultConfigStore(initial);
  const applied: unknown[] = [];
  const adapter = createSettingsAdapter({
    configStore,
    wpaths: { globalConfig, inProjectConfig } as never,
    fleetStreamController: undefined,
    applyLiveSettings: (settings) => {
      applied.push(settings);
    },
  });

  return { adapter, configStore, globalConfig, inProjectConfig, applied };
}

describe('TUI settings adapter', () => {
  it('returns the runtime default maxConcurrent when config has no setting', () => {
    const initial = baseConfig({ maxConcurrent: undefined as never });
    const { adapter } = makeAdapter(initial);

    expect(adapter.getSettings().maxConcurrent).toBe(4);
  });

  it('partial saves preserve existing autonomy fields', async () => {
    const { adapter, configStore, globalConfig } = makeAdapter(
      baseConfig({
        autonomy: {
          defaultMode: 'suggest',
          autoProceedDelayMs: 30_000,
          terminalTitleAnimation: false,
        },
      }),
    );

    const err = await adapter.saveSettings({ contextMode: 'deep' });

    expect(err).toBeNull();
    const written = JSON.parse(readFileSync(globalConfig, 'utf8'));
    expect(written.autonomy.defaultMode).toBe('suggest');
    expect(written.autonomy.autoProceedDelayMs).toBe(30_000);
    expect(written.autonomy.terminalTitleAnimation).toBe(false);
    expect(written.context.mode).toBe('deep');
    expect(configStore.get().autonomy?.defaultMode).toBe('suggest');
    expect(configStore.get().autonomy?.autoProceedDelayMs).toBe(30_000);
  });

  it('cacheTtl default removes cache TTL from disk and the live config store', async () => {
    const { adapter, configStore, globalConfig } = makeAdapter(
      baseConfig({
        modelRuntime: {
          reasoning: { mode: 'auto', effort: 'high', preserve: false },
          cache: { ttl: '5m' },
        },
      }),
    );

    const err = await adapter.saveSettings({ cacheTtl: 'default' });

    expect(err).toBeNull();
    const written = JSON.parse(readFileSync(globalConfig, 'utf8'));
    expect(written.modelRuntime.cache).toBeUndefined();
    expect(configStore.get().modelRuntime?.cache).toBeUndefined();
  });

  it('persists all TUI settings rows that are saved through the picker', async () => {
    const { adapter, configStore, globalConfig, applied } = makeAdapter();

    const err = await adapter.saveSettings({
      mode: 'auto',
      delayMs: 15_000,
      yolo: true,
      featureTokenSaving: 'light',
      allowOutsideProjectRoot: false,
      contextAutoCompact: false,
      contextStrategy: 'selective',
      contextMode: 'deep',
      maxConcurrent: 25,
      logLevel: 'debug',
      auditLevel: 'full',
      indexOnStart: false,
      maxIterations: 200,
      autoProceedMaxIterations: 10,
      enhanceDelayMs: 15_000,
      enhanceEnabled: false,
      enhanceLanguage: 'english',
      reasoningMode: 'off',
      reasoningEffort: 'minimal',
      reasoningPreserve: true,
      cacheTtl: '5m',
    });

    expect(err).toBeNull();
    expect(applied).toHaveLength(1);

    const written = JSON.parse(readFileSync(globalConfig, 'utf8'));
    expect(written.autonomy.autoProceedDelayMs).toBe(15_000);
    expect(written.yolo).toBe(true);
    expect(written.autonomy.yolo).toBe(true);
    expect(written.autonomy.autoProceedMaxIterations).toBe(10);
    expect(written.autonomy.enhanceDelayMs).toBe(15_000);
    expect(written.autonomy.enhance).toBe(false);
    expect(written.autonomy.enhanceLanguage).toBe('english');
    expect(written.features.tokenSavingMode).toBe('light');
    expect(written.features.allowOutsideProjectRoot).toBe(false);
    expect(written.tools.restrictToProjectRoot).toBe(true);
    expect(written.context.autoCompact).toBe(false);
    expect(written.context.strategy).toBe('selective');
    expect(written.context.mode).toBe('deep');
    expect(written.maxConcurrent).toBe(25);
    expect(written.log.level).toBe('debug');
    expect(written.session.auditLevel).toBe('full');
    expect(written.indexing.onSessionStart).toBe(false);
    expect(written.modelRuntime.reasoning).toEqual({
      mode: 'off',
      effort: 'minimal',
      preserve: true,
    });
    expect(written.modelRuntime.cache.ttl).toBe('5m');

    const live = configStore.get();
    expect(live.yolo).toBe(true);
    expect(live.context.mode).toBe('deep');
    expect(live.maxConcurrent).toBe(25);
    expect(live.features.allowOutsideProjectRoot).toBe(false);
    expect(live.tools.restrictToProjectRoot).toBe(true);
    expect(live.autonomy?.enhanceDelayMs).toBe(15_000);
    expect(live.modelRuntime?.reasoning?.mode).toBe('off');
    expect(live.modelRuntime?.cache?.ttl).toBe('5m');
    expect(live.modelRuntime?.parameters?.user).toBe('kept');

    const settings = adapter.getSettings();
    expect(settings['contextMode']).toBe('deep');
    expect(settings['maxConcurrent']).toBe(25);
    expect(settings['reasoningMode']).toBe('off');
    expect(settings['cacheTtl']).toBe('5m');
  });

  it('creates the project config when config scope changes to project', async () => {
    const { adapter, configStore, inProjectConfig } = makeAdapter();

    const err = await adapter.saveSettings({
      mode: 'auto',
      delayMs: 15_000,
      configScope: 'project',
      contextMode: 'frugal',
      enhanceDelayMs: 15_000,
      enhanceEnabled: false,
      reasoningMode: 'on',
      cacheTtl: '5m',
    });

    expect(err).toBeNull();
    const written = JSON.parse(readFileSync(inProjectConfig, 'utf8'));
    expect(written.configScope).toBe('project');
    expect(written.autonomy.defaultMode).toBe('auto');
    expect(written.autonomy.autoProceedDelayMs).toBe(15_000);
    expect(written.autonomy.enhanceDelayMs).toBe(15_000);
    expect(written.autonomy.enhance).toBe(false);
    expect(written.context.mode).toBe('frugal');
    expect(written.modelRuntime.reasoning.mode).toBe('on');
    expect(written.modelRuntime.cache.ttl).toBe('5m');
    expect(configStore.get().configScope).toBe('project');
    expect(configStore.get().autonomy?.defaultMode).toBe('auto');
    expect(configStore.get().autonomy?.autoProceedDelayMs).toBe(15_000);
    expect(configStore.get().context.mode).toBe('frugal');
    expect(configStore.get().modelRuntime?.reasoning?.mode).toBe('on');
  });
});
