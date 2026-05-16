import type { Plugin } from '@wrongstack/core';
import type { Logger } from '@wrongstack/core';
import { TelegramBot } from './bot.js';
import type { TelegramIncomingMessage } from './bot.js';
import { truncateForTelegram, escapeHtml } from './bot.js';
import { PLUGIN_NAME, readTelegramConfig, telegramConfigSchema } from './config.js';
import { registerSlashCommands } from './slash-commands/index.js';
import { makeTelegramSendTool } from './tools/telegram-send.js';

// ---------------------------------------------------------------------------
// Teardown state
// ---------------------------------------------------------------------------

let teardownState: {
  offs: Array<() => void>;
  toolName: string;
  commandNames: string[];
  bot: TelegramBot;
} | null = null;

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

const plugin: Plugin = {
  name: PLUGIN_NAME,
  version: '0.1.0',
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
      pollIntervalSec: cfg.pollIntervalSec,
      allowedUsers: new Set((cfg.allowedUsers ?? []).map(String)),
      allowedChats: new Set((cfg.allowedChats ?? []).map(String)),
      log,
      onMessage(msg: TelegramIncomingMessage) {
        // Emit custom event so other plugins or the host can react.
        // The TUI can subscribe and surface it (future hook).
        api.emitCustom('telegram:message_received', msg);

        // Log it for the user in the TUI
        const who = msg.userName ?? msg.userId ?? 'unknown';
        log.info(`📨 Telegram: ${who} (chat=${msg.chatId}): ${msg.text.slice(0, 200)}`);
      },
    });

    // ---- Register tool ----
    const sendTool = makeTelegramSendTool({
      bot,
      defaultChatId: cfg.notifyChatId,
      maxMessageLength: cfg.maxMessageLength,
      log,
    });
    api.tools.register(sendTool);

    // ---- Register slash commands ----
    const commandNames = registerSlashCommands(api, bot, cfg);

    // ---- Event subscriptions ----
    const offs: Array<() => void> = [];

    // Notify on session end
    if (cfg.notifyOnSessionEnd && cfg.notifyChatId) {
      offs.push(
        api.events.on('session.ended', (event) => {
          const inputTokens = event.usage.input ?? 0;
          const outputTokens = event.usage.output ?? 0;
          const totalTokens = inputTokens + outputTokens;
          const msg = [
            '✅ <b>Session ended</b>',
            '',
            `Session: <code>${event.id.slice(0, 8)}</code>`,
            `Input:  ${inputTokens} tokens`,
            `Output: ${outputTokens} tokens`,
            `Total:  ${totalTokens} tokens`,
          ].join('\n');

          void bot.sendMessage(cfg.notifyChatId!, msg).catch((err) => {
            log.warn(`Failed to send session end notification: ${(err as Error).message}`);
          });
        }),
      );
    }

    // Notify for long-running tools
    if (cfg.longToolThresholdMs && cfg.longToolThresholdMs > 0 && cfg.notifyChatId) {
      offs.push(
        api.events.on('tool.executed', (event) => {
          if (event.durationMs < cfg.longToolThresholdMs!) return;
          const sec = (event.durationMs / 1000).toFixed(1);
          const status = event.ok ? '✅' : '❌';
          const preview = event.output
            ? truncateForTelegram(escapeHtml(event.output), 500)
            : '(no output)';

          const msg = [
            `${status} <b>${escapeHtml(event.name)}</b> completed in ${sec}s`,
            '',
            `<pre>${preview}</pre>`,
          ].join('\n');

          void bot.sendMessage(cfg.notifyChatId!, msg).catch((err) => {
            log.warn(`Failed to send tool notification: ${(err as Error).message}`);
          });
        }),
      );
    }

    // ---- Start polling ----
    bot.start();

    teardownState = { offs, toolName: sendTool.name, commandNames, bot };

    log.info('Telegram plugin ready');
  },

  async teardown(api) {
    const state = teardownState;
    if (!state) return;
    teardownState = null;

    state.bot.stop();
    for (const off of state.offs) off();
    api.tools.unregister(state.toolName);
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
