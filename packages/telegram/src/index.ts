import { expectDefined } from '@wrongstack/core';
import type { Config, Plugin } from '@wrongstack/core';
import { TelegramBot } from './bot.js';
import type { TelegramIncomingMessage } from './bot.js';
import { truncateForTelegram } from './bot.js';
import { PLUGIN_NAME, readTelegramConfig, telegramConfigSchema } from './config.js';
import { formatDelegateCompleted, formatSessionEnded, formatToolExecuted } from './format.js';
import type { SessionEndedLike, ToolExecutedLike } from './format.js';
import { PollLock, lockPathForToken } from './poll-lock.js';
import { registerSlashCommands } from './slash-commands/index.js';
import { makeTelegramReadTool } from './tools/telegram-read.js';
import { makeTelegramSendTool } from './tools/telegram-send.js';
// ---------------------------------------------------------------------------
// Teardown state
// ---------------------------------------------------------------------------

/** Mutable runtime config — updated via api.onConfigChange so changes take
 * effect without restarting the plugin. */
interface RuntimeConfig {
  notifyChatId: string | number | undefined;
  notifyOnSessionEnd: boolean;
  notifyOnDelegate: boolean;
  longToolThresholdMs: number;
  maxMessageLength: number;
}

let teardownState: {
  offs: Array<() => void>;
  toolNames: string[];
  commandNames: string[];
  bot: TelegramBot;
  runtimeCfg: RuntimeConfig;
} | null = null;

/** Read the Telegram section from a full Config object. */
function telegramFromConfig(cfg: Config): {
  notifyChatId: string | number | undefined;
  notifyOnSessionEnd: boolean;
  notifyOnDelegate: boolean;
  longToolThresholdMs: number;
  maxMessageLength: number;
} {
  const ext = (cfg.extensions as Record<string, Record<string, unknown>> | undefined)?.[PLUGIN_NAME] ?? {};
  return {
    notifyChatId:
      ext.notifyChatId !== undefined ? String(ext.notifyChatId) : undefined,
    notifyOnSessionEnd: ext.notifyOnSessionEnd === true,
    notifyOnDelegate: ext.notifyOnDelegate !== false, // default true
    longToolThresholdMs:
      typeof ext.longToolThresholdMs === 'number' ? ext.longToolThresholdMs : 30_000,
    maxMessageLength:
      typeof ext.maxMessageLength === 'number' ? ext.maxMessageLength : 4000,
  };
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

const plugin: Plugin = {
  name: PLUGIN_NAME,
  version: '0.3.4',
  description: 'Telegram bridge — send/receive messages, get agent notifications.',
  apiVersion: '^0.1.10',
  capabilities: {
    tools: true,
    slashCommands: true,
    pipelines: [],
  },
  configSchema: telegramConfigSchema,
  defaultConfig: {
    pollIntervalSec: 2,
    notifyOnSessionEnd: false,
    longToolThresholdMs: 30_000,
    maxMessageLength: 4000,
  },

  async setup(api) {
    const cfg = readTelegramConfig(api);
    const log = api.log;

    log.info('Starting Telegram plugin...');

    // ---- Mutable runtime config (updated via onConfigChange) ----
    const runtimeCfg: RuntimeConfig = {
      notifyChatId: cfg.notifyChatId,
      notifyOnSessionEnd: cfg.notifyOnSessionEnd ?? false,
      notifyOnDelegate: cfg.notifyOnDelegate ?? true,
      longToolThresholdMs: cfg.longToolThresholdMs ?? 30_000,
      maxMessageLength: cfg.maxMessageLength ?? 4000,
    };

    // ---- Bot ----
    // Telegram allows one getUpdates consumer per token: elect a single
    // poller across wstack instances so concurrent TUI/WebUI/projects don't
    // fight over the token (HTTP 409 on every poll).
    const lock =
      cfg.singleInstanceLock === false
        ? undefined
        : new PollLock(lockPathForToken(cfg.botToken), { log });
    const bot = new TelegramBot({
      token: cfg.botToken,
      pollIntervalSec: cfg.pollIntervalSec ?? 2,
      allowedUsers: new Set((cfg.allowedUsers ?? []).map(String)),
      allowedChats: new Set((cfg.allowedChats ?? []).map(String)),
      bufferSize: 50,
      log,
      offsetStoragePath: cfg.offsetStoragePath,
      lock,
      onMessage(msg: TelegramIncomingMessage) {
        // Emit custom event so other plugins or the host can react.
        // The TUI can subscribe and surface it (future hook).
        api.emitCustom('telegram:message_received', msg);

        // Log it for the user in the TUI
        const who = msg.userName ?? msg.userId ?? 'unknown';
        log.info(`📨 Telegram: ${who} (chat=${msg.chatId}): ${msg.text.slice(0, 200)}`);
      },
    });

    // ---- Register tools ----
    const sendTool = makeTelegramSendTool({
      bot,
      getDefaultChatId: () => runtimeCfg.notifyChatId,
      maxMessageLength: runtimeCfg.maxMessageLength,
      log,
    });
    const readTool = makeTelegramReadTool({ bot });
    api.tools.register(sendTool);
    api.tools.register(readTool);

    // ---- Event subscriptions ----
    const offs: Array<() => void> = [];

    // System prompt contributor — inject unread Telegram messages
    const unregisterPrompt = api.registerSystemPromptContributor(async () => {
      const msgs = bot.getMessages({ limit: 5 });
      if (msgs.length === 0) return [];

      const blocks: Array<{ type: 'text'; text: string }> = [
        {
          type: 'text',
          text: [
            '## Telegram Inbox',
            `You have ${bot.bufferCount} unread Telegram message(s).`,
            'Read them with `telegram_read` and reply with `telegram_send`.',
            '',
            'Recent messages:',
            ...msgs.map((m) => {
              const who = m.userName ?? `user_${m.userId ?? 'unknown'}`;
              const ts = new Date(m.timestamp).toLocaleTimeString();
              return `- [${ts}] **${who}** (chat=${m.chatId}): ${m.text.slice(0, 200)}`;
            }),
            '',
          ].join('\n'),
        },
      ];
      return blocks;
    });
    offs.push(unregisterPrompt);

    // Register slash commands
    const commandNames = registerSlashCommands(api, bot, cfg);

    // ---- Notification event handlers ----
    // Always subscribed; guard at event time against runtime flags so changes
    // take effect immediately without needing to restart the plugin.

    offs.push(
      api.events.on('session.ended', (event) => {
        if (!runtimeCfg.notifyOnSessionEnd || !runtimeCfg.notifyChatId) return;
        const payload: SessionEndedLike = {
          id: event.id,
          inputTokens: event.usage.input,
          outputTokens: event.usage.output,
          cacheRead: event.usage.cacheRead,
          cacheWrite: event.usage.cacheWrite,
        };
        const msg = truncateForTelegram(
          formatSessionEnded(payload),
          runtimeCfg.maxMessageLength,
        );
        void bot.sendMessage(expectDefined(runtimeCfg.notifyChatId), msg).catch((err) => {
          log.debug(`Failed to send session end notification: ${(err as Error).message}`);
        });
      }),
    );

    offs.push(
      api.events.on('tool.executed', (event) => {
        if (
          !runtimeCfg.notifyChatId ||
          runtimeCfg.longToolThresholdMs <= 0 ||
          event.durationMs < runtimeCfg.longToolThresholdMs
        ) return;
        const payload: ToolExecutedLike = {
          name: event.name,
          ok: event.ok,
          durationMs: event.durationMs,
          output: event.output,
        };
        const msg = truncateForTelegram(
          formatToolExecuted(payload),
          runtimeCfg.maxMessageLength,
        );
        void bot.sendMessage(expectDefined(runtimeCfg.notifyChatId), msg).catch((err) => {
          log.debug(`Failed to send tool notification: ${(err as Error).message}`);
        });
      }),
    );

    offs.push(
      api.events.on('delegate.completed', (event) => {
        if (!runtimeCfg.notifyOnDelegate || !runtimeCfg.notifyChatId) return;
        const msg = truncateForTelegram(
          formatDelegateCompleted(event),
          runtimeCfg.maxMessageLength,
        );
        void bot.sendMessage(expectDefined(runtimeCfg.notifyChatId), msg).catch((err) => {
          log.debug(`Failed to send delegate notification: ${(err as Error).message}`);
        });
      }),
    );

    // ---- Live config updates ----
    // api.config is frozen at setup, but onConfigChange fires whenever the
    // ConfigStore is updated (from CLI /settings, WebUI prefSync, /telegram-settings).
    // Update the mutable runtime refs so all handlers pick up the new values
    // on the next event — no restart needed.
    const unlistenConfig = api.onConfigChange((next, _prev) => {
      const fresh = telegramFromConfig(next);
      runtimeCfg.notifyChatId = fresh.notifyChatId;
      runtimeCfg.notifyOnSessionEnd = fresh.notifyOnSessionEnd;
      runtimeCfg.notifyOnDelegate = fresh.notifyOnDelegate;
      runtimeCfg.longToolThresholdMs = fresh.longToolThresholdMs;
      runtimeCfg.maxMessageLength = fresh.maxMessageLength;
      log.debug('Telegram notification settings updated from config', {
        notifyOnSessionEnd: runtimeCfg.notifyOnSessionEnd,
        notifyOnDelegate: runtimeCfg.notifyOnDelegate,
        longToolThresholdMs: runtimeCfg.longToolThresholdMs,
        notifyChatId: runtimeCfg.notifyChatId ?? 'not set',
      });
    });
    offs.push(unlistenConfig);

    // ---- Start polling ----
    bot.start();

    teardownState = {
      offs,
      toolNames: [sendTool.name, readTool.name],
      commandNames,
      bot,
      runtimeCfg,
    };

    log.info('Telegram plugin ready');
  },

  async teardown(api) {
    const state = teardownState;
    if (!state) return;
    teardownState = null;

    state.bot.stop();
    for (const off of state.offs) off();
    for (const name of state.toolNames) api.tools.unregister(name);
    for (const name of state.commandNames) {
      api.slashCommands.unregister(`${PLUGIN_NAME}:${name}`);
    }

    api.log.info('Telegram plugin torn down');
  },

  async health() {
    const state = teardownState;
    if (!state?.bot) return { ok: false, message: 'Plugin not initialized' };
    const h = await state.bot.health();
    return h;
  },
};

export default plugin;

// Re-export the types consumers may want
export type { TelegramIncomingMessage } from './bot.js';
export type { TelegramPluginConfig } from './config.js';
