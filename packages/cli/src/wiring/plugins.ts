import { type AgentPipelines, type Config, type Container, type EventBus, type Logger, type ProviderRegistry, type SlashCommandRegistry, type ToolRegistry, type SessionWriter, type ConfigStore, type ExtensionRegistry, type MetricsSinkView } from '@wrongstack/core';
import { loadPlugins, type Plugin } from '@wrongstack/core';
import { MCPRegistry } from '@wrongstack/mcp';
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
}

export async function setupPlugins(params: PluginsWiringDeps): Promise<void> {
  const { config, container, events, toolRegistry, providerRegistry, slashCommandRegistry,
    mcpRegistry, log, agent, sessionWriter, metricsSink, configStore, pipelines } = params;

  if (!config.features.plugins || !config.plugins || config.plugins.length === 0) return;

  const resolvedPlugins: Plugin[] = [];
  for (const p of config.plugins) {
    if (typeof p === 'object' && p.enabled === false) continue;
    const spec = typeof p === 'string' ? p : p.name;
    try {
      const mod = (await import(spec)) as { default?: Plugin };
      if (mod.default) resolvedPlugins.push(mod.default);
    } catch (err) {
      log.warn(`Plugin "${spec}" failed to load`, err);
    }
  }

  if (resolvedPlugins.length === 0) return;

  const pluginOptions = buildPluginOptions(config);
  const pluginConfig =
    Object.keys(pluginOptions).length > 0
      ? patchConfig(config, { extensions: pluginOptions } as Partial<Config>)
      : config;

  await loadPlugins(resolvedPlugins, {
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

function patchConfig(base: Config, patch: Partial<Config>): Config {
  return { ...base, ...patch };
}