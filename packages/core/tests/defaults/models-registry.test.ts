import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  DefaultModelsRegistry,
  classifyFamily,
} from '../../src/defaults/models-registry.js';
import type { ModelsDevPayload } from '../../src/types/models-registry.js';

const SAMPLE: ModelsDevPayload = {
  anthropic: {
    id: 'anthropic',
    name: 'Anthropic',
    env: ['ANTHROPIC_API_KEY'],
    npm: '@ai-sdk/anthropic',
    doc: 'https://docs.anthropic.com',
    models: {
      'claude-sonnet-4-6': {
        id: 'claude-sonnet-4-6',
        name: 'Claude Sonnet 4.6',
        release_date: '2025-09-01',
        tool_call: true,
        modalities: { input: ['text', 'image'], output: ['text'] },
        cost: { input: 3, output: 15 },
        limit: { context: 200_000, output: 8192 },
      },
      'claude-opus-4-7': {
        id: 'claude-opus-4-7',
        name: 'Claude Opus 4.7',
        release_date: '2025-11-15',
        tool_call: true,
        modalities: { input: ['text', 'image'], output: ['text'] },
        cost: { input: 15, output: 75 },
        limit: { context: 200_000 },
      },
    },
  },
  google: {
    id: 'google',
    name: 'Google',
    env: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
    npm: '@ai-sdk/google',
    models: {
      'gemini-2.5-flash': {
        id: 'gemini-2.5-flash',
        name: 'Gemini 2.5 Flash',
        release_date: '2025-09-01',
        tool_call: true,
        limit: { context: 1_000_000 },
        cost: { input: 0.075, output: 0.3 },
        modalities: { input: ['text', 'image'], output: ['text'] },
      },
    },
  },
  mistral: {
    id: 'mistral',
    name: 'Mistral',
    npm: '@ai-sdk/mistral',
    models: {},
  },
};

describe('classifyFamily', () => {
  it('maps anthropic family', () => {
    expect(classifyFamily('@ai-sdk/anthropic')).toBe('anthropic');
  });
  it('maps openai family', () => {
    expect(classifyFamily('@ai-sdk/openai')).toBe('openai');
  });
  it('maps openai-compatible aliases', () => {
    expect(classifyFamily('@ai-sdk/groq')).toBe('openai-compatible');
    expect(classifyFamily('@ai-sdk/xai')).toBe('openai-compatible');
    expect(classifyFamily('@openrouter/ai-sdk-provider')).toBe('openai-compatible');
  });
  it('maps google', () => {
    expect(classifyFamily('@ai-sdk/google')).toBe('google');
  });
  it('marks unknown as unsupported', () => {
    expect(classifyFamily('@ai-sdk/mistral')).toBe('unsupported');
    expect(classifyFamily(undefined)).toBe('unsupported');
  });
});

describe('DefaultModelsRegistry', () => {
  let cacheDir: string;
  let cacheFile: string;

  beforeEach(async () => {
    cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-mreg-'));
    cacheFile = path.join(cacheDir, 'models.dev.json');
  });
  afterEach(async () => {
    await fs.rm(cacheDir, { recursive: true, force: true });
  });

  it('uses seed payload without network', async () => {
    const reg = new DefaultModelsRegistry({ cacheFile, seed: SAMPLE });
    const providers = await reg.listProviders();
    expect(providers.map((p) => p.id).sort()).toEqual(['anthropic', 'google', 'mistral']);
  });

  it('classifies providers into families', async () => {
    const reg = new DefaultModelsRegistry({ cacheFile, seed: SAMPLE });
    const a = await reg.getProvider('anthropic');
    expect(a?.family).toBe('anthropic');
    const g = await reg.getProvider('google');
    expect(g?.family).toBe('google');
    const m = await reg.getProvider('mistral');
    expect(m?.family).toBe('unsupported');
  });

  it('getModel returns capabilities + cost', async () => {
    const reg = new DefaultModelsRegistry({ cacheFile, seed: SAMPLE });
    const m = await reg.getModel('anthropic', 'claude-sonnet-4-6');
    expect(m?.capabilities.tools).toBe(true);
    expect(m?.capabilities.vision).toBe(true);
    expect(m?.capabilities.maxContext).toBe(200_000);
    expect(m?.cost?.input).toBe(3);
  });

  it('suggestModel returns the newest', async () => {
    const reg = new DefaultModelsRegistry({ cacheFile, seed: SAMPLE });
    expect(await reg.suggestModel('anthropic')).toBe('claude-opus-4-7');
  });

  it('refresh writes cache via fetch impl', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => SAMPLE,
    } as unknown as Response) as unknown as typeof fetch;
    const reg = new DefaultModelsRegistry({ cacheFile, fetchImpl });
    await reg.refresh();
    const cached = JSON.parse(await fs.readFile(cacheFile, 'utf8'));
    expect(cached.payload.anthropic).toBeDefined();
    expect(cached.fetchedAt).toBeTruthy();
  });

  it('load falls back to stale cache on network failure', async () => {
    // Pre-write stale cache (recent enough to pass maxStaleAgeSeconds check)
    const recentCache = {
      fetchedAt: new Date(Date.now() - 60_000).toISOString(), // 1 minute ago
      url: 'https://models.dev/api.json',
      payload: SAMPLE,
    };
    await fs.writeFile(cacheFile, JSON.stringify(recentCache));
    const fetchImpl = vi.fn().mockRejectedValue(new Error('offline')) as unknown as typeof fetch;
    const reg = new DefaultModelsRegistry({ cacheFile, fetchImpl, ttlSeconds: 0 });
    const payload = await reg.load();
    expect(Object.keys(payload).length).toBeGreaterThan(0);
  });

  it('throws when network fails and no cache exists', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('offline')) as unknown as typeof fetch;
    const reg = new DefaultModelsRegistry({ cacheFile, fetchImpl });
    await expect(reg.load()).rejects.toThrow(/offline/);
  });

  it('reports ageSeconds', async () => {
    const reg = new DefaultModelsRegistry({ cacheFile, seed: SAMPLE });
    await reg.load();
    const age = await reg.ageSeconds();
    expect(age).toBeLessThan(60);
  });
});
