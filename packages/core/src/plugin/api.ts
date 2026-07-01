import { ExtensionRegistry } from '../extension/registry.js';
import { KERNEL_API_VERSION } from './loader.js';
import type { HookRegistry } from '../hooks/registry.js';
import type { Container } from '../kernel/container.js';
import type { EventBus, EventName, Listener } from '../kernel/events.js';
import type { Pipeline } from '../kernel/pipeline.js';
import type { ProviderRegistry } from '../registry/provider-registry.js';
import type { SlashCommandRegistry } from '../registry/slash-command-registry.js';
import type { ToolRegistry } from '../registry/tool-registry.js';
import type { ToolWrapper } from '../registry/tool-registry.js';
import type { Config } from '../types/config.js';
import type { Logger } from '../types/logger.js';
import type { ModelsRegistry } from '../types/models-registry.js';
import type { Mailbox } from '../coordination/mailbox-types.js';
import type {
  MCPRegistryView,
  MetricsSinkView,
  PluginAPI,
  PluginCapabilities,
  PluginDependency,
  PluginPipelines,
  ProviderFactory,
  ProviderRegistryView,
  SessionWriterView,
  SlashCommandRegistryView,
  ToolRegistryView,
} from '../types/plugin.js';
import type { HookEvent, HookMatcher, InProcessHook } from '../types/hooks.js';
import type { SystemPromptContributor } from '../types/system-prompt-contributor.js';
import type { JSONSchema, Tool } from '../types/tool.js';

export interface PluginAPIInit {
  ownerName: string;
  container: Container;
  events: EventBus;
  /**
   * The agent's concrete pipelines. `DefaultPluginAPI` converts each to a
   * `ReadonlyPipeline` before exposing them to the plugin — plugins can
   * inspect and invoke pipelines but cannot mutate them.
   */
  pipelines: PluginPipelines;
  toolRegistry: ToolRegistry;
  providerRegistry: ProviderRegistry;
  slashCommandRegistry?: SlashCommandRegistry | undefined;
  mcpRegistry?: MCPRegistryView | undefined;
  /**
   * The agent's extension registry. Plugins register AgentExtension
   * instances here to hook into agent lifecycle events.
   */
  extensions?: ExtensionRegistry | undefined;
  /**
   * The host's lifecycle hook registry. When provided, `api.registerHook`
   * adds in-process hooks here. When absent, `registerHook` is a noop.
   */
  hookRegistry?: HookRegistry | undefined;
  /**
   * The active session writer. Plugins append custom events here.
   * When not provided, a noop writer is used.
   */
  sessionWriter?: SessionWriterView | undefined;
  /**
   * The host's metrics sink. When set, the plugin gets a scoped view
   * that auto-prefixes metric names with `plugin.<pluginName>.`.
   * When not provided, a noop sink is used.
   */
  metricsSink?: MetricsSinkView | undefined;
  /**
   * The host's models registry (models.dev-backed catalog of providers,
   * models, and per-token pricing). When provided, plugins that need
   * model metadata (cost-tracker, billing reports) can query it instead
   * of relying on bundled tables. Optional — minimal hosts/tests may
   * omit it.
   */
  modelsRegistry?: ModelsRegistry | undefined;
  /**
   * The host's project-level mailbox. When provided, plugins that publish
   * to other agents (todo-listener, session-recap) can call `api.mailbox.send`.
   * When not provided, those plugins should gracefully no-op.
   */
  mailbox?: Mailbox | undefined;
  config: Config;
  /**
   * The host's ConfigStore. Used to wire `api.onConfigChange()`.
   * When not provided, `onConfigChange` is a noop.
   */
  configStore?: { watch(cb: (next: unknown, prev: unknown) => void): () => void };
  log: Logger;
  /**
   * Whether this plugin is first-party ("official"). Set by the host based on
   * the plugin's load source (e.g. shipped in the built-in factory list), NOT
   * self-declared by the plugin. Official plugins may register bare slash
   * command names and override built-ins; external plugins are namespaced.
   * Defaults to false.
   */
  official?: boolean | undefined;
  /**
   * Declared capabilities of the plugin. Used for capability-based
   * authorization checks (e.g. tool mutation permissions).
   */
  capabilities?: PluginCapabilities | undefined;
}

export class DefaultPluginAPI implements PluginAPI {
  readonly container: Container;
  readonly events: EventBus;
  readonly pipelines: PluginPipelines;
  readonly tools: ToolRegistryView;
  readonly providers: ProviderRegistryView;
  readonly mcp: MCPRegistryView;
  readonly slashCommands: SlashCommandRegistryView;
  readonly extensions: ExtensionRegistry;
  readonly session: SessionWriterView;
  readonly metrics: MetricsSinkView;
  readonly config: Config;
  readonly log: Logger;
  readonly modelsRegistry: ModelsRegistry | undefined;
  readonly mailbox: Mailbox | undefined;
  private readonly configStore:
    | { watch(cb: (next: unknown, prev: unknown) => void): () => void }
    | undefined;
  private readonly hookRegistry: HookRegistry | undefined;
  private readonly ownerName: string;
  private readonly pluginCleanupFns: Array<() => void> = [];

  constructor(init: PluginAPIInit) {
    const owner = init.ownerName;
    this.ownerName = owner;
    this.hookRegistry = init.hookRegistry;
    this.container = init.container;
    this.events = init.events;
    this.config = init.config;
    this.configStore = init.configStore;
    this.log = init.log.child({ plugin: owner });
    this.extensions = init.extensions ?? new ExtensionRegistry();
    this.session = init.sessionWriter ?? noopSession;
    this.metrics = init.metricsSink ? scopedMetrics(init.metricsSink, owner) : noopMetrics;
    this.modelsRegistry = init.modelsRegistry;
    this.mailbox = init.mailbox;

    // Convert concrete pipelines to read-only views before passing to plugins.
    const pipelines = init.pipelines as never as Record<string, Pipeline<unknown>>;
    const readonlyPipelines: PluginPipelines = {} as PluginPipelines;
    for (const [key, pipeline] of Object.entries(pipelines)) {
      readonlyPipelines[key] = pipeline.asReadonly() as PluginPipelines[typeof key];
    }
    this.pipelines = readonlyPipelines;

    const tr = init.toolRegistry;
    const isOfficial = init.official === true;
    const capabilities = init.capabilities;
    // Trust tiers for the tool registry, mirroring the slash-command registry:
    // only first-party ("official") plugins (and core) may mutate a tool they
    // do not own. An external plugin can register, wrap, and unregister its OWN
    // tools, but must not silently downgrade a built-in's `permission` via
    // `wrap`, nor `unregister` another owner's safeguard. Officiality is set by
    // the host from the load source — never self-declared. (`register` is
    // already collision-safe: it throws on a duplicate name, so an external
    // plugin cannot shadow a built-in by re-registering it.)
    const assertCanMutateTool = (name: string, op: string): void => {
      if (isOfficial) return;
      const currentOwner = tr.ownerOf(name);
      // undefined: tool doesn't exist — let the downstream call no-op/throw.
      if (currentOwner === undefined) return;
      // `wrap` records a chain owner like "core+plugin"; a tool this plugin
      // solely registered and (re)wrapped is "plugin" or "plugin+plugin".
      // The plugin owns the tool only if EVERY segment is itself — so a core
      // tool ("core") or one another plugin touched ("core+plugin") is denied.
      const ownedSolelyByMe = currentOwner.split('+').every((seg) => seg === owner);
      if (ownedSolelyByMe) return;

      // 2026-06-13: Capability-based mutation check for non-official plugins
      // that don't own the tool. If the plugin declares toolMutateCapabilities
      // matching the tool's capabilities, allow the mutation.
      const toolCaps = tr.get(name)?.capabilities ?? [];
      const pluginMutateCaps = capabilities?.toolMutateCapabilities ?? [];
      const hasRequiredCap = toolCaps.some((c) => pluginMutateCaps.includes(c));

      if (!hasRequiredCap) {
        throw new Error(
          `Plugin "${owner}" may not ${op} tool "${name}" — it is owned by "${currentOwner}". ` +
            `Tool capabilities: [${toolCaps.join(', ') || 'none'}]. ` +
            `Plugin toolMutateCapabilities: [${pluginMutateCaps.join(', ') || 'none'}]. ` +
            `Missing required capability to mutate this tool.`,
        );
      }
    };
    this.tools = {
      register: (t: Tool) => tr.register(t, owner),
      unregister: (name: string) => {
        assertCanMutateTool(name, 'unregister');
        return tr.unregister(name);
      },
      wrap: (name: string, wrapper: ToolWrapper) => {
        assertCanMutateTool(name, 'wrap');
        tr.wrap(name, wrapper, owner);
      },
      get: (name: string) => tr.get(name),
      list: () => tr.list(),
    };

    const pr = init.providerRegistry;
    this.providers = {
      register: (f: ProviderFactory) => pr.register(f),
      unregister: (type: string) => pr.unregister(type),
      create: (cfg) => pr.create(cfg as { type: string }),
      list: () => pr.list(),
    };

    this.mcp = init.mcpRegistry ?? noopMcp;

    const scr = init.slashCommandRegistry;
    const official = init.official === true;
    this.slashCommands = scr
      ? {
          register: (cmd) => scr.register(cmd, owner, { official }),
          unregister: (name) => scr.unregister(name),
          get: (name) => scr.get(name),
          list: () => scr.list(),
        }
      : noopSlashCommands;
  }

  onEvent<K extends EventName>(event: K, handler: Listener<K>): () => void {
    const off = this.events.on(event, handler);
    this.pluginCleanupFns.push(off);
    return off;
  }

  onPattern(pattern: string, handler: (event: string, payload: unknown) => void): () => void {
    const off = this.events.onPattern(pattern, handler);
    this.pluginCleanupFns.push(off);
    return off;
  }

  emitCustom(event: string, payload: unknown): void {
    this.events.emitCustom(event, payload);
  }

  onConfigChange(handler: (next: Readonly<Config>, prev: Readonly<Config>) => void): () => void {
    if (!this.configStore) return () => {};
    return this.configStore.watch(handler as (next: unknown, prev: unknown) => void);
  }

  /** Called by the plugin loader when uninstalling the plugin. */
  drainCleanup(): void {
    for (const fn of this.pluginCleanupFns.splice(0)) {
      try {
        fn();
      } catch {
        /* best-effort */
      }
    }
    // Belt-and-braces: drain any hooks this plugin still owns. If `setup()`
    // threw partway through, the unsubscribe functions above may not cover
    // every registered hook (the push happens *after* registerInProcess
    // returns). Sweeping by owner guarantees no closure outlives its plugin.
    if (this.hookRegistry) this.hookRegistry.drainByOwner(this.ownerName);
  }

  registerSystemPromptContributor(c: SystemPromptContributor): () => void {
    return this.extensions.registerSystemPromptContributor(c);
  }

  registerHook(
    event: HookEvent,
    matcher: HookMatcher | undefined,
    hook: InProcessHook,
  ): () => void {
    if (!this.hookRegistry) return () => {};
    const off = this.hookRegistry.registerInProcess(event, matcher, hook, this.ownerName);
    this.pluginCleanupFns.push(off);
    return off;
  }
}

const noopMcp: MCPRegistryView = {
  start: async () => undefined,
  stop: async () => undefined,
  restart: async () => undefined,
  list: () => [],
};

const noopSlashCommands: SlashCommandRegistryView = {
  register() {
    /* noop */
  },
  unregister() {
    return false;
  },
  get() {
    return undefined;
  },
  list() {
    return [];
  },
};

const noopSession: SessionWriterView = {
  append: async () => {
    /* noop */
  },
};

const noopMetrics: MetricsSinkView = {
  counter() {},
  histogram() {},
  gauge() {},
};

/**
 * Wrap a MetricsSinkView so every metric name is prefixed with
 * `plugin.<pluginName>.`. This prevents metric name collisions
 * between plugins and keeps the Prometheus output organized.
 */
function scopedMetrics(sink: MetricsSinkView, pluginName: string): MetricsSinkView {
  const prefix = `plugin.${pluginName}.`;
  return {
    counter(name, value, labels) {
      sink.counter(`${prefix}${name}`, value, labels);
    },
    histogram(name, value, labels) {
      sink.histogram(`${prefix}${name}`, value, labels);
    },
    gauge(name, value, labels) {
      sink.gauge(`${prefix}${name}`, value, labels);
    },
  };
}

/**
 * Define a plugin with automatic `apiVersion` injection and optional
 * TypeScript type inference for the plugin options schema.
 *
 * The `options` generic is inferred from the `factory` function's second
 * parameter, so annotating it gives you fully-typed options throughout:
 *
 * @example
 * ```ts
 * import { definePlugin } from '@wrongstack/core';
 *
 * interface MyOptions {
 *   threshold: number;
 *   enabled: boolean;
 * }
 *
 * const myPlugin = definePlugin(
 *   {
 *     name: 'my-plugin',
 *     version: '0.1.0',
 *     description: 'My example plugin',
 *     capabilities: { tools: true },
 *     configSchema: {
 *       type: 'object',
 *       properties: {
 *         threshold: { type: 'number', default: 100 },
 *         enabled: { type: 'boolean', default: true },
 *       },
 *     },
 *     defaultConfig: { threshold: 100, enabled: true },
 *   },
 *   (api, options) => {
 *     // options.threshold is `number` here, not `unknown`
 *     api.tools.register({
 *       name: 'my-tool',
 *       description: `Threshold is ${options.threshold}`,
 *       // ...
 *     });
 *   },
 * );
 *
 * export default myPlugin;
 * ```
 *
 * Plugins that don't need typed options can omit the interface and let
 * TypeScript infer from `defaultConfig`, or omit `defaultConfig` entirely
 * (options will be `undefined` at runtime, accessible via `api.config`):
 *
 * @example
 * ```ts
 * const simplePlugin = definePlugin(
 *   { name: 'simple' },
 *   (api) => {
 *     api.tools.register({ name: 'ping', description: 'Ping the service' });
 *   },
 * );
 * ```
 *
 * The `apiVersion` is automatically set to the current `KERNEL_API_VERSION`
 * so plugins are always compatible with the kernel that loaded them.
 * Plugins that need to pin to a specific kernel version can override it
 * in the returned object before exporting.
 */
export function definePlugin<const TOptions extends Record<string, unknown> | undefined>(
  metadata: {
    name: string;
    version?: string | undefined;
    description?: string | undefined;
    capabilities?: PluginCapabilities | undefined;
    configSchema?: JSONSchema | undefined;
    defaultConfig?: TOptions | undefined;
    dependsOn?: (string | PluginDependency)[] | undefined;
    optionalDeps?: (string | PluginDependency)[] | undefined;
    conflictsWith?: string[] | undefined;
  },
  factory: (api: PluginAPI, options: TOptions) => void | Promise<void>,
): { name: string; version?: string | undefined; description?: string | undefined; apiVersion: string; capabilities?: PluginCapabilities | undefined; configSchema?: JSONSchema | undefined; defaultConfig?: TOptions | undefined; dependsOn?: (string | PluginDependency)[] | undefined; optionalDeps?: (string | PluginDependency)[] | undefined; conflictsWith?: string[] | undefined; setup: (api: PluginAPI) => void | Promise<void> } {
  return {
    name: metadata.name,
    version: metadata.version,
    description: metadata.description,
    capabilities: metadata.capabilities,
    configSchema: metadata.configSchema,
    defaultConfig: metadata.defaultConfig,
    dependsOn: metadata.dependsOn,
    optionalDeps: metadata.optionalDeps,
    conflictsWith: metadata.conflictsWith,
    apiVersion: KERNEL_API_VERSION,
    // Cast the factory to match the Plugin.setup signature.
    // The opts parameter ({ signal }) is accepted by Plugin.setup but the
    // definePlugin factory doesn't need to declare it — the host always passes
    // it at the call site; the factory just doesn't have to care about it.
    setup: (api: PluginAPI) => factory(api, metadata.defaultConfig as TOptions),
  };
}
