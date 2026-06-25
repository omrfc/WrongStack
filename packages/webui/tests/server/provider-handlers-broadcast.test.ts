import type { ProviderConfig, SecretVault } from '@wrongstack/core';
import type { WebSocket } from 'ws';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createProviderHandlers } from '../../src/server/provider-handlers.js';

const mockLoadSavedProviders = vi.hoisted(() => vi.fn());
const mockSaveProviders = vi.hoisted(() => vi.fn());

vi.mock('../../src/server/provider-config-io.js', () => ({
  loadSavedProviders: mockLoadSavedProviders,
  saveProviders: mockSaveProviders,
}));

function cloneProviders(input: Record<string, ProviderConfig>): Record<string, ProviderConfig> {
  return JSON.parse(JSON.stringify(input)) as Record<string, ProviderConfig>;
}

function mockWs(): WebSocket & { send: ReturnType<typeof vi.fn> } {
  return {
    readyState: 1,
    send: vi.fn(),
  } as never as WebSocket & { send: ReturnType<typeof vi.fn> };
}

function makeHandlers() {
  const clients = new Map<WebSocket, never>();
  const broadcast = vi.fn();
  const handlers = createProviderHandlers({
    globalConfigPath: '/tmp/config.json',
    vault: {} as SecretVault,
    getConfigWriteLock: () => Promise.resolve(),
    setConfigWriteLock: vi.fn(),
    broadcast,
    clients,
  });
  return { handlers, broadcast, clients };
}

const providers: Record<string, ProviderConfig> = {
  local: {
    type: 'openai-compatible',
    family: 'openai-compatible',
    baseUrl: 'http://localhost:11434/v1',
    models: ['llama3.1:8b', 'qwen2.5:7b'],
    activeKey: 'primary',
    apiKeys: [
      { label: 'primary', apiKey: 'sk-primary-secret', createdAt: '2026-06-01T00:00:00.000Z' },
      { label: 'backup', apiKey: 'sk-backup-secret', createdAt: '2026-06-02T00:00:00.000Z' },
    ],
  },
};

describe('createProviderHandlers saved-provider broadcasts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSaveProviders.mockResolvedValue(undefined);
  });

  it('broadcasts a fresh saved-provider projection after a successful key mutation', async () => {
    mockLoadSavedProviders.mockResolvedValueOnce(cloneProviders(providers));
    const ws = mockWs();
    const { handlers, broadcast, clients } = makeHandlers();

    await handlers.handleKeySetActive(ws, 'local', 'backup');

    expect(mockSaveProviders).toHaveBeenCalledOnce();
    expect(broadcast).toHaveBeenCalledWith(clients, {
      type: 'providers.saved',
      payload: {
        providers: [
          {
            id: 'local',
            family: 'openai-compatible',
            baseUrl: 'http://localhost:11434/v1',
            models: ['llama3.1:8b', 'qwen2.5:7b'],
            pickedModelId: 'llama3.1:8b',
            apiKeys: [
              {
                label: 'primary',
                maskedKey: 'sk-p…cret',
                isActive: false,
                createdAt: '2026-06-01T00:00:00.000Z',
              },
              {
                label: 'backup',
                maskedKey: 'sk-b…cret',
                isActive: true,
                createdAt: '2026-06-02T00:00:00.000Z',
              },
            ],
          },
        ],
      },
    });
  });

  it('does not broadcast when a provider mutation fails validation', async () => {
    mockLoadSavedProviders.mockResolvedValueOnce({});
    const ws = mockWs();
    const { handlers, broadcast } = makeHandlers();

    await handlers.handleProviderRemove(ws, 'missing');

    expect(mockSaveProviders).not.toHaveBeenCalled();
    expect(broadcast).not.toHaveBeenCalled();
  });
});
