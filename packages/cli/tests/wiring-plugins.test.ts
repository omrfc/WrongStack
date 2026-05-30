import { describe, expect, it, vi, beforeEach } from 'vitest';
import { setupPlugins } from '../src/wiring/plugins.js';
import type { Config, Logger } from '@wrongstack/core';

// loadPlugins is the one external function we care about — capture its
// invocations to confirm setupPlugins wires options & API factory correctly.
const loadPluginsMock = vi.fn().mockResolvedValue(undefined);

vi.mock('virtual:broken-plugin', () => {
  throw new Error('boom');
}, { virtual: true } as never);

// A virtual ESM module that setupPlugins can dynamically import.
vi.mock('virtual:test-plugin', () => ({
  default: { name: 'virtual:test-plugin', register: vi.fn() },
}), { virtual: true } as never);

// Mock @wrongstack/core: replace loadPlugins so we can observe calls
vi.mock('@wrongstack/core', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, loadPlugins: (...args: unknown[]) => loadPluginsMock(...args) };
});

vi.mock('@wrongstack/mcp', () => ({ MCPRegistry: class {} }));
vi.mock('../src/plugin-api-factory.js', () => ({
  default: vi.fn(() => ({ kind: 'fake-api' })),
}));

function fakeLogger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn(), setLevel: vi.fn() } as unknown as Logger;
}

function baseDeps(overrides: Partial<Config> = {}) {
  return {
    config: {
      version: 1,
      provider: 'a',
      model: 'm',
      features: { mcp: true, plugins: true, memory: true, modelsRegistry: true, skills: true },
      ...overrides,
    } as Config,
    container: { resolve: vi.fn(), has: vi.fn() } as never,
    events: {} as never,
    pipelines: {} as never,
    toolRegistry: {} as never,
    providerRegistry: {} as never,
    slashCommandRegistry: {} as never,
    mcpRegistry: {} as never,
    log: fakeLogger(),
    agent: {},
    sessionWriter: { transcriptPath: '/tmp/x.jsonl', append: vi.fn() } as never,
    configStore: {} as never,
  };
}

beforeEach(() => {
  loadPluginsMock.mockClear();
});

describe('setupPlugins', () => {
  it('returns early when plugins feature disabled', async () => {
    const deps = baseDeps({
      features: { mcp: true, plugins: false, memory: true, modelsRegistry: true, skills: true },
      plugins: ['virtual:test-plugin'] as never,
    });
    await setupPlugins(deps);
    // plugins feature disabled → loadPlugins not called at all
    expect(loadPluginsMock).not.toHaveBeenCalled();
  });

  it('returns early when no plugins list (no paths → no built-in plugins)', async () => {
    // paths not provided → built-in plugins skipped; no user plugins → early return
    await setupPlugins(baseDeps());
    expect(loadPluginsMock).not.toHaveBeenCalled();
  });

  it('returns early when plugins list is empty (no paths → no built-in plugins)', async () => {
    await setupPlugins(baseDeps({ plugins: [] as never }));
    expect(loadPluginsMock).not.toHaveBeenCalled();
  });

  it('skips object plugins explicitly disabled (no paths → no built-in plugins)', async () => {
    const deps = baseDeps({
      plugins: [{ name: 'virtual:test-plugin', enabled: false }] as never,
    });
    await setupPlugins(deps);
    // no paths → no built-ins, no user plugins → early return
    expect(loadPluginsMock).not.toHaveBeenCalled();
  });

  it('warns and continues when a plugin import fails (no paths)', async () => {
    const deps = baseDeps({ plugins: ['virtual:broken-plugin'] as never });
    await setupPlugins(deps);
    expect(deps.log.warn).toHaveBeenCalledWith(
      expect.stringContaining('virtual:broken-plugin'),
      expect.any(Error),
    );
    expect(loadPluginsMock).not.toHaveBeenCalled();
  });

  it('loads string-form plugin (no paths → no built-in plugins)', async () => {
    const deps = baseDeps({ plugins: ['virtual:test-plugin'] as never });
    await setupPlugins(deps);
    expect(loadPluginsMock).toHaveBeenCalledTimes(1);
    const [plugins, opts] = loadPluginsMock.mock.calls[0]!;
    // only the user plugin; no built-ins since paths not provided
    expect(plugins).toHaveLength(1);
    expect(plugins[0].name).toBe('virtual:test-plugin');
    expect(opts.log).toBe(deps.log);
    expect(typeof opts.apiFactory).toBe('function');
  });

  it('loads object-form plugin and merges options from plugin + extensions', async () => {
    const deps = baseDeps({
      plugins: [
        { name: 'virtual:test-plugin', options: { foo: 1, bar: 'a' } },
      ] as never,
      extensions: { 'virtual:test-plugin': { bar: 'override', baz: true } } as never,
    });
    await setupPlugins(deps);
    const [, opts] = loadPluginsMock.mock.calls[0]!;
    // config.extensions wins on key collisions; new keys are merged in.
    expect(opts.pluginOptions['virtual:test-plugin']).toEqual({
      foo: 1,
      bar: 'override',
      baz: true,
    });
  });

  // ── built-in plugins: enabled by default, opt-out via config ──────────────

  const EXPECTED_BUILTINS = [
    'wstack-prompts',
    'wstack-sync',
    'wstack-git',
    'wstack-observability',
    'wstack-security',
    'wstack-skills',
    'wstack-plan',
  ];

  function fakePaths() {
    return {
      globalRoot: '/g',
      globalConfig: '/g/config.json',
      globalSkills: '/g/skills',
      globalPrompts: '/g/prompts',
      globalMemory: '/g/memory.md',
      historyFile: '/g/history',
      syncConfig: '/g/sync.json',
      projectPlan: '/p/plan.json',
    } as never;
  }

  it('loads all built-in plugins by default when paths are provided', async () => {
    const deps = { ...baseDeps(), paths: fakePaths() };
    await setupPlugins(deps as never);
    expect(loadPluginsMock).toHaveBeenCalledTimes(1);
    const [plugins] = loadPluginsMock.mock.calls[0]!;
    const names = (plugins as Array<{ name: string }>).map((p) => p.name);
    expect(names).toEqual(expect.arrayContaining(EXPECTED_BUILTINS));
  });

  it('opts a single built-in out via config.plugins { enabled: false }', async () => {
    const deps = {
      ...baseDeps({ plugins: [{ name: 'wstack-git', enabled: false }] as never }),
      paths: fakePaths(),
    };
    await setupPlugins(deps as never);
    const [plugins] = loadPluginsMock.mock.calls[0]!;
    const names = (plugins as Array<{ name: string }>).map((p) => p.name);
    expect(names).not.toContain('wstack-git');
    // the rest stay enabled by default
    expect(names).toContain('wstack-prompts');
    expect(names).toContain('wstack-plan');
  });

  it('features.plugins:false disables built-ins too', async () => {
    const deps = {
      ...baseDeps({
        features: { mcp: true, plugins: false, memory: true, modelsRegistry: true, skills: true },
      }),
      paths: fakePaths(),
    };
    await setupPlugins(deps as never);
    expect(loadPluginsMock).not.toHaveBeenCalled();
  });

  it('apiFactory injects sessionWriter wrapper that delegates append', async () => {
    const deps = baseDeps({ plugins: ['virtual:test-plugin'] as never });
    await setupPlugins(deps);
    const [, opts] = loadPluginsMock.mock.calls[0]!;
    const apiCfgCapture = vi.fn();
    const apiFactoryMod = (await import('../src/plugin-api-factory.js')) as unknown as {
      default: ReturnType<typeof vi.fn>;
    };
    apiFactoryMod.default.mockImplementation((_name, cfg: { sessionWriter: { append: (e: unknown) => void; transcriptPath: string } }) => {
      apiCfgCapture(cfg);
      cfg.sessionWriter.append({ type: 't', ts: 'now', data: 'x' });
      return {};
    });
    opts.apiFactory({ name: 'virtual:test-plugin' });
    expect(apiCfgCapture).toHaveBeenCalled();
    expect(deps.sessionWriter.append).toHaveBeenCalledWith({ type: 't', ts: 'now', data: 'x' });
  });
});