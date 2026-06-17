import * as fs from 'node:fs/promises';
import { decryptConfigSecrets } from '../security/secret-vault.js';
import { atomicWrite } from '../utils/atomic-write.js';
import { toErrorMessage } from '../utils/error.js';
import {
  DEFAULT_CONTEXT_WINDOW_MODE_ID,
  isContextWindowModeId,
  listContextWindowModes,
} from '../types/context-window.js';
import type { Config, ConfigLoader, SyncConfig } from '../types/config.js';
import type { SecretVault } from '../types/secret-vault.js';
import { ConfigError, ERROR_CODES } from '../types/errors.js';
import { safeParse } from '../utils/safe-json.js';
import { deepMerge as deepMergeCore, type DeepMergeOptions } from '../utils/deep-merge.js';
import type { WstackPaths } from '../utils/wstack-paths.js';
import {
  DEFAULT_TOOLS_CONFIG,
  DEFAULT_CONTEXT_CONFIG,
  DEFAULT_SESSION_LOGGING_CONFIG,
} from '../types/default-config.js';
import type { EventBus } from '../kernel/events.js';

/**
 * Surface the OS error code (EACCES, ENOSPC, …) alongside the message in
 * storage.* event payloads. Codes are stable and locale-independent, so
 * they are what dashboards and alerts key on; the message is supplementary.
 */
function storageErrorString(err: unknown): string {
  if (err instanceof Error) {
    const code = (err as NodeJS.ErrnoException).code;
    return code ? `${code}: ${err.message}` : err.message;
  }
  /* v8 ignore next -- defensive: callers only pass fs Error instances */
  return String(err);
}

/**
 * Defaults express *behavior*, not identity. Provider and model are NOT
 * hardcoded — they must be resolved at runtime from config + env + the
 * ModelsRegistry. A bare Config returned by this loader will throw when
 * the agent tries to construct a provider, with a message that points
 * users at `wstack init`.
 */
const BEHAVIOR_DEFAULTS: Omit<Config, 'provider' | 'model'> = {
  version: 1,
  context: {
    mode: DEFAULT_CONTEXT_WINDOW_MODE_ID,
    warnThreshold: 0.6,
    softThreshold: 0.75,
    hardThreshold: 0.9,
    autoCompact: true,
    preserveK: DEFAULT_CONTEXT_CONFIG.preserveK,
    eliseThreshold: DEFAULT_CONTEXT_CONFIG.eliseThreshold,
  },
  tools: {
    defaultExecutionStrategy: DEFAULT_TOOLS_CONFIG.defaultExecutionStrategy,
    maxIterations: DEFAULT_TOOLS_CONFIG.maxIterations,
    iterationTimeoutMs: DEFAULT_TOOLS_CONFIG.iterationTimeoutMs,
    sessionTimeoutMs: DEFAULT_TOOLS_CONFIG.sessionTimeoutMs,
    perIterationOutputCapBytes: DEFAULT_TOOLS_CONFIG.perIterationOutputCapBytes,
    autoExtendLimit: DEFAULT_TOOLS_CONFIG.autoExtendLimit,
    restrictToProjectRoot: DEFAULT_TOOLS_CONFIG.restrictToProjectRoot,
  },
  log: { level: 'info' },
  features: {
    mcp: true,
    plugins: true,
    memory: true,
    modelsRegistry: true,
    skills: true,
  },
  indexing: {
    onSessionStart: true,
    onEdit: true,
    watchExternal: true,
    debounceMs: 400,
  },
  session: { ...DEFAULT_SESSION_LOGGING_CONFIG },
};

/** Parse a boolean-ish env var: "0"/"false"/"no"/"off" → false, anything else → true. */
function envBool(v: string): boolean {
  return !/^(0|false|no|off)$/i.test(v.trim());
}

function envBoolOptional(v: string | undefined): boolean {
  return v !== undefined && envBool(v);
}

const LOG_LEVELS = new Set<Config['log']['level']>(['error', 'warn', 'info', 'debug', 'trace']);

function envLogLevel(v: string): Config['log']['level'] {
  return LOG_LEVELS.has(v as Config['log']['level']) ? (v as Config['log']['level']) : 'info';
}

const ENV_MAP: Record<string, (cfg: PartialConfig, val: string) => void> = {
  WRONGSTACK_PROVIDER: (c, v) => {
    c.provider = v;
    if (c._envSource === undefined) c._envSource = new Set();
    c._envSource.add('provider');
  },
  WRONGSTACK_MODEL: (c, v) => {
    c.model = v;
    if (c._envSource === undefined) c._envSource = new Set();
    c._envSource.add('model');
  },
  WRONGSTACK_API_KEY: (c, v) => {
    c.apiKey = v;
    if (c._envSource === undefined) c._envSource = new Set();
    c._envSource.add('apiKey');
  },
  WRONGSTACK_BASE_URL: (c, v) => {
    c.baseUrl = v;
    if (c._envSource === undefined) c._envSource = new Set();
    c._envSource.add('baseUrl');
  },
  WRONGSTACK_LOG_LEVEL: (c, v) => {
    if (!c.log) c.log = { level: 'info' };
    c.log.level = envLogLevel(v);
  },
  WRONGSTACK_INDEX_ON_START: (c, v) => {
    c.indexing = { ...defaultIndexing, ...c.indexing, onSessionStart: envBool(v) };
  },
  WRONGSTACK_INDEX_ON_EDIT: (c, v) => {
    c.indexing = { ...defaultIndexing, ...c.indexing, onEdit: envBool(v) };
  },
  WRONGSTACK_INDEX_WATCH: (c, v) => {
    c.indexing = { ...defaultIndexing, ...c.indexing, watchExternal: envBool(v) };
  },
};

const defaultIndexing = {
  onSessionStart: true,
  onEdit: true,
  watchExternal: true,
  debounceMs: 400,
} as const;

type PartialConfig = Partial<Config> & {
  providers?: Record<
    string,
    { apiKey?: string | undefined; baseUrl?: string | undefined; type?: string | undefined }
  >;
  /** Fields that came from environment variables — must not be persisted. */
  _envSource?: Set<string> | undefined;
};

/**
 * Config-layer deep merge — delegates to the shared utility with
 * `arrayMode: 'concat-primitives'` and optional debug logging for
 * non-primitive array replacements.
 */
function deepMerge<T>(base: T, patch: Partial<T>): T {
  const opts: DeepMergeOptions = { arrayMode: 'concat-primitives' };
  if (envBoolOptional(process.env.WRONGSTACK_DEBUG_CONFIG)) {
    opts.onNonPrimitiveArrayReplace = (key, existingLen, patchLen) => {
      console.warn(
        `[config] Non-primitive array for "${key}" replaced (global + local config merge). ` +
          `Global entries: ${existingLen}, local entries: ${patchLen}.`,
      );
    };
  }
  return deepMergeCore(base as Record<string, unknown>, patch as Record<string, unknown>, opts) as T;
}

/**
 * A single config source. Higher priority wins in merges.
 * Sources are applied in priority order (lowest first), so a source
 * with priority=10 overrides one with priority=1.
 */
export interface ConfigSource {
  /** Unique name for debugging and error messages. */
  name: string;
  /** Lower numbers merge first, higher numbers override lower. Default: 50. */
  priority?: number | undefined;
  /**
   * Read the raw config patch. Return an empty object if unavailable.
   * Errors are surfaced but do not abort loading — the source is skipped.
   */
  read(): Promise<Partial<Config>>;
}

export interface ConfigLoaderOptions {
  paths: WstackPaths;
  strict?: boolean | undefined;
  vault?: SecretVault | undefined;
  /** Extra sources merged after the built-in layers. */
  sources?: ConfigSource[] | undefined;
  events?: EventBus;
  traceId?: string;
}

export class DefaultConfigLoader implements ConfigLoader {
  private readonly paths: WstackPaths;
  private readonly strict: boolean;
  private readonly vault: SecretVault | undefined;
  private readonly extraSources: ConfigSource[];
  private readonly events: EventBus | undefined;
  private readonly traceId: string | undefined;

  constructor(opts: ConfigLoaderOptions) {
    this.paths = opts.paths;
    this.strict = opts.strict ?? false;
    this.vault = opts.vault;
    this.extraSources = opts.sources ?? [];
    this.events = opts.events;
    this.traceId = opts.traceId;
  }

  async load(
    opts: { cliFlags?: Partial<Config> | undefined; cwd?: string | undefined } = {},
  ): Promise<Config> {
    let cfg: PartialConfig = { ...BEHAVIOR_DEFAULTS } as PartialConfig;

    // Layer 2, 3 & 3b: global + project-local + in-project config — read in parallel.
    // inProjectConfig (<project>/.wrongstack/config.json) merges AFTER
    // projectLocalConfig so it takes priority (user-intended > auto-cached).
    const [global, local, inProject] = await Promise.all([
      this.readJson(this.paths.globalConfig),
      this.readJson(this.paths.projectLocalConfig),
      this.readJson(this.paths.inProjectConfig),
    ]);
    cfg = deepMerge(cfg, global);
    cfg = deepMerge(cfg, local);
    cfg = deepMerge(cfg, inProject);

    // Layer 4: env vars
    for (const [key, fn] of Object.entries(ENV_MAP)) {
      const v = process.env[key];
      if (v) fn(cfg, v);
    }

    // Layer 5: extra sources — sorted by priority (lowest first).
    // When priorities tie, sort by name for deterministic order.
    const sorted = [...this.extraSources].sort((a, b) => {
      const pd = (a.priority ?? 50) - (b.priority ?? 50);
      if (pd !== 0) return pd;
      return a.name.localeCompare(b.name);
    });
    for (const src of sorted) {
      try {
        const patch = await src.read();
        if (patch && Object.keys(patch).length > 0) {
          cfg = deepMerge(cfg, patch);
        }
      } catch (err) {
        // Best-effort: skip failing sources so one bad source doesn't block boot.
        console.warn(JSON.stringify({
          level: 'warn',
          event: 'config.source_load_failed',
          source: src.name,
          message: toErrorMessage(err),
          timestamp: new Date().toISOString(),
        }));
      }
    }

    // Layer 6: CLI flags
    if (opts.cliFlags) {
      cfg = deepMerge(cfg, opts.cliFlags);
    }

    // Decrypt apiKey-like fields if a vault is configured.
    if (this.vault) {
      cfg = decryptConfigSecrets(cfg, this.vault);
    }

    // Multi-key resolution: when a provider has `apiKeys[]` configured,
    // mirror the active entry into `apiKey` so downstream construction
    // code (provider registry, wire adapters) needs no changes. Honors
    // `activeKey` (by label), else falls back to the first entry. A
    // pre-existing `apiKey` set by env/CLI flags wins so an explicit
    // override still beats the saved list.
    if (cfg.providers) {
      for (const pcfg of Object.values(cfg.providers)) {
        if (!pcfg || typeof pcfg !== 'object') continue;
        const rawKeys = (pcfg as { apiKeys?: unknown | undefined }).apiKeys;
        if (!Array.isArray(rawKeys) || rawKeys.length === 0) continue;
        // Each apiKeys entry came from arbitrary JSON. Filter to entries
        // that actually have a string apiKey + label so a malformed array
        // (null entry, missing field) doesn't crash the .find / chosen.apiKey
        // path below.
        const keys = rawKeys.filter(
          (k): k is { label: string; apiKey: string } =>
            !!k &&
            typeof k === 'object' &&
            typeof (k as { label?: unknown | undefined }).label === 'string' &&
            typeof (k as { apiKey?: unknown | undefined }).apiKey === 'string',
        );
        if (keys.length === 0) continue;
        const existing = (pcfg as { apiKey?: string | undefined }).apiKey;
        if (existing && existing.length > 0) continue;
        const activeLabel = (pcfg as { activeKey?: string | undefined }).activeKey;
        const chosen = activeLabel
          ? (keys.find((k) => k.label === activeLabel) ?? keys[0])
          : keys[0];
        if (chosen?.apiKey) {
          (pcfg as { apiKey?: string | undefined }).apiKey = chosen.apiKey;
        }
      }
    }

    this.validateBehavior(cfg);
    if (this.strict) {
      this.validateIdentity(cfg);
    }
    // In strict mode, validateIdentity has confirmed provider/model are set;
    // it's safe to assert the full Config contract. In non-strict mode the
    // caller (e.g. early-boot wizard) accepts a Partial and constructs the
    // provider later, so we deliberately return without the cast.
    return Object.freeze(cfg) as Config;
  }

  /**
   * Persist a sync config to ~/.wrongstack/sync.json, with the token encrypted
   * by the vault (if provided). The file is isolated from the main config
   * hierarchy to prevent accidental commits.
   */
  async persistSyncConfig(cfg: SyncConfig): Promise<void> {
    let toWrite = { ...cfg };
    if (this.vault && toWrite.githubToken && !toWrite.githubToken.startsWith('enc:')) {
      // Re-encrypt if plaintext (e.g. came from in-memory configStore update
      // rather than direct /sync enable call). Idempotent for already-encrypted.
      toWrite = { ...toWrite, githubToken: this.vault.encrypt(toWrite.githubToken) };
    }
    const fp = this.paths.syncConfig;
    const t0 = Date.now();
    try {
      await atomicWrite(fp, JSON.stringify(toWrite, null, 2), { mode: 0o600 });
      this.events?.emit('storage.write', {
        sessionId: '~config~',
        store: 'config',
        filePath: fp,
        operation: 'persist_sync',
        outcome: 'success',
        durationMs: Date.now() - t0,
        ...(this.traceId !== undefined ? { traceId: this.traceId } : {}),
      });
    } catch (err) {
      this.events?.emit('storage.error', {
        sessionId: '~config~',
        store: 'config',
        filePath: fp,
        operation: 'persist_sync',
        outcome: 'failure',
        error: storageErrorString(err),
        recoverable: false,
        durationMs: Date.now() - t0,
        ...(this.traceId !== undefined ? { traceId: this.traceId } : {}),
      });
      throw err;
    }
  }

  /**
   * Read ~/.wrongstack/sync.json (encrypted GitHub token storage) and decrypt
   * the token if a vault is available. Returns null if the file doesn't exist.
   * This is separate from main config loading because sync.json is intentionally
   * isolated — it should never be part of project-local or env-driven config.
   */
  async loadSyncConfig(): Promise<SyncConfig | null> {
    const fp = this.paths.syncConfig;
    const t0 = Date.now();
    try {
      const raw = await fs.readFile(fp, 'utf8');
      const parsed = safeParse<SyncConfig>(raw);
      if (!parsed.ok || !parsed.value) {
        this.events?.emit('storage.read', {
          sessionId: '~config~',
          store: 'config',
          filePath: fp,
          operation: 'load_sync',
          outcome: 'failure',
          durationMs: Date.now() - t0,
          error: 'parse error or empty file',
          ...(this.traceId !== undefined ? { traceId: this.traceId } : {}),
        });
        return null;
      }

      // Decrypt the token if vault is available (field name matches secret pattern)
      if (this.vault) {
        const decrypted = decryptConfigSecrets({ sync: parsed.value } as PartialConfig, this.vault);
        const result = (decrypted as { sync: SyncConfig }).sync ?? null;
        this.events?.emit('storage.read', {
          sessionId: '~config~',
          store: 'config',
          filePath: fp,
          operation: 'load_sync',
          outcome: 'success',
          durationMs: Date.now() - t0,
          ...(this.traceId !== undefined ? { traceId: this.traceId } : {}),
        });
        return result;
      }
      this.events?.emit('storage.read', {
        sessionId: '~config~',
        store: 'config',
        filePath: fp,
        operation: 'load_sync',
        outcome: 'success',
        durationMs: Date.now() - t0,
        ...(this.traceId !== undefined ? { traceId: this.traceId } : {}),
      });
      return parsed.value;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      // Non-ENOENT failures (EACCES, ENOSPC, etc.) — emit storage.read failure, then return null
      this.events?.emit('storage.read', {
        sessionId: '~config~',
        store: 'config',
        filePath: fp,
        operation: 'load_sync',
        outcome: 'failure',
        durationMs: Date.now() - t0,
        error: storageErrorString(err),
        ...(this.traceId !== undefined ? { traceId: this.traceId } : {}),
      });
      console.warn(JSON.stringify({
        level: 'warn',
        event: 'config.sync_load_failed',
        message: toErrorMessage(err),
        timestamp: new Date().toISOString(),
      }));
      return null;
    }
  }

  private async readJson(file: string): Promise<PartialConfig> {
    let raw: string;
    const t0 = Date.now();
    try {
      raw = await fs.readFile(file, 'utf8');
    } catch (err) {
      // Missing file is the common case (per-project local config rarely
      // exists at start). Surface anything else (EACCES, EISDIR) so a
      // mis-permissioned config doesn't silently fall back to defaults.
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.events?.emit('storage.read', {
          sessionId: '~config~',
          store: 'config',
          filePath: file,
          operation: 'read_json',
          outcome: 'failure',
          durationMs: Date.now() - t0,
          error: storageErrorString(err),
          ...(this.traceId !== undefined ? { traceId: this.traceId } : {}),
        });
        console.warn(JSON.stringify({
          level: 'warn',
          event: 'config.read_failed',
          path: file,
          message: toErrorMessage(err),
          timestamp: new Date().toISOString(),
        }));
      }
      return {};
    }
    const parsed = safeParse<PartialConfig>(raw);
    if (!parsed.ok || !parsed.value) {
      // The file exists but isn't valid JSON. Don't silently reset to
      // defaults — that's hours of debug timesink for users who'd typo'd
      // their config. Warn loudly and keep the in-memory defaults.
      this.events?.emit('storage.read', {
        sessionId: '~config~',
        store: 'config',
        filePath: file,
        operation: 'read_json',
        outcome: 'failure',
        durationMs: Date.now() - t0,
        error: 'parse error or empty file',
        ...(this.traceId !== undefined ? { traceId: this.traceId } : {}),
      });
      console.warn(JSON.stringify({
        level: 'warn',
        event: 'config.parse_failed',
        path: file,
        message: 'invalid JSON — falling back to defaults for this layer',
        timestamp: new Date().toISOString(),
      }));
      return {};
    }
    return parsed.value;
  }

  private validateBehavior(cfg: PartialConfig): void {
    if (cfg.version === undefined) throw new ConfigError({
      message: 'Config: missing version field',
      code: ERROR_CODES.CONFIG_INVALID,
      context: { field: 'version' },
    });
    if (cfg.version !== 1) throw new ConfigError({
      message: `Config: unsupported version ${cfg.version}`,
      code: ERROR_CODES.CONFIG_INVALID,
      context: { field: 'version', actual: cfg.version },
    });
    const c = cfg.context;
    if (!c) throw new ConfigError({
      message: 'Config: missing context section',
      code: ERROR_CODES.CONFIG_INVALID,
      context: { field: 'context' },
    });
    // A user-edited config.json can land strings here ("0.6") and slip past
    // truthiness checks; the `>=` comparison then coerces silently and the
    // threshold ordering check passes for nonsense values. Validate types
    // explicitly so misconfigs surface here, not as confusing failures deep
    // in the auto-compaction logic.
    const fields: Array<keyof typeof c> = ['warnThreshold', 'softThreshold', 'hardThreshold'];
    for (const f of fields) {
      const v = c[f];
      if (typeof v !== 'number' || !Number.isFinite(v)) {
        throw new ConfigError({
          message: `Config: context.${String(f)} must be a finite number (got ${typeof v})`,
          code: ERROR_CODES.CONFIG_INVALID,
          context: { field: `context.${String(f)}`, actualType: typeof v },
        });
      }
    }
    if (c.warnThreshold >= c.softThreshold || c.softThreshold >= c.hardThreshold) {
      throw new ConfigError({
        message: 'Config: context thresholds must satisfy warn < soft < hard',
        code: ERROR_CODES.CONFIG_INVALID,
        context: { warn: c.warnThreshold, soft: c.softThreshold, hard: c.hardThreshold },
      });
    }
    if (c.mode !== undefined && !isContextWindowModeId(c.mode)) {
      // An unknown mode (typo or value from an older/renamed scheme) should not
      // brick the CLI — unlike the numeric thresholds above there is a safe
      // default. Warn and fall back rather than throwing.
      const known = listContextWindowModes()
        .map((m) => m.id)
        .join(', ');
      console.warn(
        `[config] Ignoring unknown context.mode "${c.mode}" (expected one of: ${known}); ` +
          `falling back to "${DEFAULT_CONTEXT_WINDOW_MODE_ID}".`,
      );
      c.mode = DEFAULT_CONTEXT_WINDOW_MODE_ID;
    }
  }

  private validateIdentity(cfg: PartialConfig): void {
    if (!cfg.provider) {
      throw new ConfigError({
        message: 'Config: no provider configured. Run `wstack init` or set WRONGSTACK_PROVIDER.',
        code: ERROR_CODES.CONFIG_INVALID,
        context: { field: 'provider' },
      });
    }
    if (!cfg.model) {
      throw new ConfigError({
        message: 'Config: no model configured. Run `wstack init` or set WRONGSTACK_MODEL.',
        code: ERROR_CODES.CONFIG_INVALID,
        context: { field: 'model' },
      });
    }
  }
}
