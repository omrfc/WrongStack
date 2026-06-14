import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DefaultConfigLoader } from '../../src/storage/config-loader.js';
import { resolveWstackPaths } from '../../src/utils/wstack-paths.js';
import { EventBus } from '../../src/kernel/events.js';

describe('DefaultConfigLoader', () => {
  let projectRoot: string;
  let userHome: string;

  beforeEach(async () => {
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-cfg-proj-'));
    userHome = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-cfg-home-'));
  });
  afterEach(async () => {
    await fs.rm(projectRoot, { recursive: true, force: true });
    await fs.rm(userHome, { recursive: true, force: true });
    delete process.env['WRONGSTACK_PROVIDER'];
    delete process.env['WRONGSTACK_MODEL'];
  });

  function loader(opts?: { events?: EventBus; traceId?: string }) {
    const paths = resolveWstackPaths({ projectRoot, userHome });
    return { loader: new DefaultConfigLoader({ paths, ...opts }), paths };
  }

  it('returns behavior defaults with no files (no hardcoded provider/model)', async () => {
    const { loader: l } = loader();
    const cfg = await l.load();
    expect(cfg.provider).toBeUndefined();
    expect(cfg.model).toBeUndefined();
    expect(cfg.context.mode).toBe('balanced');
    expect(cfg.context.softThreshold).toBe(0.75);
    expect(cfg.tools.maxIterations).toBe(100);
  });

  it('user-global config sets provider/model', async () => {
    const { loader: l, paths } = loader();
    await fs.mkdir(path.dirname(paths.globalConfig), { recursive: true });
    await fs.writeFile(
      paths.globalConfig,
      JSON.stringify({ provider: 'anthropic', model: 'claude-sonnet-4-6' }),
    );
    const cfg = await l.load();
    expect(cfg.provider).toBe('anthropic');
    expect(cfg.model).toBe('claude-sonnet-4-6');
  });

  it('project-local config overrides user-global', async () => {
    const { loader: l, paths } = loader();
    await fs.mkdir(path.dirname(paths.globalConfig), { recursive: true });
    await fs.writeFile(
      paths.globalConfig,
      JSON.stringify({ provider: 'anthropic', model: 'claude-haiku-4-5' }),
    );
    await fs.mkdir(path.dirname(paths.projectLocalConfig), { recursive: true });
    await fs.writeFile(paths.projectLocalConfig, JSON.stringify({ model: 'claude-opus-4-7' }));
    const cfg = await l.load();
    expect(cfg.provider).toBe('anthropic');
    expect(cfg.model).toBe('claude-opus-4-7');
  });

  it('env overrides files', async () => {
    process.env['WRONGSTACK_PROVIDER'] = 'openai';
    const { loader: l } = loader();
    const cfg = await l.load();
    expect(cfg.provider).toBe('openai');
  });

  it('cli flags override env', async () => {
    process.env['WRONGSTACK_PROVIDER'] = 'openai';
    const { loader: l } = loader();
    const cfg = await l.load({ cliFlags: { provider: 'groq' } });
    expect(cfg.provider).toBe('groq');
  });

  it('invalid version throws', async () => {
    const { loader: l, paths } = loader();
    await fs.mkdir(path.dirname(paths.globalConfig), { recursive: true });
    await fs.writeFile(paths.globalConfig, JSON.stringify({ version: 99 }));
    await expect(l.load()).rejects.toThrow(/version/);
  });

  it('strict mode requires provider+model', async () => {
    const paths = resolveWstackPaths({ projectRoot, userHome });
    const l = new DefaultConfigLoader({ paths, strict: true });
    await expect(l.load()).rejects.toThrow(/provider/);
  });

  it('strict mode passes when provider+model both present', async () => {
    const paths = resolveWstackPaths({ projectRoot, userHome });
    await fs.mkdir(path.dirname(paths.globalConfig), { recursive: true });
    await fs.writeFile(paths.globalConfig, JSON.stringify({ provider: 'openai', model: 'gpt-4o' }));
    const l = new DefaultConfigLoader({ paths, strict: true });
    const cfg = await l.load();
    expect(cfg.provider).toBe('openai');
    expect(cfg.model).toBe('gpt-4o');
  });

  it('strict mode demands model when provider alone is set', async () => {
    const paths = resolveWstackPaths({ projectRoot, userHome });
    await fs.mkdir(path.dirname(paths.globalConfig), { recursive: true });
    await fs.writeFile(paths.globalConfig, JSON.stringify({ provider: 'openai' }));
    const l = new DefaultConfigLoader({ paths, strict: true });
    await expect(l.load()).rejects.toThrow(/model/);
  });

  it('reads WRONGSTACK_MODEL / API_KEY / BASE_URL / LOG_LEVEL env vars', async () => {
    process.env['WRONGSTACK_MODEL'] = 'gpt-4o';
    process.env['WRONGSTACK_API_KEY'] = 'sk-x';
    process.env['WRONGSTACK_BASE_URL'] = 'https://x';
    process.env['WRONGSTACK_LOG_LEVEL'] = 'debug';
    try {
      const { loader: l } = loader();
      const cfg = await l.load();
      expect(cfg.model).toBe('gpt-4o');
      expect(cfg.apiKey).toBe('sk-x');
      expect(cfg.baseUrl).toBe('https://x');
      expect(cfg.log.level).toBe('debug');
    } finally {
      delete process.env['WRONGSTACK_MODEL'];
      delete process.env['WRONGSTACK_API_KEY'];
      delete process.env['WRONGSTACK_BASE_URL'];
      delete process.env['WRONGSTACK_LOG_LEVEL'];
    }
  });

  it('rejects invalid context thresholds', async () => {
    const { loader: l, paths } = loader();
    await fs.mkdir(path.dirname(paths.globalConfig), { recursive: true });
    await fs.writeFile(
      paths.globalConfig,
      JSON.stringify({
        context: { warnThreshold: 0.9, softThreshold: 0.5, hardThreshold: 0.95 },
      }),
    );
    await expect(l.load()).rejects.toThrow(/thresholds/);
  });

  it('ignores unknown context-window modes and uses the default', async () => {
    const { loader: l, paths } = loader();
    await fs.mkdir(path.dirname(paths.globalConfig), { recursive: true });
    await fs.writeFile(paths.globalConfig, JSON.stringify({ context: { mode: 'tiny' } }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const cfg = await l.load();
      expect(cfg.context.mode).toBe('balanced');
    } finally {
      warn.mockRestore();
    }
  });

  it('ignores malformed JSON gracefully', async () => {
    const { loader: l, paths } = loader();
    await fs.mkdir(path.dirname(paths.globalConfig), { recursive: true });
    await fs.writeFile(paths.globalConfig, '{not json');
    // should not throw — just use defaults
    const cfg = await l.load();
    expect(cfg.context.softThreshold).toBe(0.75);
  });

  it('merges primitive arrays by concatenation with deduplication', async () => {
    const { loader: l, paths } = loader();
    await fs.mkdir(path.dirname(paths.globalConfig), { recursive: true });
    await fs.writeFile(paths.globalConfig, JSON.stringify({ features: { plugins: ['a', 'b'] } }));
    await fs.mkdir(path.dirname(paths.projectLocalConfig), { recursive: true });
    await fs.writeFile(
      paths.projectLocalConfig,
      JSON.stringify({ features: { plugins: ['b', 'c'] } }),
    );
    const cfg = await l.load();
    expect(cfg.features.plugins).toEqual(['a', 'b', 'c']);
  });

  it('replaces object arrays wholesale', async () => {
    const { loader: l, paths } = loader();
    await fs.mkdir(path.dirname(paths.globalConfig), { recursive: true });
    await fs.writeFile(
      paths.globalConfig,
      JSON.stringify({ mcpServers: [{ name: 'a', url: 'http://a' }] }),
    );
    await fs.mkdir(path.dirname(paths.projectLocalConfig), { recursive: true });
    await fs.writeFile(
      paths.projectLocalConfig,
      JSON.stringify({ mcpServers: [{ name: 'b', url: 'http://b' }] }),
    );
    const cfg = await l.load();
    expect(cfg.mcpServers).toEqual([{ name: 'b', url: 'http://b' }]);
  });

  it('returned config is frozen', async () => {
    const { loader: l } = loader();
    const cfg = await l.load();
    expect(Object.isFrozen(cfg)).toBe(true);
  });

  // ── multi-key apiKeys[] resolution ─────────────────────────────────────────

  it('mirrors the first apiKeys[] entry into apiKey when none is set', async () => {
    const { loader: l, paths } = loader();
    await fs.mkdir(path.dirname(paths.globalConfig), { recursive: true });
    await fs.writeFile(
      paths.globalConfig,
      JSON.stringify({
        providers: {
          openai: {
            type: 'openai',
            apiKeys: [
              { label: 'prod', apiKey: 'sk-prod' },
              { label: 'dev', apiKey: 'sk-dev' },
            ],
          },
        },
      }),
    );
    const cfg = await l.load();
    const provCfg = (cfg.providers as Record<string, { apiKey?: string }>).openai;
    expect(provCfg.apiKey).toBe('sk-prod');
  });

  it('honors activeKey label when resolving apiKeys[]', async () => {
    const { loader: l, paths } = loader();
    await fs.mkdir(path.dirname(paths.globalConfig), { recursive: true });
    await fs.writeFile(
      paths.globalConfig,
      JSON.stringify({
        providers: {
          openai: {
            type: 'openai',
            activeKey: 'dev',
            apiKeys: [
              { label: 'prod', apiKey: 'sk-prod' },
              { label: 'dev', apiKey: 'sk-dev' },
            ],
          },
        },
      }),
    );
    const cfg = await l.load();
    const provCfg = (cfg.providers as Record<string, { apiKey?: string }>).openai;
    expect(provCfg.apiKey).toBe('sk-dev');
  });

  it('falls back to first entry when activeKey label does not match', async () => {
    const { loader: l, paths } = loader();
    await fs.mkdir(path.dirname(paths.globalConfig), { recursive: true });
    await fs.writeFile(
      paths.globalConfig,
      JSON.stringify({
        providers: {
          openai: {
            type: 'openai',
            activeKey: 'missing',
            apiKeys: [
              { label: 'prod', apiKey: 'sk-prod' },
              { label: 'dev', apiKey: 'sk-dev' },
            ],
          },
        },
      }),
    );
    const cfg = await l.load();
    const provCfg = (cfg.providers as Record<string, { apiKey?: string }>).openai;
    expect(provCfg.apiKey).toBe('sk-prod');
  });

  it('preserves an explicit apiKey instead of mirroring from apiKeys[]', async () => {
    const { loader: l, paths } = loader();
    await fs.mkdir(path.dirname(paths.globalConfig), { recursive: true });
    await fs.writeFile(
      paths.globalConfig,
      JSON.stringify({
        providers: {
          openai: {
            type: 'openai',
            apiKey: 'sk-explicit',
            apiKeys: [{ label: 'prod', apiKey: 'sk-prod' }],
          },
        },
      }),
    );
    const cfg = await l.load();
    const provCfg = (cfg.providers as Record<string, { apiKey?: string }>).openai;
    expect(provCfg.apiKey).toBe('sk-explicit');
  });

  it('ignores malformed apiKeys[] entries (missing label or apiKey)', async () => {
    const { loader: l, paths } = loader();
    await fs.mkdir(path.dirname(paths.globalConfig), { recursive: true });
    await fs.writeFile(
      paths.globalConfig,
      JSON.stringify({
        providers: {
          openai: {
            type: 'openai',
            apiKeys: [
              null,
              { label: 'no-key' },
              { apiKey: 'no-label' },
              { label: 'good', apiKey: 'sk-good' },
            ],
          },
        },
      }),
    );
    const cfg = await l.load();
    const provCfg = (cfg.providers as Record<string, { apiKey?: string }>).openai;
    expect(provCfg.apiKey).toBe('sk-good');
  });

  it('leaves apiKey undefined when apiKeys[] is empty or all malformed', async () => {
    const { loader: l, paths } = loader();
    await fs.mkdir(path.dirname(paths.globalConfig), { recursive: true });
    await fs.writeFile(
      paths.globalConfig,
      JSON.stringify({
        providers: {
          openai: { type: 'openai', apiKeys: [null, { label: 1 }] },
        },
      }),
    );
    const cfg = await l.load();
    const provCfg = (cfg.providers as Record<string, { apiKey?: string }>).openai;
    expect(provCfg.apiKey).toBeUndefined();
  });

  // ── validation errors ────────────────────────────────────────────────────

  it('throws when context thresholds are non-numeric', async () => {
    const { loader: l, paths } = loader();
    await fs.mkdir(path.dirname(paths.globalConfig), { recursive: true });
    await fs.writeFile(
      paths.globalConfig,
      JSON.stringify({ context: { warnThreshold: 'oops', softThreshold: 0.7, hardThreshold: 0.9 } }),
    );
    await expect(l.load()).rejects.toThrow(/context\.warnThreshold/);
  });

  it('throws when context thresholds are out of order', async () => {
    const { loader: l, paths } = loader();
    await fs.mkdir(path.dirname(paths.globalConfig), { recursive: true });
    await fs.writeFile(
      paths.globalConfig,
      JSON.stringify({ context: { warnThreshold: 0.9, softThreshold: 0.7, hardThreshold: 0.8 } }),
    );
    await expect(l.load()).rejects.toThrow(/warn < soft < hard/);
  });

  it('falls back to the default when context.mode is an unknown id', async () => {
    const { loader: l, paths } = loader();
    await fs.mkdir(path.dirname(paths.globalConfig), { recursive: true });
    await fs.writeFile(
      paths.globalConfig,
      JSON.stringify({ context: { mode: 'lightning-fast' } }),
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const cfg = await l.load();
      // Unknown mode must not brick the CLI — it is replaced by the default.
      expect(cfg.context.mode).toBe('balanced');
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('lightning-fast'));
    } finally {
      warn.mockRestore();
    }
  });

  // ── storage.* event emissions ─────────────────────────────────────────────

  it('emits storage.write with outcome success on persistSyncConfig()', async () => {
    const events = new EventBus();
    const emitSpy = vi.spyOn(events, 'emit');
    const { loader: l } = loader({ events });
    await l.persistSyncConfig({});
    expect(emitSpy).toHaveBeenCalledWith('storage.write', expect.objectContaining({
      store: 'config',
      operation: 'persist_sync',
      outcome: 'success',
    }));
  });

  it('emits storage.error when persistSyncConfig() encounters a write failure', async () => {
    const events = new EventBus();
    const emitSpy = vi.spyOn(events, 'emit');
    const { loader: l, paths } = loader({ events });
    await fs.mkdir(path.dirname(paths.syncConfig), { recursive: true });
    // Make the directory read-only so atomicWrite fails with EACCES
    vi.spyOn(fs, 'writeFile').mockRejectedValueOnce(
      Object.assign(new Error('Permission denied'), { code: 'EACCES' }),
    );
    try {
      await expect(l.persistSyncConfig({})).rejects.toThrow('Permission denied');
      expect(emitSpy).toHaveBeenCalledWith('storage.error', expect.objectContaining({
        store: 'config',
        operation: 'persist_sync',
        outcome: 'failure',
        error: expect.stringContaining('EACCES'),
      }));
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('emits storage.read with outcome success when loadSyncConfig() finds sync.json', async () => {
    const events = new EventBus();
    const emitSpy = vi.spyOn(events, 'emit');
    const { loader: l, paths } = loader({ events });
    await fs.mkdir(path.dirname(paths.syncConfig), { recursive: true });
    await fs.writeFile(paths.syncConfig, JSON.stringify({ githubToken: 'ghp_abc123' }));
    const result = await l.loadSyncConfig();
    expect(result).not.toBeNull();
    expect(result!.githubToken).toBe('ghp_abc123');
    expect(emitSpy).toHaveBeenCalledWith('storage.read', expect.objectContaining({
      store: 'config',
      operation: 'load_sync',
      outcome: 'success',
    }));
  });

  it('emits storage.read with outcome failure when loadSyncConfig() encounters EACCES', async () => {
    const events = new EventBus();
    const emitSpy = vi.spyOn(events, 'emit');
    const { loader: l, paths } = loader({ events });
    await fs.mkdir(path.dirname(paths.syncConfig), { recursive: true });
    // Write a valid file so the path resolves, then make it unreadable
    await fs.writeFile(paths.syncConfig, JSON.stringify({ githubToken: 'ghp_abc' }));
    vi.spyOn(fs, 'readFile').mockRejectedValueOnce(
      Object.assign(new Error('Permission denied'), { code: 'EACCES' }),
    );
    try {
      const result = await l.loadSyncConfig();
      // EACCES → returns null, not a thrown error
      expect(result).toBeNull();
      expect(emitSpy).toHaveBeenCalledWith('storage.read', expect.objectContaining({
        store: 'config',
        operation: 'load_sync',
        outcome: 'failure',
        error: expect.stringContaining('EACCES'),
      }));
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('emits storage.read with outcome failure when loadSyncConfig() finds corrupt JSON', async () => {
    const events = new EventBus();
    const emitSpy = vi.spyOn(events, 'emit');
    const { loader: l, paths } = loader({ events });
    await fs.mkdir(path.dirname(paths.syncConfig), { recursive: true });
    await fs.writeFile(paths.syncConfig, 'not-json{');
    const result = await l.loadSyncConfig();
    expect(result).toBeNull();
    expect(emitSpy).toHaveBeenCalledWith('storage.read', expect.objectContaining({
      store: 'config',
      operation: 'load_sync',
      outcome: 'failure',
      error: 'parse error or empty file',
    }));
  });
});
