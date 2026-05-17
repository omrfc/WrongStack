import type { PluginAPI } from '@wrongstack/core';

export const PLUGIN_NAME = 'telegram';

export interface TelegramPluginConfig {
  /** Telegram Bot API token (from @BotFather). */
  botToken: string;
  /**
   * Default chat ID for outgoing notifications.
   * The agent's `telegram_send` tool can override per-call.
   */
  notifyChatId?: string | number;
  /**
   * List of user/chat IDs allowed to interact with the bot.
   * Empty = allow all. Recommended to set in production.
   */
  allowedUsers?: Array<string | number>;
  /**
   * List of group/chat IDs the bot is allowed to read from.
   * Empty = allow all. Narrow this to prevent noise.
   */
  allowedChats?: Array<string | number>;
  /** Polling interval in seconds (default: 2). */
  pollIntervalSec?: number;
  /** Notify on Telegram when a session ends. */
  notifyOnSessionEnd?: boolean;
  /** Notify when a tool runs longer than this threshold (ms). Set 0 to disable. */
  longToolThresholdMs?: number;
  /** Maximum message length for Telegram (Telegram caps at 4096). */
  maxMessageLength?: number;
}

export const DEFAULT_CONFIG: Required<Omit<TelegramPluginConfig, 'botToken' | 'notifyChatId'>> = {
  allowedUsers: [],
  allowedChats: [],
  pollIntervalSec: 2,
  notifyOnSessionEnd: false,
  longToolThresholdMs: 30_000,
  maxMessageLength: 4000,
};

export const telegramConfigSchema = {
  type: 'object',
  properties: {
    botToken: { type: 'string', description: 'Telegram Bot API token from @BotFather' },
    notifyChatId: {
      oneOf: [{ type: 'string' }, { type: 'integer' }],
      description: 'Default chat ID for outgoing notifications',
    },
    allowedUsers: {
      type: 'array',
      items: { oneOf: [{ type: 'string' }, { type: 'integer' }] },
      description: 'User IDs allowed to interact with the bot',
    },
    allowedChats: {
      type: 'array',
      items: { oneOf: [{ type: 'string' }, { type: 'integer' }] },
      description: 'Chat IDs the bot is allowed to read from',
    },
    pollIntervalSec: {
      type: 'integer',
      minimum: 1,
      maximum: 60,
      description: 'Polling interval in seconds',
    },
    notifyOnSessionEnd: { type: 'boolean' },
    longToolThresholdMs: { type: 'integer', minimum: 0 },
    maxMessageLength: { type: 'integer', minimum: 100, maximum: 4096 },
  },
  required: ['botToken'],
};

export function readTelegramConfig(
  api: Pick<PluginAPI, 'config'>,
): Required<Omit<TelegramPluginConfig, 'notifyChatId'>> & Pick<TelegramPluginConfig, 'notifyChatId'> {
  const config = api.config as unknown as Record<string, unknown>;
  const extensions = config.extensions as Record<string, unknown> | undefined;
  const pluginEntries = config.plugins;
  const legacyPlugins = pluginEntries as Record<string, unknown> | undefined;
  const legacyOpts =
    legacyPlugins && !Array.isArray(legacyPlugins) ? legacyPlugins[PLUGIN_NAME] : undefined;
  const entryOpts = pluginOptionsFromEntries(pluginEntries);
  const opts = {
    ...((legacyOpts ?? entryOpts) as TelegramPluginConfig),
    ...((extensions?.[PLUGIN_NAME] ?? {}) as TelegramPluginConfig),
  };
  return {
    ...DEFAULT_CONFIG,
    ...opts,
  };
}

function pluginOptionsFromEntries(entries: unknown): TelegramPluginConfig | undefined {
  if (!Array.isArray(entries)) return undefined;
  const found = entries.find(
    (entry) =>
      typeof entry === 'object' &&
      entry !== null &&
      'name' in entry &&
      ((entry as { name?: unknown }).name === '@wrongstack/telegram' ||
        (entry as { name?: unknown }).name === PLUGIN_NAME),
  ) as { name?: unknown; options?: unknown } | undefined;
  return found?.options && typeof found.options === 'object'
    ? (found.options as TelegramPluginConfig)
    : undefined;
}
