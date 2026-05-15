import { describe, expect, it } from 'vitest';
import { AnthropicProvider } from '../src/anthropic.js';
import { makeProviderFromConfig } from '../src/index.js';
import { OpenAICompatibleProvider } from '../src/openai-compatible.js';

describe('makeProviderFromConfig (no models.dev dependency)', () => {
  it('constructs an Anthropic provider from explicit family', () => {
    const p = makeProviderFromConfig('custom-claude', {
      type: 'custom-claude',
      family: 'anthropic',
      apiKey: 'sk-fake',
    });
    expect(p).toBeInstanceOf(AnthropicProvider);
    expect(p.id).toBe('anthropic');
    expect(p.capabilities.tools).toBe(true);
  });

  it('constructs an OpenAI-compatible provider with baseUrl override', () => {
    const p = makeProviderFromConfig('my-proxy', {
      type: 'my-proxy',
      family: 'openai-compatible',
      apiKey: 'sk-fake',
      baseUrl: 'https://my-llm-proxy.internal/v1',
    });
    expect(p).toBeInstanceOf(OpenAICompatibleProvider);
    expect(p.id).toBe('my-proxy');
  });

  it('rejects missing family with a helpful error', () => {
    expect(() => makeProviderFromConfig('mystery', { type: 'mystery', apiKey: 'sk-fake' })).toThrow(
      /explicit family/,
    );
  });

  it('uses envVars from config when apiKey is absent', () => {
    process.env['MY_CUSTOM_KEY'] = 'sk-from-env';
    try {
      const p = makeProviderFromConfig('custom', {
        type: 'custom',
        family: 'anthropic',
        envVars: ['MY_CUSTOM_KEY'],
      });
      expect(p).toBeInstanceOf(AnthropicProvider);
    } finally {
      delete process.env['MY_CUSTOM_KEY'];
    }
  });

  it('throws if neither apiKey nor envVars match', () => {
    expect(() =>
      makeProviderFromConfig('nokey', {
        type: 'nokey',
        family: 'anthropic',
        envVars: ['UNSET_TEST_VAR_X'],
      }),
    ).toThrow(/requires an API key/);
  });
});
