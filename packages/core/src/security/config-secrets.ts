import type { SecretVault } from '../types/secret-vault.js';

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
