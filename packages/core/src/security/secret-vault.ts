import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import type { Logger } from '../types/logger.js';
import type { RotatableSecretVault, SecretVault } from '../types/secret-vault.js';
import { ConfigError, ERROR_CODES } from '../types/errors.js';
import {
  ENCRYPTED_PREFIX_PATTERN,
  encryptedPrefixForVersion,
} from '../types/secret-vault.js';
import { atomicWrite } from '../utils/atomic-write.js';

export interface SecretVaultOptions {
  /** Absolute path to the key file. Created with mode 0o600 if missing. */
  keyFile: string;
}

const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const ALGO = 'aes-256-gcm';
// Desired file mode for the key file on POSIX systems.
const KEY_FILE_MODE = 0o600;

/**
 * Key file format v2+: 4-byte magic + 1-byte version + 32-byte key = 37 bytes.
 * The magic header distinguishes versioned key files from legacy 32-byte raw keys.
 */
const KEY_FILE_MAGIC = Buffer.from('WSKV', 'ascii');
const VERSIONED_KEY_FILE_SIZE = KEY_FILE_MAGIC.length + 1 + KEY_BYTES; // 37 bytes

/**
 * Check and warn if the key file has incorrect permissions on POSIX.
 * On Windows this is a no-op (mode bits don't apply).
 */
function checkKeyFilePermissions(keyFile: string): void {
  if (process.platform === 'win32') return; // No mode bits on Windows
  try {
    const stat = fs.statSync(keyFile);
    const actualMode = stat.mode & 0o777;
    if (actualMode !== KEY_FILE_MODE) {
      console.warn(JSON.stringify({
        level: 'warn',
        event: 'vault.key_file_wrong_permissions',
        message: `Key file ${keyFile} has mode ${actualMode.toString(8)} — expected ${KEY_FILE_MODE.toString(8)}. Run: chmod ${KEY_FILE_MODE.toString(8)} ${keyFile}`,
        keyFile,
        expectedMode: KEY_FILE_MODE,
        actualMode,
        timestamp: new Date().toISOString(),
      }));
    }
  } catch {
    // stat can fail for reasons other than the file not existing;
    // if it does, the ENOENT path handles it.
  }
}

/**
 * Default vault: AES-256-GCM with a key stored at `keyFile` (mode 0o600).
 * The key is loaded lazily on first encrypt/decrypt; if it does not exist,
 * a fresh one is generated. Decryption of plaintext values is a no-op so
 * legacy configs continue to work.
 *
 * Key file format:
 *   - Legacy (v1): exactly 32 raw bytes
 *   - Versioned (v2+): 4-byte magic `WSKV` + 1-byte version + 32-byte key (37 bytes)
 *
 * Encrypted value format: `enc:v<N>:<iv>:<tag>:<ciphertext>` where N is the
 * key version. After rotation, encrypt() emits the new version prefix.
 */
export class DefaultSecretVault implements RotatableSecretVault {
  private readonly keyFile: string;
  private key?: Buffer | undefined;
  private _keyVersion: number = 1;

  constructor(opts: SecretVaultOptions) {
    this.keyFile = opts.keyFile;
  }

  /** Current key version. Starts at 1; incremented by rotateKey(). */
  get keyVersion(): number {
    // Ensure key is loaded so version is accurate
    if (!this.key) this.loadOrCreateKey();
    return this._keyVersion;
  }

  isEncrypted(value: string): boolean {
    return typeof value === 'string' && ENCRYPTED_PREFIX_PATTERN.test(value);
  }

  encrypt(plaintext: string): string {
    if (this.isEncrypted(plaintext)) return plaintext;
    const key = this.loadOrCreateKey();
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGO, key, iv);
    const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    const prefix = encryptedPrefixForVersion(this._keyVersion);
    return `${prefix}${iv.toString('base64')}:${tag.toString('base64')}:${ct.toString('base64')}`;
  }

  decrypt(value: string): string {
    if (!this.isEncrypted(value)) return value;
    // Strip the versioned prefix (enc:v1:, enc:v2:, etc.)
    const prefixMatch = value.match(ENCRYPTED_PREFIX_PATTERN);
    if (!prefixMatch) {
      throw new ConfigError({
        message: 'SecretVault: malformed encrypted value',
        code: ERROR_CODES.CONFIG_PARSE_FAILED,
        context: { field: 'encrypted_value' },
      });
    }
    const rest = value.slice(prefixMatch[0].length);
    const parts = rest.split(':');
    if (parts.length !== 3) {
      throw new ConfigError({
        message: 'SecretVault: malformed encrypted value',
        code: ERROR_CODES.CONFIG_PARSE_FAILED,
        context: { field: 'encrypted_value' },
      });
    }
    const [ivB64, tagB64, ctB64] = parts as [string, string, string];
    const iv = Buffer.from(ivB64, 'base64');
    const tag = Buffer.from(tagB64, 'base64');
    const ct = Buffer.from(ctB64, 'base64');
    if (iv.length !== IV_BYTES) throw new ConfigError({
      message: 'SecretVault: bad IV length',
      code: ERROR_CODES.CONFIG_PARSE_FAILED,
      context: { expected: IV_BYTES, actual: iv.length },
    });
    if (tag.length !== TAG_BYTES) throw new ConfigError({
      message: 'SecretVault: bad tag length',
      code: ERROR_CODES.CONFIG_PARSE_FAILED,
      context: { expected: TAG_BYTES, actual: tag.length },
    });
    const key = this.loadOrCreateKey();
    const decipher = createDecipheriv(ALGO, key, iv);
    decipher.setAuthTag(tag);
    const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
    return pt.toString('utf8');
  }

  /**
   * Generate a new encryption key, write it to disk, and increment the key version.
   * After rotation, encrypt() emits the new version prefix (e.g. enc:v2:).
   * The caller must re-encrypt existing config values (see rotateConfigKeys()).
   */
  rotateKey(): { oldVersion: number; newVersion: number } {
    const oldVersion = this._keyVersion;
    const newKey = randomBytes(KEY_BYTES);
    const newVersion = oldVersion + 1;

    // Write versioned key file: WSKV + version byte + key
    const keyFileBuf = Buffer.alloc(VERSIONED_KEY_FILE_SIZE);
    KEY_FILE_MAGIC.copy(keyFileBuf, 0);
    keyFileBuf[KEY_FILE_MAGIC.length] = newVersion;
    newKey.copy(keyFileBuf, KEY_FILE_MAGIC.length + 1);

    fs.mkdirSync(path.dirname(this.keyFile), { recursive: true });
    fs.writeFileSync(this.keyFile, keyFileBuf, { mode: 0o600 });
    checkKeyFilePermissions(this.keyFile);

    this.key = newKey;
    this._keyVersion = newVersion;
    return { oldVersion, newVersion };
  }

  private loadOrCreateKey(): Buffer {
    // readFileSync blocks the event loop, but this is a one-time cost per
    // process: the key is cached after the first load and reused for every
    // subsequent encrypt/decrypt. For CLI usage (single run → exit) this is
    // negligible. For server contexts (eternal autonomy, MCP server mode),
    // the first encrypt/decrypt call causes a brief (<1ms) event loop stall.
    // Prefer calling vault.encrypt('') during boot to warm the cache if this
    // is a concern in your deployment.
    if (this.key) return this.key;
    try {
      const buf = fs.readFileSync(this.keyFile);

      // Detect key file format:
      if (buf.length === KEY_BYTES) {
        // Legacy v1: raw 32-byte key
        this.key = buf;
        this._keyVersion = 1;
        checkKeyFilePermissions(this.keyFile);
        return this.key;
      }

      if (buf.length === VERSIONED_KEY_FILE_SIZE) {
        // Versioned v2+: WSKV magic + version byte + 32-byte key
        const magic = buf.subarray(0, KEY_FILE_MAGIC.length);
        if (!magic.equals(KEY_FILE_MAGIC)) {
          throw new ConfigError({
            message: `SecretVault: key file ${this.keyFile} has invalid magic header`,
            code: ERROR_CODES.CONFIG_INVALID,
            context: { keyFile: this.keyFile },
          });
        }
        const version = buf[KEY_FILE_MAGIC.length]!;
        const key = buf.subarray(KEY_FILE_MAGIC.length + 1);
        if (key.length !== KEY_BYTES) {
          throw new ConfigError({
            message: `SecretVault: key file ${this.keyFile} has wrong key size (${key.length} bytes, expected ${KEY_BYTES})`,
            code: ERROR_CODES.CONFIG_INVALID,
            context: { keyFile: this.keyFile, expectedBytes: KEY_BYTES, actualBytes: key.length },
          });
        }
        this.key = Buffer.from(key);
        this._keyVersion = version;
        checkKeyFilePermissions(this.keyFile);
        return this.key;
      }

      // Wrong size — neither legacy nor versioned format
      throw new ConfigError({
        message:
          `SecretVault: key file ${this.keyFile} is ${buf.length} bytes ` +
          `(expected ${KEY_BYTES} for v1 or ${VERSIONED_KEY_FILE_SIZE} for v2+). ` +
          `Remove it manually to generate a new key.`,
        code: ERROR_CODES.CONFIG_INVALID,
        context: { keyFile: this.keyFile, expectedBytes: KEY_BYTES, actualBytes: buf.length },
      });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    // Create a fresh key. Use sync APIs so the constructor-free getter
    // remains synchronous from the caller's perspective.
    fs.mkdirSync(path.dirname(this.keyFile), { recursive: true });
    const key = randomBytes(KEY_BYTES);
    // Use exclusive-create flag 'wx' to prevent races: if two processes race
    // to create the key file, only one succeeds and the loser gets EEXIST.
    try {
      fs.writeFileSync(this.keyFile, key, { mode: 0o600, flag: 'wx' });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      // Another process won the race — re-read what they wrote.
      const buf = fs.readFileSync(this.keyFile);
      if (buf.length === KEY_BYTES) {
        // Legacy v1 format
        this.key = buf;
        this._keyVersion = 1;
        checkKeyFilePermissions(this.keyFile);
        return this.key;
      }
      if (buf.length === VERSIONED_KEY_FILE_SIZE) {
        // Versioned format
        const magic = buf.subarray(0, KEY_FILE_MAGIC.length);
        if (!magic.equals(KEY_FILE_MAGIC)) {
          throw new ConfigError({
            message: `SecretVault: key file ${this.keyFile} has invalid magic header`,
            code: ERROR_CODES.CONFIG_INVALID,
            context: { keyFile: this.keyFile },
          });
        }
        const version = buf[KEY_FILE_MAGIC.length]!;
        const winnerKey = buf.subarray(KEY_FILE_MAGIC.length + 1);
        this.key = Buffer.from(winnerKey);
        this._keyVersion = version;
        checkKeyFilePermissions(this.keyFile);
        return this.key;
      }
      throw new ConfigError({
        message:
          `SecretVault: key file ${this.keyFile} is ${buf.length} bytes ` +
          `(expected ${KEY_BYTES} for v1 or ${VERSIONED_KEY_FILE_SIZE} for v2+). ` +
          `Remove it manually to generate a new key.`,
        code: ERROR_CODES.CONFIG_INVALID,
        context: { keyFile: this.keyFile, expectedBytes: KEY_BYTES, actualBytes: buf.length },
      });
    }
    this.key = key;
    this._keyVersion = 1;
    return key;
  }
}

/**
 * Walk a Config-shaped object and decrypt any apiKey-like fields in place,
 * returning a new object. Used by the config loader so the rest of the
 * system never has to know about the wire format.
 *
 * @param warn — callback for decryption warnings. Defaults to `console.warn`
 *   for backward compatibility; pass `logger.warn` when a structured logger
 *   is available (preferred in long-running/server contexts).
 */
export function decryptConfigSecrets<T>(
  cfg: T,
  vault: SecretVault,
  opts?: { warn?: (msg: string) => void },
): T {
  const warn = opts?.warn ?? ((msg: string) => console.warn(msg));
  // A single corrupted/malformed encrypted field should not kill the entire
  // config load. Swallow per-field decrypt errors (zero the field so callers
  // see "missing key" instead of holding ciphertext) and surface a warning.
  return walk(cfg, vault, (v, key) => {
    try {
      return vault.decrypt(v);
    } catch (err) {
      warn(
        `[secret-vault] Failed to decrypt "${key}": ${err instanceof Error ? err.message : err}`,
      );
      return '';
    }
  });
}

export function encryptConfigSecrets<T>(
  cfg: T,
  vault: SecretVault,
  _opts?: { warn?: (msg: string) => void },
): T {
  return walk(cfg, vault, (v) => vault.encrypt(v));
}

function walk<T>(node: T, vault: SecretVault, transform: (s: string, key: string) => string): T {
  if (node === null || node === undefined) return node;
  if (typeof node !== 'object') return node;
  if (Array.isArray(node)) {
    return node.map((item) => walk(item, vault, transform)) as never as T;
  }
  const out: Record<string, unknown> = Object.create(null);
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    if (typeof v === 'string' && isSecretField(k)) {
      out[k] = transform(v, k);
    } else if (typeof v === 'object' && v !== null) {
      out[k] = walk(v, vault, transform);
    } else {
      out[k] = v;
    }
  }
  return out as T;
}

/**
 * A key is treated as secret-bearing if its name (case-insensitive) contains
 * one of these tokens. Captures common variants like `apiKey`, `authToken`,
 * `refreshToken`, `sessionKey`, `password`, `client_secret`, `bearer`, etc.
 * Use a named field with `isSecret: false` annotation if you must opt out —
 * see `NON_SECRET_OVERRIDES` below.
 */
const SECRET_KEY_PATTERN =
  /(?:apikey|api_key|authtoken|auth_token|bearer|secret|password|passwd|pwd|refreshtoken|refresh_token|sessionkey|session_key|access[_-]?token|private[_-]?key)/i;

// Field names that contain the literal substring "key" but are not secrets.
// Keep this list short; the substring rule itself is intentionally narrow.
const NON_SECRET_OVERRIDES = new Set(['publickey', 'public_key']);

export function isSecretField(name: string): boolean {
  const lc = name.toLowerCase();
  if (NON_SECRET_OVERRIDES.has(lc)) return false;
  return SECRET_KEY_PATTERN.test(lc);
}

/**
 * Re-write `~/.wrongstack/config.json` (or any path) with all secret-bearing
 * fields encrypted. Used by the `wstack auth` subcommand.
 */
export async function rewriteConfigEncrypted(
  configPath: string,
  vault: SecretVault,
  patch?: Record<string, unknown>,
): Promise<void> {
  let current: Record<string, unknown> = {};
  try {
    const raw = await fsp.readFile(configPath, 'utf8');
    current = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    // start from empty
  }
  const merged = deepMerge(current, patch ?? {});
  const encrypted = encryptConfigSecrets(merged, vault);
  await fsp.mkdir(path.dirname(configPath), { recursive: true });
  // atomicWrite: torn write here would erase every saved encrypted API key.
  await atomicWrite(configPath, JSON.stringify(encrypted, null, 2), { mode: 0o600 });
  await restrictFilePermissions(configPath);
}

/**
 * Scan a config file on disk for plaintext secret-bearing fields and
 * rewrite the file with them encrypted in place. Returns a count of how
 * many fields were migrated. Idempotent — calling on a fully-encrypted
 * file is a no-op and writes nothing. Used by the CLI on every boot so
 * users who had plaintext keys before the vault landed are upgraded
 * transparently.
 */
export async function migratePlaintextSecrets(
  configPath: string,
  vault: SecretVault,
  logger?: Pick<Logger, 'warn'>,
): Promise<{ migrated: number; file: string }> {
  let raw: string;
  try {
    raw = await fsp.readFile(configPath, 'utf8');
  } catch {
    return { migrated: 0, file: configPath };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { migrated: 0, file: configPath };
  }
  const counter = { n: 0 };
  const migrated = walkCount(parsed, vault, counter);
  if (counter.n === 0) return { migrated: 0, file: configPath };
  // atomicWrite: runs on every boot for legacy users — torn write = wipe.
  await atomicWrite(configPath, JSON.stringify(migrated, null, 2), { mode: 0o600 });
  await restrictFilePermissions(
    configPath,
    logger ? { warn: (msg) => logger.warn(msg) } : undefined,
  );
  return { migrated: counter.n, file: configPath };
}

/**
 * Rotate the vault's encryption key and re-encrypt all secret-bearing
 * fields in a config file. This is the atomic key rotation operation:
 *
 * 1. Read the config file
 * 2. Decrypt all encrypted values with the old key
 * 3. Generate a new key (vault.rotateKey())
 * 4. Re-encrypt all values with the new key (new version prefix)
 * 5. Write the config file atomically
 *
 * Returns the number of fields re-encrypted and the version transition.
 * If the config file doesn't exist or has no encrypted fields, returns
 * { rotated: 0 } without modifying the key.
 */
export async function rotateConfigKeys(
  configPath: string,
  vault: RotatableSecretVault,
  logger?: Pick<Logger, 'warn' | 'info'>,
): Promise<{ rotated: number; oldVersion: number; newVersion: number; file: string }> {
  const log = logger?.info ?? (() => {});
  const warn = logger?.warn ?? ((msg: string) => console.warn(msg));

  // Read the config file
  let raw: string;
  try {
    raw = await fsp.readFile(configPath, 'utf8');
  } catch {
    // No config file — just rotate the key without re-encrypting anything
    const { oldVersion, newVersion } = vault.rotateKey();
    log(`[secret-vault] Key rotated (v${oldVersion} → v${newVersion}) — no config file to re-encrypt`);
    return { rotated: 0, oldVersion, newVersion, file: configPath };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    warn(`[secret-vault] Config file ${configPath} is not valid JSON — skipping rotation`);
    return { rotated: 0, oldVersion: vault.keyVersion, newVersion: vault.keyVersion, file: configPath };
  }

  // Count encrypted fields and decrypt them
  const counter = { n: 0, failed: [] as string[] };
  const decrypted = walkDecryptCount(parsed, vault, counter);

  // Abort BEFORE rotating if any encrypted field could not be decrypted with
  // the current key. Rotation would discard the old key while these fields
  // still hold old-key ciphertext, and walkReencrypt skips already-encrypted
  // values — so they would become permanently undecryptable. Surface the
  // corruption and leave the key intact for the operator to investigate.
  if (counter.failed.length > 0) {
    throw new Error(
      `[secret-vault] Aborting key rotation: ${counter.failed.length} field(s) could not be decrypted ` +
        `with the current key and would be permanently lost on rotation: ${counter.failed.join(', ')}. ` +
        `Restore or remove these fields before rotating.`,
    );
  }

  if (counter.n === 0) {
    // No encrypted fields — just rotate the key
    const { oldVersion, newVersion } = vault.rotateKey();
    log(`[secret-vault] Key rotated (v${oldVersion} → v${newVersion}) — no encrypted fields to re-encrypt`);
    return { rotated: 0, oldVersion, newVersion, file: configPath };
  }

  // Rotate the key (generates new key, increments version)
  const { oldVersion, newVersion } = vault.rotateKey();

  // Re-encrypt all secret fields with the new key
  const reencrypted = walkReencrypt(decrypted, vault);

  // Write the config file atomically
  await atomicWrite(configPath, JSON.stringify(reencrypted, null, 2), { mode: 0o600 });
  await restrictFilePermissions(configPath, { warn });

  log(`[secret-vault] Key rotated (v${oldVersion} → v${newVersion}) — re-encrypted ${counter.n} field(s)`);
  return { rotated: counter.n, oldVersion, newVersion, file: configPath };
}

/**
 * Walk a config object, decrypt all encrypted values, and count them.
 * Returns a new object with decrypted values.
 *
 * `counter.failed` collects the key paths of any field that is encrypted but
 * could NOT be decrypted with the current key. These are left as-is (old
 * ciphertext). The caller MUST treat a non-empty `failed` list as a hard stop
 * before rotating: rotation discards the old key, and `walkReencrypt` skips
 * already-encrypted values, so a retained old-key ciphertext would become
 * permanently undecryptable. Surfacing it is strictly safer than entombing it.
 */
function walkDecryptCount<T>(
  node: T,
  vault: SecretVault,
  counter: { n: number; failed: string[] },
  pathPrefix = '',
): T {
  if (node === null || node === undefined) return node;
  if (typeof node !== 'object') return node;
  if (Array.isArray(node)) {
    return node.map((item, i) =>
      walkDecryptCount(item, vault, counter, `${pathPrefix}[${i}]`),
    ) as never as T;
  }
  const out: Record<string, unknown> = Object.create(null);
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    const keyPath = pathPrefix ? `${pathPrefix}.${k}` : k;
    if (typeof v === 'string' && vault.isEncrypted(v)) {
      try {
        out[k] = vault.decrypt(v);
        counter.n++;
      } catch {
        // Decryption failed — record the path and keep the old ciphertext.
        // The caller aborts rotation when counter.failed is non-empty, so
        // the old key is never discarded while this value still depends on it.
        counter.failed.push(keyPath);
        out[k] = v;
      }
    } else if (typeof v === 'object' && v !== null) {
      out[k] = walkDecryptCount(v, vault, counter, keyPath);
    } else {
      out[k] = v;
    }
  }
  return out as T;
}

/**
 * Walk a config object and re-encrypt all secret-bearing fields.
 * Unlike encryptConfigSecrets, this encrypts ALL string values that
 * were previously decrypted (they're now plaintext), not just those
 * matching the secret field pattern. This ensures we re-encrypt values
 * that were successfully decrypted in walkDecryptCount.
 */
function walkReencrypt<T>(node: T, vault: SecretVault): T {
  if (node === null || node === undefined) return node;
  if (typeof node !== 'object') return node;
  if (Array.isArray(node)) {
    return node.map((item) => walkReencrypt(item, vault)) as never as T;
  }
  const out: Record<string, unknown> = Object.create(null);
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    if (typeof v === 'string' && isSecretField(k) && v.length > 0 && !vault.isEncrypted(v)) {
      // This was a decrypted secret — re-encrypt it
      out[k] = vault.encrypt(v);
    } else if (typeof v === 'object' && v !== null) {
      out[k] = walkReencrypt(v, vault);
    } else {
      out[k] = v;
    }
  }
  return out as T;
}

/**
 * Restrict a file to owner-only access. On POSIX this is chmod 0o600.
 * On Windows, chmod is a no-op — we use icacls to remove inherited
 * permissions and grant only the current user. Failures are logged
 * but not thrown so callers are not blocked on unsupported platforms.
 */
async function restrictFilePermissions(
  filePath: string,
  opts?: { warn?: (msg: string) => void },
): Promise<void> {
  const warn = opts?.warn ?? ((msg: string) => console.warn(msg));
  if (process.platform === 'win32') {
    try {
      const { execFile } = await import('node:child_process');
      const { promisify } = await import('node:util');
      const execFileAsync = promisify(execFile);
      const user = windowsAccountName();
      if (!user) {
        warn(
          `[secret-vault] Could not determine the current Windows user for ${filePath}; skipping icacls hardening.`,
        );
        return;
      }
      // Remove inherited ACEs, grant full control only to current user.
      await execFileAsync('icacls', [filePath, '/inheritance:r', '/grant:r', `${user}:(F)`]);
    } catch {
      // Best-effort: icacls may not be available in all environments.
      warn(
        `[secret-vault] Could not restrict permissions on ${filePath} — config file may be readable by other users on this system.`,
      );
    }
  } else {
    try {
      await fsp.chmod(filePath, 0o600);
    } catch {
      // Best-effort
    }
  }
}

function windowsAccountName(): string | undefined {
  const username = process.env.USERNAME || process.env.USER;
  if (!username || username.includes('\0')) return undefined;
  const domain = process.env.USERDOMAIN;
  if (domain && !domain.includes('\0')) return `${domain}\\${username}`;
  return username;
}

function walkCount<T>(node: T, vault: SecretVault, counter: { n: number }): T {
  if (node === null || node === undefined) return node;
  if (typeof node !== 'object') return node;
  if (Array.isArray(node)) {
    return node.map((item) => walkCount(item, vault, counter)) as never as T;
  }
  const out: Record<string, unknown> = Object.create(null);
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    if (typeof v === 'string' && isSecretField(k) && !vault.isEncrypted(v) && v.length > 0) {
      out[k] = vault.encrypt(v);
      counter.n++;
    } else if (typeof v === 'object' && v !== null) {
      out[k] = walkCount(v, vault, counter);
    } else {
      out[k] = v;
    }
  }
  return out as T;
}

/** Keys that, when written into a plain object, can poison the prototype
 *  chain. We never want user config to carry these. */
import { deepMerge } from '../utils/deep-merge.js';
