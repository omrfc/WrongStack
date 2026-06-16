import type { Tool } from '@wrongstack/core';
import type { Logger } from '@wrongstack/core';
import type { TelegramBot } from '../bot.js';
import { truncateForTelegram } from '../bot.js';

interface TelegramSendInput {
  /** Chat or user ID to send the message to. Falls back to config.notifyChatId when omitted. */
  chat_id?: string | number | undefined;
  /** Message text. */
  message: string;
}

export function makeTelegramSendTool(opts: {
  bot: TelegramBot;
  /** Resolved at every execute() call so config changes take effect without restart. */
  getDefaultChatId(): string | number | undefined;
  maxMessageLength: number;
  log: Logger;
}): Tool<TelegramSendInput> {
  return {
    name: 'telegram_send',
    description:
      'Send a message to a Telegram chat. Write the message in natural prose — a human reads it. Summarize results, state what happened, and include only the key details. Never paste raw JSON, object dumps, or truncated tool output directly into the message field.',
    usageHint: 'telegram_send(chat_id: "123456789", message: "Build completed — 12 tests passed, 0 failed. Deploying to staging now.")',
    category: 'Telegram',
    inputSchema: {
      type: 'object',
      properties: {
        chat_id: {
          oneOf: [{ type: 'string' }, { type: 'integer' }],
          description: 'Target chat or user ID. Uses the plugin default when omitted.',
        },
        message: {
          type: 'string',
          description:
            'Message text in natural, human-readable prose. Summarize results, include only key details. Do NOT paste raw JSON, object dumps, or unformatted tool output. Target 1–4 lines for readability on mobile.',
        },
      },
      required: ['message'],
    },
    permission: 'confirm',
    mutating: true,
    timeoutMs: 15_000,
    async execute(input, _ctx, _opts) {
      const chatId = input.chat_id ?? opts.getDefaultChatId();
      if (!chatId) {
        throw new Error(
          'No chat_id provided and no default notifyChatId configured. Set notifyChatId in plugin config or pass chat_id.',
        );
      }

      // Truncate message to fit Telegram's 4096 char limit
      const truncated = truncateForTelegram(input.message, opts.maxMessageLength);

      opts.log.info(`telegram_send → chat_id=${chatId} (${truncated.length} chars)`);

      const res = await opts.bot.sendMessage(chatId, truncated);

      return {
        ok: res.ok,
        message_id: res.result?.message_id,
        chat: res.result?.chat
          ? {
              id: res.result.chat.id,
              type: res.result.chat.type,
              title: res.result.chat.title,
            }
          : undefined,
      };
    },
  };
}
