import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { DefaultLogger } from './infrastructure/logger.js';
import { DefaultPathResolver } from './infrastructure/path-resolver.js';
import { DefaultSecretVault, migratePlaintextSecrets } from './security/secret-vault.js';
import { DefaultConfigLoader } from './storage/config-loader.js';
import type { Config } from './types/config.js';
import { writeErr } from './utils/term.js';
import { type WstackPaths, resolveWstackPaths } from './utils/wstack-paths.js';

/**
 * Options for {@link bootConfig}. Both the CLI and the WebUI server boot the
 * same way; the only intentional differences are the label used in the
 * plaintext-secret migration notice and whether CLI flags are supplied.
 */
export interface BootConfigOptions {
  /**
   * Parsed CLI flags. `cwd` relocates path resolution; `provider`/`model`/
   * `log-level`/`verbose`/`trace`/`yolo`/`no-features` are patched into the
   * loaded config (see {@link flagsToConfigPatch}). Defaults to `{}` (the
   * WebUI server passes no flags).
   */
  flags?: Record<string, string | boolean>;
  /**
   * Label shown in the `[<label>] Encrypted N plaintext secret(s) in FILE`
   * stderr notice emitted when legacy plaintext secrets get auto-encrypted.
   * The CLI passes `wstack`; the WebUI server passes `WebUI`. Default
   * `wstack`.
   */
  appLabel?: string;
  /**
   * Load `~/.wrongstack/sync.json` and merge it into `config.sync` so the
   * ConfigStore starts with the correct CloudSync state. Default `true`.
   */
  loadSyncConfig?: boolean;
}

/**
 * Everything the boot phase resolves before DI-container wiring. Superset of
 * what the CLI and WebUI server each consumed previously, so both can pick the
 * fields they need from a single canonical result.
 */
export interface BootConfigResult {
  cwd: string;
  projectRoot: string;
  userHome: string;
  wpaths: WstackPaths;
  pathResolver: DefaultPathResolver;
  config: Config;
  vault: DefaultSecretVault;
  logger: DefaultLogger;
  /** Convenience alias for `wpaths.globalConfig`. */
  globalConfigPath: string;
}

/**
 * Canonical boot routine shared by `@wrongstack/cli` and `@wrongstack/webui`.
 * Resolves paths, creates the real AES-GCM secret vault, migrates any
 * plaintext secrets, loads + merges config (with CLI-flag overrides and an
 * optional sync overlay), and builds a logger.
 *
 * The per-package `bootConfig()` wrappers re-shape this result into their own
 * legacy return types for backward compatibility — keep this the single source
 * of boot behavior so the two consumers can't drift.
 */
export async function bootConfig(options: BootConfigOptions = {}): Promise<BootConfigResult> {
  const { flags = {}, appLabel = 'wstack', loadSyncConfig = true } = options;

  const cwd = typeof flags['cwd'] === 'string' ? path.resolve(flags['cwd']) : process.cwd();
  const pathResolver = new DefaultPathResolver(cwd);
  const projectRoot = pathResolver.projectRoot;
  const userHome = os.homedir();
  const wpaths = resolveWstackPaths({ projectRoot, userHome });

  // Ensure the directories every consumer relies on exist. This is the union
  // of what the cli and webui boot paths created independently — creating all
  // three eagerly is harmless and removes the "new wpath added to one copy
  // only" drift hazard.
  await fs.mkdir(wpaths.globalRoot, { recursive: true });
  await fs.mkdir(wpaths.projectDir, { recursive: true });
  await fs.mkdir(wpaths.projectSessions, { recursive: true });
  await writeProjectMeta(wpaths, projectRoot);

  // Vault must come first so the config loader can decrypt apiKey-like fields.
  // It lazily creates ~/.wrongstack/.key on first encrypt/decrypt.
  const vault = new DefaultSecretVault({ keyFile: wpaths.secretsKey });

  // Auto-encrypt any plaintext secrets still sitting in config files (left
  // over from before the vault existed, or hand-written). Silent no-op for
  // already-encrypted configs; never blocks boot on migration issues.
  for (const file of [wpaths.globalConfig, wpaths.projectLocalConfig]) {
    try {
      const { migrated } = await migratePlaintextSecrets(file, vault);
      if (migrated > 0) {
        writeErr(`[${appLabel}] Encrypted ${migrated} plaintext secret(s) in ${file}\n`);
      }
    } catch {
      // best-effort — never block boot on migration issues
    }
  }

  const configLoader = new DefaultConfigLoader({ paths: wpaths, vault });
  let config = await configLoader.load({ cliFlags: flagsToConfigPatch(flags) });

  // Load and decrypt sync config from ~/.wrongstack/sync.json and merge it into
  // the main config so ConfigStore starts with the correct sync state.
  // `load()` returns a frozen Config, so rebuild a new frozen object rather
  // than mutating in place (a direct assignment throws "Cannot add property
  // sync, object is not extensible" once sync.json exists).
  if (loadSyncConfig) {
    const syncConfig = await configLoader.loadSyncConfig();
    if (syncConfig) {
      config = Object.freeze({ ...config, sync: syncConfig }) as Config;
    }
  }

  const logger = new DefaultLogger({ level: config.log?.level ?? 'info', file: wpaths.logFile });

  return {
    cwd,
    projectRoot,
    userHome,
    wpaths,
    pathResolver,
    config,
    vault,
    logger,
    globalConfigPath: wpaths.globalConfig,
  };
}

/**
 * Translate parsed CLI flags into a partial Config patch applied on top of the
 * file-loaded config. Explicit `--log-level` wins over `--verbose`/`--trace`.
 */
export function flagsToConfigPatch(flags: Record<string, string | boolean>): Partial<Config> {
  const patch: Partial<Config> = {};
  if (typeof flags['provider'] === 'string') patch.provider = flags['provider'];
  if (typeof flags['model'] === 'string') patch.model = flags['model'];
  if (typeof flags['cwd'] === 'string') patch.cwd = flags['cwd'];
  if (typeof flags['log-level'] === 'string') {
    patch.log = { level: flags['log-level'] as Config['log']['level'] };
  } else if (flags['verbose']) {
    patch.log = { level: 'debug' };
  } else if (flags['trace']) {
    patch.log = { level: 'trace' };
  }
  if (flags['yolo']) patch.yolo = true;
  if (flags['no-features']) {
    patch.features = {
      mcp: false,
      plugins: false,
      memory: false,
      modelsRegistry: false,
      skills: false,
    };
  }
  return patch;
}

async function writeProjectMeta(paths: WstackPaths, projectRoot: string): Promise<void> {
  try {
    await fs.mkdir(paths.projectDir, { recursive: true });
    const meta = {
      hash: paths.projectHash,
      root: projectRoot,
      lastSeen: new Date().toISOString(),
    };
    await fs.writeFile(paths.projectMeta, JSON.stringify(meta, null, 2));
  } catch {
    // best-effort
  }
}
