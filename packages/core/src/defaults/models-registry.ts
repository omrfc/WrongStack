import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { atomicWrite } from '../utils/atomic-write.js';
import type {
  ModelsRegistry,
  ModelsDevPayload,
  ModelsDevProvider,
  ResolvedModel,
  ResolvedProvider,
  WireFamily,
} from '../types/models-registry.js';

const DEFAULT_URL = 'https://models.dev/api.json';
const DEFAULT_TTL_SECONDS = 24 * 3600;

interface CacheEnvelope {
  fetchedAt: string;
  url: string;
  payload: ModelsDevPayload;
}

export interface DefaultModelsRegistryOptions {
  cacheFile: string;
  url?: string;
  ttlSeconds?: number;
  fetchImpl?: typeof fetch;
  /** Pre-seeded payload — useful for offline scenarios and tests. */
  seed?: ModelsDevPayload;
  /**
   * Maximum age in seconds for stale cache fallback when network fails.
   * Defaults to 7 days. Set to `Infinity` for full offline resilience
   * (risk: deprecated models, wrong pricing). Set to `0` to disable
   * stale fallback entirely.
   */
  maxStaleAgeSeconds?: number;
}

/**
 * The npm package each models.dev provider declares determines which wire
 * family WrongStack speaks. Anything not listed falls into `unsupported` and
 * can be enabled by registering a custom provider factory via a plugin.
 */
const FAMILY_BY_NPM: Record<string, WireFamily> = {
  '@ai-sdk/anthropic': 'anthropic',
  '@ai-sdk/google-vertex/anthropic': 'anthropic',
  '@ai-sdk/openai': 'openai',
  '@ai-sdk/openai-compatible': 'openai-compatible',
  '@ai-sdk/groq': 'openai-compatible',
  '@ai-sdk/xai': 'openai-compatible',
  '@ai-sdk/cerebras': 'openai-compatible',
  '@ai-sdk/togetherai': 'openai-compatible',
  '@ai-sdk/perplexity': 'openai-compatible',
  '@ai-sdk/deepinfra': 'openai-compatible',
  '@openrouter/ai-sdk-provider': 'openai-compatible',
  'ai-gateway-provider': 'openai-compatible',
  '@ai-sdk/vercel': 'openai-compatible',
  '@ai-sdk/gateway': 'openai-compatible',
  '@aihubmix/ai-sdk-provider': 'openai-compatible',
  'venice-ai-sdk-provider': 'openai-compatible',
  '@ai-sdk/google': 'google',
};

export function classifyFamily(npm: string | undefined): WireFamily {
  if (!npm) return 'unsupported';
  return FAMILY_BY_NPM[npm] ?? 'unsupported';
}

export class DefaultModelsRegistry implements ModelsRegistry {
  private payload?: ModelsDevPayload;
  private fetchedAt?: Date;
  private readonly cacheFile: string;
  private readonly url: string;
  private readonly ttlMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly seed?: ModelsDevPayload;
  private readonly maxStaleAgeMs: number;

  constructor(opts: DefaultModelsRegistryOptions) {
    this.cacheFile = opts.cacheFile;
    this.url = opts.url ?? DEFAULT_URL;
    this.ttlMs = (opts.ttlSeconds ?? DEFAULT_TTL_SECONDS) * 1000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.seed = opts.seed;
    // Default max stale age: 7 days
    const maxStaleSeconds = opts.maxStaleAgeSeconds ?? 7 * 24 * 3600;
    this.maxStaleAgeMs = maxStaleSeconds * 1000;
  }

  async load(opts: { force?: boolean } = {}): Promise<ModelsDevPayload> {
    if (this.payload && !opts.force) return this.payload;
    if (this.seed) {
      this.payload = this.seed;
      this.fetchedAt = new Date();
      return this.payload;
    }
    if (!opts.force) {
      const cached = await this.readCache();
      if (cached && this.isFresh(cached.fetchedAt)) {
        this.payload = cached.payload;
        this.fetchedAt = new Date(cached.fetchedAt);
        return cached.payload;
      }
    }
    try {
      return await this.refresh();
    } catch (err) {
      // Network failed — fall back to stale cache if within maxStaleAgeMs.
      const cached = await this.readCache();
      if (cached && this.isWithinMaxStaleAge(cached.fetchedAt)) {
        this.payload = cached.payload;
        this.fetchedAt = new Date(cached.fetchedAt);
        return cached.payload;
      }
      throw err;
    }
  }

  async refresh(): Promise<ModelsDevPayload> {
    const res = await this.fetchImpl(this.url, {
      method: 'GET',
      headers: { accept: 'application/json' },
    });
    if (!res.ok) {
      throw new Error(`ModelsRegistry: HTTP ${res.status} fetching ${this.url}`);
    }
    const json = (await res.json()) as ModelsDevPayload;
    this.payload = json;
    this.fetchedAt = new Date();
    const envelope: CacheEnvelope = {
      fetchedAt: this.fetchedAt.toISOString(),
      url: this.url,
      payload: json,
    };
    await atomicWrite(this.cacheFile, JSON.stringify(envelope));
    return json;
  }

  async listProviders(): Promise<ResolvedProvider[]> {
    const payload = await this.load();
    return Object.values(payload).map((p) => this.resolveProvider(p));
  }

  async getProvider(id: string): Promise<ResolvedProvider | undefined> {
    const payload = await this.load();
    const p = payload[id];
    return p ? this.resolveProvider(p) : undefined;
  }

  async getModel(providerId: string, modelId: string): Promise<ResolvedModel | undefined> {
    const provider = await this.getProvider(providerId);
    if (!provider) return undefined;
    const model = provider.models.find((m) => m.id === modelId);
    if (!model) return undefined;
    return {
      providerId,
      modelId,
      capabilities: {
        tools: model.tool_call ?? false,
        vision: Boolean(model.modalities?.input?.includes('image')),
        reasoning: model.reasoning ?? false,
        maxContext: model.limit?.context ?? 0,
        maxOutput: model.limit?.output,
        knowledge: model.knowledge,
      },
      cost: model.cost,
    };
  }

  async suggestModel(providerId: string): Promise<string | undefined> {
    const provider = await this.getProvider(providerId);
    if (!provider || provider.models.length === 0) return undefined;
    const ranked = [...provider.models].sort((a, b) => {
      const at = a.release_date ?? a.last_updated ?? '';
      const bt = b.release_date ?? b.last_updated ?? '';
      return bt.localeCompare(at);
    });
    return ranked[0]?.id;
  }

  async ageSeconds(): Promise<number> {
    if (!this.fetchedAt) {
      const cached = await this.readCache();
      if (!cached) return Number.POSITIVE_INFINITY;
      return (Date.now() - new Date(cached.fetchedAt).getTime()) / 1000;
    }
    return (Date.now() - this.fetchedAt.getTime()) / 1000;
  }

  private resolveProvider(p: ModelsDevProvider): ResolvedProvider {
    return {
      id: p.id,
      name: p.name,
      family: classifyFamily(p.npm),
      apiBase: p.api,
      envVars: p.env ?? [],
      doc: p.doc,
      models: Object.values(p.models ?? {}),
      npm: p.npm,
    };
  }

  private isFresh(fetchedAtIso: string): boolean {
    return Date.now() - new Date(fetchedAtIso).getTime() < this.ttlMs;
  }

  private isWithinMaxStaleAge(fetchedAtIso: string): boolean {
    return Date.now() - new Date(fetchedAtIso).getTime() < this.maxStaleAgeMs;
  }

  private async readCache(): Promise<CacheEnvelope | undefined> {
    try {
      const raw = await fs.readFile(this.cacheFile, 'utf8');
      return JSON.parse(raw) as CacheEnvelope;
    } catch {
      return undefined;
    }
  }

  /** Used by `wstack models refresh` to expose where the cache lives. */
  cacheLocation(): string {
    return path.resolve(this.cacheFile);
  }
}
