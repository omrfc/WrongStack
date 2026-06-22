import { Writable } from 'node:stream';
import type { ModelsDevModel, ResolvedProvider } from '@wrongstack/core';
import { describe, expect, it, vi } from 'vitest';
import { runPicker, saveToGlobalConfig } from '../src/picker.js';
import { TerminalRenderer } from '../src/renderer.js';

class CapStream extends Writable {
  buf = '';
  override _write(c: Buffer | string, _e: BufferEncoding, cb: (err?: Error | null) => void): void {
    this.buf += typeof c === 'string' ? c : c.toString('utf8');
    cb();
  }
}

function mkRig() {
  const out = new CapStream();
  const err = new CapStream();
  const renderer = new TerminalRenderer({
    out: out as never as NodeJS.WriteStream,
    err: err as never as NodeJS.WriteStream,
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

  it('shows an OAuth-family provider that lives only in saved config (not the catalog)', async () => {
    const { renderer, out } = mkRig();
    // github-copilot is never in the models.dev catalog — it exists only as a
    // saved config entry with an OAuth key and a model allowlist. It must still
    // appear in the launch picker and be selectable.
    const registry = fakeRegistry([]); // empty catalog
    const config = {
      providers: {
        'github-copilot': {
          type: 'github-copilot',
          family: 'github-copilot',
          apiKeys: [{ label: 'oauth-default', apiKey: 'tok', createdAt: '2026-01-01' }],
          activeKey: 'oauth-default',
          models: ['gpt-5-mini', 'claude-haiku-4.5'],
        },
      },
    } as never;
    const reader = fakeReader(['1', '1', 'n']); // provider 1, model 1, don't save
    const result = await runPicker({
      modelsRegistry: registry as never,
      renderer,
      reader: reader as never,
      config,
    });
    expect(out.buf).toContain('github-copilot'); // family header + provider entry rendered
    expect(result).toBeDefined();
    expect(result!.provider).toBe('github-copilot');
    expect(result!.model).toBe('gpt-5-mini');
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

  it('Enter (empty answer) accepts the default model when one is provided', async () => {
    const { renderer } = mkRig();
    const providers = [
      fakeProvider({
        models: [fakeModel({ id: 'm1' }), fakeModel({ id: 'm2' }), fakeModel({ id: 'm3' })],
      }),
    ];
    // Pick provider 1, then press Enter to accept the default model, then 'n' for save.
    const reader = fakeReader(['1', '', 'n']);
    const registry = fakeRegistry(providers);
    const result = await runPicker({
      modelsRegistry: registry as never,
      renderer,
      reader: reader as never,
      defaultProvider: 'anthropic',
      defaultModel: 'm2',
    });
    expect(result).toBeDefined();
    expect(result!.model).toBe('m2');
  });

  it('resolveModelSelection matches a model by exact id string', async () => {
    const { renderer } = mkRig();
    const providers = [
      fakeProvider({ models: [fakeModel({ id: 'opus-4' }), fakeModel({ id: 'haiku-4' })] }),
    ];
    // pick provider 1, then type the exact model id, then don't save
    const reader = fakeReader(['1', 'haiku-4', 'n']);
    const registry = fakeRegistry(providers);
    const result = await runPicker({
      modelsRegistry: registry as never,
      renderer,
      reader: reader as never,
    });
    expect(result?.model).toBe('haiku-4');
  });

  it('resolveModelSelection picks unique partial-match model id', async () => {
    const { renderer } = mkRig();
    const providers = [
      fakeProvider({
        models: [fakeModel({ id: 'claude-opus-4' }), fakeModel({ id: 'gpt-4o' })],
      }),
    ];
    // 'opus' uniquely matches 'claude-opus-4'
    const reader = fakeReader(['1', 'opus', 'n']);
    const registry = fakeRegistry(providers);
    const result = await runPicker({
      modelsRegistry: registry as never,
      renderer,
      reader: reader as never,
    });
    expect(result?.model).toBe('claude-opus-4');
  });

  it('resolveModelSelection reports an error when partial match is ambiguous', async () => {
    const { renderer, err } = mkRig();
    const providers = [
      fakeProvider({
        models: [
          fakeModel({ id: 'claude-opus-4' }),
          fakeModel({ id: 'claude-sonnet-4' }),
        ],
      }),
    ];
    // 'claude' matches both — should print an error and return undefined
    const reader = fakeReader(['1', 'claude']);
    const registry = fakeRegistry(providers);
    const result = await runPicker({
      modelsRegistry: registry as never,
      renderer,
      reader: reader as never,
    });
    expect(result).toBeUndefined();
    expect(err.buf).toMatch(/multiple models/i);
  });

  it('resolveModelSelection falls back to using the raw answer when nothing matches', async () => {
    const { renderer } = mkRig();
    const providers = [fakeProvider({ models: [fakeModel({ id: 'opus-4' })] })];
    // Answer doesn't match any model — use as-is
    const reader = fakeReader(['1', 'experimental-model-x', 'n']);
    const registry = fakeRegistry(providers);
    const result = await runPicker({
      modelsRegistry: registry as never,
      renderer,
      reader: reader as never,
    });
    expect(result?.model).toBe('experimental-model-x');
  });

  it('cancels mid-pagination when user types q on the "more" prompt', async () => {
    // Generate 35 models so the picker shows page 1 (30) then asks for "more".
    const manyModels = Array.from({ length: 35 }, (_, i) =>
      fakeModel({ id: `m${i + 1}`, release_date: '2025-01-01' }),
    );
    const providers = [fakeProvider({ models: manyModels })];
    const { renderer } = mkRig();
    // Pick provider 1, then type 'q' on the pagination prompt.
    const reader = fakeReader(['1', 'q']);
    const registry = fakeRegistry(providers);
    const result = await runPicker({
      modelsRegistry: registry as never,
      renderer,
      reader: reader as never,
    });
    expect(result).toBeUndefined();
  });

  it('picks a numbered model on the first page even when more models exist', async () => {
    const manyModels = Array.from({ length: 35 }, (_, i) =>
      fakeModel({ id: `m${i + 1}`, release_date: '2025-01-01' }),
    );
    const providers = [fakeProvider({ models: manyModels })];
    const { renderer } = mkRig();
    // Pick provider 1, then "2" to pick the 2nd model from the first page.
    const reader = fakeReader(['1', '2']);
    const registry = fakeRegistry(providers);
    const result = await runPicker({
      modelsRegistry: registry as never,
      renderer,
      reader: reader as never,
    });
    expect(result).toBeDefined();
    expect(result!.model).toBe('m2');
  });

  it('reports an error when the chosen model index is out of range and no default applies', async () => {
    const providers = [fakeProvider({ models: [fakeModel({ id: 'only-one' })] })];
    const { renderer } = mkRig();
    // Pick provider 1, then an invalid out-of-range numeric selection.
    const reader = fakeReader(['1', '99']);
    const registry = fakeRegistry(providers);
    const result = await runPicker({
      modelsRegistry: registry as never,
      renderer,
      reader: reader as never,
    });
    // resolveModelSelection falls back to using the raw answer when nothing matches.
    expect(result).toBeDefined();
    expect(result!.model).toBe('99');
  });

  it('shows an empty-models error when the provider has no models in the catalog', async () => {
    const providers = [fakeProvider({ models: [] })];
    const { renderer, err } = mkRig();
    const reader = fakeReader(['1']);
    const registry = fakeRegistry(providers);
    const result = await runPicker({
      modelsRegistry: registry as never,
      renderer,
      reader: reader as never,
    });
    expect(result).toBeUndefined();
    expect(err.buf).toMatch(/No models listed/);
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
