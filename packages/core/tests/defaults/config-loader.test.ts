import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { DefaultConfigLoader } from '../../src/defaults/config-loader.js';
import { resolveWstackPaths } from '../../src/utils/wstack-paths.js';

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

  function loader() {
    const paths = resolveWstackPaths({ projectRoot, userHome });
    return { loader: new DefaultConfigLoader({ paths }), paths };
  }

  it('returns behavior defaults with no files (no hardcoded provider/model)', async () => {
    const { loader: l } = loader();
    const cfg = await l.load();
    expect(cfg.provider).toBeUndefined();
    expect(cfg.model).toBeUndefined();
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
    await fs.writeFile(
      paths.projectLocalConfig,
      JSON.stringify({ model: 'claude-opus-4-7' }),
    );
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
    await fs.writeFile(
      paths.globalConfig,
      JSON.stringify({ provider: 'openai', model: 'gpt-4o' }),
    );
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
    await fs.writeFile(
      paths.globalConfig,
      JSON.stringify({ features: { plugins: ['a', 'b'] } }),
    );
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
});
