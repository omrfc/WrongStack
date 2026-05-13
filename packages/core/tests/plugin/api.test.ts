import { describe, it, expect, vi } from 'vitest';
import {
  Container,
  EventBus,
  ToolRegistry,
  ProviderRegistry,
  DefaultPluginAPI,
  DefaultLogger,
} from '../../src/index.js';
import type { Tool, Config, ProviderFactory } from '../../src/index.js';

const baseConfig: Config = {
  providers: {},
  log: { level: 'error' },
} as unknown as Config;

const tool = (name: string): Tool => ({
  name,
  description: '',
  inputSchema: { type: 'object' },
  permission: 'auto',
  mutating: false,
  async execute() {
    return '';
  },
});

function mkApi() {
  const container = new Container();
  const events = new EventBus();
  const pipelines = {} as Parameters<typeof DefaultPluginAPI>[0]['pipelines'];
  const toolRegistry = new ToolRegistry();
  const providerRegistry = new ProviderRegistry();
  const log = new DefaultLogger({ level: 'error' });
  const api = new DefaultPluginAPI({
    ownerName: 'plugin-x',
    container,
    events,
    pipelines,
    toolRegistry,
    providerRegistry,
    config: baseConfig,
    log,
  });
  return { api, toolRegistry, providerRegistry };
}

describe('DefaultPluginAPI', () => {
  it('tools.register attributes ownership and list reflects it', () => {
    const { api, toolRegistry } = mkApi();
    api.tools.register(tool('alpha'));
    expect(api.tools.list().map((t) => t.name)).toContain('alpha');
    expect(toolRegistry.get('alpha')?.name).toBe('alpha');
  });

  it('tools.unregister removes the tool', () => {
    const { api } = mkApi();
    api.tools.register(tool('alpha'));
    api.tools.unregister('alpha');
    expect(api.tools.get('alpha')).toBeUndefined();
  });

  it('providers.register / list works', () => {
    const { api } = mkApi();
    const factory: ProviderFactory = {
      type: 'mock',
      family: 'openai-compatible',
      create: () => ({
        id: 'mock',
        capabilities: {} as never,
        complete: async () => ({ content: [], stopReason: 'end_turn', usage: { input: 0, output: 0 }, model: 'm' }),
      }),
    };
    api.providers.register(factory);
    expect(api.providers.list()).toContain('mock');
  });

  it('providers.create dispatches to registered factory', () => {
    const { api } = mkApi();
    const create = vi.fn().mockReturnValue({ id: 'mock' });
    api.providers.register({ type: 'mock', family: 'openai', create });
    api.providers.create({ type: 'mock', apiKey: 'k' });
    expect(create).toHaveBeenCalled();
  });

  it('mcp falls back to noop when not provided', async () => {
    const { api } = mkApi();
    await expect(api.mcp.start({ name: 'x' } as never)).resolves.toBeUndefined();
    await expect(api.mcp.stop('x')).resolves.toBeUndefined();
    await expect(api.mcp.restart('x')).resolves.toBeUndefined();
    expect(api.mcp.list()).toEqual([]);
  });

  it('uses provided mcpRegistry view when given', () => {
    const container = new Container();
    const events = new EventBus();
    const log = new DefaultLogger({ level: 'error' });
    const mcpList = vi.fn().mockReturnValue([{ name: 'srv', state: 'connected', toolCount: 1 }]);
    const api = new DefaultPluginAPI({
      ownerName: 'p',
      container,
      events,
      pipelines: {} as never,
      toolRegistry: new ToolRegistry(),
      providerRegistry: new ProviderRegistry(),
      config: baseConfig,
      log,
      mcpRegistry: {
        start: async () => undefined,
        stop: async () => undefined,
        restart: async () => undefined,
        list: mcpList,
      },
    });
    expect(api.mcp.list()).toEqual([{ name: 'srv', state: 'connected', toolCount: 1 }]);
    expect(mcpList).toHaveBeenCalled();
  });
});
