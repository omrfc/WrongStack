import * as fs from 'node:fs/promises';
import { decryptConfigSecrets } from '../security/config-secrets.js';
import {
  DEFAULT_CONTEXT_WINDOW_MODE_ID,
  isContextWindowModeId,
  listContextWindowModes,
} from '../types/context-window.js';
import type { Config, ConfigLoader } from '../types/config.js';
import type { SecretVault } from '../types/secret-vault.js';
import { safeParse } from '../utils/safe-json.js';
import type { WstackPaths } from '../utils/wstack-paths.js';
import { DEFAULT_TOOLS_CONFIG, DEFAULT_CONTEXT_CONFIG } from '../types/default-config.js';

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
  },
  log: { level: 'info' },
  features: {
    mcp: true,
    plugins: true,
    memory: true,
    modelsRegistry: true,
    skills: true,
  },
};

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
    c.log.level = v as Config['log']['level'];
  },
};

type PartialConfig = Partial<Config> & {
  providers?: Record<string, { apiKey?: string; baseUrl?: string; type?: string }>;
  /** Fields that came from environment variables — must not be persisted. */
  _envSource?: Set<string>;
};

function isPrimitiveArray(a: unknown[]): boolean {
  return a.every((v) => v === null || typeof v !== 'object');
}

const FORBIDDEN_PROTO_KEYS = new Set([
  '__proto__',
  'constructor',
  'prototype',
  '__defineGetter__',
  '__defineSetter__',
  '__lookupGetter__',
  '__lookupSetter__',
]);

function deepMerge<T>(base: T, patch: Partial<T>): T {
  if (typeof base !== 'object' || base === null) return (patch as T) ?? base;
  if (typeof patch !== 'object' || patch === null) return base;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    // Defense in depth — user config is parsed from JSON and merged
    // recursively; blocking these keys eliminates prototype-pollution
    // gadgets regardless of where else they might be touched.
    if (FORBIDDEN_PROTO_KEYS.has(k)) continue;
    const existing = out[k];
    // Primitive arrays (plugins, tools, etc.) are merged by concatenation.
    // Object arrays (MCP servers, etc.) are replaced wholesale.
    if (Array.isArray(v)) {
      if (Array.isArray(existing) && isPrimitiveArray(v) && isPrimitiveArray(existing)) {
        out[k] = [...new Set([...existing, ...v])];
      } else {
        out[k] = v;
        if (process.env.WRONGSTACK_DEBUG_CONFIG) {
          console.warn(
            `[config] Non-primitive array for "${k}" replaced (global + local config merge). ` +
              `Global entries: ${(existing as unknown[] | undefined)?.length ?? 0}, local entries: ${v.length}.`,
          );
        }
      }
    } else if (
      typeof v === 'object' &&
      v !== null &&
      typeof existing === 'object' &&
      existing !== null
    ) {
      out[k] = deepMerge(existing, v as Record<string, unknown>);
    } else if (v !== undefined) {
      out[k] = v;
    }
  }
  return out as T;
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
  priority?: number;
  /**
   * Read the raw config patch. Return an empty object if unavailable.
   * Errors are surfaced but do not abort loading — the source is skipped.
   */
  read(): Promise<Partial<Config>>;
}

export interface ConfigLoaderOptions {
  paths: WstackPaths;
  strict?: boolean;
  vault?: SecretVault;
  /** Extra sources merged after the built-in layers. */
  sources?: ConfigSource[];
}

export class DefaultConfigLoader implements ConfigLoader {
  private readonly paths: WstackPaths;
  private readonly strict: boolean;
  private readonly vault: SecretVault | undefined;
  private readonly extraSources: ConfigSource[];

  constructor(opts: ConfigLoaderOptions) {
    this.paths = opts.paths;
    this.strict = opts.strict ?? false;
    this.vault = opts.vault;
    this.extraSources = opts.sources ?? [];
  }

  async load(opts: { cliFlags?: Partial<Config>; cwd?: string } = {}): Promise<Config> {
    let cfg: PartialConfig = { ...BEHAVIOR_DEFAULTS } as PartialConfig;

    // Layer 2 & 3: global + project-local config — read in parallel
    const [global, local] = await Promise.all([
      this.readJson(this.paths.globalConfig),
      this.readJson(this.paths.projectLocalConfig),
    ]);
    cfg = deepMerge(cfg, global);
    cfg = deepMerge(cfg, local);

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
        console.warn(`Config source "${src.name}" failed`, err);
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
        const rawKeys = (pcfg as { apiKeys?: unknown }).apiKeys;
        if (!Array.isArray(rawKeys) || rawKeys.length === 0) continue;
        // Each apiKeys entry came from arbitrary JSON. Filter to entries
        // that actually have a string apiKey + label so a malformed array
        // (null entry, missing field) doesn't crash the .find / chosen.apiKey
        // path below.
        const keys = rawKeys.filter(
          (k): k is { label: string; apiKey: string } =>
            !!k &&
            typeof k === 'object' &&
            typeof (k as { label?: unknown }).label === 'string' &&
            typeof (k as { apiKey?: unknown }).apiKey === 'string',
        );
        if (keys.length === 0) continue;
        const existing = (pcfg as { apiKey?: string }).apiKey;
        if (existing && existing.length > 0) continue;
        const activeLabel = (pcfg as { activeKey?: string }).activeKey;
        const chosen = activeLabel
          ? (keys.find((k) => k.label === activeLabel) ?? keys[0])
          : keys[0];
        if (chosen?.apiKey) {
          (pcfg as { apiKey?: string }).apiKey = chosen.apiKey;
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

  private async readJson(file: string): Promise<PartialConfig> {
    let raw: string;
    try {
      raw = await fs.readFile(file, 'utf8');
    } catch (err) {
      // Missing file is the common case (per-project local config rarely
      // exists at start). Surface anything else (EACCES, EISDIR) so a
      // mis-permissioned config doesn't silently fall back to defaults.
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn(`[config] Failed to read "${file}":`, err);
      }
      return {};
    }
    const parsed = safeParse<PartialConfig>(raw);
    if (!parsed.ok || !parsed.value) {
      // The file exists but isn't valid JSON. Don't silently reset to
      // defaults — that's hours of debug timesink for users who'd typo'd
      // their config. Warn loudly and keep the in-memory defaults.
      console.warn(
        `[config] Failed to parse "${file}": invalid JSON. Falling back to defaults for this layer.`,
      );
      return {};
    }
    return parsed.value;
  }

  private validateBehavior(cfg: PartialConfig): void {
    if (cfg.version === undefined) throw new Error('Config: missing version field');
    if (cfg.version !== 1) throw new Error(`Config: unsupported version ${cfg.version}`);
    const c = cfg.context;
    if (!c) throw new Error('Config: missing context section');
    // A user-edited config.json can land strings here ("0.6") and slip past
    // truthiness checks; the `>=` comparison then coerces silently and the
    // threshold ordering check passes for nonsense values. Validate types
    // explicitly so misconfigs surface here, not as confusing failures deep
    // in the auto-compaction logic.
    const fields: Array<keyof typeof c> = ['warnThreshold', 'softThreshold', 'hardThreshold'];
    for (const f of fields) {
      const v = c[f];
      if (typeof v !== 'number' || !Number.isFinite(v)) {
        throw new Error(`Config: context.${String(f)} must be a finite number (got ${typeof v})`);
      }
    }
    if (c.warnThreshold >= c.softThreshold || c.softThreshold >= c.hardThreshold) {
      throw new Error('Config: context thresholds must satisfy warn < soft < hard');
    }
    if (c.mode !== undefined && !isContextWindowModeId(c.mode)) {
      const known = listContextWindowModes().map((m) => m.id).join(', ');
      throw new Error(`Config: context.mode must be one of: ${known}`);
    }
  }

  private validateIdentity(cfg: PartialConfig): void {
    if (!cfg.provider) {
      throw new Error(
        'Config: no provider configured. Run `wstack init` or set WRONGSTACK_PROVIDER.',
      );
    }
    if (!cfg.model) {
      throw new Error('Config: no model configured. Run `wstack init` or set WRONGSTACK_MODEL.');
    }
  }
}
