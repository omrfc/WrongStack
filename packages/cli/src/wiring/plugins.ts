import type {
  AgentPipelines,
  Config,
  ConfigStore,
  Container,
  EventBus,
  ExtensionRegistry,
  HealthRegistry,
  Logger,
  MetricsSinkView,
  Plugin,
  ProviderRegistry,
  SessionWriter,
  SkillLoader,
  SlashCommandRegistry,
  ToolRegistry,
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
  agent: { extensions?: ExtensionRegistry | undefined };
  /** Lifecycle hook registry — injected so plugins can register in-process hooks. */
  hookRegistry?: import('@wrongstack/core').HookRegistry | undefined;
  sessionWriter: SessionWriter;
  metricsSink?: MetricsSinkView | undefined;
  /** Health registry — injected so the observability built-in can run /health. */
  healthRegistry?: HealthRegistry | undefined;
  /** Skill loader — injected so the skills built-in can list/read skills. */
  skillLoader?: SkillLoader | undefined;
  configStore: ConfigStore;
  /** Secret vault — injected so sync plugin can encrypt the GitHub token. */
  vault?: { encrypt(plaintext: string): string; decrypt?(value: string): string };
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
  async () => {
    const { createGitPlugin } = await import('@wrongstack/core');
    return createGitPlugin();
  },
  async () => {
    const { createObservabilityPlugin } = await import('@wrongstack/core');
    return createObservabilityPlugin();
  },
  async () => {
    const { createSecurityPlugin } = await import('@wrongstack/core');
    return createSecurityPlugin();
  },
  async () => {
    const { createChimeraPlugin } = await import('@wrongstack/core');
    return createChimeraPlugin();
  },
  async () => {
    const { createSkillsPlugin } = await import('@wrongstack/core');
    return createSkillsPlugin();
  },
  async () => {
    const { createPlanPlugin } = await import('@wrongstack/core');
    return createPlanPlugin();
  },
  // ── Workspace plugins (@wrongstack/plugins subpath exports) ──────────
  async () => (await import('@wrongstack/plugins/cost-tracker')).default,
  async () => (await import('@wrongstack/plugins/json-path')).default,
  async () => (await import('@wrongstack/plugins/web-search')).default,
  async () => (await import('@wrongstack/plugins/file-watcher')).default,
  async () => (await import('@wrongstack/plugins/git-autocommit')).default,
  async () => (await import('@wrongstack/plugins/auto-doc')).default,
  async () => (await import('@wrongstack/plugins/shell-check')).default,
  async () => (await import('@wrongstack/plugins/cron')).default,
  async () => (await import('@wrongstack/plugins/template-engine')).default,
  async () => (await import('@wrongstack/plugins/semver-bump')).default,
  // ── LSP plugin ──────────────────────────────────────────────────────
  async () => (await import('@wrongstack/plug-lsp')).default,
  // ── Telegram plugin ─────────────────────────────────────────────────
  async () => (await import('@wrongstack/telegram')).default,
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
    healthRegistry,
    skillLoader,
    configStore,
    pipelines,
    paths,
    hookRegistry,
  } = params;

  // ── 1. Load built-in plugins (prompts, sync, git, …) only when paths are
  // available — they need WstackPaths to initialise their stores.
  //
  // Built-ins are ENABLED BY DEFAULT. A user can opt a specific one out by
  // adding `{ name: 'wstack-git', enabled: false }` to `config.plugins`
  // (or disable all plugins with `config.features.plugins === false`).
  const builtinPlugins: Plugin[] = [];
  const disabledBuiltins = new Set(
    (config.plugins ?? [])
      .filter(
        (p): p is { name: string; enabled?: boolean | undefined } =>
          typeof p === 'object' && p.enabled === false,
      )
      .map((p) => p.name),
  );
  if (paths && config.features?.plugins !== false) {
    for (const factory of BUILTIN_PLUGIN_FACTORIES) {
      try {
        const plugin = await factory();
        if (!plugin) continue;
        if (disabledBuiltins.has(plugin.name)) {
          log.info(`[setupPlugins] built-in plugin "${plugin.name}" disabled by config`);
          continue;
        }
        builtinPlugins.push(plugin);
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
        const mod = (await import(spec)) as { default?: Plugin | undefined };
        if (mod.default) userPlugins.push(mod.default);
      } catch (err) {
        log.warn(`Plugin "${spec}" failed to load`, err);
      }
    }
  }

  // ── 3. Merge: builtins first (they set up infrastructure), then user plugins
  const allPlugins = [...builtinPlugins, ...userPlugins];
  if (allPlugins.length === 0) return;

  const pluginOptions = buildPluginOptions(config);

  // Built-in plugins read their host dependencies off the TOP LEVEL of the
  // config object they receive (e.g. prompts/sync use `config.paths` /
  // `config.configStore`, observability uses `config.metricsSink` /
  // `config.healthRegistry`). Inject them here so each can wire up its store or
  // view without a circular import. User plugins never see these — they only
  // read their own namespaced `config.extensions[name]` options.
  const pluginConfig = patchConfig(config, {
    extensions: pluginOptions,
    paths,
    configStore,
    metricsSink,
    healthRegistry,
    skillLoader,
  } as Partial<Config>);

  await loadPlugins(allPlugins, {
    log,
    pluginOptions,
    apiFactory: (plugin) =>
      createApi(plugin.name, {
        // First-party plugins come from BUILTIN_PLUGIN_FACTORIES — trust them
        // ("official") so they can claim bare slash command names (/prompts,
        // /sync) and override built-ins. User plugins stay namespaced.
        official: builtinPlugins.includes(plugin),
        container,
        events,
        pipelines: pipelines as never as Parameters<typeof createApi>[1]['pipelines'],
        toolRegistry,
        providerRegistry,
        slashCommandRegistry,
        mcpRegistry,
        config: pluginConfig,
        log,
        extensions: agent.extensions,
        hookRegistry,
        sessionWriter: {
          transcriptPath: sessionWriter.transcriptPath,
          append: (e: Record<string, unknown> & { type: string; ts: string }) =>
            sessionWriter.append(e as Parameters<typeof sessionWriter.append>[0]),
        },
        metricsSink,
        configStore,
      }),
  });

  log.info(
    `[setupPlugins] loaded ${builtinPlugins.length} built-in, ${userPlugins.length} user plugin(s)`,
  );
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
