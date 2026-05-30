import type {
  AgentPipelines,
  Config,
  ConfigStore,
  Container,
  EventBus,
  Logger,
  ProviderRegistry,
  SlashCommandRegistry,
  ToolRegistry,
  SessionWriter,
  ExtensionRegistry,
  MetricsSinkView,
  Plugin,
} from '@wrongstack/core';
import { loadPlugins } from '@wrongstack/core';
import type { MCPRegistry } from '@wrongstack/mcp';
import createApi from '../plugin-api-factory.js';
import { patchConfig } from '../utils.js';

export interface PluginsWiringDeps {
  config: Config;
  container: Container;
  events: EventBus;
  pipelines: AgentPipelines;
  toolRegistry: ToolRegistry;
  providerRegistry: ProviderRegistry;
  slashCommandRegistry: SlashCommandRegistry;
  mcpRegistry: MCPRegistry;
  log: Logger;
  agent: { extensions?: ExtensionRegistry };
  sessionWriter: SessionWriter;
  metricsSink?: MetricsSinkView;
  configStore: ConfigStore;
  /** Resolved WstackPaths — injected so built-in plugins can init stores. */
  paths?: {
    globalRoot: string;
    globalConfig: string;
    globalSkills: string;
    globalPrompts: string;
    globalMemory: string;
    historyFile: string;
    syncConfig: string;
  };
}

/**
 * Built-in plugins loaded automatically for every WrongStack session.
 * Lazy (dynamic import) so they don't bloat consumers who never use them.
 *
 * Disable a built-in by adding `{ name: 'wstack-prompts', enabled: false }`
 * to config.plugins.
 *
 * Override for tests by mocking this module's `BUILTIN_PLUGIN_FACTORIES`.
 */
export const BUILTIN_PLUGIN_FACTORIES: (() => Promise<Plugin>)[] = [
  async () => {
    const { createPromptsPlugin } = await import('@wrongstack/core');
    return createPromptsPlugin();
  },
  async () => {
    const { createSyncPlugin } = await import('@wrongstack/core');
    return createSyncPlugin();
  },
];

export async function setupPlugins(params: PluginsWiringDeps): Promise<void> {
  const {
    config,
    container,
    events,
    toolRegistry,
    providerRegistry,
    slashCommandRegistry,
    mcpRegistry,
    log,
    agent,
    sessionWriter,
    metricsSink,
    configStore,
    pipelines,
    paths,
  } = params;

  // ── 1. Load built-in plugins (prompts, sync, etc.) only when paths are
  // available — they need WstackPaths to initialise their stores.
  const builtinPlugins: Plugin[] = [];
  if (paths) {
    for (const factory of BUILTIN_PLUGIN_FACTORIES) {
      try {
        const plugin = await factory();
        if (plugin) builtinPlugins.push(plugin);
      } catch (err) {
        log.warn('[setupPlugins] builtin plugin failed to load:', err);
      }
    }
  }

  // ── 2. Load user plugins from config.plugins ───────────────────────────
  const userPlugins: Plugin[] = [];
  if (config.features?.plugins !== false) {
    for (const p of config.plugins ?? []) {
      if (typeof p === 'object' && p.enabled === false) continue;
      const spec = typeof p === 'string' ? p : p.name;
      try {
        const mod = (await import(spec)) as { default?: Plugin };
        if (mod.default) userPlugins.push(mod.default);
      } catch (err) {
        log.warn(`Plugin "${spec}" failed to load`, err);
      }
    }
  }

  // ── 3. Merge: builtins first (they set up infrastructure), then user plugins
  const allPlugins = [...builtinPlugins, ...userPlugins];
  if (allPlugins.length === 0) return;

  let pluginOptions = buildPluginOptions(config);

  // Inject paths and configStore into plugin options so built-in plugins can
  // wire up their stores without circular imports.
  if (paths) {
    pluginOptions = {
      ...pluginOptions,
      'wstack-prompts': { ...pluginOptions['wstack-prompts'], paths },
      'wstack-sync': { ...pluginOptions['wstack-sync'], paths, configStore },
    };
  }

  const pluginConfig =
    Object.keys(pluginOptions).length > 0
      ? patchConfig(config, { extensions: pluginOptions } as Partial<Config>)
      : config;

  await loadPlugins(allPlugins, {
    log,
    pluginOptions,
    apiFactory: (plugin) =>
      createApi(plugin.name, {
        container,
        events,
        pipelines: pipelines as unknown as Parameters<typeof createApi>[1]['pipelines'],
        toolRegistry,
        providerRegistry,
        slashCommandRegistry,
        mcpRegistry,
        config: pluginConfig,
        log,
        extensions: agent.extensions,
        sessionWriter: {
          transcriptPath: sessionWriter.transcriptPath,
          append: (e: Record<string, unknown> & { type: string; ts: string }) =>
            sessionWriter.append(e as Parameters<typeof sessionWriter.append>[0]),
        },
        metricsSink,
        configStore,
      }),
  });

  log.info(`[setupPlugins] loaded ${builtinPlugins.length} built-in, ${userPlugins.length} user plugin(s)`);
}

function buildPluginOptions(config: Config): Record<string, Record<string, unknown>> {
  const options: Record<string, Record<string, unknown>> = {};
  for (const entry of config.plugins ?? []) {
    if (typeof entry !== 'object') continue;
    if (entry.options) options[entry.name] = { ...entry.options };
  }
  for (const [name, value] of Object.entries(config.extensions ?? {})) {
    options[name] = { ...(options[name] ?? {}), ...value };
  }
  return options;
}