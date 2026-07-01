import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type {
  Config,
  Logger,
  ModelsDevPayload,
  ModelsDevProvider,
  ProviderConfig,
} from '@wrongstack/core';
import { COMPATIBLE_PRESETS, discoverOpenAICompatibleModels } from '@wrongstack/providers';

interface DiscoverCacheEntry {
  fetchedAt: string;
  provider: ModelsDevProvider;
}

type DiscoverCache = Record<string, DiscoverCacheEntry>;

interface OverlayRegistry {
  mergeOverlay(payload: ModelsDevPayload): void;
}

function isOverlayRegistry(value: unknown): value is OverlayRegistry {
  return !!value && typeof value === 'object' && typeof (value as OverlayRegistry).mergeOverlay === 'function';
}

function resolveKey(cfg: ProviderConfig): string | undefined {
  if (Array.isArray(cfg.apiKeys) && cfg.apiKeys.length > 0) {
    const active = cfg.activeKey
      ? cfg.apiKeys.find((key) => key.label === cfg.activeKey)
      : undefined;
    return (active ?? cfg.apiKeys[0])?.apiKey;
  }
  return cfg.apiKey && cfg.apiKey.length > 0 ? cfg.apiKey : undefined;
}

function eligibleProviders(
  config: Config,
): Array<{ id: string; cfg: ProviderConfig; baseUrl: string; apiKey?: string | undefined }> {
  const out: Array<{ id: string; cfg: ProviderConfig; baseUrl: string; apiKey?: string | undefined }> = [];
  for (const [id, cfg] of Object.entries(config.providers ?? {})) {
    const preset = COMPATIBLE_PRESETS[id];
    const enabled = cfg.autoDiscoverModels ?? preset?.autoDiscover ?? false;
    if (!enabled) continue;
    const baseUrl = cfg.baseUrl ?? preset?.defaultBaseUrl;
    if (!baseUrl) continue;
    out.push({ id, cfg, baseUrl, apiKey: resolveKey(cfg) });
  }
  return out;
}

async function readCache(file: string): Promise<DiscoverCache> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as DiscoverCache;
  } catch {
    return {};
  }
}

export async function discoverAndMergeWebuiProviders(opts: {
  config: Config;
  registry: unknown;
  cacheDir: string;
  logger?: Pick<Logger, 'debug' | 'info' | 'warn'> | undefined;
  fetchImpl?: typeof fetch | undefined;
}): Promise<void> {
  const registry = opts.registry;
  if (!isOverlayRegistry(registry)) return;
  const targets = eligibleProviders(opts.config);
  if (targets.length === 0) return;

  const cacheFile = path.join(opts.cacheDir, 'discovered-models-cache.json');
  const cache = await readCache(cacheFile);
  let cacheDirty = false;

  await Promise.all(
    targets.map(async ({ id, cfg, baseUrl, apiKey }) => {
      const cacheKey = `${id}\u0000${baseUrl}`;
      const provider = await discoverOpenAICompatibleModels(id, {
        baseUrl,
        apiKey,
        headers: cfg.headers,
        providerName: id,
        fetchImpl: opts.fetchImpl,
      });
      if (provider) {
        cache[cacheKey] = { fetchedAt: new Date().toISOString(), provider };
        cacheDirty = true;
        registry.mergeOverlay({ [id]: provider });
        opts.logger?.info?.(
          `auto-discovered ${Object.keys(provider.models).length} models for "${id}" from ${baseUrl}`,
        );
        return;
      }

      const cached = cache[cacheKey];
      if (cached) {
        registry.mergeOverlay({ [id]: cached.provider });
        opts.logger?.warn?.(
          `auto-discovery for "${id}" failed; using ${
            Object.keys(cached.provider.models).length
          } cached models from ${cached.fetchedAt}`,
        );
      } else {
        opts.logger?.warn?.(
          `auto-discovery for "${id}" failed and no cache available (server at ${baseUrl} unreachable?)`,
        );
      }
    }),
  );

  if (cacheDirty) {
    try {
      await fs.mkdir(path.dirname(cacheFile), { recursive: true });
      await fs.writeFile(cacheFile, JSON.stringify(cache), 'utf8');
    } catch {
      opts.logger?.debug?.('provider auto-discovery cache write failed');
    }
  }
}
