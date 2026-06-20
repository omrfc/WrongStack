import type { ModelsRegistry, Provider } from '@wrongstack/core';
import { describe, expect, it } from 'vitest';
import { resolveRuntimeMaxContext } from '../src/context-limit.js';

/**
 * Minimal fake catalog: the canonical `anthropic` and `openai` providers expose
 * modern models at their real windows (Opus 4.8 → 1M, gpt-5.5 → 1.05M). The
 * OAuth families (anthropic-oauth / openai-codex / github-copilot) are NOT
 * listed — resolution must fall through to these siblings.
 */
function fakeRegistry(): ModelsRegistry {
  const catalog: Record<string, Record<string, number>> = {
    anthropic: { 'claude-opus-4-8': 1_000_000, 'claude-haiku-4-5': 200_000 },
    openai: { 'gpt-5.5': 1_050_000, 'gpt-4o': 128_000 },
  };
  return {
    async getProvider(id: string) {
      const models = catalog[id];
      if (!models) return undefined;
      return {
        family: id,
        models: Object.entries(models).map(([mid, context]) => ({ id: mid, limit: { context } })),
      };
    },
    async getModel(providerId: string, modelId: string) {
      const max = catalog[providerId]?.[modelId];
      if (!max) return undefined;
      return {
        capabilities: { maxContext: max, tools: true, vision: true, reasoning: false },
      };
    },
  } as unknown as ModelsRegistry;
}

const provider = { capabilities: { maxContext: 200_000 } } as unknown as Provider;

describe('resolveRuntimeMaxContext — OAuth sibling-catalog resolution', () => {
  it('resolves Opus 4.8 via anthropic-oauth to the real 1M window (not the 200k family default)', async () => {
    const max = await resolveRuntimeMaxContext({
      modelsRegistry: fakeRegistry(),
      config: {
        provider: 'anthropic-oauth',
        model: 'claude-opus-4-8',
        providers: {
          'anthropic-oauth': {
            type: 'anthropic-oauth',
            family: 'anthropic-oauth',
            baseUrl: 'https://api.anthropic.com',
            models: ['claude-opus-4-8'],
          },
        },
      },
      provider,
      providerId: 'anthropic-oauth',
      modelId: 'claude-opus-4-8',
    });
    expect(max).toBe(1_000_000);
  });

  it('resolves gpt-5.5 via openai-codex to 1.05M from the openai catalog', async () => {
    const max = await resolveRuntimeMaxContext({
      modelsRegistry: fakeRegistry(),
      config: {
        provider: 'openai-codex',
        model: 'gpt-5.5',
        providers: {
          'openai-codex': { type: 'openai-codex', family: 'openai-codex', models: ['gpt-5.5'] },
        },
      },
      provider,
      providerId: 'openai-codex',
      modelId: 'gpt-5.5',
    });
    expect(max).toBe(1_050_000);
  });

  it('resolves github-copilot gpt-4o via the openai catalog, ignoring the proxy baseUrl', async () => {
    const max = await resolveRuntimeMaxContext({
      modelsRegistry: fakeRegistry(),
      config: {
        provider: 'github-copilot',
        model: 'gpt-4o',
        providers: {
          'github-copilot': {
            type: 'github-copilot',
            family: 'github-copilot',
            baseUrl: 'https://copilot-proxy.example.com',
            models: ['gpt-4o'],
          },
        },
      },
      provider,
      providerId: 'github-copilot',
      modelId: 'gpt-4o',
    });
    expect(max).toBe(128_000);
  });

  it('honours an explicit per-provider override above the sibling catalog', async () => {
    const max = await resolveRuntimeMaxContext({
      modelsRegistry: fakeRegistry(),
      config: {
        provider: 'anthropic-oauth',
        model: 'claude-opus-4-8',
        providers: {
          'anthropic-oauth': {
            type: 'anthropic-oauth',
            family: 'anthropic-oauth',
            capabilities: { maxContext: 400_000 },
            models: ['claude-opus-4-8'],
          },
        },
      },
      provider,
      providerId: 'anthropic-oauth',
      modelId: 'claude-opus-4-8',
    });
    expect(max).toBe(400_000);
  });

  it('falls back to the family default when the model is not in the sibling catalog', async () => {
    const max = await resolveRuntimeMaxContext({
      modelsRegistry: fakeRegistry(),
      config: {
        provider: 'anthropic-oauth',
        model: 'claude-unknown-9',
        providers: {
          'anthropic-oauth': {
            type: 'anthropic-oauth',
            family: 'anthropic-oauth',
            models: ['claude-unknown-9'],
          },
        },
      },
      provider,
      providerId: 'anthropic-oauth',
      modelId: 'claude-unknown-9',
    });
    expect(max).toBe(200_000);
  });
});
