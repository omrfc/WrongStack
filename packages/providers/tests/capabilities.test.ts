import * as os from 'node:os';
import * as path from 'node:path';
import { DefaultModelsRegistry, type ModelsDevPayload } from '@wrongstack/core';
import { describe, expect, it } from 'vitest';
import { capabilitiesFor } from '../src/capabilities.js';

const SAMPLE: ModelsDevPayload = {
  anthropic: {
    id: 'anthropic',
    name: 'Anthropic',
    env: ['ANTHROPIC_API_KEY'],
    npm: '@ai-sdk/anthropic',
    models: {
      'claude-sonnet-4-6': {
        id: 'claude-sonnet-4-6',
        name: 'Claude Sonnet',
        tool_call: true,
        modalities: { input: ['text', 'image'], output: ['text'] },
        limit: { context: 200_000 },
      },
      'claude-text-only': {
        id: 'claude-text-only',
        name: 'Claude Text Only',
        tool_call: false,
        modalities: { input: ['text'], output: ['text'] },
        limit: { context: 100_000 },
      },
    },
  },
  google: {
    id: 'google',
    name: 'Google',
    env: ['GEMINI_API_KEY'],
    npm: '@ai-sdk/google',
    models: {
      'gemini-2.5-flash': {
        id: 'gemini-2.5-flash',
        name: 'Gemini',
        tool_call: true,
        modalities: { input: ['text', 'image'], output: ['text'] },
        limit: { context: 1_000_000 },
      },
    },
  },
};

function reg() {
  return new DefaultModelsRegistry({
    cacheFile: path.join(os.tmpdir(), `wstack-cap-${Date.now()}.json`),
    seed: SAMPLE,
  });
}

describe('capabilitiesFor', () => {
  it('anthropic + claude has native cache control', async () => {
    const c = await capabilitiesFor(reg(), 'anthropic', 'claude-sonnet-4-6');
    expect(c.cacheControl).toBe('native');
    expect(c.tools).toBe(true);
    expect(c.vision).toBe(true);
    expect(c.maxContext).toBe(200_000);
  });

  it('google has 1M context default', async () => {
    const c = await capabilitiesFor(reg(), 'google', 'gemini-2.5-flash');
    expect(c.maxContext).toBe(1_000_000);
  });

  it('unknown model still returns family baseline', async () => {
    const c = await capabilitiesFor(reg(), 'anthropic', 'mystery-model');
    expect(c.cacheControl).toBe('native');
  });

  it('unknown provider falls back to unsupported', async () => {
    const c = await capabilitiesFor(reg(), 'nonexistent', 'foo');
    expect(c.tools).toBe(false);
  });

  it('model without explicit capabilities still returns family baseline', async () => {
    const c = await capabilitiesFor(reg(), 'anthropic', 'claude-sonnet-4-6');
    expect(c.tools).toBe(true);
    expect(c.vision).toBe(true);
    expect(c.maxContext).toBe(200_000);
  });

  it('model-level tool and vision limits narrow the family baseline', async () => {
    const c = await capabilitiesFor(reg(), 'anthropic', 'claude-text-only');
    expect(c.tools).toBe(false);
    expect(c.parallelTools).toBe(false);
    expect(c.vision).toBe(false);
    expect(c.cacheControl).toBe('native');
    expect(c.maxContext).toBe(100_000);
  });
});
