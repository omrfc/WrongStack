import { describe, expect, it } from 'vitest';
import {
  describeCatalogModel,
  resolveProviderModelList,
} from '../../src/models/provider-model-resolve.js';
import type { ModelsDevModel, ResolvedProvider } from '../../src/types/models-registry.js';

function catalogModel(over: Partial<ModelsDevModel> = {}): ModelsDevModel {
  return { id: 'm', name: 'M', ...over };
}

function catalog(models: ModelsDevModel[]): ResolvedProvider {
  return { id: 'p', name: 'P', family: 'openai', envVars: [], models };
}

describe('describeCatalogModel', () => {
  it('maps metadata and capability flags', () => {
    const d = describeCatalogModel(
      catalogModel({
        id: 'gpt-x',
        name: 'GPT X',
        release_date: '2026-01-01',
        limit: { context: 200000 },
        cost: { input: 1, output: 2 },
        tool_call: true,
        reasoning: true,
        modalities: { input: ['text', 'image'] },
        open_weights: true,
      }),
    );
    expect(d).toEqual({
      id: 'gpt-x',
      name: 'GPT X',
      releaseDate: '2026-01-01',
      contextWindow: 200000,
      inputCost: 1,
      outputCost: 2,
      capabilities: ['tools', 'reasoning', 'vision', 'open_weights'],
    });
  });

  it('emits no capabilities for a bare model', () => {
    expect(describeCatalogModel(catalogModel()).capabilities).toEqual([]);
  });
});

describe('resolveProviderModelList', () => {
  it('returns the full catalog list when there is no saved allowlist', () => {
    const list = resolveProviderModelList(
      undefined,
      catalog([catalogModel({ id: 'a' }), catalogModel({ id: 'b' })]),
    );
    expect(list.map((m) => m.id)).toEqual(['a', 'b']);
  });

  it('uses the saved allowlist as authoritative (OAuth / subscription providers)', () => {
    // github-copilot shape: no catalog entry, models come only from config.
    const list = resolveProviderModelList(['gpt-5-mini', 'claude-haiku-4.5'], undefined);
    expect(list).toEqual([
      { id: 'gpt-5-mini', name: 'gpt-5-mini', capabilities: [] },
      { id: 'claude-haiku-4.5', name: 'claude-haiku-4.5', capabilities: [] },
    ]);
  });

  it('enriches saved allowlist ids with catalog metadata when ids match', () => {
    const list = resolveProviderModelList(
      ['known', 'unknown'],
      catalog([
        catalogModel({ id: 'known', name: 'Known', limit: { context: 128000 }, tool_call: true }),
      ]),
    );
    expect(list[0]).toMatchObject({
      id: 'known',
      name: 'Known',
      contextWindow: 128000,
      capabilities: ['tools'],
    });
    expect(list[1]).toEqual({ id: 'unknown', name: 'unknown', capabilities: [] });
  });

  it('returns an empty list (never an error) for an unknown provider with no allowlist', () => {
    expect(resolveProviderModelList(undefined, undefined)).toEqual([]);
    expect(resolveProviderModelList([], undefined)).toEqual([]);
  });
});
