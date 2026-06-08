import { expectDefined } from '@wrongstack/core';
import type { Plugin } from '@wrongstack/core';
import { TelegramBot } from './bot.js';
import type { TelegramIncomingMessage } from './bot.js';
import { truncateForTelegram } from './bot.js';
import { PLUGIN_NAME, readTelegramConfig, telegramConfigSchema } from './config.js';
import { formatDelegateCompleted, formatSessionEnded, formatToolExecuted } from './format.js';
import type { SessionEndedLike, ToolExecutedLike } from './format.js';
import { registerSlashCommands } from './slash-commands/index.js';
import { makeTelegramReadTool } from './tools/telegram-read.js';
import { makeTelegramSendTool } from './tools/telegram-send.js';
// ---------------------------------------------------------------------------
// Teardown state
// ---------------------------------------------------------------------------

let teardownState: {
  offs: Array<() => void>;
  toolNames: string[];
  commandNames: string[];
  bot: TelegramBot;
} | null = null;

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

    // ---- Bot ----
    const bot = new TelegramBot({
      token: cfg.botToken,
      pollIntervalSec: cfg.pollIntervalSec ?? 2,
      allowedUsers: new Set((cfg.allowedUsers ?? []).map(String)),
      allowedChats: new Set((cfg.allowedChats ?? []).map(String)),
      bufferSize: 50,
      log,
      offsetStoragePath: cfg.offsetStoragePath,
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
      defaultChatId: cfg.notifyChatId,
      maxMessageLength: cfg.maxMessageLength ?? 4000,
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

    // Notify on session end — humanized multi-line summary
    if (cfg.notifyOnSessionEnd && cfg.notifyChatId) {
      offs.push(
        api.events.on('session.ended', (event) => {
          const payload: SessionEndedLike = {
            id: event.id,
            inputTokens: event.usage.input,
            outputTokens: event.usage.output,
            cacheRead: event.usage.cacheRead,
            cacheWrite: event.usage.cacheWrite,
          };
          const msg = truncateForTelegram(
            formatSessionEnded(payload),
            cfg.maxMessageLength,
          );
          void bot.sendMessage(expectDefined(cfg.notifyChatId), msg).catch((err) => {
            log.debug(`Failed to send session end notification: ${(err as Error).message}`);
          });
        }),
      );
    }

    // Notify for long-running tools — humanized output, not raw JSON
    if (cfg.longToolThresholdMs && cfg.longToolThresholdMs > 0 && cfg.notifyChatId) {
      offs.push(
        api.events.on('tool.executed', (event) => {
          if (event.durationMs < expectDefined(cfg.longToolThresholdMs)) return;
          const payload: ToolExecutedLike = {
            name: event.name,
            ok: event.ok,
            durationMs: event.durationMs,
            output: event.output,
          };
          const msg = truncateForTelegram(
            formatToolExecuted(payload),
            cfg.maxMessageLength,
          );
          void bot.sendMessage(expectDefined(cfg.notifyChatId), msg).catch((err) => {
            log.debug(`Failed to send tool notification: ${(err as Error).message}`);
          });
        }),
      );
    }

    // Notify (humanized) when a delegated subagent finishes. The generic
    // `tool.executed` notifier would dump the delegate's truncated JSON
    // result; `delegate.completed` carries readable fields instead.
    if (cfg.notifyOnDelegate && cfg.notifyChatId) {
      offs.push(
        api.events.on('delegate.completed', (event) => {
          const msg = truncateForTelegram(
            formatDelegateCompleted(event),
            cfg.maxMessageLength,
          );
          void bot.sendMessage(expectDefined(cfg.notifyChatId), msg).catch((err) => {
            log.debug(`Failed to send delegate notification: ${(err as Error).message}`);
          });
        }),
      );
    }

    // ---- Start polling ----
    bot.start();

    teardownState = { offs, toolNames: [sendTool.name, readTool.name], commandNames, bot };

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
