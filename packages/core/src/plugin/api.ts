import type { Container } from '../kernel/container.js';
import type { EventBus, EventName, Listener } from '../kernel/events.js';
import type { Tool } from '../types/tool.js';
import type { Config } from '../types/config.js';
import type { Logger } from '../types/logger.js';
import type {
  PluginAPI,
  PluginPipelines,
  ToolRegistryView,
  ProviderRegistryView,
  MCPRegistryView,
  ProviderFactory,
} from '../types/plugin.js';
import type { ToolRegistry } from '../registry/tool-registry.js';
import type { ProviderRegistry } from '../registry/provider-registry.js';

export interface PluginAPIInit {
  ownerName: string;
  container: Container;
  events: EventBus;
  pipelines: PluginPipelines;
  toolRegistry: ToolRegistry;
  providerRegistry: ProviderRegistry;
  mcpRegistry?: MCPRegistryView;
  config: Config;
  log: Logger;
}

export class DefaultPluginAPI implements PluginAPI {
  readonly container: Container;
  readonly events: EventBus;
  readonly pipelines: PluginPipelines;
  readonly tools: ToolRegistryView;
  readonly providers: ProviderRegistryView;
  readonly mcp: MCPRegistryView;
  readonly config: Config;
  readonly log: Logger;
  private readonly pluginCleanupFns: Array<() => void> = [];

  constructor(init: PluginAPIInit) {
    const owner = init.ownerName;
    this.container = init.container;
    this.events = init.events;
    this.pipelines = init.pipelines;
    this.config = init.config;
    this.log = init.log.child({ plugin: owner });

    const tr = init.toolRegistry;
    this.tools = {
      register: (t: Tool) => tr.register(t, owner),
      unregister: (name: string) => tr.unregister(name),
      get: (name: string) => tr.get(name),
      list: () => tr.list(),
    };

    const pr = init.providerRegistry;
    this.providers = {
      register: (f: ProviderFactory) => pr.register(f),
      create: (cfg) => pr.create(cfg as { type: string }),
      list: () => pr.list(),
    };

    this.mcp = init.mcpRegistry ?? noopMcp;
  }

  onEvent<K extends EventName>(event: K, handler: Listener<K>): () => void {
    const off = this.events.once(event, handler);
    this.pluginCleanupFns.push(off);
    return off;
  }

  /** Called by the plugin loader when uninstalling the plugin. */
  drainCleanup(): void {
    for (const fn of this.pluginCleanupFns.splice(0)) {
      try { fn(); } catch { /* best-effort */ }
    }
  }
}

const noopMcp: MCPRegistryView = {
  start: async () => undefined,
  stop: async () => undefined,
  restart: async () => undefined,
  list: () => [],
};
