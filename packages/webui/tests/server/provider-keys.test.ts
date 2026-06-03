import type { ProviderConfig } from '@wrongstack/core';
import { describe, expect, it } from 'vitest';
import {
  type ProvidersRecord,
  addProvider,
  deleteKey,
  maskedKey,
  normalizeKeys,
  removeProvider,
  setActiveKey,
  upsertKey,
  writeKeysBack,
} from '../../src/server/provider-keys.js';

/**
 * Pure provider/API-key record transforms behind the WebUI `key.*`/`provider.*`
 * handlers. This is security-sensitive bookkeeping (which key is active, when a
 * provider is dropped, legacy single-key upgrade) that had no coverage while it
 * lived inline in index.ts.
 */

const NOW = '2026-06-03T00:00:00.000Z';

describe('normalizeKeys', () => {
  it('returns the array form unchanged (as copies)', () => {
    const cfg: ProviderConfig = {
      type: 'anthropic',
      apiKeys: [{ label: 'a', apiKey: 'k1', createdAt: NOW }],
    };
    const keys = normalizeKeys(cfg);
    expect(keys).toEqual([{ label: 'a', apiKey: 'k1', createdAt: NOW }]);
    expect(keys[0]).not.toBe(cfg.apiKeys![0]); // fresh copy, not aliased
  });

  it('upgrades a legacy single apiKey to a default-labeled entry', () => {
    expect(normalizeKeys({ type: 'openai', apiKey: 'legacy' })).toEqual([
      { label: 'default', apiKey: 'legacy', createdAt: '' },
    ]);
  });

  it('returns empty for a provider with no keys', () => {
    expect(normalizeKeys({ type: 'openai' })).toEqual([]);
    expect(normalizeKeys({ type: 'openai', apiKey: '' })).toEqual([]);
  });
});

describe('writeKeysBack', () => {
  it('drops all key fields when the list is empty', () => {
    const cfg: ProviderConfig = { type: 'x', apiKey: 'k', activeKey: 'default', apiKeys: [] };
    writeKeysBack(cfg, []);
    expect(cfg.apiKeys).toBeUndefined();
    expect(cfg.apiKey).toBeUndefined();
    expect(cfg.activeKey).toBeUndefined();
  });

  it('mirrors the active key into the legacy apiKey field', () => {
    const cfg: ProviderConfig = { type: 'x', activeKey: 'b' };
    writeKeysBack(cfg, [
      { label: 'a', apiKey: 'ka', createdAt: NOW },
      { label: 'b', apiKey: 'kb', createdAt: NOW },
    ]);
    expect(cfg.apiKey).toBe('kb');
    expect(cfg.activeKey).toBe('b');
  });

  it('re-points activeKey to the first key when it no longer exists', () => {
    const cfg: ProviderConfig = { type: 'x', activeKey: 'gone' };
    writeKeysBack(cfg, [{ label: 'a', apiKey: 'ka', createdAt: NOW }]);
    expect(cfg.activeKey).toBe('a');
    expect(cfg.apiKey).toBe('ka');
  });
});

describe('maskedKey', () => {
  it('renders a placeholder, bullets, or a head…tail mask', () => {
    expect(maskedKey(undefined)).toBe('—');
    expect(maskedKey('')).toBe('—');
    expect(maskedKey('short')).toBe('•••••');
    expect(maskedKey('sk-abcdefgh_xyz')).toBe('sk-a…_xyz');
  });
});

describe('upsertKey', () => {
  it('creates the provider and seeds the active key on first add', () => {
    const providers: ProvidersRecord = {};
    const r = upsertKey(providers, 'anthropic', 'work', 'k1', NOW);
    expect(r).toEqual({ ok: true, message: 'Key "work" saved for anthropic' });
    expect(providers.anthropic?.activeKey).toBe('work');
    expect(providers.anthropic?.apiKeys).toEqual([{ label: 'work', apiKey: 'k1', createdAt: NOW }]);
  });

  it('replaces an existing label and leaves the active key untouched', () => {
    const providers: ProvidersRecord = {
      anthropic: {
        type: 'anthropic',
        activeKey: 'work',
        apiKeys: [{ label: 'work', apiKey: 'old', createdAt: '2020' }],
      },
    };
    upsertKey(providers, 'anthropic', 'work', 'new', NOW);
    expect(providers.anthropic?.apiKeys).toEqual([
      { label: 'work', apiKey: 'new', createdAt: NOW },
    ]);
    expect(providers.anthropic?.activeKey).toBe('work');
  });
});

describe('deleteKey', () => {
  it('errors when the provider is missing', () => {
    expect(deleteKey({}, 'nope', 'x')).toEqual({ ok: false, message: 'Provider "nope" not found' });
  });

  it('removes the provider entirely when its last key is deleted', () => {
    const providers: ProvidersRecord = {
      openai: {
        type: 'openai',
        activeKey: 'a',
        apiKeys: [{ label: 'a', apiKey: 'k', createdAt: NOW }],
      },
    };
    const r = deleteKey(providers, 'openai', 'a');
    expect(r.ok).toBe(true);
    expect(providers.openai).toBeUndefined();
  });

  it('re-points the active key when the active label is deleted', () => {
    const providers: ProvidersRecord = {
      openai: {
        type: 'openai',
        activeKey: 'a',
        apiKeys: [
          { label: 'a', apiKey: 'ka', createdAt: NOW },
          { label: 'b', apiKey: 'kb', createdAt: NOW },
        ],
      },
    };
    deleteKey(providers, 'openai', 'a');
    expect(providers.openai?.apiKeys?.map((k) => k.label)).toEqual(['b']);
    expect(providers.openai?.activeKey).toBe('b');
  });
});

describe('setActiveKey', () => {
  it('errors when the provider is missing', () => {
    expect(setActiveKey({}, 'nope', 'x')).toEqual({
      ok: false,
      message: 'Provider "nope" not found',
    });
  });

  it('switches the active key and mirrors its secret', () => {
    const providers: ProvidersRecord = {
      openai: {
        type: 'openai',
        activeKey: 'a',
        apiKeys: [
          { label: 'a', apiKey: 'ka', createdAt: NOW },
          { label: 'b', apiKey: 'kb', createdAt: NOW },
        ],
      },
    };
    const r = setActiveKey(providers, 'openai', 'b');
    expect(r.ok).toBe(true);
    expect(providers.openai?.activeKey).toBe('b');
    expect(providers.openai?.apiKey).toBe('kb');
  });
});

describe('addProvider', () => {
  it('rejects an existing provider', () => {
    const providers: ProvidersRecord = { openai: { type: 'openai' } };
    expect(addProvider(providers, { id: 'openai', family: 'openai' }, NOW)).toEqual({
      ok: false,
      message: 'Provider "openai" already exists. Use key.add to add a key.',
    });
  });

  it('adds a bare provider', () => {
    const providers: ProvidersRecord = {};
    const r = addProvider(providers, { id: 'groq', family: 'openai', baseUrl: 'https://x' }, NOW);
    expect(r.ok).toBe(true);
    expect(providers.groq).toEqual({ type: 'groq', family: 'openai', baseUrl: 'https://x' });
  });

  it('seeds a default key when one is supplied', () => {
    const providers: ProvidersRecord = {};
    addProvider(providers, { id: 'groq', family: 'openai', apiKey: 'gk' }, NOW);
    expect(providers.groq?.activeKey).toBe('default');
    expect(providers.groq?.apiKeys).toEqual([{ label: 'default', apiKey: 'gk', createdAt: NOW }]);
  });
});

describe('removeProvider', () => {
  it('errors when the provider is missing', () => {
    expect(removeProvider({}, 'nope')).toEqual({ ok: false, message: 'Provider "nope" not found' });
  });

  it('removes the provider', () => {
    const providers: ProvidersRecord = { openai: { type: 'openai' } };
    const r = removeProvider(providers, 'openai');
    expect(r.ok).toBe(true);
    expect(providers.openai).toBeUndefined();
  });
});
