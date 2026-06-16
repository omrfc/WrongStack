import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { cloudInstance } = vi.hoisted(() => ({
  cloudInstance: {
    loadState: vi.fn(async () => {}),
    status: vi.fn(async () => 'STATUS-OUTPUT'),
    disable: vi.fn(async () => 'DISABLED-OUTPUT'),
    push: vi.fn(async () => ({ ok: true, message: 'pushed ok' })),
    pull: vi.fn(async () => ({ ok: true, message: 'pulled ok' })),
  },
}));

vi.mock('../../src/storage/cloud-sync.js', async (orig) => ({
  ...(await orig<typeof import('../../src/storage/cloud-sync.js')>()),
  CloudSync: vi.fn(function MockCloudSync() {
    return cloudInstance; // a function (not arrow) so `new CloudSync()` returns the instance
  }),
}));

import { createSyncPlugin } from '../../src/plugins/sync-plugin.js';
import { CloudSync } from '../../src/storage/cloud-sync.js';
import type { Context, SlashCommand } from '../../src/index.js';

let tmp: string;
const ctx = {} as Context;

type CfgGetter = () => Record<string, unknown>;

function build(cfgGet: CfgGetter = () => ({}), apiConfig: Record<string, unknown> = {}, withOpts = true) {
  const registered: SlashCommand[] = [];
  const warn = vi.fn();
  const configStore = { get: vi.fn(cfgGet), update: vi.fn() };
  const vault = { encrypt: vi.fn((t: string) => `enc:${t}`) };
  const api = { config: apiConfig, slashCommands: { register: (c: SlashCommand) => registered.push(c), unregister: vi.fn() }, log: { info: vi.fn(), warn } } as never;
  const opts = withOpts ? { paths: { syncConfig: path.join(tmp, 'sync.json') } as never, configStore: configStore as never, vault } : undefined;
  const plugin = createSyncPlugin(opts);
  plugin.setup!(api);
  return { cmd: registered[0], configStore, vault, warn, registered, plugin, api };
}

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'sync-plugin-'));
  for (const m of Object.values(cloudInstance)) m.mockClear();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('createSyncPlugin lifecycle', () => {
  it('registers /sync when paths + configStore are available and loads state', () => {
    const { cmd, registered, plugin, api } = build();
    expect(cmd?.name).toBe('sync');
    expect(cloudInstance.loadState).toHaveBeenCalled();
    plugin.teardown!(api);
    expect(registered).toHaveLength(1);
  });

  it('warns and skips registration when paths/configStore are missing', () => {
    const { registered, warn } = build(() => ({}), {}, false);
    expect(registered).toHaveLength(0);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('disabled'));
  });

  it('reads paths/configStore/vault from api.config as a fallback', () => {
    const configStore = { get: vi.fn(() => ({})), update: vi.fn() };
    const registered: SlashCommand[] = [];
    const api = { config: { paths: { syncConfig: path.join(tmp, 's.json') }, configStore, vault: { encrypt: (t: string) => t } }, slashCommands: { register: (c: SlashCommand) => registered.push(c), unregister: vi.fn() }, log: { info: vi.fn(), warn: vi.fn() } } as never;
    createSyncPlugin().setup!(api);
    expect(registered[0]?.name).toBe('sync');
  });

  it('health is ok', async () => {
    expect(await build().plugin.health!()).toMatchObject({ ok: true });
  });

  it('wires the config getter/setter callbacks into CloudSync', async () => {
    const sync = { enabled: true, repo: 'r', githubToken: 't', categories: [] };
    const { configStore } = build(() => ({ sync }));
    const call = (CloudSync as unknown as { mock: { calls: unknown[][] } }).mock.calls.at(-1)!;
    const getCfg = call[1] as () => unknown;
    const setCfg = call[2] as (c: unknown) => Promise<void>;
    expect(getCfg()).toBe(sync); // getter returns config.sync
    await setCfg({ enabled: false });
    expect(configStore.update).toHaveBeenCalledWith(expect.objectContaining({ sync: { enabled: false } }));
  });
});

describe('/sync verbs', () => {
  it('status (default and explicit)', async () => {
    const { cmd } = build();
    expect((await cmd!.run!('', ctx)).message).toBe('STATUS-OUTPUT');
    expect((await cmd!.run!('status', ctx)).message).toBe('STATUS-OUTPUT');
  });

  it('disable delegates to CloudSync', async () => {
    const { cmd } = build();
    expect((await cmd!.run!('disable', ctx)).message).toBe('DISABLED-OUTPUT');
  });

  it('enable: usage, invalid repo, and success (encrypts + writes + updates)', async () => {
    const { cmd, configStore, vault } = build();
    expect((await cmd!.run!('enable', ctx)).message).toContain('Usage');
    expect((await cmd!.run!('enable badrepo ghp_x', ctx)).message).toContain('Invalid repo');
    const out = await cmd!.run!('enable me/data ghp_secret memory prompts', ctx);
    expect(out.message).toContain('CloudSync enabled for me/data');
    expect(vault.encrypt).toHaveBeenCalledWith('ghp_secret');
    expect(configStore.update).toHaveBeenCalledWith(expect.objectContaining({ sync: expect.objectContaining({ enabled: true, repo: 'me/data', githubToken: 'enc:ghp_secret' }) }));
    // token file written with 0600
    const written = JSON.parse(await fs.readFile(path.join(tmp, 'sync.json'), 'utf8'));
    expect(written.categories).toEqual(['memory', 'prompts']);
    expect(cloudInstance.loadState).toHaveBeenCalled();
  });

  it('enable without a vault stores the raw token', async () => {
    const registered: SlashCommand[] = [];
    const configStore = { get: () => ({}), update: vi.fn() };
    const api = { config: {}, slashCommands: { register: (c: SlashCommand) => registered.push(c), unregister: vi.fn() }, log: { info: vi.fn(), warn: vi.fn() } } as never;
    createSyncPlugin({ paths: { syncConfig: path.join(tmp, 'sync.json') } as never, configStore: configStore as never }).setup!(api);
    await registered[0]!.run!('enable me/data ghp_raw', ctx);
    const written = JSON.parse(await fs.readFile(path.join(tmp, 'sync.json'), 'utf8'));
    expect(written.githubToken).toBe('ghp_raw'); // no vault → not encrypted
    expect(written.categories.length).toBeGreaterThan(0); // defaulted to ALL
  });

  it('push: not-enabled, no-token, success, and failure', async () => {
    expect((await build(() => ({ sync: { enabled: false } })).cmd!.run!('push', ctx)).message).toContain('not enabled');
    expect((await build(() => ({ sync: { enabled: true } })).cmd!.run!('push', ctx)).message).toContain('No GitHub token');

    const ok = build(() => ({ sync: { enabled: true, githubToken: 't', repo: 'r', categories: [] } }));
    expect((await ok.cmd!.run!('push', ctx)).message).toBe('pushed ok');
    expect(ok.configStore.update).toHaveBeenCalledWith(expect.objectContaining({ sync: expect.objectContaining({ lastSyncedAt: expect.any(String) }) }));

    cloudInstance.push.mockRejectedValueOnce(new Error('network down'));
    expect((await build(() => ({ sync: { enabled: true, githubToken: 't' } })).cmd!.run!('push', ctx)).message).toContain('Push failed: network down');
  });

  it('pull: not-enabled, no-token, success, and failure', async () => {
    expect((await build(() => ({ sync: { enabled: false } })).cmd!.run!('pull', ctx)).message).toContain('not enabled');
    expect((await build(() => ({ sync: { enabled: true } })).cmd!.run!('pull', ctx)).message).toContain('No GitHub token');

    const ok = build(() => ({ sync: { enabled: true, githubToken: 't', repo: 'r', categories: [] } }));
    expect((await ok.cmd!.run!('pull', ctx)).message).toBe('pulled ok');

    cloudInstance.pull.mockRejectedValueOnce(new Error('boom'));
    expect((await build(() => ({ sync: { enabled: true, githubToken: 't' } })).cmd!.run!('pull', ctx)).message).toContain('Pull failed: boom');
  });

  it('categories: gated, list, add (unknown/dup/success), remove (missing/success), usage', async () => {
    expect((await build(() => ({ sync: { enabled: false } })).cmd!.run!('categories', ctx)).message).toContain('not enabled');

    const enabled = (cats: string[]) => build(() => ({ sync: { enabled: true, categories: cats } }));

    expect((await enabled(['memory']).cmd!.run!('categories', ctx)).message).toContain('Synced categories: memory');
    expect((await enabled(['memory']).cmd!.run!('categories list', ctx)).message).toContain('Available:');

    expect((await enabled(['memory']).cmd!.run!('categories add bogus', ctx)).message).toContain('Unknown');
    expect((await enabled(['memory']).cmd!.run!('categories add memory', ctx)).message).toContain('already synced');
    const added = enabled(['memory']);
    expect((await added.cmd!.run!('categories add prompts', ctx)).message).toContain('Added "prompts"');
    expect(added.configStore.update).toHaveBeenCalled();

    expect((await enabled(['memory']).cmd!.run!('categories remove prompts', ctx)).message).toContain('not in sync');
    const removed = enabled(['memory', 'prompts']);
    expect((await removed.cmd!.run!('categories remove prompts', ctx)).message).toContain('Removed "prompts"');

    expect((await enabled(['memory']).cmd!.run!('categories frobnicate', ctx)).message).toContain('Usage');
  });

  it('unknown verb prints the help block', async () => {
    expect((await build().cmd!.run!('xyzzy', ctx)).message).toContain('Cloud Sync');
  });
});
