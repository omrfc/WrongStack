import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { MCPServerConfig } from '@wrongstack/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  addMcp,
  disableMcp,
  discoverMcp,
  enableMcp,
  listMcp,
  type McpManageDeps,
  removeMcp,
  restartMcp,
  updateMcp,
} from '../src/manage.js';

let tmp: string;
let configPath: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-manage-'));
  configPath = path.join(tmp, 'config.json');
  await fs.writeFile(configPath, JSON.stringify({ version: 1 }));
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

/** Minimal MCPRegistry stub — records calls, lets tests drive list() state. */
function makeRegistry(overrides: Record<string, unknown> = {}) {
  return {
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    restart: vi.fn().mockResolvedValue(undefined),
    list: vi.fn().mockReturnValue([]),
    ...overrides,
  } as never;
}

function deps(registry: unknown, presets: Record<string, MCPServerConfig> = {}): McpManageDeps {
  return { configPath, registry: registry as never, presets } as McpManageDeps;
}

const githubPreset: MCPServerConfig = {
  name: 'github',
  transport: 'stdio',
  command: 'npx',
  args: ['-y', '@modelcontextprotocol/server-github'],
  description: 'GitHub MCP',
};

async function readServers(): Promise<Record<string, MCPServerConfig>> {
  const raw = JSON.parse(await fs.readFile(configPath, 'utf8'));
  return raw.mcpServers ?? {};
}

describe('addMcp', () => {
  it('adds a preset by name (disabled) without starting it', async () => {
    const registry = makeRegistry();
    const r = await addMcp({ name: 'github' }, deps(registry, { github: githubPreset }));
    expect(r.ok).toBe(true);
    const servers = await readServers();
    expect(servers.github?.command).toBe('npx');
    expect(servers.github?.enabled).toBe(false);
    expect((registry as { start: ReturnType<typeof vi.fn> }).start).not.toHaveBeenCalled();
  });

  it('persists url for an http transport server', async () => {
    const r = await addMcp(
      {
        name: 'context7',
        transport: 'streamable-http',
        url: 'https://mcp.context7.com/mcp',
        enabled: false,
      },
      deps(makeRegistry()),
    );
    expect(r.ok).toBe(true);
    const servers = await readServers();
    expect(servers.context7?.url).toBe('https://mcp.context7.com/mcp');
    expect(servers.context7?.transport).toBe('streamable-http');
  });

  it('persists the lazy flag', async () => {
    await addMcp(
      { name: 'github', enabled: false, lazy: true },
      deps(makeRegistry(), { github: githubPreset }),
    );
    const servers = await readServers();
    expect(servers.github?.lazy).toBe(true);
  });

  it('normalizes a bare "http" transport to streamable-http', async () => {
    await addMcp(
      { name: 'svc', transport: 'http', url: 'https://x.example/mcp', enabled: false },
      deps(makeRegistry()),
    );
    const servers = await readServers();
    expect(servers.svc?.transport).toBe('streamable-http');
  });

  it('starts the server when enabled', async () => {
    const registry = makeRegistry();
    const r = await addMcp(
      { name: 'github', enabled: true },
      deps(registry, { github: githubPreset }),
    );
    expect(r.ok).toBe(true);
    expect((registry as { start: ReturnType<typeof vi.fn> }).start).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'github', enabled: true }),
    );
    const servers = await readServers();
    expect(servers.github?.enabled).toBe(true);
  });

  it('rejects a duplicate', async () => {
    await addMcp(
      { name: 'github', enabled: false },
      deps(makeRegistry(), { github: githubPreset }),
    );
    const r = await addMcp({ name: 'github' }, deps(makeRegistry(), { github: githubPreset }));
    expect(r.ok).toBe(false);
    expect(r.message).toContain('already exists');
  });

  it('rejects an unknown name with no explicit config', async () => {
    const r = await addMcp({ name: 'nope' }, deps(makeRegistry(), { github: githubPreset }));
    expect(r.ok).toBe(false);
    expect(r.message).toContain('Unknown server');
  });

  it('soft-warns when config persisted but the registry fails to start', async () => {
    const registry = makeRegistry({ start: vi.fn().mockRejectedValue(new Error('boom')) });
    const r = await addMcp(
      { name: 'github', enabled: true },
      deps(registry, { github: githubPreset }),
    );
    expect(r.ok).toBe(true);
    expect(r.registryError).toBe('boom');
    expect(r.message).toContain('failed to start');
    const servers = await readServers();
    expect(servers.github).toBeDefined();
  });
});

describe('updateMcp', () => {
  it('merges fields and keeps url', async () => {
    await addMcp(
      { name: 'context7', transport: 'streamable-http', url: 'https://a/mcp', enabled: false },
      deps(makeRegistry()),
    );
    const r = await updateMcp({ name: 'context7', description: 'docs' }, deps(makeRegistry()));
    expect(r.ok).toBe(true);
    const servers = await readServers();
    expect(servers.context7?.url).toBe('https://a/mcp');
    expect(servers.context7?.description).toBe('docs');
  });

  it('errors when the server is not in config', async () => {
    const r = await updateMcp({ name: 'ghost' }, deps(makeRegistry()));
    expect(r.ok).toBe(false);
    expect(r.message).toContain('not found');
  });
});

describe('removeMcp', () => {
  it('stops and deletes', async () => {
    await addMcp(
      { name: 'github', enabled: false },
      deps(makeRegistry(), { github: githubPreset }),
    );
    const registry = makeRegistry();
    const r = await removeMcp('github', deps(registry));
    expect(r.ok).toBe(true);
    expect((registry as { stop: ReturnType<typeof vi.fn> }).stop).toHaveBeenCalledWith('github');
    expect(await readServers()).toEqual({});
  });

  it('errors when not present', async () => {
    const r = await removeMcp('ghost', deps(makeRegistry()));
    expect(r.ok).toBe(false);
    expect(r.message).toContain('not found');
  });
});

describe('enable / disable', () => {
  it('enable flips config and starts', async () => {
    await addMcp(
      { name: 'github', enabled: false },
      deps(makeRegistry(), { github: githubPreset }),
    );
    const registry = makeRegistry();
    const r = await enableMcp('github', deps(registry));
    expect(r.ok).toBe(true);
    expect((await readServers()).github?.enabled).toBe(true);
  });

  it('disable stops and flips config', async () => {
    await addMcp({ name: 'github', enabled: true }, deps(makeRegistry(), { github: githubPreset }));
    const registry = makeRegistry();
    const r = await disableMcp('github', deps(registry));
    expect(r.ok).toBe(true);
    expect((registry as { stop: ReturnType<typeof vi.fn> }).stop).toHaveBeenCalledWith('github');
    expect((await readServers()).github?.enabled).toBe(false);
  });
});

describe('restart / discover', () => {
  it('restarts a registered server', async () => {
    const registry = makeRegistry({
      list: () => [{ name: 'github', state: 'connected', toolCount: 2, tools: ['a', 'b'] }],
    });
    const r = await restartMcp('github', deps(registry));
    expect(r.ok).toBe(true);
    expect((registry as { restart: ReturnType<typeof vi.fn> }).restart).toHaveBeenCalledWith(
      'github',
    );
    expect(r.tools).toEqual(['a', 'b']);
  });

  it('discover returns the live tool list', async () => {
    await addMcp({ name: 'github', enabled: true }, deps(makeRegistry(), { github: githubPreset }));
    const registry = makeRegistry({
      list: () => [{ name: 'github', state: 'connected', toolCount: 1, tools: ['x'] }],
    });
    const r = await discoverMcp('github', deps(registry));
    expect(r.ok).toBe(true);
    expect(r.tools).toEqual(['x']);
    expect(r.message).toContain('1 tool');
  });
});

describe('listMcp', () => {
  it('merges live state + tools into config entries', async () => {
    await addMcp({ name: 'github', enabled: true }, deps(makeRegistry(), { github: githubPreset }));
    const registry = makeRegistry({
      list: () => [{ name: 'github', state: 'connected', toolCount: 2, tools: ['t1', 't2'] }],
    });
    const list = await listMcp(deps(registry));
    expect(list).toHaveLength(1);
    expect(list[0]?.status).toBe('connected');
    expect(list[0]?.tools).toEqual(['t1', 't2']);
  });

  it('reports stopped servers as stopped with no tools', async () => {
    await addMcp(
      { name: 'github', enabled: false },
      deps(makeRegistry(), { github: githubPreset }),
    );
    const list = await listMcp(deps(makeRegistry()));
    expect(list[0]?.status).toBe('stopped');
    expect(list[0]?.tools).toEqual([]);
  });
});
