import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { SecretVault } from '../types/secret-vault.js';
import { ENCRYPTED_PREFIX } from '../types/secret-vault.js';

export interface SecretVaultOptions {
  /** Absolute path to the key file. Created with mode 0o600 if missing. */
  keyFile: string;
}

const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const ALGO = 'aes-256-gcm';

/**
 * Default vault: AES-256-GCM with a key stored at `keyFile` (mode 0o600).
 * The key is loaded lazily on first encrypt/decrypt; if it does not exist,
 * a fresh one is generated. Decryption of plaintext values is a no-op so
 * legacy configs continue to work.
 */
export class DefaultSecretVault implements SecretVault {
  private readonly keyFile: string;
  private key?: Buffer;

  constructor(opts: SecretVaultOptions) {
    this.keyFile = opts.keyFile;
  }

  isEncrypted(value: string): boolean {
    return typeof value === 'string' && value.startsWith(ENCRYPTED_PREFIX);
  }

  encrypt(plaintext: string): string {
    if (this.isEncrypted(plaintext)) return plaintext;
    const key = this.loadOrCreateKey();
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGO, key, iv);
    const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${ENCRYPTED_PREFIX}${iv.toString('base64')}:${tag.toString('base64')}:${ct.toString('base64')}`;
  }

  decrypt(value: string): string {
    if (!this.isEncrypted(value)) return value;
    const rest = value.slice(ENCRYPTED_PREFIX.length);
    const parts = rest.split(':');
    if (parts.length !== 3) {
      throw new Error('SecretVault: malformed encrypted value');
    }
    const [ivB64, tagB64, ctB64] = parts as [string, string, string];
    const iv = Buffer.from(ivB64, 'base64');
    const tag = Buffer.from(tagB64, 'base64');
    const ct = Buffer.from(ctB64, 'base64');
    if (iv.length !== IV_BYTES) throw new Error('SecretVault: bad IV length');
    if (tag.length !== TAG_BYTES) throw new Error('SecretVault: bad tag length');
    const key = this.loadOrCreateKey();
    const decipher = createDecipheriv(ALGO, key, iv);
    decipher.setAuthTag(tag);
    const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
    return pt.toString('utf8');
  }

  private loadOrCreateKey(): Buffer {
    if (this.key) return this.key;
    try {
      const buf = fs.readFileSync(this.keyFile);
      if (buf.length !== KEY_BYTES) {
        throw new Error(`SecretVault: key file ${this.keyFile} has wrong size`);
      }
      this.key = buf;
      return this.key;
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
      if (buf.length !== KEY_BYTES) {
        throw new Error(`SecretVault: key file ${this.keyFile} has wrong size`);
      }
      this.key = buf;
      return this.key;
    }
    this.key = key;
    return key;
  }
}

/**
 * Walk a Config-shaped object and decrypt any apiKey-like fields in place,
 * returning a new object. Used by the config loader so the rest of the
 * system never has to know about the wire format.
 */
export function decryptConfigSecrets<T>(cfg: T, vault: SecretVault): T {
  // A single corrupted/malformed encrypted field should not kill the entire
  // config load. Swallow per-field decrypt errors (zero the field so callers
  // see "missing key" instead of holding ciphertext) and surface a warning.
  return walk(cfg, vault, (v, key) => {
    try {
      return vault.decrypt(v);
    } catch (err) {
      console.warn(
        `[secret-vault] Failed to decrypt "${key}":`,
        err instanceof Error ? err.message : err,
      );
      return '';
    }
  });
}

export function encryptConfigSecrets<T>(cfg: T, vault: SecretVault): T {
  return walk(cfg, vault, (v) => vault.encrypt(v));
}

function walk<T>(node: T, vault: SecretVault, transform: (s: string, key: string) => string): T {
  if (node === null || node === undefined) return node;
  if (typeof node !== 'object') return node;
  if (Array.isArray(node)) {
    return node.map((item) => walk(item, vault, transform)) as unknown as T;
  }
  const out: Record<string, unknown> = {};
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
const SECRET_KEY_PATTERN = /(?:apikey|api_key|authtoken|auth_token|bearer|secret|password|passwd|pwd|refreshtoken|refresh_token|sessionkey|session_key|access[_-]?token|private[_-]?key)/i;

// Field names that contain the literal substring "key" but are not secrets.
// Keep this list short; the substring rule itself is intentionally narrow.
const NON_SECRET_OVERRIDES = new Set(['publickey', 'public_key']);

function isSecretField(name: string): boolean {
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
  await fsp.writeFile(configPath, JSON.stringify(encrypted, null, 2), { mode: 0o600 });
  try {
    await fsp.chmod(configPath, 0o600);
  } catch {
    // best-effort on Windows
  }
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
  await fsp.writeFile(configPath, JSON.stringify(migrated, null, 2), { mode: 0o600 });
  try {
    await fsp.chmod(configPath, 0o600);
  } catch {
    // best-effort on Windows
  }
  return { migrated: counter.n, file: configPath };
}

function walkCount<T>(node: T, vault: SecretVault, counter: { n: number }): T {
  if (node === null || node === undefined) return node;
  if (typeof node !== 'object') return node;
  if (Array.isArray(node)) {
    return node.map((item) => walkCount(item, vault, counter)) as unknown as T;
  }
  const out: Record<string, unknown> = {};
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
const FORBIDDEN_PROTO_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function deepMerge<T extends Record<string, unknown>>(a: T, b: Record<string, unknown>): T {
  const out: Record<string, unknown> = { ...a };
  for (const [k, v] of Object.entries(b)) {
    if (FORBIDDEN_PROTO_KEYS.has(k)) continue;
    const existing = out[k];
    if (
      v !== null &&
      typeof v === 'object' &&
      !Array.isArray(v) &&
      existing !== null &&
      typeof existing === 'object' &&
      !Array.isArray(existing)
    ) {
      out[k] = deepMerge(existing as Record<string, unknown>, v as Record<string, unknown>);
    } else {
      out[k] = v;
    }
  }
  return out as T;
}
