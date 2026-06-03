/**
 * Pure provider/API-key record transforms for the WebUI server's `key.*` and
 * `provider.*` WebSocket handlers.
 *
 * These operate on an in-memory `providers` record (the decrypted
 * `config.providers` map) and return a `{ ok, message }` result mirroring the
 * status string the handler sends back to the client. All persistence
 * (load/decrypt, encrypt/atomic-write) and WS messaging stays in `index.ts` —
 * keeping this layer pure means the security-sensitive key bookkeeping (which
 * key is active, when a provider is dropped, how legacy single-key configs are
 * normalized) is unit-testable without a vault or a socket.
 *
 * Extracted from `index.ts`; transforms mutate the passed record in place, the
 * same way the original handlers did before calling `saveProviders`.
 */
import type { ProviderApiKey, ProviderConfig } from '@wrongstack/core';

export type ProvidersRecord = Record<string, ProviderConfig>;

export interface KeyOpResult {
  ok: boolean;
  message: string;
}

/**
 * Normalize a provider's keys to the array form, upgrading a legacy single
 * `apiKey` string to a one-element `[{ label: 'default', ... }]` list. Returns
 * fresh copies so callers can mutate without aliasing the stored config.
 */
export function normalizeKeys(cfg: ProviderConfig): ProviderApiKey[] {
  if (Array.isArray(cfg.apiKeys) && cfg.apiKeys.length > 0) {
    return cfg.apiKeys.map((k) => ({ ...k }));
  }
  if (typeof cfg.apiKey === 'string' && cfg.apiKey.length > 0) {
    return [{ label: 'default', apiKey: cfg.apiKey, createdAt: '' }];
  }
  return [];
}

/**
 * Write a normalized key list back onto a provider config: drop all key fields
 * when empty, otherwise sync `apiKeys`, the legacy `apiKey` mirror (the active
 * key), and re-point `activeKey` if it no longer names a present key.
 */
export function writeKeysBack(cfg: ProviderConfig, keys: ProviderApiKey[]): void {
  if (keys.length === 0) {
    delete cfg.apiKeys;
    delete cfg.apiKey;
    delete cfg.activeKey;
    return;
  }
  cfg.apiKeys = keys;
  const active = keys.find((k) => k.label === cfg.activeKey) ?? keys[0]!;
  cfg.apiKey = active.apiKey;
  if (!cfg.activeKey || !keys.some((k) => k.label === cfg.activeKey)) {
    cfg.activeKey = active.label;
  }
}

/** Mask a secret for display: `••••` for short keys, `abcd…wxyz` otherwise. */
export function maskedKey(key: string | undefined): string {
  if (!key) return '—';
  if (key.length <= 8) return '•'.repeat(key.length);
  return `${key.slice(0, 4)}…${key.slice(-4)}`;
}

/** Add or replace a labeled key for a provider, creating the provider if new. */
export function upsertKey(
  providers: ProvidersRecord,
  providerId: string,
  label: string,
  apiKey: string,
  nowIso: string,
): KeyOpResult {
  const existing: ProviderConfig = providers[providerId] ?? { type: providerId };
  const keys = normalizeKeys(existing);
  const idx = keys.findIndex((k) => k.label === label);
  if (idx >= 0) {
    keys[idx] = { ...keys[idx]!, apiKey, createdAt: nowIso };
  } else {
    keys.push({ label, apiKey, createdAt: nowIso });
  }
  writeKeysBack(existing, keys);
  if (!existing.activeKey) existing.activeKey = label;
  providers[providerId] = existing;
  return { ok: true, message: `Key "${label}" saved for ${providerId}` };
}

/** Remove a labeled key; drops the provider entirely when its last key goes. */
export function deleteKey(
  providers: ProvidersRecord,
  providerId: string,
  label: string,
): KeyOpResult {
  const existing = providers[providerId];
  if (!existing) {
    return { ok: false, message: `Provider "${providerId}" not found` };
  }
  const keys = normalizeKeys(existing).filter((k) => k.label !== label);
  if (keys.length === 0) {
    delete providers[providerId];
  } else {
    writeKeysBack(existing, keys);
    if (existing.activeKey === label) existing.activeKey = keys[0]!.label;
    providers[providerId] = existing;
  }
  return { ok: true, message: `Key "${label}" deleted from ${providerId}` };
}

/** Point a provider's active key at the given label. */
export function setActiveKey(
  providers: ProvidersRecord,
  providerId: string,
  label: string,
): KeyOpResult {
  const existing = providers[providerId];
  if (!existing) {
    return { ok: false, message: `Provider "${providerId}" not found` };
  }
  existing.activeKey = label;
  writeKeysBack(existing, normalizeKeys(existing));
  providers[providerId] = existing;
  return { ok: true, message: `Active key for ${providerId} set to "${label}"` };
}

/** Register a brand-new provider (optionally with an initial `default` key). */
export function addProvider(
  providers: ProvidersRecord,
  payload: { id: string; family: string; baseUrl?: string; apiKey?: string },
  nowIso: string,
): KeyOpResult {
  if (providers[payload.id]) {
    return {
      ok: false,
      message: `Provider "${payload.id}" already exists. Use key.add to add a key.`,
    };
  }
  const newProv: ProviderConfig = {
    type: payload.id,
    family: payload.family as ProviderConfig['family'],
    baseUrl: payload.baseUrl,
  };
  if (payload.apiKey) {
    newProv.apiKeys = [{ label: 'default', apiKey: payload.apiKey, createdAt: nowIso }];
    newProv.activeKey = 'default';
  }
  providers[payload.id] = newProv;
  return { ok: true, message: `Provider "${payload.id}" added` };
}

/** Remove an entire provider and all its keys. */
export function removeProvider(providers: ProvidersRecord, providerId: string): KeyOpResult {
  if (!providers[providerId]) {
    return { ok: false, message: `Provider "${providerId}" not found` };
  }
  delete providers[providerId];
  return { ok: true, message: `Provider "${providerId}" removed` };
}
