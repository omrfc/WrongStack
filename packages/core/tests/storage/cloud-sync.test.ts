import { describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import type { WstackPaths } from '../../src/utils/wstack-paths.js';
import type { SyncConfig } from '../../src/types/config.js';
import { CloudSync } from '../../src/storage/cloud-sync.js';

const mockSyncConfig: SyncConfig = {
  enabled: true,
  repo: 'testuser/testrepo',
  categories: ['settings', 'prompts'],
};

const mockPaths: WstackPaths = {
  globalRoot: '',
  globalConfig: '',
  globalSkills: '',
  globalPrompts: '',
  globalMemory: '',
  historyFile: '',
  sessionDir: '',
  logsDir: '',
  pluginsDir: '',
};

async function withTempDir(fn: (dir: string) => Promise<void>) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cloudsync-test-'));
  try {
    await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

describe('CloudSync', () => {
  describe('constructor', () => {
    it('stores paths and config callbacks without calling them', async () => {
      await withTempDir(async (dir) => {
        const paths: WstackPaths = { ...mockPaths, globalRoot: dir };
        const getConfig = vi.fn<() => SyncConfig | null>(() => mockSyncConfig);
        const setConfig = vi.fn<(_: SyncConfig) => Promise<void>>();

        const sync = new CloudSync(paths, getConfig, setConfig);

        expect(getConfig).not.toHaveBeenCalled();
        expect(setConfig).not.toHaveBeenCalled();

        await sync.status();
        expect(getConfig).toHaveBeenCalledTimes(1);
      });
    });
  });

  describe('status()', () => {
    it('returns disabled message when config is null', async () => {
      await withTempDir(async (dir) => {
        const sync = new CloudSync({ ...mockPaths, globalRoot: dir }, () => null, vi.fn());
        const result = await sync.status();
        expect(result).toContain('disabled');
      });
    });

    it('returns disabled message when enabled is false', async () => {
      await withTempDir(async (dir) => {
        const sync = new CloudSync(
          { ...mockPaths, globalRoot: dir },
          () => ({ ...mockSyncConfig, enabled: false }),
          vi.fn(),
        );
        const result = await sync.status();
        expect(result).toContain('disabled');
      });
    });

    it('includes repo and categories when enabled', async () => {
      await withTempDir(async (dir) => {
        const sync = new CloudSync({ ...mockPaths, globalRoot: dir }, () => mockSyncConfig, vi.fn());
        const result = await sync.status();
        expect(result).toContain('enabled');
        expect(result).toContain('testuser/testrepo');
        expect(result).toContain('settings');
        expect(result).toContain('prompts');
      });
    });

    it('shows "never" when no state file exists', async () => {
      await withTempDir(async (dir) => {
        const sync = new CloudSync({ ...mockPaths, globalRoot: dir }, () => mockSyncConfig, vi.fn());
        await sync.loadState();
        const result = await sync.status();
        expect(result).toContain('never');
      });
    });

    it('shows time-ago string when state file exists', async () => {
      await withTempDir(async (dir) => {
        const twoMinsAgo = new Date(Date.now() - 2 * 60_000).toISOString();
        await fs.writeFile(
          path.join(dir, 'sync-state.json'),
          JSON.stringify({ version: 1, sha: 'abc123', lastSyncedAt: twoMinsAgo, localRev: 'rev1' }),
        );
        const sync = new CloudSync({ ...mockPaths, globalRoot: dir }, () => mockSyncConfig, vi.fn());
        await sync.loadState();
        const result = await sync.status();
        expect(result).toContain('2m ago');
      });
    });
  });

  describe('loadState()', () => {
    it('loads and parses a valid state file', async () => {
      await withTempDir(async (dir) => {
        await fs.writeFile(
          path.join(dir, 'sync-state.json'),
          JSON.stringify({ version: 1, sha: 'abc', lastSyncedAt: '2024-01-01T00:00:00Z', localRev: 'r1' }),
        );
        const sync = new CloudSync({ ...mockPaths, globalRoot: dir }, () => mockSyncConfig, vi.fn());
        await sync.loadState();
        const result = await sync.status();
        expect(result).toContain('880d ago');
      });
    });

    it('sets state to null when file does not exist', async () => {
      await withTempDir(async (dir) => {
        const sync = new CloudSync({ ...mockPaths, globalRoot: dir }, () => mockSyncConfig, vi.fn());
        await sync.loadState();
        const result = await sync.status();
        expect(result).toContain('never');
      });
    });

    it('sets state to null when file is malformed JSON', async () => {
      await withTempDir(async (dir) => {
        await fs.writeFile(path.join(dir, 'sync-state.json'), 'not valid json');
        const sync = new CloudSync({ ...mockPaths, globalRoot: dir }, () => mockSyncConfig, vi.fn());
        await sync.loadState();
        const result = await sync.status();
        expect(result).toContain('never');
      });
    });
  });

  describe('disable()', () => {
    it('calls setConfig with enabled: false', async () => {
      await withTempDir(async (dir) => {
        const setConfig = vi.fn<(_: SyncConfig) => Promise<void>>();
        const sync = new CloudSync(
          { ...mockPaths, globalRoot: dir },
          () => mockSyncConfig,
          setConfig,
        );

        await sync.disable();

        expect(setConfig).toHaveBeenCalledTimes(1);
        const [cfg] = setConfig.mock.calls[0]!;
        expect(cfg.enabled).toBe(false);
        expect(cfg.repo).toBe('testuser/testrepo');
      });
    });

    it('returns error message when config is null', async () => {
      await withTempDir(async (dir) => {
        const sync = new CloudSync({ ...mockPaths, globalRoot: dir }, () => null, vi.fn());
        const result = await sync.disable();
        expect(result).toContain('not configured');
      });
    });
  });

  describe('hasLocalChanges()', () => {
    it('returns true when state is null', async () => {
      await withTempDir(async (dir) => {
        const sync = new CloudSync({ ...mockPaths, globalRoot: dir }, () => null, vi.fn());
        await sync.loadState();
        expect(await sync.hasLocalChanges()).toBe(true);
      });
    });

    it('returns true when getConfig returns null even with existing state', async () => {
      await withTempDir(async (dir) => {
        await fs.writeFile(
          path.join(dir, 'sync-state.json'),
          JSON.stringify({ version: 1, sha: 'abc', lastSyncedAt: '2024-01-01T00:00:00Z', localRev: 'rev1' }),
        );
        const sync = new CloudSync({ ...mockPaths, globalRoot: dir }, () => null, vi.fn());
        await sync.loadState();
        expect(await sync.hasLocalChanges()).toBe(true);
      });
    });
  });

  describe('push() — state file writing', () => {
    it('writes sync-state.json after a successful push', async () => {
      await withTempDir(async (dir) => {
        const promptsPath = path.join(dir, 'prompts');
        await fs.mkdir(promptsPath, { recursive: true });
        await fs.writeFile(path.join(promptsPath, 'note.txt'), 'hello');

        const paths: WstackPaths = {
          ...mockPaths,
          globalRoot: dir,
          globalConfig: path.join(dir, 'config.json'),
          globalSkills: path.join(dir, 'skills'),
          globalPrompts: promptsPath,
          globalMemory: path.join(dir, 'memory'),
          historyFile: path.join(dir, 'history.json'),
        };
        await fs.writeFile(paths.globalConfig, '{}');
        await fs.writeFile(paths.historyFile, '[]');

        const sync = new CloudSync(paths, () => ({
          enabled: true,
          repo: 'testuser/testrepo',
          categories: ['prompts'],
        }), vi.fn());

        // Mock GitHub API calls via spy on private githubFetch
        vi.spyOn(sync, 'githubFetch' as keyof CloudSync).mockImplementation(
          async (_t, _o, _r, method, seg) => {
            if (method === 'POST' && seg === '/git/trees') return { sha: 'tree-sha-abc' };
            if (method === 'POST' && seg === '/git/commits') return { sha: 'commit-sha-abc' };
            if (method === 'PATCH' && seg === '/git/refs/heads/main') return {};
            return {};
          },
        );

        const result = await sync.push('fake-token');

        expect(result.ok).toBe(true);
        expect(result.action).toBe('push');
        expect(result.message).toMatch(/commit/i);

        const stateRaw = await fs.readFile(path.join(dir, 'sync-state.json'), 'utf8');
        const state = JSON.parse(stateRaw);
        expect(state.version).toBe(1);
        expect(state.sha).toBe('commit-sha-abc');
        expect(state.lastSyncedAt).toBeTruthy();
        expect(state.localRev).toBeTruthy();
      });
    });
  });

  describe('pull() — state file writing', () => {
    it('writes sync-state.json after a successful pull', async () => {
      await withTempDir(async (dir) => {
        const promptsPath = path.join(dir, 'prompts');
        await fs.mkdir(promptsPath, { recursive: true });
        const paths: WstackPaths = {
          ...mockPaths,
          globalRoot: dir,
          globalConfig: path.join(dir, 'config.json'),
          globalSkills: path.join(dir, 'skills'),
          globalPrompts: promptsPath,
          globalMemory: path.join(dir, 'memory'),
          historyFile: path.join(dir, 'history.json'),
        };
        await fs.writeFile(paths.globalConfig, '{}');
        await fs.writeFile(paths.historyFile, '[]');

        const sync = new CloudSync(paths, () => ({
          enabled: true,
          repo: 'testuser/testrepo',
          categories: ['prompts'],
        }), vi.fn());

        vi.spyOn(sync, 'githubFetch' as keyof CloudSync).mockImplementation(
          async (_t, _o, _r, method, seg) => {
            if (method === 'GET' && seg.startsWith('/git/refs/heads/')) {
              return { object: { sha: 'remote-commit-sha' } };
            }
            if (method === 'GET' && seg.startsWith('/git/commits/')) {
              return { tree: { sha: 'tree-sha-xyz' } };
            }
            if (method === 'GET' && seg.startsWith('/git/trees/')) return [];
            return {};
          },
        );

        const result = await sync.pull('fake-token');

        expect(result.ok).toBe(true);
        expect(result.action).toBe('pull');

        const stateRaw = await fs.readFile(path.join(dir, 'sync-state.json'), 'utf8');
        const state = JSON.parse(stateRaw);
        expect(state.sha).toBe('remote-commit-sha');
        expect(state.lastSyncedAt).toBeTruthy();
      });
    });
  });

  describe('getConfig callback — called on every relevant operation', () => {
    it('is called by status()', async () => {
      await withTempDir(async (dir) => {
        const getConfig = vi.fn<() => SyncConfig | null>(() => mockSyncConfig);
        const sync = new CloudSync({ ...mockPaths, globalRoot: dir }, getConfig, vi.fn());
        await sync.status();
        expect(getConfig).toHaveBeenCalledTimes(1);
      });
    });

    it('is called by disable()', async () => {
      await withTempDir(async (dir) => {
        const getConfig = vi.fn<() => SyncConfig | null>(() => mockSyncConfig);
        const sync = new CloudSync({ ...mockPaths, globalRoot: dir }, getConfig, vi.fn());
        await sync.disable();
        expect(getConfig).toHaveBeenCalledTimes(1);
      });
    });

    it('is called by push()', async () => {
      await withTempDir(async (dir) => {
        const promptsPath = path.join(dir, 'prompts');
        await fs.mkdir(promptsPath, { recursive: true });
        await fs.writeFile(path.join(promptsPath, 'note.txt'), 'hello');

        const paths: WstackPaths = {
          ...mockPaths,
          globalRoot: dir,
          globalConfig: path.join(dir, 'config.json'),
          globalSkills: path.join(dir, 'skills'),
          globalPrompts: promptsPath,
          globalMemory: path.join(dir, 'memory'),
          historyFile: path.join(dir, 'history.json'),
        };
        await fs.writeFile(paths.globalConfig, '{}');
        await fs.writeFile(paths.historyFile, '[]');

        const getConfig = vi.fn<() => SyncConfig | null>(() => ({
          enabled: true,
          repo: 'u/r',
          categories: ['prompts'],
        }));
        const sync = new CloudSync(paths, getConfig, vi.fn());

        vi.spyOn(sync, 'githubFetch' as keyof CloudSync).mockResolvedValue({ sha: 'c' });

        await sync.push('tok');
        expect(getConfig).toHaveBeenCalledTimes(1);
      });
    });
  });

  describe('setConfig callback — called when config changes', () => {
    it('is called by disable() with enabled: false and preserved fields', async () => {
      await withTempDir(async (dir) => {
        const setConfig = vi.fn<(_: SyncConfig) => Promise<void>>();
        const getConfig = vi.fn<() => SyncConfig | null>(() => ({
          enabled: true,
          repo: 'my/repo',
          categories: ['memory'],
        }));
        const sync = new CloudSync({ ...mockPaths, globalRoot: dir }, getConfig, setConfig);

        await sync.disable();

        expect(setConfig).toHaveBeenCalledTimes(1);
        const [sent] = setConfig.mock.calls[0]!;
        expect(sent.enabled).toBe(false);
        expect(sent.repo).toBe('my/repo');
        expect(sent.categories).toEqual(['memory']);
      });
    });

    it('preserves categories when disabling', async () => {
      await withTempDir(async (dir) => {
        const setConfig = vi.fn<(_: SyncConfig) => Promise<void>>();
        const sync = new CloudSync(
          { ...mockPaths, globalRoot: dir },
          () => ({ enabled: true, repo: 'a/b', categories: ['skills', 'history'] }),
          setConfig,
        );

        await sync.disable();

        const [sent] = setConfig.mock.calls[0]!;
        expect(sent.categories).toEqual(['skills', 'history']);
      });
    });
  });

  describe('timeAgo() formatting in status()', () => {
    it('returns "just now" for recent timestamps', async () => {
      await withTempDir(async (dir) => {
        const justNow = new Date(Date.now() - 30_000).toISOString();
        await fs.writeFile(
          path.join(dir, 'sync-state.json'),
          JSON.stringify({ version: 1, sha: 'x', lastSyncedAt: justNow, localRev: 'r' }),
        );
        const sync = new CloudSync({ ...mockPaths, globalRoot: dir }, () => mockSyncConfig, vi.fn());
        await sync.loadState();
        const result = await sync.status();
        expect(result).toContain('just now');
      });
    });

    it('returns Xh ago for hours-old timestamps', async () => {
      await withTempDir(async (dir) => {
        const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60_000).toISOString();
        await fs.writeFile(
          path.join(dir, 'sync-state.json'),
          JSON.stringify({ version: 1, sha: 'x', lastSyncedAt: threeHoursAgo, localRev: 'r' }),
        );
        const sync = new CloudSync({ ...mockPaths, globalRoot: dir }, () => mockSyncConfig, vi.fn());
        await sync.loadState();
        const result = await sync.status();
        expect(result).toMatch(/\d+h ago/);
      });
    });

    it('returns Xd ago for day-old timestamps', async () => {
      await withTempDir(async (dir) => {
        const fiveDaysAgo = new Date(Date.now() - 5 * 24 * 60 * 60_000).toISOString();
        await fs.writeFile(
          path.join(dir, 'sync-state.json'),
          JSON.stringify({ version: 1, sha: 'x', lastSyncedAt: fiveDaysAgo, localRev: 'r' }),
        );
        const sync = new CloudSync({ ...mockPaths, globalRoot: dir }, () => mockSyncConfig, vi.fn());
        await sync.loadState();
        const result = await sync.status();
        expect(result).toContain('5d ago');
      });
    });
  });
});