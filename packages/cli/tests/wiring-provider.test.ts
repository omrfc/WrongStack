import { describe, expect, it, vi, beforeEach } from 'vitest';
import { setupProvider } from '../src/wiring/provider.js';
import type { Config, Logger, ModelsRegistry, ResolvedProvider } from '@wrongstack/core';

// Mock the providers package — we test setupProvider in isolation from
// the real provider factory chain. The factories are exercised in their
// own package tests.
vi.mock('@wrongstack/providers', () => ({
  buildProviderFactoriesFromRegistry: vi.fn(),
  makeProviderFromConfig: vi.fn(),
}));

const providersMod = await import('@wrongstack/providers');
const buildProviderFactoriesFromRegistry = vi.mocked(
  providersMod.buildProviderFactoriesFromRegistry,
);
const makeProviderFromConfig = vi.mocked(providersMod.makeProviderFromConfig);

function fakeLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(),
    setLevel: vi.fn(),
  } as never as Logger;
}

function fakeModelsRegistry(overrides: Partial<ModelsRegistry> = {}): ModelsRegistry {
  return {
    getProvider: vi.fn().mockResolvedValue(undefined),
    listProviders: vi.fn(),
    suggestModel: vi.fn(),
    refresh: vi.fn(),
    ...overrides,
  } as never as ModelsRegistry;
}

function fakeConfig(overrides: Partial<Config> = {}): Config {
  return {
    version: 1,
    provider: 'anthropic',
    model: 'claude',
    apiKey: 'sk-test',
    features: { mcp: true, plugins: true, memory: true, modelsRegistry: true, skills: true },
    ...overrides,
  } as Config;
}

const fakeFactory = { type: 'anthropic', create: () => ({}) } as never;
const fakeProviderInstance = { name: 'anthropic-instance' } as never;

beforeEach(() => {
  vi.clearAllMocks();
  buildProviderFactoriesFromRegistry.mockResolvedValue([fakeFactory]);
  makeProviderFromConfig.mockReturnValue(fakeProviderInstance);
});

describe('setupProvider', () => {
  it('resolves provider and creates via registry on happy path', async () => {
    const resolved = { family: 'anthropic', npm: '@anthropic-ai/sdk' } as ResolvedProvider;
    const modelsRegistry = fakeModelsRegistry({
      getProvider: vi.fn().mockResolvedValue(resolved),
    });

    const out = await setupProvider({
      config: fakeConfig(),
      modelsRegistry,
      logger: fakeLogger(),
    });

    expect(out.resolvedProvider).toBe(resolved);
    expect(out.providerRegistry.has('anthropic')).toBe(true);
    // Registry path used — makeProviderFromConfig should NOT be called.
    expect(makeProviderFromConfig).not.toHaveBeenCalled();
    expect(out.provider).toBeDefined();
  });

  it('falls back to savedProviderCfg.type when primary lookup misses', async () => {
    const resolved = { family: 'openai', npm: 'openai' } as ResolvedProvider;
    const getProvider = vi
      .fn()
      .mockImplementationOnce(() => Promise.resolve(undefined))
      .mockImplementationOnce(() => Promise.resolve(resolved));
    const modelsRegistry = fakeModelsRegistry({ getProvider });

    const out = await setupProvider({
      config: fakeConfig({
        provider: 'my-openai',
        providers: { 'my-openai': { type: 'openai', apiKey: 'sk' } },
      }),
      modelsRegistry,
      logger: fakeLogger(),
    });

    expect(getProvider).toHaveBeenCalledTimes(2);
    expect(out.resolvedProvider).toBe(resolved);
  });

  it('warns when provider unresolved and no saved family', async () => {
    const logger = fakeLogger();
    await setupProvider({
      config: fakeConfig({ provider: 'mystery' }),
      modelsRegistry: fakeModelsRegistry(),
      logger,
    });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('"mystery" not found in models.dev'),
    );
  });

  it('does NOT warn when saved provider has family override', async () => {
    const logger = fakeLogger();
    await setupProvider({
      config: fakeConfig({
        provider: 'mystery',
        providers: { mystery: { type: 'mystery', family: 'openai' } as never },
      }),
      modelsRegistry: fakeModelsRegistry(),
      logger,
    });
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('throws UNSUPPORTED_PROVIDER when family is unsupported and no override', async () => {
    const resolved = { family: 'unsupported', npm: 'weird-sdk' } as ResolvedProvider;
    const modelsRegistry = fakeModelsRegistry({
      getProvider: vi.fn().mockResolvedValue(resolved),
    });

    await expect(
      setupProvider({
        config: fakeConfig({ provider: 'weird' }),
        modelsRegistry,
        logger: fakeLogger(),
      }),
    ).rejects.toMatchObject({
      code: 'UNSUPPORTED_PROVIDER',
      message: expect.stringContaining('weird-sdk'),
    });
  });

  it('skips registry build when modelsRegistry feature is disabled', async () => {
    const out = await setupProvider({
      config: fakeConfig({
        features: { mcp: true, plugins: true, memory: true, modelsRegistry: false, skills: true },
      }),
      modelsRegistry: fakeModelsRegistry(),
      logger: fakeLogger(),
    });

    expect(buildProviderFactoriesFromRegistry).not.toHaveBeenCalled();
    // Registry empty → falls through to makeProviderFromConfig.
    expect(makeProviderFromConfig).toHaveBeenCalled();
    expect(out.provider).toBe(fakeProviderInstance);
  });

  it('wraps registry build failure with actionable hint', async () => {
    buildProviderFactoriesFromRegistry.mockRejectedValue(new Error('ENOENT'));

    await expect(
      setupProvider({
        config: fakeConfig(),
        modelsRegistry: fakeModelsRegistry(),
        logger: fakeLogger(),
      }),
    ).rejects.toThrow(/Failed to load models\.dev registry.*ENOENT.*wstack models refresh/s);
  });

  it('wraps provider create failure with descriptive error', async () => {
    makeProviderFromConfig.mockImplementation(() => {
      throw new Error('bad config');
    });
    buildProviderFactoriesFromRegistry.mockResolvedValue([]); // registry empty

    await expect(
      setupProvider({
        config: fakeConfig({ provider: 'novel' }),
        modelsRegistry: fakeModelsRegistry(),
        logger: fakeLogger(),
      }),
    ).rejects.toThrow(/Failed to create provider.*bad config/);
  });

  it('uses providerConfig from config.providers when available', async () => {
    buildProviderFactoriesFromRegistry.mockResolvedValue([]);
    await setupProvider({
      config: fakeConfig({
        provider: 'openai',
        providers: { openai: { type: 'openai', apiKey: 'sk-saved', baseUrl: 'https://x' } },
      }),
      modelsRegistry: fakeModelsRegistry(),
      logger: fakeLogger(),
    });
    expect(makeProviderFromConfig).toHaveBeenCalledWith(
      'openai',
      expect.objectContaining({ apiKey: 'sk-saved', baseUrl: 'https://x', type: 'openai' }),
    );
  });

  it('handles non-Error throw from makeProviderFromConfig', async () => {
    buildProviderFactoriesFromRegistry.mockResolvedValue([]);
    makeProviderFromConfig.mockImplementation(() => {
      throw 'plain string';
    });
    await expect(
      setupProvider({
        config: fakeConfig(),
        modelsRegistry: fakeModelsRegistry(),
        logger: fakeLogger(),
      }),
    ).rejects.toThrow(/Failed to create provider.*plain string/);
  });

  it('handles non-Error throw from buildProviderFactoriesFromRegistry', async () => {
    buildProviderFactoriesFromRegistry.mockRejectedValue('registry boom');
    await expect(
      setupProvider({
        config: fakeConfig(),
        modelsRegistry: fakeModelsRegistry(),
        logger: fakeLogger(),
      }),
    ).rejects.toThrow(/Failed to load models\.dev registry.*registry boom/);
  });
});
