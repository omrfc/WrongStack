import type { WebSocket } from 'ws';
import type { ProviderConfig } from '@wrongstack/core';
import { loadSavedProviders, saveProviders } from './provider-config-io.js';
import {
  upsertKey as upsertKeyRecord,
  deleteKey as deleteKeyRecord,
  setActiveKey as setActiveKeyRecord,
  addProvider as addProviderRecord,
  removeProvider as removeProviderRecord,
} from './provider-keys.js';
import type { WSServerMessage } from './types.js';
import { sendResult, errMessage } from './ws-utils.js';

export interface ProviderHandlerDeps {
  globalConfigPath: string;
  vault: import('@wrongstack/core').SecretVault;
  /** Shared config write lock — serialized via chained promises */
  setConfigWriteLock: (lock: Promise<void>) => void;
  getConfigWriteLock: () => Promise<void>;
}

export function createProviderHandlers(deps: ProviderHandlerDeps) {
  const { globalConfigPath, vault } = deps;
  let configWriteLock = deps.getConfigWriteLock();

  async function loadConfigProviders(): Promise<Record<string, ProviderConfig>> {
    return loadSavedProviders(globalConfigPath, vault);
  }

  async function saveConfigProviders(providers: Record<string, ProviderConfig>): Promise<void> {
    const next = configWriteLock
      .then(() => saveProviders(globalConfigPath, vault, providers))
      .catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(JSON.stringify({
          level: 'error',
          event: 'webui.provider_save_failed',
          message: msg,
          timestamp: new Date().toISOString(),
        }));
      });
    configWriteLock = next;
    deps.setConfigWriteLock(next);
    await next;
  }

  async function handleKeyUpsert(ws: WebSocket, providerId: string, label: string, apiKey: string): Promise<void> {
    try {
      const providers = await loadConfigProviders();
      const result = upsertKeyRecord(providers, providerId, label, apiKey, new Date().toISOString());
      if (result.ok) await saveConfigProviders(providers);
      sendResult(ws, result.ok, result.message);
    } catch (err) {
      sendResult(ws, false, errMessage(err));
    }
  }

  async function handleKeyDelete(ws: WebSocket, providerId: string, label: string): Promise<void> {
    try {
      const providers = await loadConfigProviders();
      const result = deleteKeyRecord(providers, providerId, label);
      if (result.ok) await saveConfigProviders(providers);
      sendResult(ws, result.ok, result.message);
    } catch (err) {
      sendResult(ws, false, errMessage(err));
    }
  }

  async function handleKeySetActive(ws: WebSocket, providerId: string, label: string): Promise<void> {
    try {
      const providers = await loadConfigProviders();
      const result = setActiveKeyRecord(providers, providerId, label);
      if (result.ok) await saveConfigProviders(providers);
      sendResult(ws, result.ok, result.message);
    } catch (err) {
      sendResult(ws, false, errMessage(err));
    }
  }

  async function handleProviderAdd(ws: WebSocket, payload: { id: string; family: string; baseUrl?: string | undefined; apiKey?: string | undefined }): Promise<void> {
    try {
      const providers = await loadConfigProviders();
      const result = addProviderRecord(providers, payload, new Date().toISOString());
      if (result.ok) await saveConfigProviders(providers);
      sendResult(ws, result.ok, result.message);
    } catch (err) {
      sendResult(ws, false, errMessage(err));
    }
  }

  async function handleProviderRemove(ws: WebSocket, providerId: string): Promise<void> {
    try {
      const providers = await loadConfigProviders();
      const result = removeProviderRecord(providers, providerId);
      if (result.ok) await saveConfigProviders(providers);
      sendResult(ws, result.ok, result.message);
    } catch (err) {
      sendResult(ws, false, errMessage(err));
    }
  }

  return { handleKeyUpsert, handleKeyDelete, handleKeySetActive, handleProviderAdd, handleProviderRemove, loadConfigProviders };
}
