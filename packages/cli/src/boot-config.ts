import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  type Config,
  DefaultConfigLoader,
  DefaultPathResolver,
  DefaultSecretVault,
  type WstackPaths,
  migratePlaintextSecrets,
  resolveWstackPaths,
} from '@wrongstack/core';

export interface BootPaths {
  cwd: string;
  projectRoot: string;
  userHome: string;
  wpaths: WstackPaths;
  pathResolver: DefaultPathResolver;
}

export interface BootConfigResult {
  paths: BootPaths;
  config: Config;
  vault: DefaultSecretVault;
}

/**
 * Resolve paths and load config. This covers:
 *   - cwd/project resolution
 *   - wstack paths
 *   - secret vault creation + plaintext migration
 *   - config loading with CLI flag overrides
 */
export async function bootConfig(
  flags: Record<string, string | boolean>,
): Promise<BootConfigResult> {
  const cwd = typeof flags['cwd'] === 'string' ? path.resolve(flags['cwd']) : process.cwd();
  const pathResolver = new DefaultPathResolver(cwd);
  const projectRoot = pathResolver.projectRoot;
  const userHome = os.homedir();
  const wpaths = resolveWstackPaths({ projectRoot, userHome });
  await ensureProjectMeta(wpaths, projectRoot);

  // Vault must come first so the config loader can decrypt apiKey-like
  // fields. It lazily creates ~/.wrongstack/.key on first encrypt/decrypt.
  const vault = new DefaultSecretVault({ keyFile: wpaths.secretsKey });

  // Auto-encrypt any plaintext secrets users still have in their config
  // files (left over from before the vault existed, or hand-written).
  // Silent no-op for already-encrypted configs.
  for (const file of [wpaths.globalConfig, wpaths.projectLocalConfig]) {
    try {
      const { migrated } = await migratePlaintextSecrets(file, vault);
      if (migrated > 0) {
        process.stderr.write(`[wstack] Encrypted ${migrated} plaintext secret(s) in ${file}\n`);
      }
    } catch {
      // best-effort — never block boot on migration issues
    }
  }

  const configLoader = new DefaultConfigLoader({ paths: wpaths, vault });
  const config = await configLoader.load({ cliFlags: flagsToConfigPatch(flags) });

  // Load and decrypt sync config from ~/.wrongstack/sync.json and merge it
  // into the main config so ConfigStore starts with the correct sync state.
  const syncConfig = await configLoader.loadSyncConfig();
  if (syncConfig) {
    (config as unknown as Record<string, unknown>).sync = syncConfig;
  }

  return {
    paths: { cwd, projectRoot, userHome, wpaths, pathResolver },
    config,
    vault,
  };
}

function flagsToConfigPatch(flags: Record<string, string | boolean>): Partial<Config> {
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

async function ensureProjectMeta(paths: WstackPaths, projectRoot: string): Promise<void> {
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
