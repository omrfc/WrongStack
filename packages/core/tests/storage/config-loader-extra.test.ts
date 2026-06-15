import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DefaultConfigLoader, type ConfigSource } from '../../src/storage/config-loader.js';
import type { SecretVault } from '../../src/types/secret-vault.js';
import { resolveWstackPaths } from '../../src/utils/wstack-paths.js';

let projectRoot: string;
let userHome: string;
let paths: ReturnType<typeof resolveWstackPaths>;

const fakeVault = (): SecretVault =>
  ({
    encrypt: (s: string) => (s.startsWith('enc:') ? s : `enc:${s}`),
    decrypt: (s: string) => (s.startsWith('enc:') ? s.slice(4) : s),
  }) as unknown as SecretVault;

const ENV_KEYS = [
  'WRONGSTACK_PROVIDER', 'WRONGSTACK_MODEL', 'WRONGSTACK_API_KEY', 'WRONGSTACK_BASE_URL',
  'WRONGSTACK_LOG_LEVEL', 'WRONGSTACK_INDEX_ON_START', 'WRONGSTACK_INDEX_ON_EDIT',
  'WRONGSTACK_INDEX_WATCH', 'WRONGSTACK_DEBUG_CONFIG',
];
const savedEnv: Record<string, string | undefined> = {};

beforeEach(async () => {
  projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cfg-proj-'));
  userHome = await fs.mkdtemp(path.join(os.tmpdir(), 'cfg-home-'));
  paths = resolveWstackPaths({ projectRoot, userHome });
  // Ensure parent dirs exist for the config files we write directly.
  for (const f of [paths.globalConfig, paths.projectLocalConfig, paths.inProjectConfig, paths.syncConfig]) {
    await fs.mkdir(path.dirname(f), { recursive: true });
  }
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
});
afterEach(async () => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  await fs.rm(projectRoot, { recursive: true, force: true });
  await fs.rm(userHome, { recursive: true, force: true });
});

describe('DefaultConfigLoader env-var layer', () => {
  it('applies all WRONGSTACK_* environment overrides', async () => {
    process.env.WRONGSTACK_PROVIDER = 'openai';
    process.env.WRONGSTACK_MODEL = 'gpt-5';
    process.env.WRONGSTACK_API_KEY = 'sk-env';
    process.env.WRONGSTACK_BASE_URL = 'https://example.test';
    process.env.WRONGSTACK_LOG_LEVEL = 'debug';
    process.env.WRONGSTACK_INDEX_ON_START = 'off'; // envBool → false
    process.env.WRONGSTACK_INDEX_ON_EDIT = 'true';
    process.env.WRONGSTACK_INDEX_WATCH = '0'; // envBool → false
    const cfg = await new DefaultConfigLoader({ paths }).load();
    expect(cfg.provider).toBe('openai');
    expect(cfg.model).toBe('gpt-5');
    expect((cfg as { apiKey?: string }).apiKey).toBe('sk-env');
    expect((cfg as { baseUrl?: string }).baseUrl).toBe('https://example.test');
    expect(cfg.log.level).toBe('debug');
    expect(cfg.indexing?.onSessionStart).toBe(false);
    expect(cfg.indexing?.onEdit).toBe(true);
    expect(cfg.indexing?.watchExternal).toBe(false);
  });

  it('initializes the env-source set from the apiKey handler when it runs first', async () => {
    process.env.WRONGSTACK_API_KEY = 'sk-only'; // no provider/model set
    const cfg = await new DefaultConfigLoader({ paths }).load();
    expect((cfg as { apiKey?: string }).apiKey).toBe('sk-only');
  });

  it('initializes the env-source set from the baseUrl handler when it runs first', async () => {
    process.env.WRONGSTACK_BASE_URL = 'https://only.test';
    const cfg = await new DefaultConfigLoader({ paths }).load();
    expect((cfg as { baseUrl?: string }).baseUrl).toBe('https://only.test');
  });

  it('falls back to info for an invalid log level', async () => {
    process.env.WRONGSTACK_LOG_LEVEL = 'bogus';
    const cfg = await new DefaultConfigLoader({ paths }).load();
    expect(cfg.log.level).toBe('info');
  });

  it('logs a warning for non-primitive array replacement when WRONGSTACK_DEBUG_CONFIG is set', async () => {
    process.env.WRONGSTACK_DEBUG_CONFIG = '1';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await fs.writeFile(paths.globalConfig, JSON.stringify({ version: 1, sources: [{ a: 1 }] }));
    await fs.writeFile(paths.projectLocalConfig, JSON.stringify({ version: 1, sources: [{ b: 2 }] }));
    await new DefaultConfigLoader({ paths }).load();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('DefaultConfigLoader extra sources', () => {
  it('merges sources by priority and skips a failing source', async () => {
    const order: string[] = [];
    const good: ConfigSource = {
      name: 'good',
      priority: 10,
      read: async () => { order.push('good'); return { model: 'from-source' }; },
    };
    const bad: ConfigSource = {
      name: 'bad',
      priority: 5,
      read: async () => { order.push('bad'); throw new Error('source failed'); },
    };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const cfg = await new DefaultConfigLoader({ paths, sources: [good, bad] }).load();
    expect(order).toEqual(['bad', 'good']); // priority 5 before 10
    expect(cfg.model).toBe('from-source');
    expect(warn).toHaveBeenCalled(); // bad source warned
    warn.mockRestore();
  });

  it('breaks priority ties by source name', async () => {
    const order: string[] = [];
    const mk = (name: string): ConfigSource => ({
      name,
      priority: 20, // identical priority → name tie-break
      read: async () => { order.push(name); return {}; },
    });
    await new DefaultConfigLoader({ paths, sources: [mk('zebra'), mk('alpha')] }).load();
    expect(order).toEqual(['alpha', 'zebra']); // sorted by name
  });

  it('applies CLI flags last', async () => {
    const cfg = await new DefaultConfigLoader({ paths }).load({ cliFlags: { model: 'cli-model' } });
    expect(cfg.model).toBe('cli-model');
  });
});

describe('DefaultConfigLoader apiKeys[] resolution', () => {
  it('mirrors the active key into apiKey and tolerates malformed entries', async () => {
    await fs.writeFile(paths.globalConfig, JSON.stringify({
      version: 1,
      providers: {
        good: { apiKeys: [{ label: 'a', apiKey: 'k-a' }, { label: 'b', apiKey: 'k-b' }], activeKey: 'b' },
        firstWins: { apiKeys: [{ label: 'x', apiKey: 'k-x' }] }, // no activeKey → first
        existing: { apiKey: 'explicit', apiKeys: [{ label: 'y', apiKey: 'k-y' }] }, // existing wins
        notObject: 'oops',
        emptyKeys: { apiKeys: [] },
        malformed: { apiKeys: [null, { label: 'z' }, { apiKey: 'no-label' }] }, // all filtered out
      },
    }));
    const cfg = await new DefaultConfigLoader({ paths }).load();
    const providers = (cfg as { providers: Record<string, { apiKey?: string }> }).providers;
    expect(providers.good?.apiKey).toBe('k-b');
    expect(providers.firstWins?.apiKey).toBe('k-x');
    expect(providers.existing?.apiKey).toBe('explicit');
    expect(providers.malformed?.apiKey).toBeUndefined();
  });

  it('decrypts apiKey-like fields when a vault is configured', async () => {
    await fs.writeFile(paths.globalConfig, JSON.stringify({
      version: 1,
      providers: { anthropic: { apiKey: 'enc:secret-key' } },
    }));
    const cfg = await new DefaultConfigLoader({ paths, vault: fakeVault() }).load();
    const providers = (cfg as { providers: Record<string, { apiKey?: string }> }).providers;
    expect(providers.anthropic?.apiKey).toBe('secret-key');
  });
});

describe('DefaultConfigLoader readJson error handling', () => {
  it('warns and falls back to {} on a non-ENOENT read error (path is a directory)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // Point globalConfig at a directory → readFile throws EISDIR (non-ENOENT).
    await fs.mkdir(paths.globalConfig, { recursive: true });
    const cfg = await new DefaultConfigLoader({ paths }).load();
    expect(cfg.version).toBe(1); // defaults retained
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('warns and falls back on invalid JSON', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await fs.writeFile(paths.globalConfig, 'not json {');
    const cfg = await new DefaultConfigLoader({ paths }).load();
    expect(cfg.version).toBe(1);
    warn.mockRestore();
  });
});

describe('DefaultConfigLoader sync config persistence', () => {
  it('persists and reloads a sync config, encrypting/decrypting the token', async () => {
    const loader = new DefaultConfigLoader({ paths, vault: fakeVault() });
    await loader.persistSyncConfig({ enabled: true, repo: 'o/r', categories: ['settings'], githubToken: 'plain-tok' });
    const raw = await fs.readFile(paths.syncConfig, 'utf8');
    expect(raw).toContain('enc:plain-tok'); // token encrypted on disk
    // loadSyncConfig runs the vault-decrypt branch (decryptConfigSecrets).
    const loaded = await loader.loadSyncConfig();
    expect(loaded?.repo).toBe('o/r');
  });

  it('loads a sync config without a vault verbatim', async () => {
    const loader = new DefaultConfigLoader({ paths });
    await loader.persistSyncConfig({ enabled: true, repo: 'o/r', categories: ['settings'] });
    const loaded = await loader.loadSyncConfig();
    expect(loaded?.repo).toBe('o/r');
  });

  it('returns null when the sync file is absent', async () => {
    expect(await new DefaultConfigLoader({ paths }).loadSyncConfig()).toBeNull();
  });

  it('returns null for a malformed sync file', async () => {
    await fs.writeFile(paths.syncConfig, 'not json');
    expect(await new DefaultConfigLoader({ paths }).loadSyncConfig()).toBeNull();
  });

  it('returns null and warns on a non-ENOENT sync read error (directory)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await fs.mkdir(paths.syncConfig, { recursive: true });
    expect(await new DefaultConfigLoader({ paths }).loadSyncConfig()).toBeNull();
    warn.mockRestore();
  });

  it('rethrows when persisting the sync config fails (target is a directory)', async () => {
    await fs.mkdir(paths.syncConfig, { recursive: true });
    const loader = new DefaultConfigLoader({ paths });
    await expect(
      loader.persistSyncConfig({ enabled: true, repo: 'o/r', categories: ['settings'] }),
    ).rejects.toThrow();
  });
});
