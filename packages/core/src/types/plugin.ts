import type { ToolCallPipelinePayload } from '../core/agent.js';
import type { Context } from '../core/context.js';
import type { ExtensionRegistry } from '../extension/registry.js';
import type { Container } from '../kernel/container.js';
import type { EventBus, EventName, Listener } from '../kernel/events.js';
import type { ReadonlyPipeline } from '../kernel/pipeline.js';
import type { ToolWrapper } from '../registry/tool-registry.js';
import type { TextBlock } from './blocks.js';
import type { Config } from './config.js';
import type { HookEvent, HookMatcher, InProcessHook } from './hooks.js';
import type { Logger } from './logger.js';
import type { WireFamily } from './models-registry.js';
import type { Provider, Request, Response } from './provider.js';
import type { SlashCommand } from './slash-command.js';
import type { SystemPromptContributor } from './system-prompt-contributor.js';
import type { JSONSchema, Tool } from './tool.js';

export interface ToolRegistryView {
  register(t: Tool): void;
  unregister(name: string): void;
  /** Wrap (decorate) an existing tool. The wrapper gets the current tool and returns the decorated version. */
  wrap(name: string, wrapper: ToolWrapper): void;
  get(name: string): Tool | undefined;
  list(): Tool[];
}

export interface ProviderFactory {
  type: string;
  family: WireFamily;
  create(cfg: unknown): Provider;
}

export interface ProviderRegistryView {
  register(f: ProviderFactory): void;
  create(cfg: { type: string } & Record<string, unknown>): Provider;
  list(): string[];
}

export interface MCPRegistryView {
  start(cfg: unknown): Promise<void>;
  stop(name: string): Promise<void>;
  restart(name: string): Promise<void>;
  list(): { name: string; state: string; toolCount: number }[];
}

export interface SlashCommandRegistryView {
  register(cmd: SlashCommand): void;
  unregister(name: string): boolean;
  get(name: string): SlashCommand | undefined;
  list(): SlashCommand[];
}

/**
 * Read-only view of the session writer. Plugins can append custom events
 * to the JSONL session log and read the transcript path.
 *
 * The `append` method accepts any JSON-serializable payload — custom
 * event types are persisted verbatim next to the built-in events.
 */
export interface SessionWriterView {
  readonly transcriptPath?: string | undefined;
  append(event: Record<string, unknown> & { type: string; ts: string }): Promise<void>;
}

/**
 * Metrics sink scoped to a plugin. The host auto-prefixes metric names
 * with `plugin.<pluginName>.` so plugins don't need to namespace
 * manually. Plugins call counter/histogram/gauge directly; the values
 * flow to the host's MetricsSink (Prometheus, OTLP, or noop).
 */
export interface MetricsSinkView {
  counter(name: string, value?: number | undefined, labels?: Record<string, string>): void;
  histogram(name: string, value: number, labels?: Record<string, string>): void;
  gauge(name: string, value: number, labels?: Record<string, string>): void;
}

export interface PluginPipelines {
  request: ReadonlyPipeline<Request>;
  response: ReadonlyPipeline<Response>;
  toolCall: ReadonlyPipeline<ToolCallPipelinePayload>;
  userInput: ReadonlyPipeline<{
    content: import('./blocks.js').ContentBlock[];
    text: string;
    ctx: Context;
  }>;
  assistantOutput: ReadonlyPipeline<TextBlock>;
  contextWindow: ReadonlyPipeline<Context>;
  // biome-ignore lint/suspicious/noExplicitAny: plugins may extend with custom pipelines
  [k: string]: ReadonlyPipeline<any>;
}

export interface PluginAPI {
  container: Container;
  pipelines: PluginPipelines;
  events: EventBus;
  tools: ToolRegistryView;
  providers: ProviderRegistryView;
  mcp: MCPRegistryView;
  slashCommands: SlashCommandRegistryView;
  /** Live session writer — plugins can append custom events here. */
  session: SessionWriterView;
  /** Scoped metrics sink — counters/histograms/gauges auto-namespaced under `plugin.<name>.` */
  metrics: MetricsSinkView;
  /** Registry for agent lifecycle extensions — hooks like beforeRun, beforeIteration, onError, etc. */
  extensions: ExtensionRegistry;
  /**
   * Register a system prompt contributor. Plugins call this to inject
   * ephemeral TextBlocks into the system prompt on every build.
   * Returns an unregister function.
   */
  registerSystemPromptContributor(c: SystemPromptContributor): () => void;
  /**
   * Register an in-process lifecycle hook. `matcher` is a tool-name filter for
   * `PreToolUse`/`PostToolUse` (`"Bash"`, `"edit|write"`, `"*"`) and ignored
   * for other events. The hook can block, rewrite tool input, or inject extra
   * context — see `HookOutcome`. Automatically removed when the plugin is
   * uninstalled. Returns an unregister function.
   */
  registerHook(event: HookEvent, matcher: HookMatcher | undefined, hook: InProcessHook): () => void;
  config: Config;
  log: Logger;
  /**
   * Register a one-time event listener. The handler is automatically removed
   * after the first emission, or when the plugin is uninstalled — whichever
   * comes first.
   */
  onEvent<K extends EventName>(event: K, handler: Listener<K>): () => void;
  /**
   * Subscribe to all events matching a glob-style pattern.
   * `'tool.*'` matches all tool events. `'*'` matches everything.
   * Returns an unsubscribe function.
   */
  onPattern(pattern: string, handler: (event: string, payload: unknown) => void): () => void;
  /**
   * Emit a custom event on the agent's EventBus. Use for inter-plugin
   * communication or to surface plugin-specific state to the host.
   *
   * Custom events use a `pluginName:eventName` convention to avoid
   * collisions with built-in events (e.g. `my-plugin:cache_hit`).
   * The payload is passed through to all subscribers.
   */
  emitCustom(event: string, payload: unknown): void;
  /**
   * Register a callback that fires when the configuration changes at
   * runtime (e.g. via `/config` slash command or programmatic update).
   * The handler receives the new and previous config snapshots.
   * Returns an unsubscribe function.
   */
  onConfigChange(handler: (next: Readonly<Config>, prev: Readonly<Config>) => void): () => void;
}

/**
 * Capability declaration — informs the host which subsystems a plugin
 * intends to touch. Used for diagnostics and per-plugin enable/disable UX
 * (e.g. "this plugin registers tools — disable to remove them"). Not
 * enforced at runtime: a plugin that declares `tools: false` can still
 * call `api.tools.register()`, but the host can flag the discrepancy.
 */
export interface PluginCapabilities {
  /** Will register tools via `api.tools.register()`. */
  tools?: boolean | undefined;
  /** Will register provider factories via `api.providers.register()`. */
  providers?: boolean | undefined;
  /**
   * Pipelines the plugin hooks into. Use the standard names
   * (`request | response | toolCall | userInput | assistantOutput | contextWindow`)
   * or custom pipeline names exposed by other plugins.
   */
  pipelines?: string[] | undefined;
  /** Will register slash commands via `api.slashCommands.register()`. */
  slashCommands?: boolean | undefined;
  /** Will start MCP servers via `api.mcp.start()`. */
  mcp?: boolean | undefined;
  /**
   * Capabilities required to mutate (wrap, unregister, override) tools
   * the plugin does not own. If empty or omitted, the plugin may only
   * mutate its own tools. Official plugins bypass this check.
   *
   * Example: `['fs.read', 'net.outbound']` allows the plugin to wrap
   * read-only tools, but not `fs.write` or `shell.arbitrary` tools.
   */
  toolMutateCapabilities?: string[] | undefined;
}

/**
 * Structured dependency declaration. The string form (`dependsOn: ['foo']`)
 * is shorthand for `[{ name: 'foo' }]` — both work. Use the structured form
 * when you need a version constraint:
 *
 *   dependsOn: [{ name: 'wstack-auth', version: '^1.2.0' }]
 */
export interface PluginDependency {
  name: string;
  /** npm-style semver range. Supports `^`, `~`, exact, and unprefixed. */
  version?: string | undefined;
}

export interface Plugin {
  name: string;
  version?: string | undefined;
  /** One-line summary for `wstack plugins list` and error messages. */
  description?: string | undefined;
  /** Semver range against the kernel API version (KERNEL_API_VERSION). */
  apiVersion: string;
  /**
   * Capability hints — what subsystems the plugin will register against.
   * Optional; provided for diagnostics and UX. The loader does not enforce
   * these, but mismatch is surfaced via logger at warn level.
   */
  capabilities?: PluginCapabilities | undefined;
  /**
   * JSON Schema for the options under `Config.plugins[<name>].options`.
   * When present, the loader validates that section before calling `setup`
   * and rejects the plugin with a clear error path on failure.
   */
  configSchema?: JSONSchema | undefined;
  /**
   * Mandatory plugin dependencies — loading fails if any are absent or
   * version-incompatible. Accepts both the legacy string-array form and
   * the structured form with version constraints.
   */
  dependsOn?: (string | PluginDependency)[] | undefined;
  /** Optional plugin dependencies — silently skipped if absent. */
  optionalDeps?: (string | PluginDependency)[] | undefined;
  conflictsWith?: string[] | undefined;
  /**
   * Default configuration values, deep-merged under the plugin's options
   * key before `configSchema` validation. User-provided values take
   * precedence over defaults — this is a fallback, not an override.
   *
   * @example
   * defaultConfig: { ttl: 3600, maxSize: 100 }
   */
  defaultConfig?: Record<string, unknown>;
  setup(api: PluginAPI): void | Promise<void>;
  teardown?(api: PluginAPI): void | Promise<void>;
  /**
   * Optional health check. Called by the host (e.g. `/diag plugins` slash
   * command or health endpoint) to surface plugin status. Return
   * `{ ok: false, message: '...' }` when the plugin is degraded.
   */
  health?(): Promise<{ ok: boolean; message?: string | undefined }>;
}
