import type { WebSocket } from 'ws';
import { describe, expect, it, vi } from 'vitest';
import { handleProviderRoute, type ProviderRouteHandlers } from '../../src/server/provider-routes.js';

function mockWs() {
  return {
    readyState: 1,
    send: vi.fn(),
  } as never as WebSocket & { send: ReturnType<typeof vi.fn> };
}

function sentMessages(ws: ReturnType<typeof mockWs>) {
  return ws.send.mock.calls.map(([raw]) => JSON.parse(String(raw)) as { type: string; payload: { success?: boolean; message?: string } });
}

function routes(): ProviderRouteHandlers {
  return {
    listProviders: vi.fn(async () => undefined),
    listSavedProviders: vi.fn(async () => undefined),
    listProviderModels: vi.fn(async () => undefined),
    switchModel: vi.fn(async () => undefined),
    refineModel: vi.fn(async () => undefined),
    providerHandlers: {
      loadConfigProviders: vi.fn(async () => ({})),
      handleKeyUpsert: vi.fn(async () => undefined),
      handleKeyDelete: vi.fn(async () => undefined),
      handleKeySetActive: vi.fn(async () => undefined),
      handleProviderAdd: vi.fn(async () => undefined),
      handleProviderRemove: vi.fn(async () => undefined),
      handleProviderClearModels: vi.fn(async () => undefined),
      handleProviderUndoClear: vi.fn(async () => undefined),
      handleProviderUpdate: vi.fn(async () => undefined),
      handleProviderProbe: vi.fn(async () => undefined),
    } as never as ProviderRouteHandlers['providerHandlers'],
  };
}

describe('handleProviderRoute malformed payload characterization', () => {
  it('returns false and does not send for non-provider message types', async () => {
    const ws = mockWs();
    const deps = routes();

    await expect(handleProviderRoute(ws, { type: 'sessions.list', payload: {} }, deps)).resolves.toBe(false);

    expect(ws.send).not.toHaveBeenCalled();
  });

  it.each([
    ['key.add', {}],
    ['key.update', { providerId: 'anthropic', label: 'main' }],
    ['key.delete', { providerId: 'anthropic' }],
    ['key.set_active', { providerId: 'anthropic', label: '' }],
    ['provider.add', { id: 'custom' }],
    ['provider.remove', { providerId: 123 }],
    ['provider.clear_models', null],
    ['provider.undo_clear', { providerId: 'custom', previousModels: [123] }],
    ['provider.update', { id: 'custom', models: 'claude' }],
    ['provider.probe', { providerId: 'custom', timeoutMs: Number.NaN }],
  ])('handles malformed %s payload without invoking provider handlers', async (type, payload) => {
    const ws = mockWs();
    const deps = routes();

    await expect(handleProviderRoute(ws, { type, payload }, deps)).resolves.toBe(true);

    expect(sentMessages(ws)).toEqual([
      {
        type: 'key.operation_result',
        payload: { success: false, message: `${type} payload is invalid` },
      },
    ]);
    for (const handler of [
      deps.providerHandlers.handleKeyUpsert,
      deps.providerHandlers.handleKeyDelete,
      deps.providerHandlers.handleKeySetActive,
      deps.providerHandlers.handleProviderAdd,
      deps.providerHandlers.handleProviderRemove,
      deps.providerHandlers.handleProviderClearModels,
      deps.providerHandlers.handleProviderUndoClear,
      deps.providerHandlers.handleProviderUpdate,
      deps.providerHandlers.handleProviderProbe,
    ]) {
      expect(handler).not.toHaveBeenCalled();
    }
  });

  it('dispatches valid provider.remove payloads to the provider handler', async () => {
    const ws = mockWs();
    const deps = routes();

    await expect(
      handleProviderRoute(ws, { type: 'provider.remove', payload: { providerId: 'custom' } }, deps),
    ).resolves.toBe(true);

    expect(deps.providerHandlers.handleProviderRemove).toHaveBeenCalledWith(ws, 'custom');
    expect(ws.send).not.toHaveBeenCalled();
  });
});
