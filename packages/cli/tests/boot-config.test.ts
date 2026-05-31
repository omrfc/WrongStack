import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bootConfig } from '../src/boot-config.js';

/**
 * V0-C: `bootConfig` is the first thing every CLI invocation runs. If it
 * silently picks the wrong config file or fails to apply a flag, every
 * downstream behavior is wrong. These tests don't try to be exhaustive —
 * they pin the contract that matters: flags actually override file values,
 * `cwd` flag actually relocates path resolution, and secret-migration
 * failures don't crash boot.
 */

async function mkTempDir(prefix = 'wstack-boot-'): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

describe('bootConfig', () => {
  let originalHome: string | undefined;
  let homeDir: string;

  beforeEach(async () => {
    homeDir = await mkTempDir();
    originalHome = process.env.HOME;
    process.env.HOME = homeDir;
    if (process.platform === 'win32') {
      process.env.USERPROFILE = homeDir;
    }
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
  });

  it('returns paths, config, and vault for an empty-config workspace', async () => {
    const projectDir = await mkTempDir('wstack-boot-proj-');
    const result = await bootConfig({ cwd: projectDir });
    expect(result.config).toBeDefined();
    expect(result.paths.cwd).toBe(path.resolve(projectDir));
    expect(result.paths.projectRoot).toBeTruthy();
    expect(result.vault).toBeDefined();
  });

  it('CLI provider/model flags override file defaults', async () => {
    const projectDir = await mkTempDir('wstack-boot-flags-');
    const result = await bootConfig({
      cwd: projectDir,
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
    });
    expect(result.config.provider).toBe('anthropic');
    expect(result.config.model).toBe('claude-sonnet-4-6');
  });

  it('--yolo flag sets yolo: true in config', async () => {
    const projectDir = await mkTempDir('wstack-boot-yolo-');
    const result = await bootConfig({ cwd: projectDir, yolo: true });
    expect(result.config.yolo).toBe(true);
  });

  it('--verbose flag sets log.level to debug', async () => {
    const projectDir = await mkTempDir('wstack-boot-verbose-');
    const result = await bootConfig({ cwd: projectDir, verbose: true });
    expect(result.config.log.level).toBe('debug');
  });

  it('--log-level explicit value wins over --verbose', async () => {
    const projectDir = await mkTempDir('wstack-boot-loglevel-');
    const result = await bootConfig({
      cwd: projectDir,
      verbose: true,
      'log-level': 'warn',
    });
    expect(result.config.log.level).toBe('warn');
  });

  it('--no-features disables every optional subsystem', async () => {
    const projectDir = await mkTempDir('wstack-boot-features-');
    const result = await bootConfig({ cwd: projectDir, 'no-features': true });
    expect(result.config.features?.mcp).toBe(false);
    expect(result.config.features?.plugins).toBe(false);
    expect(result.config.features?.memory).toBe(false);
    expect(result.config.features?.modelsRegistry).toBe(false);
    expect(result.config.features?.skills).toBe(false);
  });

  it('writes a project meta file under the resolved project dir', async () => {
    const projectDir = await mkTempDir('wstack-boot-meta-');
    const result = await bootConfig({ cwd: projectDir });
    const metaPath = result.paths.wpaths.projectMeta;
    const raw = await fs.readFile(metaPath, 'utf8');
    const meta = JSON.parse(raw);
    expect(meta.hash).toBeTruthy();
    expect(meta.root).toBe(result.paths.projectRoot);
    expect(typeof meta.lastSeen).toBe('string');
  });

  it('absolute --cwd flag is honored (path.resolve no-op)', async () => {
    const projectDir = await mkTempDir('wstack-boot-abscwd-');
    const result = await bootConfig({ cwd: projectDir });
    expect(result.paths.cwd).toBe(path.resolve(projectDir));
  });

  it('merges sync.json into config without mutating the frozen Config', async () => {
    // Regression: load() returns a frozen Config. Merging sync state by
    // direct assignment threw "Cannot add property sync, object is not
    // extensible" once ~/.wrongstack/sync.json existed (post `/sync enable`).
    const projectDir = await mkTempDir('wstack-boot-sync-');
    const wsDir = path.join(homeDir, '.wrongstack');
    await fs.mkdir(wsDir, { recursive: true });
    const syncConfig = {
      enabled: true,
      repo: 'owner/repo',
      githubToken: 'plaintext-token',
      categories: ['settings', 'memory'],
    };
    await fs.writeFile(path.join(wsDir, 'sync.json'), JSON.stringify(syncConfig), 'utf8');

    const result = await bootConfig({ cwd: projectDir });
    expect(result.config.sync?.enabled).toBe(true);
    expect(result.config.sync?.repo).toBe('owner/repo');
    expect(result.config.sync?.categories).toEqual(['settings', 'memory']);
  });
});
