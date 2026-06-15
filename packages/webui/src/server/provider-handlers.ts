import type { WebSocket } from 'ws';
import type { ProviderConfig } from '@wrongstack/core';
import { loadSavedProviders, saveProviders } from './provider-config-io.js';
import { toErrorMessage } from '@wrongstack/core/utils';
import {
  upsertKey as upsertKeyRecord,
  deleteKey as deleteKeyRecord,
  setActiveKey as setActiveKeyRecord,
  addProvider as addProviderRecord,
  removeProvider as removeProviderRecord,
  maskedKey,
  normalizeKeys,
} from './provider-keys.js';
import type { ConnectedClient, WSServerMessage } from './types.js';
import { sendResult, errMessage } from './ws-utils.js';

export interface ProviderHandlerDeps {
  globalConfigPath: string;
  vault: import('@wrongstack/core').SecretVault;
  /** Shared config write lock — serialized via chained promises */
  setConfigWriteLock: (lock: Promise<void>) => void;
  getConfigWriteLock: () => Promise<void>;
  /** Broadcast a message to all connected WebUI clients */
  broadcast: (clients: Map<WebSocket, ConnectedClient>, msg: WSServerMessage) => void;
  /** Connected WebUI clients map */
  clients: Map<WebSocket, ConnectedClient>;
}

export function createProviderHandlers(deps: ProviderHandlerDeps) {
  const { globalConfigPath, vault, broadcast, clients } = deps;
  let configWriteLock = deps.getConfigWriteLock();

  async function loadConfigProviders(): Promise<Record<string, ProviderConfig>> {
    return loadSavedProviders(globalConfigPath, vault);
  }

  async function saveConfigProviders(providers: Record<string, ProviderConfig>): Promise<void> {
    const next = configWriteLock
      .then(() => saveProviders(globalConfigPath, vault, providers))
      .catch((err) => {
        const msg = toErrorMessage(err);
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
      if (result.ok) {
        console.log(`[WebUI] Provider "${payload.id}" added via provider.add`);
        broadcast(clients, {
          type: 'providers.saved',
          payload: {
            providers: Object.entries(providers).map(([id, cfg]) => {
              const keys = normalizeKeys(cfg);
              return {
                id,
                family: cfg.family ?? id,
                baseUrl: cfg.baseUrl,
                apiKeys: keys.map((k) => ({
                  label: k.label,
                  maskedKey: maskedKey(k.apiKey),
                  isActive: k.label === cfg.activeKey,
                  createdAt: k.createdAt,
                })),
              };
            }),
          },
        });
      }
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
