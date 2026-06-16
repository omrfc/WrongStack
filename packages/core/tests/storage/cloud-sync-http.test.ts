import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CloudSync } from '../../src/storage/cloud-sync.js';
import type { SyncConfig } from '../../src/types/config.js';
import type { WstackPaths } from '../../src/utils/wstack-paths.js';

/**
 * Exercises the REAL `githubFetch` HTTP machinery (and every push/pull helper
 * that flows through it) by stubbing global `fetch` with a URL+method dispatcher.
 * The sibling cloud-sync.test.ts mocks githubFetch directly, which leaves the
 * HTTP layer + tree/commit/blob helpers uncovered — this file restores them.
 */
const json = (body: unknown, status = 200): Response =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });

let dir: string;
let paths: WstackPaths;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cloudsync-http-'));
  await fs.mkdir(path.join(dir, 'prompts', 'sub'), { recursive: true });
  await fs.writeFile(path.join(dir, 'prompts', 'p.json'), '{"title":"x"}');
  await fs.writeFile(path.join(dir, 'prompts', 'sub', 'nested.json'), '{"n":1}'); // → walkDir recursion
  await fs.writeFile(path.join(dir, 'config.json'), '{"setting":true}');
  paths = {
    globalRoot: dir,
    globalConfig: path.join(dir, 'config.json'),
    globalSkills: path.join(dir, 'skills'),
    globalPrompts: path.join(dir, 'prompts'),
    globalMemory: path.join(dir, 'memory'),
    historyFile: path.join(dir, 'history.jsonl'),
    sessionDir: '', logsDir: '', pluginsDir: '',
  } as WstackPaths;
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await fs.rm(dir, { recursive: true, force: true });
});

const cfg = (over: Partial<SyncConfig> = {}): SyncConfig => ({ enabled: true, repo: 'me/data', categories: ['settings', 'prompts'], ...over });
const make = (config: SyncConfig | null = cfg()) => new CloudSync(paths, () => config, async () => {});

describe('CloudSync.enable', () => {
  it('returns the slash-command hint', async () => {
    expect(await make().enable('me/data', ['prompts'])).toMatch(/Enable via/);
  });
});

describe('CloudSync.push via real githubFetch', () => {
  function stubPush(patchHandler?: (calls: number) => Response) {
    let patchCalls = 0;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url);
      const m = init?.method;
      if (u.endsWith('/git/trees') && m === 'POST') return json({ sha: 'tree-sha' });
      if (u.endsWith('/git/commits') && m === 'POST') return json({ sha: 'commit-sha' });
      if (u.includes('/git/refs/heads/main') && m === 'PATCH') {
        patchCalls++;
        return patchHandler ? patchHandler(patchCalls) : json({});
      }
      if (u.includes('/git/refs/heads/main') && m === 'GET') return json({ object: { sha: 'remote-sha' } });
      return json({}, 404);
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it('builds a tree, commits, and updates the ref', async () => {
    stubPush();
    const sync = make();
    const res = await sync.push('tok');
    expect(res.ok).toBe(true);
    expect(res.message).toContain('Pushed');
    // state file written with the commit sha
    const state = JSON.parse(await fs.readFile(path.join(dir, 'sync-state.json'), 'utf8'));
    expect(state.sha).toBe('commit-sha');
  });

  it('uses base_tree + parent on a second push (prior state present)', async () => {
    stubPush();
    const sync = make();
    await sync.push('tok'); // first push writes state
    const res = await sync.push('tok'); // second push → state.sha drives base_tree + parent
    expect(res.ok).toBe(true);
  });

  it('rebases and retries when updateRef returns 422 (not a fast-forward)', async () => {
    stubPush((n) => (n === 1 ? json('not a fast forward', 422) : json({})));
    const res = await make().push('tok');
    expect(res.ok).toBe(true); // succeeded on retry
  });

  it('rethrows a non-422 updateRef failure', async () => {
    stubPush(() => json('server error', 500));
    await expect(make().push('tok')).rejects.toThrow(/500/);
  });

  it('returns a not-enabled result when sync is disabled', async () => {
    const res = await make(cfg({ enabled: false })).push('tok');
    expect(res).toMatchObject({ ok: false, action: 'push' });
  });
});

describe('CloudSync.pull via real githubFetch', () => {
  function stubPull(treeEntries: Array<{ path: string; sha: string; type: string }>) {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url);
      const m = init?.method;
      if (u.includes('/git/refs/heads/main') && m === 'GET') return json({ object: { sha: 'head-sha' } });
      if (u.includes('/git/commits/') && m === 'GET') return json({ tree: { sha: 'tree-sha' }, message: 'm' });
      if (u.includes('/git/trees/') && m === 'GET') return json(treeEntries);
      if (u.includes('/git/blobs/') && m === 'GET') return json({ content: Buffer.from('{"pulled":true}').toString('base64') });
      return json({}, 404);
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it('downloads blobs and writes category files', async () => {
    stubPull([
      { path: 'data/prompts/p.json', sha: 'blob-1', type: 'blob' },
      { path: 'data/prompts/sub', sha: 'tree-x', type: 'tree' }, // non-blob → skipped
      { path: 'notdata/x', sha: 'b', type: 'blob' }, // wrong prefix → skipped
    ]);
    const res = await make(cfg({ categories: ['prompts'] })).pull('tok');
    expect(res.ok).toBe(true);
    expect(JSON.parse(await fs.readFile(path.join(dir, 'prompts', 'p.json'), 'utf8'))).toEqual({ pulled: true });
  });

  it('returns not-enabled when disabled', async () => {
    const res = await make(cfg({ enabled: false })).pull('tok');
    expect(res).toMatchObject({ ok: false, action: 'pull' });
  });

  it('surfaces a GitHub API error (non-ok response)', async () => {
    const fetchMock = vi.fn(async () => json('boom', 500));
    vi.stubGlobal('fetch', fetchMock);
    await expect(make().pull('tok')).rejects.toThrow(/500/);
  });

  it('skips unknown categories and empty category paths', async () => {
    stubPull([
      { path: 'data/bogus/x', sha: 'b0', type: 'blob' }, // not a known category → skip
      { path: 'data/memory/m.md', sha: 'b1', type: 'blob' }, // memory path blanked → skip
      { path: 'data/prompts/p.json', sha: 'b2', type: 'blob' }, // written
    ]);
    const blanked = { ...paths, globalMemory: '' } as WstackPaths;
    const sync = new CloudSync(blanked, () => cfg({ categories: ['prompts', 'memory'] }), async () => {});
    const res = await sync.pull('tok');
    expect(res.ok).toBe(true);
  });

  it('writes a file-backed category directly when the remote path has no subpath', async () => {
    stubPull([{ path: 'data/settings', sha: 'b1', type: 'blob' }]);
    await make(cfg({ categories: ['settings'] })).pull('tok');
    expect(JSON.parse(await fs.readFile(path.join(dir, 'config.json'), 'utf8'))).toEqual({ pulled: true });
  });

  it('rejects a nested remote path for a file-backed category', async () => {
    stubPull([{ path: 'data/settings/nested.json', sha: 'b1', type: 'blob' }]);
    await expect(make(cfg({ categories: ['settings'] })).pull('tok')).rejects.toThrow(/file category|nested/i);
  });

  it('rejects a directory-escaping remote path', async () => {
    stubPull([{ path: 'data/prompts/../../escape.txt', sha: 'b1', type: 'blob' }]);
    await expect(make(cfg({ categories: ['prompts'] })).pull('tok')).rejects.toThrow(/traversal/i);
  });

  it('resolves a dir-category blob with no subpath to the category root', async () => {
    // resolvePulledCategoryPath returns the prompts dir (empty rel); writing a
    // blob onto a directory path then fails (EISDIR), but the empty-rel branch runs.
    stubPull([{ path: 'data/prompts', sha: 'b1', type: 'blob' }]);
    await expect(make(cfg({ categories: ['prompts'] })).pull('tok')).rejects.toThrow();
  });
});

describe('CloudSync.hasLocalChanges + buildLocalTree edges', () => {
  it('hashes local categories and compares against the stored rev', async () => {
    // push first to populate the state file (with a localRev)
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url); const m = init?.method;
      if (u.endsWith('/git/trees') && m === 'POST') return json({ sha: 't' });
      if (u.endsWith('/git/commits') && m === 'POST') return json({ sha: 'c' });
      return json({});
    });
    vi.stubGlobal('fetch', fetchMock);
    const sync = make(cfg({ categories: ['prompts', 'settings'] }));
    await sync.push('tok');
    await sync.loadState();
    // hashLocalCategories runs over a dir (prompts) + a file (settings)
    expect(typeof (await sync.hasLocalChanges())).toBe('boolean');
  });

  it('skips empty and missing category paths when building the tree', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url); const m = init?.method;
      if (u.endsWith('/git/trees') && m === 'POST') return json({ sha: 't' });
      if (u.endsWith('/git/commits') && m === 'POST') return json({ sha: 'c' });
      return json({});
    });
    vi.stubGlobal('fetch', fetchMock);
    // skills path is '' (skip at 313); history file is missing (stat throws → catch at 342)
    const p = { ...paths, globalSkills: '' } as WstackPaths;
    const sync = new CloudSync(p, () => cfg({ categories: ['prompts', 'skills', 'history'] }), async () => {});
    const res = await sync.push('tok');
    expect(res.ok).toBe(true);
  });
});
