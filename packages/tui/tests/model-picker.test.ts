import { describe, expect, it } from 'vitest';
import type { ProviderOption } from '../src/components/model-picker.js';

describe('ModelPicker types and data', () => {
  it('ProviderOption shape is valid with models', () => {
    const opt: ProviderOption = {
      id: 'openai',
      family: 'openai',
      models: ['gpt-4', 'gpt-3.5-turbo'],
      modelsLabel: 'from catalog',
    };
    expect(opt.id).toBe('openai');
    expect(opt.models).toHaveLength(2);
    expect(opt.modelsLabel).toBe('from catalog');
  });

  it('ProviderOption works without optional fields', () => {
    const opt: ProviderOption = {
      id: 'anthropic',
      family: 'anthropic',
      models: ['claude-3-opus'],
    };
    expect(opt.modelsLabel).toBeUndefined();
  });

  it('handles empty models array', () => {
    const opt: ProviderOption = {
      id: 'custom',
      family: 'openai-compatible',
      models: [],
    };
    expect(opt.models).toHaveLength(0);
  });

  it('model count pluralization logic', () => {
    const single: ProviderOption = { id: 'a', family: 'a', models: ['x'] };
    const plural: ProviderOption = { id: 'a', family: 'a', models: ['x', 'y'] };
    expect(single.models.length === 1 ? '' : 's').toBe('');
    expect(plural.models.length === 1 ? '' : 's').toBe('s');
  });
});
