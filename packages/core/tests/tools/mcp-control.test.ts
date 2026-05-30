import { describe, expect, it, vi, beforeEach } from 'vitest';
import { createMcpControlTool, type MCPRegistryHandle } from '../../src/tools/mcp-control.js';
import type { Config } from '../../src/index.js';

function fakeConfig(overrides: Partial<Config> = {}): Config {
  return {
    version: 1,
    provider: 'test',
    model: 'test',
    context: { warnThreshold: 80, softThreshold: 90, hardThreshold: 95, preserveK: 10, eliseThreshold: 0 },
    tools: { defaultExecutionStrategy: 'parallel', maxIterations: 10, iterationTimeoutMs: 30000, sessionTimeoutMs: 60000, perIterationOutputCapBytes: 1_000_000 },
    log: { level: 'info' },
    features: { mcp: true, plugins: true, memory: true, modelsRegistry: true, skills: true },
    ...overrides,
  } as Config;
}

function fakeRegistry(overrides: Partial<MCPRegistryHandle> = {}): MCPRegistryHandle {
  return {
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    restart: vi.fn().mockResolvedValue(undefined),
    describe: vi.fn().mockReturnValue([]),
    list: vi.fn().mockReturnValue([]),
    ...overrides,
  };
}

describe('createMcpControlTool', () => {
  let tool: ReturnType<typeof createMcpControlTool>;
  let registry: MCPRegistryHandle;
  let getConfig: () => Config;

  beforeEach(() => {
    registry = fakeRegistry();
    getConfig = () => fakeConfig({ mcpServers: {} });
    tool = createMcpControlTool({ getConfig, configPath: '/tmp/config.json', registry });
  });

  it('has name "mcp_control"', () => {
    expect(tool.name).toBe('mcp_control');
  });

  it('has category "mcp"', () => {
    expect(tool.category).toBe('mcp');
  });

  it('has permission "auto"', () => {
    expect(tool.permission).toBe('auto');
  });

  it('is mutating (writes config + spawns MCP servers)', () => {
    // mcp_control enable/disable writes the config file and spawns/kills MCP
    // server processes, so it must trip the permission confirmation gate.
    expect(tool.mutating).toBe(true);
  });

  it('has riskTier "standard"', () => {
    expect(tool.riskTier).toBe('standard');
  });

  // ── list action ────────────────────────────────────────────────────────────

  it('list: empty config shows "no servers configured"', async () => {
    const result = await tool.execute({ action: 'list' }, undefined as never, { signal: new AbortController().signal });
    expect(result).toContain('No MCP servers configured');
  });

  it('list: shows configured servers', async () => {
    getConfig = () => fakeConfig({
      mcpServers: {
        github: { name: 'github', transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'], description: 'GitHub API', enabled: true },
      },
    });
    registry = fakeRegistry({ describe: () => [{ name: 'github', state: 'connected', toolCount: 12, enabled: true }] });
    tool = createMcpControlTool({ getConfig, configPath: '/tmp/config.json', registry });
    const result = await tool.execute({ action: 'list' }, undefined as never, { signal: new AbortController().signal });
    expect(result).toContain('github');
    expect(result).toContain('connected');
  });

  // ── search action ─────────────────────────────────────────────────────────

  it('search: no query returns all unconfigured presets', async () => {
    const result = await tool.execute({ action: 'search' }, undefined as never, { signal: new AbortController().signal });
    // Should contain filesystem since it's a preset not in config
    expect(result).toContain('filesystem');
    expect(result).toContain('github');
  });

  it('search: filters by keyword in name', async () => {
    const result = await tool.execute({ action: 'search', query: 'git' }, undefined as never, { signal: new AbortController().signal });
    expect(result).toContain('github');
    expect(result).toContain('git');
  });

  it('search: filters by keyword in description', async () => {
    const result = await tool.execute({ action: 'search', query: 'image' }, undefined as never, { signal: new AbortController().signal });
    expect(result).toContain('zai-vision');
    expect(result).toContain('minimax-vision');
  });

  it('search: unknown keyword shows helpful message', async () => {
    const result = await tool.execute({ action: 'search', query: 'xyznotfound' }, undefined as never, { signal: new AbortController().signal });
    expect(result).toContain('No servers match');
  });

  // ── enable action ──────────────────────────────────────────────────────────

  it('enable: missing server name returns error', async () => {
    const result = await tool.execute({ action: 'enable' }, undefined as never, { signal: new AbortController().signal });
    expect(result).toContain('server` is required');
  });

  it('enable: unknown server returns error with known list', async () => {
    const result = await tool.execute({ action: 'enable', server: 'nonexistent' }, undefined as never, { signal: new AbortController().signal });
    expect(result).toContain('Unknown server');
    expect(result).toContain('nonexistent');
  });

  it('enable: starts a preset server and writes to config', async () => {
    const result = await tool.execute({ action: 'enable', server: 'github' }, undefined as never, { signal: new AbortController().signal });
    expect(registry.start).toHaveBeenCalled();
    expect(result).toContain('Enabled');
    expect(result).toContain('github');
  });

  it('enable: already running server reports "already running"', async () => {
    registry = fakeRegistry({ describe: () => [{ name: 'github', state: 'connected', toolCount: 12, enabled: true }] });
    tool = createMcpControlTool({ getConfig, configPath: '/tmp/config.json', registry });
    const result = await tool.execute({ action: 'enable', server: 'github' }, undefined as never, { signal: new AbortController().signal });
    expect(result).toContain('already running');
  });

  // ── disable action ────────────────────────────────────────────────────────

  it('disable: missing server name returns error', async () => {
    const result = await tool.execute({ action: 'disable' }, undefined as never, { signal: new AbortController().signal });
    expect(result).toContain('server` is required');
  });

  it('disable: unknown server returns helpful error', async () => {
    const result = await tool.execute({ action: 'disable', server: 'github' }, undefined as never, { signal: new AbortController().signal });
    expect(result).toContain('not in config');
  });

  it('disable: stops server and updates config', async () => {
    getConfig = () => fakeConfig({
      mcpServers: {
        github: { name: 'github', transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'], enabled: true },
      },
    });
    tool = createMcpControlTool({ getConfig, configPath: '/tmp/config.json', registry });
    const result = await tool.execute({ action: 'disable', server: 'github' }, undefined as never, { signal: new AbortController().signal });
    expect(registry.stop).toHaveBeenCalledWith('github');
    expect(result).toContain('Disabled');
  });

  // ── restart action ───────────────────────────────────────────────────────

  it('restart: missing server name returns error', async () => {
    const result = await tool.execute({ action: 'restart' }, undefined as never, { signal: new AbortController().signal });
    expect(result).toContain('server` is required');
  });

  it('restart: unknown server returns helpful error', async () => {
    const result = await tool.execute({ action: 'restart', server: 'github' }, undefined as never, { signal: new AbortController().signal });
    expect(result).toContain('not configured');
  });

  it('restart: calls registry.restart for configured server', async () => {
    getConfig = () => fakeConfig({
      mcpServers: {
        github: { name: 'github', transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'], enabled: true },
      },
    });
    registry = fakeRegistry({ describe: () => [{ name: 'github', state: 'connected', toolCount: 12, enabled: true }] });
    tool = createMcpControlTool({ getConfig, configPath: '/tmp/config.json', registry });
    const result = await tool.execute({ action: 'restart', server: 'github' }, undefined as never, { signal: new AbortController().signal });
    expect(registry.restart).toHaveBeenCalledWith('github');
    expect(result).toContain('Restarted');
  });

  // ── unknown action ────────────────────────────────────────────────────────

  it('unknown action returns helpful error', async () => {
    const result = await tool.execute({ action: 'frobnicate' } as never, undefined as never, { signal: new AbortController().signal });
    expect(result).toContain('Unknown action');
    expect(result).toContain('frobnicate');
  });
});