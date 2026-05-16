import type { ToolCallPipelinePayload } from '../core/agent.js';
import type { Context } from '../core/context.js';
import type { Container } from '../kernel/container.js';
import type { EventBus, EventName, Listener } from '../kernel/events.js';
import type { ReadonlyPipeline } from '../kernel/pipeline.js';
import type { ExtensionRegistry } from '../extension/registry.js';
import type { TextBlock } from './blocks.js';
import type { Config } from './config.js';
import type { Logger } from './logger.js';
import type { WireFamily } from './models-registry.js';
import type { Provider, Request, Response } from './provider.js';
import type { SlashCommand } from './slash-command.js';
import type { JSONSchema, Tool } from './tool.js';

export interface ToolRegistryView {
  register(t: Tool): void;
  unregister(name: string): void;
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
  /** Registry for agent lifecycle extensions — hooks like beforeRun, beforeIteration, onError, etc. */
  extensions: ExtensionRegistry;
  config: Config;
  log: Logger;
  /**
   * Register a one-time event listener. The handler is automatically removed
   * after the first emission, or when the plugin is uninstalled — whichever
   * comes first.
   */
  onEvent<K extends EventName>(event: K, handler: Listener<K>): () => void;
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
  tools?: boolean;
  /** Will register provider factories via `api.providers.register()`. */
  providers?: boolean;
  /**
   * Pipelines the plugin hooks into. Use the standard names
   * (`request | response | toolCall | userInput | assistantOutput | contextWindow`)
   * or custom pipeline names exposed by other plugins.
   */
  pipelines?: string[];
  /** Will register slash commands via `api.slashCommands.register()`. */
  slashCommands?: boolean;
  /** Will start MCP servers via `api.mcp.start()`. */
  mcp?: boolean;
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
  version?: string;
}

export interface Plugin {
  name: string;
  version?: string;
  /** One-line summary for `wstack plugins list` and error messages. */
  description?: string;
  /** Semver range against the kernel API version (KERNEL_API_VERSION). */
  apiVersion: string;
  /**
   * Capability hints — what subsystems the plugin will register against.
   * Optional; provided for diagnostics and UX. The loader does not enforce
   * these, but mismatch is surfaced via logger at warn level.
   */
  capabilities?: PluginCapabilities;
  /**
   * JSON Schema for the options under `Config.plugins[<name>].options`.
   * When present, the loader validates that section before calling `setup`
   * and rejects the plugin with a clear error path on failure.
   */
  configSchema?: JSONSchema;
  /**
   * Mandatory plugin dependencies — loading fails if any are absent or
   * version-incompatible. Accepts both the legacy string-array form and
   * the structured form with version constraints.
   */
  dependsOn?: (string | PluginDependency)[];
  /** Optional plugin dependencies — silently skipped if absent. */
  optionalDeps?: (string | PluginDependency)[];
  conflictsWith?: string[];
  setup(api: PluginAPI): void | Promise<void>;
  teardown?(api: PluginAPI): void | Promise<void>;
}
