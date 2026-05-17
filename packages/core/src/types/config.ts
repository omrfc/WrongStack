import type { ContextWindowModeId } from './context-window.js';
import type { WireFamily } from './models-registry.js';
import type { Permission } from './tool.js';

export interface ContextConfig {
  /** Context-window policy mode. Controls compaction thresholds and preservation depth. */
  mode?: ContextWindowModeId;
  warnThreshold: number;
  softThreshold: number;
  hardThreshold: number;
  /** Enable automatic compaction when thresholds are crossed (default: true). */
  autoCompact?: boolean;
  /**
   * Model used for LLM-assisted summarization in IntelligentCompactor.
   * Falls back to the main model when omitted.
   */
  summarizerModel?: string;
  /**
   * Override the effective context window size (in tokens). Use this when
   * you want the compactor to trigger earlier than the provider's actual
   * maxContext. Defaults to the provider's reported maxContext.
   */
  effectiveMaxContext?: number;
  maxSessionTokens?: number;
  maxDailyTokens?: number;
  preserveK: number;
  eliseThreshold: number;
  /** Compactor strategy: 'hybrid' (default, fast rules), 'intelligent' (LLM summarization), 'selective' (LLM-driven selection). */
  strategy?: 'hybrid' | 'intelligent' | 'selective';
  /** Enable LLM-driven selective compaction (default: false for backward compat). */
  llmSelector?: boolean;
}

export interface ToolsConfig {
  defaultExecutionStrategy: 'parallel' | 'sequential' | 'smart';
  maxIterations: number;
  iterationTimeoutMs: number;
  sessionTimeoutMs: number;
  perIterationOutputCapBytes: number;
  /**
   * When true (default), the agent automatically extends its iteration
   * limit by 100 when hit. Set to false to require user confirmation.
   */
  autoExtendLimit?: boolean;
}

export interface ProviderApiKey {
  /** Short human-readable label (e.g. "personal", "work", "rate-limit-backup"). */
  label: string;
  /**
   * The key itself. The field name contains `apiKey` so the secret-vault
   * walker will encrypt it on write and decrypt it on read.
   */
  apiKey: string;
  /** ISO-8601 timestamp the key was added. */
  createdAt: string;
}

export interface ProviderConfig {
  type: string;
  /**
   * Legacy single-key field. Still honored as a fallback when `apiKeys`
   * is empty. When `apiKeys`/`activeKey` are present, the config loader
   * mirrors the active entry into this field so downstream consumers
   * (provider construction, wire adapters) need no changes.
   */
  apiKey?: string;
  /** Multiple keys for the same provider — pick one with `activeKey`. */
  apiKeys?: ProviderApiKey[];
  /** Label of the entry in `apiKeys` to use. Defaults to the first one. */
  activeKey?: string;
  baseUrl?: string;
  headers?: Record<string, string>;
  model?: string;
  quirks?: Record<string, unknown>;
  capabilities?: Record<string, unknown>;
  /**
   * Optional wire-family override. When present, the provider can be
   * constructed without consulting the models.dev catalog — useful for
   * self-hosted endpoints, internal proxies, or for working offline.
   */
  family?: WireFamily;
  /** Custom env var names to probe when `apiKey` is missing. */
  envVars?: string[];
  /** Optional list of models the user wants visible for this provider. */
  models?: string[];
}

export interface MCPServerConfig {
  /** Human-readable description shown in `wstack mcp list`. */
  description?: string;
  name: string;
  transport: 'stdio' | 'sse' | 'streamable-http';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  enabled?: boolean;
  allowedTools?: string[];
  permission?: Permission;
  startupTimeoutMs?: number;
  requestTimeoutMs?: number;
}

export interface LogConfig {
  level: 'error' | 'warn' | 'info' | 'debug' | 'trace';
  file?: string;
}

export interface PluginConfig {
  name: string;
  enabled?: boolean;
  options?: Record<string, unknown>;
}

/**
 * Optional subsystems that the CLI can boot without. The core flow
 * (provider + agent loop + bundled tools + session) always works; these
 * just add capabilities. `--no-features` flips all of these off, which
 * is the minimum viable WrongStack: a single provider, a fixed config,
 * no network calls at startup.
 */
export interface FeaturesConfig {
  /** Load MCP servers declared in `mcpServers`. */
  mcp: boolean;
  /** Load + initialise npm plugins declared in `plugins`. */
  plugins: boolean;
  /** Register `remember` / `forget` tools backed by memory store. */
  memory: boolean;
  /** Fetch the models.dev catalog at startup. When false, the provider
   *  must declare its `family` explicitly in `providers[<id>]`. */
  modelsRegistry: boolean;
  /** Discover + load skills from disk. */
  skills: boolean;
}

export interface Config {
  version: 1;
  provider: string;
  model: string;
  apiKey?: string;
  baseUrl?: string;
  providers?: Record<string, ProviderConfig>;
  context: ContextConfig;
  tools: ToolsConfig;
  mcpServers?: Record<string, MCPServerConfig>;
  plugins?: (string | PluginConfig)[];
  log: LogConfig;
  features: FeaturesConfig;
  yolo?: boolean;
  cwd?: string;
  /**
   * Per-plugin namespaced config sections. Each plugin reads its own
   * subtree via `ConfigStore.getExtension(pluginName)`. Plugins should
   * declare a `configSchema` so the loader validates this section
   * automatically before `setup()` runs.
   *
   * Example:
   *   extensions: {
   *     'wstack-auth': { tokenUrl: 'https://...', refreshBefore: 300 },
   *     'wstack-metrics': { sink: 'prometheus', port: 9090 },
   *   }
   */
  extensions?: Record<string, Record<string, unknown>>;
}

export interface ConfigLoader {
  load(opts?: { cliFlags?: Partial<Config>; cwd?: string }): Promise<Config>;
}

/**
 * Subscribable view over Config. Plugins and CLI subsystems use this instead
 * of holding a frozen Config reference, so they can react to runtime updates
 * (e.g. `/model` switching the active provider, secrets rotation, dynamic
 * extension reload).
 *
 * The store enforces immutability — `get()` always returns a frozen object.
 * Updates happen through `update(partial)`, which produces a new Config
 * (structurally cloned, then frozen) and notifies watchers.
 */
export interface ConfigStore {
  get(): Readonly<Config>;
  /**
   * Get a typed top-level section. Convenience for consumers that only
   * care about one slice (e.g. `tools` or `context`).
   */
  getSection<K extends keyof Config>(key: K): Readonly<Config[K]>;
  /**
   * Return the extension namespace for `pluginName`, or an empty record
   * when none is configured. The returned object is frozen.
   */
  getExtension(pluginName: string): Readonly<Record<string, unknown>>;
  /**
   * Apply a partial update. Returns the new Config. Watchers are notified
   * synchronously after the update completes. Throws if the result fails
   * any registered invariants (currently: version must stay 1).
   */
  update(partial: Partial<Config>): Readonly<Config>;
  /** Subscribe to changes. Returns an unsubscribe function. */
  watch(cb: (next: Readonly<Config>, prev: Readonly<Config>) => void): () => void;
}
