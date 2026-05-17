import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, PLUGIN_NAME, readTelegramConfig } from '../../src/config.js';

describe('telegram config', () => {
  it('returns defaults when no plugin options are set', () => {
    const api = { config: {} };
    const cfg = readTelegramConfig(api as Parameters<typeof readTelegramConfig>[0]);
    expect(cfg.pollIntervalSec).toBe(2);
    expect(cfg.notifyOnSessionEnd).toBe(false);
    expect(cfg.longToolThresholdMs).toBe(30_000);
    expect(cfg.maxMessageLength).toBe(4000);
    expect(cfg.allowedUsers).toEqual([]);
    expect(cfg.allowedChats).toEqual([]);
  });

  it('overrides defaults with user config', () => {
    const api = {
      config: {
        extensions: {
          [PLUGIN_NAME]: {
            botToken: 'token123',
            notifyChatId: '999',
            pollIntervalSec: 5,
            notifyOnSessionEnd: true,
            longToolThresholdMs: 60_000,
            maxMessageLength: 2000,
            allowedUsers: [123, 456],
            allowedChats: ['789'],
          },
        },
      },
    };
    const cfg = readTelegramConfig(api as Parameters<typeof readTelegramConfig>[0]);
    expect(cfg.botToken).toBe('token123');
    expect(cfg.notifyChatId).toBe('999');
    expect(cfg.pollIntervalSec).toBe(5);
    expect(cfg.notifyOnSessionEnd).toBe(true);
    expect(cfg.longToolThresholdMs).toBe(60_000);
    expect(cfg.maxMessageLength).toBe(2000);
    expect(cfg.allowedUsers).toEqual([123, 456]);
    expect(cfg.allowedChats).toEqual(['789']);
  });

  it('keeps legacy plugins.telegram options working', () => {
    const api = {
      config: {
        plugins: {
          [PLUGIN_NAME]: {
            botToken: 'legacy-token',
            notifyChatId: '111',
          },
        },
      },
    };
    const cfg = readTelegramConfig(api as Parameters<typeof readTelegramConfig>[0]);
    expect(cfg.botToken).toBe('legacy-token');
    expect(cfg.notifyChatId).toBe('111');
  });

  it('reads options from plugin object entries', () => {
    const api = {
      config: {
        plugins: [
          {
            name: '@wrongstack/telegram',
            options: {
              botToken: 'entry-token',
              notifyChatId: '222',
              pollIntervalSec: 7,
            },
          },
        ],
      },
    };
    const cfg = readTelegramConfig(api as Parameters<typeof readTelegramConfig>[0]);
    expect(cfg.botToken).toBe('entry-token');
    expect(cfg.notifyChatId).toBe('222');
    expect(cfg.pollIntervalSec).toBe(7);
  });

  it('lets extensions override plugin object options', () => {
    const api = {
      config: {
        plugins: [
          {
            name: '@wrongstack/telegram',
            options: {
              botToken: 'entry-token',
              notifyChatId: '222',
            },
          },
        ],
        extensions: {
          [PLUGIN_NAME]: {
            notifyChatId: '333',
          },
        },
      },
    };
    const cfg = readTelegramConfig(api as Parameters<typeof readTelegramConfig>[0]);
    expect(cfg.botToken).toBe('entry-token');
    expect(cfg.notifyChatId).toBe('333');
  });

  it('partially overrides — missing fields stay at defaults', () => {
    const api = {
      config: {
        extensions: {
          [PLUGIN_NAME]: {
            botToken: 'token456',
          },
        },
      },
    };
    const cfg = readTelegramConfig(api as Parameters<typeof readTelegramConfig>[0]);
    expect(cfg.botToken).toBe('token456');
    expect(cfg.pollIntervalSec).toBe(2); // default
    expect(cfg.notifyOnSessionEnd).toBe(false); // default
    expect(cfg.allowedUsers).toEqual([]); // default
  });
});
