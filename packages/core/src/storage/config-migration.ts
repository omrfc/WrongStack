/**
 * L2-D: Config version migration framework. Pure functions, decoupled
 * from disk/CLI — caller passes a parsed JSON object and gets back the
 * up-to-date `Config` shape (or a structured error explaining why
 * migration failed).
 *
 * Migrations are registered as `{ from, to, migrate }` triples and run
 * sequentially. Each migration is independently testable. Adding a new
 * version means appending one migration; existing user configs are
 * upgraded in place at load time.
 */

export interface MigrationContext {
  /**
   * Original on-disk version of the input. Migrations may use this to
   * decide between in-place patches and rewrites.
   */
  fromVersion: number;
  /**
   * Set when the migration writes back to disk. Callers persist the
   * migrated config when this is true so the user doesn't see the same
   * migration banner on every boot.
   */
  shouldPersist: boolean;
}

export interface ConfigMigration {
  /** Version of the input this migration accepts. */
  from: number;
  /** Version of the output it produces. */
  to: number;
  /** Pure transform — no I/O. */
  migrate(input: Record<string, unknown>, ctx: MigrationContext): Record<string, unknown>;
  /** Optional human-readable description for migration logs / banners. */
  describe?: string;
}

export interface MigrationResult {
  /** Final config (still typed as `unknown`-keyed — caller validates). */
  config: Record<string, unknown>;
  /** Ordered list of `from→to` versions that ran. */
  applied: string[];
  /** True when at least one migration produced changes worth persisting. */
  shouldPersist: boolean;
}

export class ConfigMigrationError extends Error {
  readonly fromVersion: number;
  readonly targetVersion: number;
  readonly missingStep: number | null;

  constructor(opts: {
    message: string;
    fromVersion: number;
    targetVersion: number;
    missingStep: number | null;
  }) {
    super(opts.message);
    this.name = 'ConfigMigrationError';
    this.fromVersion = opts.fromVersion;
    this.targetVersion = opts.targetVersion;
    this.missingStep = opts.missingStep;
  }
}

/**
 * Run registered migrations until the input reaches `targetVersion`.
 *
 * Resolution rules:
 * 1. If `input.version === targetVersion`, no migrations run; `shouldPersist`
 *    is false.
 * 2. Otherwise walk the migration chain from `input.version` upward,
 *    picking the migration whose `from` matches the current version.
 * 3. Stop when `current.version === targetVersion`.
 * 4. If no migration matches at some point, throw `ConfigMigrationError`
 *    with the missing step recorded for diagnostics.
 *
 * Migrations may be downward (e.g. for staged rollouts), but `targetVersion`
 * must be reachable strictly via the registered chain — there's no implicit
 * "skip" or transitive resolution.
 */
export function runConfigMigrations(
  input: Record<string, unknown>,
  targetVersion: number,
  migrations: readonly ConfigMigration[],
): MigrationResult {
  const initial = typeof input['version'] === 'number' ? (input['version'] as number) : 1;
  let current: Record<string, unknown> = { ...input };
  let currentVersion = initial;
  const applied: string[] = [];
  let shouldPersist = false;

  let guard = 0;
  while (currentVersion !== targetVersion) {
    if (++guard > 100) {
      throw new ConfigMigrationError({
        message: `Config migration looped past 100 steps (from v${initial} toward v${targetVersion})`,
        fromVersion: initial,
        targetVersion,
        missingStep: currentVersion,
      });
    }
    const step = migrations.find((m) => m.from === currentVersion);
    if (!step) {
      throw new ConfigMigrationError({
        message: `No migration registered from config v${currentVersion} (target v${targetVersion}). Update the framework or revert the config file.`,
        fromVersion: initial,
        targetVersion,
        missingStep: currentVersion,
      });
    }
    const ctx: MigrationContext = { fromVersion: currentVersion, shouldPersist: false };
    const next = step.migrate(current, ctx);
    // Ensure the migration set the new version. Be tolerant: if it didn't,
    // patch it in so the chain doesn't infinite-loop on author oversight.
    if (typeof next['version'] !== 'number' || next['version'] !== step.to) {
      next['version'] = step.to;
    }
    current = next;
    currentVersion = step.to;
    applied.push(`v${step.from}→v${step.to}`);
    shouldPersist = shouldPersist || ctx.shouldPersist || step.from < step.to;
  }
  return { config: current, applied, shouldPersist };
}

/**
 * Default empty migration registry. Real migrations are appended as new
 * Config versions are introduced. Example (when v2 lands):
 *
 *   export const CONFIG_MIGRATIONS: readonly ConfigMigration[] = [
 *     {
 *       from: 1, to: 2, describe: 'rename `apiKey` → `auth.apiKey`',
 *       migrate(cfg) {
 *         const apiKey = cfg.apiKey;
 *         delete cfg.apiKey;
 *         return { ...cfg, auth: { ...(cfg.auth ?? {}), apiKey } };
 *       },
 *     },
 *   ];
 */
export const DEFAULT_CONFIG_MIGRATIONS: readonly ConfigMigration[] = [];
