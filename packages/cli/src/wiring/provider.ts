import type { ResolvedProvider } from '@wrongstack/core';
import { type Config, type Logger, type ModelsRegistry, ProviderRegistry } from '@wrongstack/core';
import { buildProviderFactoriesFromRegistry, makeProviderFromConfig } from '@wrongstack/providers';

export interface ProviderSetupResult {
  resolvedProvider: ResolvedProvider | undefined;
  provider: ReturnType<ProviderRegistry['create']>;
  providerRegistry: ProviderRegistry;
}

export async function setupProvider(params: {
  config: Config;
  modelsRegistry: ModelsRegistry;
  logger: Logger;
}): Promise<ProviderSetupResult> {
  const { config, modelsRegistry, logger } = params;

  // Resolve provider details from models.dev.
  const savedProviderCfg = config.providers?.[config.provider];
  let resolvedProvider = await modelsRegistry.getProvider(config.provider).catch(() => undefined);
  if (!resolvedProvider && savedProviderCfg?.type && savedProviderCfg.type !== config.provider) {
    resolvedProvider = await modelsRegistry
      .getProvider(savedProviderCfg.type)
      .catch(() => undefined);
  }
  if (!resolvedProvider) {
    if (savedProviderCfg?.family) {
      // Config-only provider not in the models.dev catalog — e.g. the OAuth
      // subscription families (openai-codex, anthropic-oauth, github-copilot)
      // or any user-defined provider with an explicit `family`. Synthesize a
      // ResolvedProvider from config so boot proceeds (the actual transport is
      // still built below via makeProviderFromConfig / the registry).
      resolvedProvider = {
        id: config.provider,
        name: config.provider,
        family: savedProviderCfg.family,
        apiBase: savedProviderCfg.baseUrl,
        envVars: savedProviderCfg.envVars ?? [],
        models: (savedProviderCfg.models ?? []).map((m) => ({ id: m, name: m })),
        npm: undefined,
      };
    } else {
      logger.warn(
        `Provider "${config.provider}" not found in models.dev. Continuing with raw config.`,
      );
    }
  } else if (resolvedProvider.family === 'unsupported' && !savedProviderCfg?.family) {
    throw Object.assign(
      new Error(
        `Provider "${config.provider}" uses an unsupported wire family (${resolvedProvider.npm}). ` +
          `Install a plugin to enable it, or pick a different provider.`,
      ),
      { code: 'UNSUPPORTED_PROVIDER' },
    );
  }

  // Provider registry — populated dynamically from models.dev catalog.
  const providerRegistry = new ProviderRegistry();
  if (config.features.modelsRegistry) {
    try {
      const factories = await buildProviderFactoriesFromRegistry({
        registry: modelsRegistry,
        log: logger,
      });
      for (const f of factories) providerRegistry.register(f);
    } catch (err) {
      throw new Error(
        `Failed to load models.dev registry: ${err instanceof Error ? err.message : err}\n` +
          `Try \`wstack models refresh\` once you have network access, or run with --no-features.`,
      );
    }
  }

  // Provider instance — registry-driven by default, falls through to config-only.
  const providerConfig = config.providers?.[config.provider] ?? {
    type: config.provider,
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
  };
  let provider: ReturnType<ProviderRegistry['create']>;
  try {
    const cfgWithType = { ...providerConfig, type: config.provider };
    if (config.features.modelsRegistry && providerRegistry.has(config.provider)) {
      provider = providerRegistry.create(cfgWithType);
    } else {
      provider = makeProviderFromConfig(config.provider, cfgWithType);
    }
  } catch (err) {
    throw new Error(`Failed to create provider: ${err instanceof Error ? err.message : err}`);
  }

  return { resolvedProvider, provider, providerRegistry };
}
