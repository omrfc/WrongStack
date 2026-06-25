import type { WebSocket } from 'ws';
import type { ProviderConfig } from '@wrongstack/core';
import { DefaultSecretScrubber } from '@wrongstack/core';
import { probeLocalLlm } from '@wrongstack/runtime/probe';
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
import { send, sendResult, errMessage } from './ws-utils.js';

/**
 * Wire shape of one saved provider as broadcast over `providers.saved`.
 * The WebUI's `<ProviderModelsPanel>` consumes this — when
 * `pickedModelId` / `models` is missing, the panel renders the empty
 * state.
 */
export interface SavedProviderView {
  id: string;
  family?: string | undefined;
  baseUrl?: string | undefined;
  /** Saved model allowlist, verbatim (undefined / [] both possible). */
  models?: string[] | undefined;
  /** First entry of `models`, or undefined when the list is empty/unset. */
  pickedModelId?: string | undefined;
  apiKeys: Array<{
    label: string;
    maskedKey: string;
    isActive: boolean;
    createdAt: string;
  }>;
}

/**
 * Canonical projection from in-memory `ProviderConfig` to the
 * `providers.saved` wire shape. Pure (no I/O) so it's unit-tested in
 * isolation — see `tests/server/provider-handlers-projection.test.ts`.
 *
 * Secrets never leave: every key is run through `maskedKey` before it
 * reaches the wire.
 */
export function projectSavedProviders(
  providers: Record<string, ProviderConfig>,
): SavedProviderView[] {
  return Object.entries(providers).map(([id, cfg]) => {
    const keys = normalizeKeys(cfg);
    const models = cfg.models;
    const view: SavedProviderView = {
      id,
      family: cfg.family ?? id,
      baseUrl: cfg.baseUrl,
      models,
      apiKeys: keys.map((k) => ({
        label: k.label,
        maskedKey: maskedKey(k.apiKey),
        isActive: k.label === cfg.activeKey,
        createdAt: k.createdAt,
      })),
    };
    const picked = models && models.length > 0 ? models[0] : undefined;
    if (picked !== undefined) view.pickedModelId = picked;
    return view;
  });
}

/** Shared scrubber for probe error/body redaction. */
const probeScrubber = new DefaultSecretScrubber();

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
      if (result.ok) {
        await saveConfigProviders(providers);
        broadcastSaved(providers);
      }
      sendResult(ws, result.ok, result.message);
    } catch (err) {
      sendResult(ws, false, errMessage(err));
    }
  }

  async function handleKeyDelete(ws: WebSocket, providerId: string, label: string): Promise<void> {
    try {
      const providers = await loadConfigProviders();
      const result = deleteKeyRecord(providers, providerId, label);
      if (result.ok) {
        await saveConfigProviders(providers);
        broadcastSaved(providers);
      }
      sendResult(ws, result.ok, result.message);
    } catch (err) {
      sendResult(ws, false, errMessage(err));
    }
  }

  async function handleKeySetActive(ws: WebSocket, providerId: string, label: string): Promise<void> {
    try {
      const providers = await loadConfigProviders();
      const result = setActiveKeyRecord(providers, providerId, label);
      if (result.ok) {
        await saveConfigProviders(providers);
        broadcastSaved(providers);
      }
      sendResult(ws, result.ok, result.message);
    } catch (err) {
      sendResult(ws, false, errMessage(err));
    }
  }

  async function handleProviderAdd(ws: WebSocket, payload: { id: string; family: string; baseUrl?: string | undefined; apiKey?: string | undefined }): Promise<void> {
    try {
      const providers = await loadConfigProviders();
      const result = addProviderRecord(providers, payload, new Date().toISOString());
      if (result.ok) {
        await saveConfigProviders(providers);
        broadcastSaved(providers);
      }
      sendResult(ws, result.ok, result.message);
      if (result.ok) {
        console.log(`[WebUI] Provider "${payload.id}" added via provider.add`);
      }
    } catch (err) {
      sendResult(ws, false, errMessage(err));
    }
  }

  async function handleProviderRemove(ws: WebSocket, providerId: string): Promise<void> {
    try {
      const providers = await loadConfigProviders();
      const result = removeProviderRecord(providers, providerId);
      if (result.ok) {
        await saveConfigProviders(providers);
        broadcastSaved(providers);
      }
      sendResult(ws, result.ok, result.message);
    } catch (err) {
      sendResult(ws, false, errMessage(err));
    }
  }

  /** Broadcast the current saved-provider list to every connected client. */
  function broadcastSaved(providers: Record<string, ProviderConfig>): void {
    broadcast(clients, {
      type: 'providers.saved',
      payload: { providers: projectSavedProviders(providers) },
    });
  }

  /** Remove the saved model allowlist for a provider. */
  async function handleProviderClearModels(ws: WebSocket, providerId: string): Promise<void> {
    try {
      const providers = await loadConfigProviders();
      const cfg = providers[providerId];
      if (!cfg) {
        sendResult(ws, false, `Unknown provider "${providerId}"`);
        return;
      }
      delete cfg.models;
      await saveConfigProviders(providers);
      sendResult(ws, true, `Cleared model allowlist for ${providerId}`);
      broadcastSaved(providers);
    } catch (err) {
      sendResult(ws, false, errMessage(err));
    }
  }

  /** Restore a previously-cleared model allowlist (pairs with clear). */
  async function handleProviderUndoClear(
    ws: WebSocket,
    providerId: string,
    previousModels: string[],
  ): Promise<void> {
    try {
      const providers = await loadConfigProviders();
      const cfg = providers[providerId];
      if (!cfg) {
        sendResult(ws, false, `Unknown provider "${providerId}"`);
        return;
      }
      cfg.models = [...previousModels];
      await saveConfigProviders(providers);
      sendResult(ws, true, `Restored ${previousModels.length} model(s) for ${providerId}`);
      broadcastSaved(providers);
    } catch (err) {
      sendResult(ws, false, errMessage(err));
    }
  }

  /** Update a saved provider's wire config (family / baseUrl / envVars / models). */
  async function handleProviderUpdate(
    ws: WebSocket,
    payload: {
      id: string;
      family?: string | undefined;
      baseUrl?: string | undefined;
      envVars?: string[] | undefined;
      models?: string[] | undefined;
    },
  ): Promise<void> {
    try {
      const providers = await loadConfigProviders();
      const cfg = providers[payload.id];
      if (!cfg) {
        sendResult(ws, false, `Unknown provider "${payload.id}"`);
        return;
      }
      if (payload.family !== undefined) cfg.family = payload.family as ProviderConfig['family'];
      if (payload.baseUrl !== undefined) cfg.baseUrl = payload.baseUrl;
      if (payload.envVars !== undefined) cfg.envVars = payload.envVars;
      if (payload.models !== undefined) cfg.models = payload.models;
      await saveConfigProviders(providers);
      sendResult(ws, true, `Updated ${payload.id}`);
      broadcastSaved(providers);
    } catch (err) {
      sendResult(ws, false, errMessage(err));
    }
  }

  /**
   * Run a health probe against a saved provider's `/v1/models` and
   * reply with a `provider.probe` message. Never throws — the
   * `ProbeResult` carries the failure mode in its `status`.
   */
  async function handleProviderProbe(
    ws: WebSocket,
    providerId: string,
    timeoutMs?: number,
  ): Promise<void> {
    const reply = (payload: Record<string, unknown>): void =>
      send(ws, { type: 'provider.probe', payload: { providerId, ...payload } });
    try {
      const providers = await loadConfigProviders();
      const cfg = providers[providerId];
      if (!cfg) {
        reply({ ok: false, status: 'no_provider' });
        return;
      }
      if (!cfg.baseUrl) {
        reply({ ok: false, status: 'no_base_url' });
        return;
      }
      const keys = normalizeKeys(cfg);
      const active = keys.find((k) => k.label === cfg.activeKey) ?? keys[0];
      const result = await probeLocalLlm({
        baseUrl: cfg.baseUrl,
        apiKey: active?.apiKey,
        noAuth: false,
        scrubber: probeScrubber,
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      });
      reply(result as never as Record<string, unknown>);
    } catch (err) {
      reply({ ok: false, status: 'unreachable', detail: errMessage(err) });
    }
  }

  return {
    handleKeyUpsert,
    handleKeyDelete,
    handleKeySetActive,
    handleProviderAdd,
    handleProviderRemove,
    handleProviderClearModels,
    handleProviderUndoClear,
    handleProviderUpdate,
    handleProviderProbe,
    loadConfigProviders,
  };
}
