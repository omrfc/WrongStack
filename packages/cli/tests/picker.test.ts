import { Writable } from 'node:stream';
import type { ModelsDevModel, ResolvedProvider } from '@wrongstack/core';
import { describe, expect, it, vi } from 'vitest';
import { runPicker, saveToGlobalConfig } from '../src/picker.js';
import { TerminalRenderer } from '../src/renderer.js';

class CapStream extends Writable {
  buf = '';
  _write(c: Buffer | string, _e: BufferEncoding, cb: (err?: Error | null) => void): void {
    this.buf += typeof c === 'string' ? c : c.toString('utf8');
    cb();
  }
}

function mkRig() {
  const out = new CapStream();
  const err = new CapStream();
  const renderer = new TerminalRenderer({
    out: out as unknown as NodeJS.WriteStream,
    err: err as unknown as NodeJS.WriteStream,
  });
  return { out, err, renderer };
}

function fakeModel(over: Partial<ModelsDevModel> = {}): ModelsDevModel {
  return {
    id: 'claude-sonnet-4-20250514',
    name: 'Claude Sonnet 4',
    release_date: '2025-05-14',
    tool_call: true,
    limit: { context: 200000, output: 8192 },
    cost: { input: 3, output: 15 },
    modalities: { input: ['text', 'image'], output: ['text'] },
    ...over,
  };
}

function fakeProvider(over: Partial<ResolvedProvider> = {}): ResolvedProvider {
  return {
    id: 'anthropic',
    name: 'Anthropic',
    family: 'anthropic',
    envVars: ['ANTHROPIC_API_KEY'],
    models: [fakeModel()],
    ...over,
  };
}

function fakeReader(responses: string[]) {
  let i = 0;
  return {
    readLine: vi.fn(async (_prompt?: string) => responses[i++] ?? ''),
    readKey: vi.fn(),
    readSecret: vi.fn(),
    close: vi.fn(),
  };
}

function fakeRegistry(providers: ResolvedProvider[]) {
  return {
    listProviders: vi.fn(async () => providers),
    getProvider: vi.fn(async (id: string) => providers.find((p) => p.id === id)),
    getModel: vi.fn(),
    suggestModel: vi.fn(),
    load: vi.fn(),
    refresh: vi.fn(),
    ageSeconds: vi.fn(async () => 60),
  };
}

describe('runPicker', () => {
  it('returns provider+model when user picks by number', async () => {
    const { renderer } = mkRig();
    const providers = [
      fakeProvider(),
      fakeProvider({
        id: 'openai',
        name: 'OpenAI',
        family: 'openai',
        envVars: ['OPENAI_API_KEY'],
        models: [fakeModel({ id: 'gpt-4o' })],
      }),
    ];
    const reader = fakeReader(['1', '1', 'y']); // provider 1, model 1, save yes
    const registry = fakeRegistry(providers);

    const result = await runPicker({
      modelsRegistry: registry as never,
      renderer,
      reader: reader as never,
    });

    expect(result).toBeDefined();
    expect(result!.provider).toBe('anthropic');
    expect(result!.model).toBe('claude-sonnet-4-20250514');
  });

  it('returns undefined when user cancels provider selection', async () => {
    const { renderer } = mkRig();
    const providers = [fakeProvider()];
    const reader = fakeReader(['']); // empty = cancel
    const registry = fakeRegistry(providers);

    const result = await runPicker({
      modelsRegistry: registry as never,
      renderer,
      reader: reader as never,
    });

    expect(result).toBeUndefined();
  });

  it('returns undefined when user cancels model selection', async () => {
    const { renderer } = mkRig();
    const providers = [fakeProvider()];
    const reader = fakeReader(['1', '']); // pick provider, cancel model
    const registry = fakeRegistry(providers);

    const result = await runPicker({
      modelsRegistry: registry as never,
      renderer,
      reader: reader as never,
    });

    expect(result).toBeUndefined();
  });

  it('returns undefined when registry fails', async () => {
    const { renderer } = mkRig();
    const reader = fakeReader([]);
    const registry = {
      ...fakeRegistry([]),
      listProviders: vi.fn(async () => {
        throw new Error('network');
      }),
    };

    const result = await runPicker({
      modelsRegistry: registry as never,
      renderer,
      reader: reader as never,
    });

    expect(result).toBeUndefined();
  });

  it('matches provider by id string', async () => {
    const { renderer } = mkRig();
    const providers = [
      fakeProvider({ id: 'anthropic', family: 'anthropic' }),
      fakeProvider({
        id: 'openai',
        family: 'openai',
        envVars: ['OPENAI_API_KEY'],
        models: [fakeModel({ id: 'gpt-4o' })],
      }),
    ];
    const reader = fakeReader(['openai', '1', 'n']); // type id, pick model, don't save
    const registry = fakeRegistry(providers);

    const result = await runPicker({
      modelsRegistry: registry as never,
      renderer,
      reader: reader as never,
    });

    expect(result).toBeDefined();
    expect(result!.provider).toBe('openai');
    expect(result!.model).toBe('gpt-4o');
  });
});

describe('saveToGlobalConfig', () => {
  it('returns true when write succeeds', async () => {
    const fs = await import('node:fs/promises');
    const os = await import('node:os');
    const path = await import('node:path');
    const tmpDir = path.join(os.tmpdir(), `wstack-picker-test-${Date.now()}`);
    await fs.mkdir(tmpDir, { recursive: true });
    const cfgPath = path.join(tmpDir, 'config.json');
    try {
      const result = await saveToGlobalConfig(cfgPath, 'test-provider', 'test-model');
      expect(result).toBe(true);
      const content = JSON.parse(await fs.readFile(cfgPath, 'utf8')) as Record<string, unknown>;
      expect(content.provider).toBe('test-provider');
      expect(content.model).toBe('test-model');
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
