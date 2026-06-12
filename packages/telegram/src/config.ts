import type { PluginAPI } from '@wrongstack/core';

export const PLUGIN_NAME = 'telegram';

export interface TelegramPluginConfig {
  /** Telegram Bot API token (from @BotFather). */
  botToken: string;
  /**
   * Default chat ID for outgoing notifications.
   * The agent's `telegram_send` tool can override per-call.
   */
  notifyChatId?: string | number | undefined;
  /**
   * List of user/chat IDs allowed to interact with the bot.
   * Empty = allow all. Recommended to set in production.
   */
  allowedUsers?: Array<string | number> | undefined;
  /**
   * List of group/chat IDs the bot is allowed to read from.
   * Empty = allow all. Narrow this to prevent noise.
   */
  allowedChats?: Array<string | number> | undefined;
  /** Polling interval in seconds (default: 2). */
  pollIntervalSec?: number | undefined;
  /** Notify on Telegram when a session ends. */
  notifyOnSessionEnd?: boolean | undefined;
  /** Notify when a tool runs longer than this threshold (ms). Set 0 to disable. */
  longToolThresholdMs?: number | undefined;
  /** Notify (humanized) when a `delegate` subagent finishes. Default: true. */
  notifyOnDelegate?: boolean | undefined;
  /** Maximum message length for Telegram (Telegram caps at 4096). */
  maxMessageLength?: number | undefined;
  /**
   * Path to a file that stores the Telegram polling offset. When set,
   * the offset is persisted on every successful poll and restored on startup,
   * preventing message replay after crashes or restarts.
   * The directory must already exist and be writable.
   */
  offsetStoragePath?: string | undefined;
  /**
   * Elect a single poller per bot token across wstack instances (default:
   * true). Telegram allows one `getUpdates` consumer per token; without this,
   * two instances sharing a token fight and get HTTP 409 on every poll.
   * Extra instances stand by and take over when the active poller stops.
   * Set false only if this is guaranteed to be the sole consumer.
   */
  singleInstanceLock?: boolean | undefined;
}

export const DEFAULT_CONFIG: Required<Omit<TelegramPluginConfig, 'botToken' | 'notifyChatId' | 'offsetStoragePath'>> = {
  allowedUsers: [],
  allowedChats: [],
  pollIntervalSec: 2,
  notifyOnSessionEnd: false,
  longToolThresholdMs: 30_000,
  notifyOnDelegate: true,
  maxMessageLength: 4000,
  singleInstanceLock: true,
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
    notifyOnDelegate: { type: 'boolean' },
    maxMessageLength: { type: 'integer', minimum: 100, maximum: 4096 },
    singleInstanceLock: {
      type: 'boolean',
      description: 'Elect a single getUpdates poller per bot token across wstack instances (default true)',
    },
  },
  required: ['botToken'],
};

export function readTelegramConfig(
  api: Pick<PluginAPI, 'config'>,
): Required<Omit<TelegramPluginConfig, 'notifyChatId' | 'offsetStoragePath'>> &
  Pick<TelegramPluginConfig, 'notifyChatId' | 'offsetStoragePath'> {
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
      ((entry as { name?: unknown | undefined }).name === '@wrongstack/telegram' ||
        (entry as { name?: unknown | undefined }).name === PLUGIN_NAME),
  ) as { name?: unknown | undefined; options?: unknown | undefined } | undefined;
  return found?.options && typeof found.options === 'object'
    ? (found.options as TelegramPluginConfig)
    : undefined;
}
