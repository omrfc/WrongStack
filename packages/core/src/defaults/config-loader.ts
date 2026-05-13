import * as fs from 'node:fs/promises';
import type { Config, ConfigLoader } from '../types/config.js';
import type { SecretVault } from '../types/secret-vault.js';
import { safeParse } from '../utils/safe-json.js';
import type { WstackPaths } from '../utils/wstack-paths.js';
import { decryptConfigSecrets } from './secret-vault.js';

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
    warnThreshold: 0.6,
    softThreshold: 0.75,
    hardThreshold: 0.9,
    preserveK: 10,
    eliseThreshold: 2000,
  },
  tools: {
    defaultExecutionStrategy: 'smart',
    maxIterations: 100,
    iterationTimeoutMs: 300_000,
    sessionTimeoutMs: 1_800_000,
    perIterationOutputCapBytes: 100_000,
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
  },
  WRONGSTACK_MODEL: (c, v) => {
    c.model = v;
  },
  WRONGSTACK_API_KEY: (c, v) => {
    c.apiKey = v;
  },
  WRONGSTACK_BASE_URL: (c, v) => {
    c.baseUrl = v;
  },
  WRONGSTACK_LOG_LEVEL: (c, v) => {
    if (!c.log) c.log = { level: 'info' };
    c.log.level = v as Config['log']['level'];
  },
};

type PartialConfig = Partial<Config> & { providers?: Record<string, { apiKey?: string; baseUrl?: string; type?: string }> };

function deepMerge<T>(base: T, patch: Partial<T>): T {
  if (typeof base !== 'object' || base === null) return (patch as T) ?? base;
  if (typeof patch !== 'object' || patch === null) return base;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    const existing = out[k];
    // Array replace: deepMerge replaces arrays entirely rather than merging.
    // This is intentional — config arrays (e.g. tools, plugins) are not merged
    // but replaced wholesale by later layers.
    if (Array.isArray(v)) {
      out[k] = v;
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

    this.validateBehavior(cfg);
    if (this.strict) this.validateIdentity(cfg);
    return Object.freeze(cfg) as Config;
  }

  private async readJson(file: string): Promise<PartialConfig> {
    try {
      const raw = await fs.readFile(file, 'utf8');
      const parsed = safeParse<PartialConfig>(raw);
      if (parsed.ok && parsed.value) return parsed.value;
    } catch {
      // missing or unreadable; skip
    }
    return {};
  }

  private validateBehavior(cfg: PartialConfig): void {
    if (cfg.version !== 1) throw new Error(`Config: unsupported version ${cfg.version}`);
    const c = cfg.context;
    if (!c) throw new Error('Config: missing context section');
    if (c.warnThreshold >= c.softThreshold || c.softThreshold >= c.hardThreshold) {
      throw new Error('Config: context thresholds must satisfy warn < soft < hard');
    }
  }

  private validateIdentity(cfg: PartialConfig): void {
    if (!cfg.provider) {
      throw new Error(
        'Config: no provider configured. Run `wstack init` or set WRONGSTACK_PROVIDER.',
      );
    }
    if (!cfg.model) {
      throw new Error(
        'Config: no model configured. Run `wstack init` or set WRONGSTACK_MODEL.',
      );
    }
  }
}
