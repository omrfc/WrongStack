import type { ContextWindowModeId } from './context-window.js';
import type { HookEvent, ShellHook } from './hooks.js';
import type { WireFamily } from './models-registry.js';
import type { Capabilities } from './provider.js';
import type { Permission } from './tool.js';

export interface ContextConfig {
  /** Context-window policy mode. Controls compaction thresholds and preservation depth. */
  mode?: ContextWindowModeId | undefined;
  warnThreshold: number;
  softThreshold: number;
  hardThreshold: number;
  /** Enable automatic compaction when thresholds are crossed (default: true). */
  autoCompact?: boolean | undefined;
  /**
   * Model used for LLM-assisted summarization in IntelligentCompactor.
   * Falls back to the main model when omitted.
   */
  summarizerModel?: string | undefined;
  /**
   * Override the effective context window size (in tokens). Use this when
   * you want the compactor to trigger earlier than the provider's actual
   * maxContext. Defaults to the provider's reported maxContext.
   */
  effectiveMaxContext?: number | undefined;
  maxSessionTokens?: number | undefined;
  maxDailyTokens?: number | undefined;
  preserveK: number;
  eliseThreshold: number;
  /** Compactor strategy: 'hybrid' (default, fast rules), 'intelligent' (LLM summarization), 'selective' (LLM-driven selection). */
  strategy?: 'hybrid' | 'intelligent' | 'selective' | undefined;
  /** Enable LLM-driven selective compaction (default: false for backward compat). */
  llmSelector?: boolean | undefined;
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
  autoExtendLimit?: boolean | undefined;
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
  apiKey?: string | undefined;
  /** Multiple keys for the same provider — pick one with `activeKey`. */
  apiKeys?: ProviderApiKey[] | undefined;
  /** Label of the entry in `apiKeys` to use. Defaults to the first one. */
  activeKey?: string | undefined;
  baseUrl?: string | undefined;
  headers?: Record<string, string>;
  model?: string | undefined;
  quirks?: Record<string, unknown>;
  capabilities?: Record<string, unknown>;
  /**
   * Optional wire-family override. When present, the provider can be
   * constructed without consulting the models.dev catalog — useful for
   * self-hosted endpoints, internal proxies, or for working offline.
   */
  family?: WireFamily | undefined;
  /** Custom env var names to probe when `apiKey` is missing. */
  envVars?: string[] | undefined;
  /** Optional list of models the user wants visible for this provider. */
  models?: string[] | undefined;
  /**
   * Provider-relative custom model definitions (maps modelId → definition).
   * Each entry adds/overrides a model for this provider with optional
   * capability overrides. The model id is the key, not a fully qualified id.
   */
  customModels?: Record<string, CustomModelDefinition>;
}

/**
 * One entry in the per-task model matrix. Pins a catalog role, a phase, or
 * the `*` default to a specific model (and, optionally, a specific provider).
 * Resolved at subagent-spawn time so e.g. `security-scanner` can run a
 * different model than `documentation` while the leader stays on its own.
 */
export interface ModelMatrixEntry {
  /** Provider registry id (e.g. "anthropic", "minimax", "zai"). When omitted,
   *  the leader's provider is used with this entry's model. */
  provider?: string | undefined;
  /** Model id to run for the matched role/phase/default. */
  model: string;
}

export interface MCPServerConfig {
  /** Human-readable description shown in `wstack mcp list`. */
  description?: string | undefined;
  name: string;
  transport: 'stdio' | 'sse' | 'streamable-http';
  command?: string | undefined;
  args?: string[] | undefined;
  env?: Record<string, string>;
  url?: string | undefined;
  headers?: Record<string, string>;
  enabled?: boolean | undefined;
  allowedTools?: string[] | undefined;
  permission?: Permission | undefined;
  startupTimeoutMs?: number | undefined;
  requestTimeoutMs?: number | undefined;
}

export interface LogConfig {
  level: 'error' | 'warn' | 'info' | 'debug' | 'trace';
  file?: string | undefined;
}

export interface PluginConfig {
  name: string;
  enabled?: boolean | undefined;
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
  /**
   * Automatically consolidate session learnings into long-term memory
   * after each completed run. The agent extracts key facts, conventions,
   * and decisions via a lightweight LLM call and persists them.
   * Enabled by default when `memory` is on; set to false to opt out.
   */
  memoryConsolidation?: boolean | undefined;
  /** Fetch the models.dev catalog at startup. When false, the provider
   *  must declare its `family` explicitly in `providers[<id>]`. */
  modelsRegistry: boolean;
  /** Discover + load skills from disk. */
  skills: boolean;
  /**
   * Token-saving mode: when enabled, non-essential tools are omitted,
   * skill descriptions are trimmed, and the system prompt is shortened
   * to reduce per-request token consumption without compromising core
   * functionality. Enable with `--token-saving-mode` or
   * `features.tokenSavingMode: true` in config.
   */
  tokenSavingMode?: boolean | undefined;
  /**
   * Allow tools to read/write paths outside the project root directory.
   * When true (default), tools can access any path on the filesystem.
   * When false, tools are restricted to the project root directory.
   */
  allowOutsideProjectRoot?: boolean | undefined;
}

export interface AutonomyConfig {
  /** ms to wait before auto-proceeding in 'auto' mode. Default: 45000. */
  autoProceedDelayMs?: number | undefined;
}

/**
 * Automatic codebase symbol-index maintenance. Keeps the `codebase-search`
 * index (SQLite, `~/.wrongstack/projects/<hash>/codebase-index/index.db`) fresh
 * without the user having to call `codebase-index` by hand.
 */
export interface IndexingConfig {
  /** Run a blocking incremental index at session start (with a visible summary). Default: true. */
  onSessionStart: boolean;
  /** Reindex files the agent writes/edits via tools, in the background. Default: true. */
  onEdit: boolean;
  /** Watch the project root for external editor changes and reindex them. Default: true. */
  watchExternal: boolean;
  /** Debounce window (ms) coalescing rapid edits to the same file. Default: 400. */
  debounceMs: number;
  /**
   * Watchdog timeout (ms) for a full index run. A run exceeding this is
   * aborted (so it can never wedge the indexing mutex or freeze the terminal)
   * and counts toward the indexing circuit breaker. Default: 120000.
   */
  indexTimeoutMs?: number | undefined;
}

/**
 * Saved launch preferences — restored on next boot so the pre-launch prompt
 * can offer a one-line "Continue with last settings? [Y/n]" instead of
 * re-asking every question from scratch.
 */
export interface LaunchConfig {
  /** Interactive mode: 'tui' (Ink TUI) or 'repl' (readline REPL). */
  mode?: 'tui' | 'repl' | undefined;
  /** Start with Director mode on (fleet manifest + multi-agent orchestration). */
  director?: boolean | undefined;
  /**
   * Launch-time autonomy mode (binary choice from pre-launch prompt).
   * 'off' = stops after each turn; 'auto' = self-driving.
   * Distinct from `AutonomyConfig.defaultMode` which also supports 'suggest'.
   */
  autonomy?: 'off' | 'auto' | undefined;
}

/**
 * Controls how much detail is persisted to the per-session JSONL log
 * (`~/.wrongstack/projects/<hash>/sessions/<id>.jsonl`).
 */
export interface SessionLoggingConfig {
  /**
   * How much detail to write to the persistent session log.
   *
   * - "minimal"  → Only events required for resume/rewind/recovery
   * - "standard" → (default) + high-value lightweight audit events
   *                (compaction, tool timing, retries, errors, etc.)
   * - "full"     → Also persist full request payloads (very large).
   *                Consider enabling a separate replay log instead.
   */
  auditLevel?: 'minimal' | 'standard' | 'full' | undefined;

  /**
   * Sampling configuration for high-volume events (especially relevant at
   * `auditLevel: "full"`).
   */
  sampling?: {
    /** Controls sampling of `tool_progress` events. */
    toolProgress?: {
      /**
       * Sample rate for noisy progress events (`log`, `partial_output`).
       * - 1 = no sampling (every message is logged)
       * - 8 = default (first message + every 8th)
       */
      sampleRate?: number | undefined;
    };
  };
}

export type SyncCategory = 'settings' | 'skills' | 'prompts' | 'memory' | 'history';

export interface SyncConfig {
  enabled: boolean;
  repo: string;
  /** GitHub token (fine-grained PAT). Encrypted at rest via SecretVault. */
  githubToken: string;
  categories: SyncCategory[];
  lastSyncedAt?: string | undefined;
}

/**
 * Per-model capability overrides the user can define in their config.
 * Used to add models not in the models.dev catalog, or override catalog
 * facts when the real backend differs (e.g. local Ollama models, proxies).
 */
export interface CustomModelDefinition {
  /** Provider this model belongs to. Defaults to the owning ProviderConfig. */
  provider?: string | undefined;
  /** Optional display name. */
  name?: string | undefined;
  /** Capability overrides — only specified fields are overlaid. */
  capabilities?: Partial<Capabilities> | undefined;
  /**
   * Max output tokens. If not specified, the provider family default
   * or catalog entry is used.
   */
  maxOutput?: number | undefined;
}

export interface Config {
  version: 1;
  provider: string;
  model: string;
  apiKey?: string | undefined;
  baseUrl?: string | undefined;
  /**
   * Maximum number of subagent tasks the fleet coordinator dispatches
   * simultaneously. Extra tasks queue until a slot frees. Default: 4.
   * Overridden by WRONGSTACK_MAX_CONCURRENT env var and --max-concurrent
   * CLI flag. Change at runtime with /fleet concurrency <n>.
   */
  maxConcurrent?: number | undefined;
  providers?: Record<string, ProviderConfig>;
  /**
   * Top-level custom models (maps modelId → definition). Merged with
   * per-provider `customModels` at resolution time. The key is the
   * model id — not a fully qualified name. When the same model id
   * appears in both places, the top-level one wins.
   */
  models?: Record<string, CustomModelDefinition>;
  /**
   * Per-task model matrix. Keys are catalog roles (e.g. "security-scanner"),
   * phase names (e.g. "review"), or the `*` default. Resolution precedence at
   * subagent spawn: exact role → the role's phase → `*` → leader model. Set via
   * the `/setmodel` slash command; persisted to ~/.wrongstack/config.json.
   */
  modelMatrix?: Record<string, ModelMatrixEntry>;
  context: ContextConfig;
  tools: ToolsConfig;
  mcpServers?: Record<string, MCPServerConfig>;
  /**
   * Ordered list of fallback model references tried, in order, when the
   * primary model is overloaded (HTTP 429/529/5xx) and its own retries are
   * exhausted. Each entry is a model reference: a bare model id (same
   * provider), `provider/model`, or `provider model`. The primary is always
   * re-tried first at the start of every user turn. See `createFallbackModelExtension`.
   */
  fallbackModels?: string[] | undefined;
  /**
   * When `true` (the default) and `fallbackModels` is empty, a fallback chain
   * is derived automatically from the other keyed providers/models so 429s
   * recover out of the box. Set `false` to disable the smart default and only
   * use an explicit `fallbackModels` list. Toggle via `/fallback auto on|off`.
   */
  fallbackAuto?: boolean | undefined;
  /**
   * Lifecycle shell hooks, keyed by event. Each command receives the hook
   * `HookInput` JSON on stdin; a JSON `HookOutcome` on stdout (and exit code 2
   * = block) steers the agent. In-process hooks are registered separately via
   * the plugin API. Disabled entirely under `--bare` / `--no-hooks`.
   */
  hooks?: Partial<Record<HookEvent, ShellHook[]>>;
  plugins?: (string | PluginConfig)[] | undefined;
  log: LogConfig;
  features: FeaturesConfig;
  yolo?: boolean | undefined;
  /** When true, show lightweight LLM-predicted next steps after each turn (/next). */
  nextPrediction?: boolean | undefined;
  cwd?: string | undefined;
  /** Autonomy mode configuration (auto-proceed delay, etc.). */
  autonomy?: AutonomyConfig | undefined;
  /** Show rotating launch hints on startup. Default: true. Set to false to suppress. */
  hints?: boolean | undefined;
  /** Raw SSE stream debugging — hex-dump every byte received from providers to stderr. */
  debugStream?: boolean | undefined;
  /**
   * Where settings are persisted. 'global' → ~/.wrongstack/config.json
   * (default). 'project' → ~/.wrongstack/projects/<slug>/config.local.json.
   * When 'project', provider/model/autonomy/ux settings are saved per-project.
   */
  configScope?: 'global' | 'project' | undefined;
  /** Automatic codebase symbol-index maintenance (session-start + live updates). */
  indexing?: IndexingConfig | undefined;
  /** Saved launch preferences — restored on next boot for one-line confirmation. */
  launch?: LaunchConfig | undefined;

  /**
   * Session logging & audit configuration.
   * Controls what gets written to the persistent JSONL transcript.
   */
  session?: SessionLoggingConfig | undefined;
  /**
   * Cloud sync configuration. Stored separately in sync.json to avoid
   * accidentally committing the GitHub token to project configs.
   */
  sync?: SyncConfig | undefined;
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
  load(opts?: { cliFlags?: Partial<Config> | undefined; cwd?: string | undefined }): Promise<Config>;
  /** Load and decrypt the sync config from ~/.wrongstack/sync.json. */
  loadSyncConfig(): Promise<SyncConfig | null>;
  /** Persist sync config to ~/.wrongstack/sync.json with encrypted token. */
  persistSyncConfig(cfg: SyncConfig): Promise<void>;
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
