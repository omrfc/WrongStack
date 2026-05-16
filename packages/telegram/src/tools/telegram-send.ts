import type { Tool } from '@wrongstack/core';
import type { Logger } from '@wrongstack/core';
import type { TelegramBot } from '../bot.js';
import { escapeHtml, truncateForTelegram } from '../bot.js';

interface TelegramSendInput {
  /** Chat or user ID to send the message to. Falls back to config.notifyChatId when omitted. */
  chat_id?: string | number;
  /** Message text. Supports Telegram HTML parse mode. */
  message: string;
}

export function makeTelegramSendTool(opts: {
  bot: TelegramBot;
  defaultChatId?: string | number;
  maxMessageLength: number;
  log: Logger;
}): Tool<TelegramSendInput> {
  return {
    name: 'telegram_send',
    description:
      'Send a message via Telegram to a specified chat. Use this to notify users, report results, or communicate through Telegram. The message supports HTML formatting (bold, italic, code, links).',
    usageHint: 'telegram_send(chat_id: "123456789", message: "Task completed ✓")',
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
            'Message text (supports HTML: <b>bold</b>, <i>italic</i>, <code>mono</code>, <a href="...">links</a>).',
        },
      },
      required: ['message'],
    },
    permission: 'confirm',
    mutating: true,
    timeoutMs: 15_000,
    async execute(input, _ctx, _opts) {
      const chatId = input.chat_id ?? opts.defaultChatId;
      if (!chatId) {
        throw new Error(
          'No chat_id provided and no default notifyChatId configured. Set notifyChatId in plugin config or pass chat_id.',
        );
      }

      // Format: wrap the message in a code block if it looks like raw output
      const safeMsg = escapeHtml(input.message);
      const truncated = truncateForTelegram(safeMsg, opts.maxMessageLength);

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
