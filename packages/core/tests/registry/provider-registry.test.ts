import { describe, expect, it } from 'vitest';
import { ProviderRegistry } from '../../src/registry/provider-registry.js';
import type { Provider } from '../../src/types/provider.js';

const fakeProvider: Provider = {
  id: 'fake',
  capabilities: {
    tools: true,
    parallelTools: true,
    vision: false,
    streaming: false,
    promptCache: false,
    systemPrompt: true,
    jsonMode: false,
    maxContext: 1000,
    cacheControl: 'none',
  },
  async complete() {
    return {
      content: [],
      stopReason: 'end_turn',
      usage: { input: 0, output: 0 },
      model: 'fake',
    };
  },
};

describe('ProviderRegistry', () => {
  it('register / has / create / list', () => {
    const r = new ProviderRegistry();
    r.register({ type: 'fake', create: () => fakeProvider });
    expect(r.has('fake')).toBe(true);
    expect(r.list()).toEqual(['fake']);
    expect(r.create({ type: 'fake' })).toBe(fakeProvider);
  });
  it('unknown type throws', () => {
    const r = new ProviderRegistry();
    expect(() => r.create({ type: 'missing' })).toThrow(/not registered/);
  });
});
