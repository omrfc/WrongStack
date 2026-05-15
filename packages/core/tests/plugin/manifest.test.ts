import { describe, expect, it } from 'vitest';
import { DefaultLogger } from '../../src/infrastructure/logger.js';
import { loadPlugins } from '../../src/plugin/loader.js';
import type { Plugin, PluginAPI } from '../../src/types/plugin.js';
import { validateAgainstSchema } from '../../src/utils/json-schema-validate.js';

const fakeApi = {} as PluginAPI;
const log = new DefaultLogger({ level: 'error' });

function p(overrides: Partial<Plugin> & { name: string }): Plugin {
  return {
    apiVersion: '^0.1',
    setup: () => undefined,
    ...overrides,
  };
}

describe('Plugin manifest — structured dependencies', () => {
  it('accepts the legacy string-array dependsOn form (backward compat)', async () => {
    const { loaded } = await loadPlugins(
      [p({ name: 'core' }), p({ name: 'ext', dependsOn: ['core'] })],
      { apiFactory: () => fakeApi, log },
    );
    expect(loaded.map((x) => x.name)).toEqual(['core', 'ext']);
  });

  it('accepts structured dependsOn with version constraint and resolves a compatible version', async () => {
    const { loaded } = await loadPlugins(
      [
        p({ name: 'auth', version: '1.5.0' }),
        p({ name: 'ext', dependsOn: [{ name: 'auth', version: '^1.2.0' }] }),
      ],
      { apiFactory: () => fakeApi, log },
    );
    expect(loaded.map((x) => x.name)).toEqual(['auth', 'ext']);
  });

  it('rejects when a dependency version constraint is unsatisfied', async () => {
    await expect(
      loadPlugins(
        [
          p({ name: 'auth', version: '0.9.0' }),
          p({ name: 'ext', dependsOn: [{ name: 'auth', version: '^1.0.0' }] }),
        ],
        { apiFactory: () => fakeApi, log },
      ),
    ).rejects.toThrow(/auth@\^1\.0\.0/);
  });

  it('tolerates missing version on dependency (treats as wildcard)', async () => {
    const { loaded } = await loadPlugins(
      [
        p({ name: 'auth' }), // no version
        p({ name: 'ext', dependsOn: [{ name: 'auth', version: '^1.0.0' }] }),
      ],
      { apiFactory: () => fakeApi, log },
    );
    expect(loaded.map((x) => x.name)).toEqual(['auth', 'ext']);
  });

  it('mixes string and structured forms in the same dependsOn list', async () => {
    const { loaded } = await loadPlugins(
      [
        p({ name: 'a' }),
        p({ name: 'b', version: '2.1.0' }),
        p({ name: 'ext', dependsOn: ['a', { name: 'b', version: '~2.1.0' }] }),
      ],
      { apiFactory: () => fakeApi, log },
    );
    expect(loaded.map((x) => x.name).sort()).toEqual(['a', 'b', 'ext']);
  });

  it('optionalDeps version mismatch fails loudly (caller asked for this version)', async () => {
    await expect(
      loadPlugins(
        [
          p({ name: 'opt', version: '0.5.0' }),
          p({ name: 'ext', optionalDeps: [{ name: 'opt', version: '^1.0.0' }] }),
        ],
        { apiFactory: () => fakeApi, log },
      ),
    ).rejects.toThrow();
  });
});

describe('Plugin manifest — configSchema validation', () => {
  it('validates plugin options before calling setup', async () => {
    let setupCalled = false;
    const { failed, loaded } = await loadPlugins(
      [
        p({
          name: 'strict',
          configSchema: {
            type: 'object',
            properties: { port: { type: 'integer' } },
            required: ['port'],
          },
          setup: () => {
            setupCalled = true;
          },
        }),
      ],
      {
        apiFactory: () => fakeApi,
        log,
        pluginOptions: { strict: { port: 'not-a-number' } },
      },
    );
    expect(setupCalled).toBe(false);
    expect(loaded).toEqual([]);
    expect(failed).toHaveLength(1);
    expect((failed[0]!.err as Error).message).toMatch(/config invalid/);
  });

  it('accepts valid plugin options and proceeds to setup', async () => {
    let receivedOpts: unknown = null;
    const { loaded } = await loadPlugins(
      [
        p({
          name: 'strict',
          configSchema: {
            type: 'object',
            properties: { port: { type: 'integer' }, host: { type: 'string' } },
            required: ['port'],
          },
          setup: () => {
            receivedOpts = 'ok';
          },
        }),
      ],
      {
        apiFactory: () => fakeApi,
        log,
        pluginOptions: { strict: { port: 8080, host: 'localhost' } },
      },
    );
    expect(loaded).toHaveLength(1);
    expect(receivedOpts).toBe('ok');
  });

  it('skips validation when no options are provided for that plugin', async () => {
    const { loaded } = await loadPlugins(
      [
        p({
          name: 'strict',
          configSchema: { type: 'object', required: ['port'] },
        }),
      ],
      { apiFactory: () => fakeApi, log }, // no pluginOptions
    );
    expect(loaded).toHaveLength(1);
  });

  it('reports a precise error path for nested validation failures', async () => {
    const { failed } = await loadPlugins(
      [
        p({
          name: 'nested',
          configSchema: {
            type: 'object',
            properties: {
              db: {
                type: 'object',
                properties: { port: { type: 'integer' } },
                required: ['port'],
              },
            },
            required: ['db'],
          },
        }),
      ],
      {
        apiFactory: () => fakeApi,
        log,
        pluginOptions: { nested: { db: { port: 'wrong' } } },
      },
    );
    expect(failed).toHaveLength(1);
    expect((failed[0]!.err as Error).message).toMatch(/db\.port/);
  });
});

describe('Plugin manifest — capabilities metadata', () => {
  it('preserves capabilities on the plugin object after loading', async () => {
    const { loaded } = await loadPlugins(
      [
        p({
          name: 'gated',
          capabilities: { tools: true, slashCommands: true, pipelines: ['request'] },
        }),
      ],
      { apiFactory: () => fakeApi, log },
    );
    expect(loaded[0]!.capabilities).toEqual({
      tools: true,
      slashCommands: true,
      pipelines: ['request'],
    });
  });
});

describe('validateAgainstSchema', () => {
  it('passes on null when type allows it via enum', () => {
    const r = validateAgainstSchema(null, { enum: [null, 'allowed'] });
    expect(r.ok).toBe(true);
  });

  it('rejects non-string for type:string', () => {
    const r = validateAgainstSchema(42, { type: 'string' });
    expect(r.ok).toBe(false);
    expect(r.errors[0]!.message).toMatch(/expected string/);
  });

  it('rejects when required property is missing', () => {
    const r = validateAgainstSchema({}, { type: 'object', required: ['x'] });
    expect(r.ok).toBe(false);
    expect(r.errors[0]!.path).toBe('x');
  });

  it('validates array items recursively', () => {
    const r = validateAgainstSchema([1, 2, 'three'], {
      type: 'array',
      items: { type: 'integer' },
    });
    expect(r.ok).toBe(false);
    expect(r.errors[0]!.path).toBe('[2]');
  });

  it('rejects values outside enum', () => {
    const r = validateAgainstSchema('purple', { enum: ['red', 'blue'] });
    expect(r.ok).toBe(false);
  });

  it('accepts integer for type:integer and rejects float', () => {
    expect(validateAgainstSchema(5, { type: 'integer' }).ok).toBe(true);
    expect(validateAgainstSchema(5.5, { type: 'integer' }).ok).toBe(false);
  });

  it('treats unknown keywords as no-ops', () => {
    const r = validateAgainstSchema(
      { x: 1 },
      {
        type: 'object',
        properties: { x: { type: 'integer' } },
        futureKeyword: { totally: 'unknown' } as never,
      },
    );
    expect(r.ok).toBe(true);
  });
});
