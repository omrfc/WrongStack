import type { Logger } from '@wrongstack/core';

// ---------------------------------------------------------------------------
// Telegram Bot API types (subset used by this plugin)
// ---------------------------------------------------------------------------

interface TgUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  username?: string;
}

interface TgChat {
  id: number;
  type: 'private' | 'group' | 'supergroup' | 'channel';
  title?: string;
  username?: string;
}

interface TgMessage {
  message_id: number;
  from?: TgUser;
  chat: TgChat;
  date: number;
  text?: string;
}

interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  edited_message?: TgMessage;
}

interface TgResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
}

// ---------------------------------------------------------------------------
// Incoming message shape emitted as a custom event
// ---------------------------------------------------------------------------

export interface TelegramIncomingMessage {
  messageId: number;
  chatId: number;
  chatType: string;
  userId?: number;
  userName?: string;
  text: string;
  timestamp: number;
}

// ---------------------------------------------------------------------------
// Bot options
// ---------------------------------------------------------------------------

export interface TelegramBotOptions {
  token: string;
  pollIntervalSec: number;
  allowedUsers: Set<string>;
  allowedChats: Set<string>;
  log: Logger;
  /** Called for each incoming message that passes allowlist checks. */
  onMessage(msg: TelegramIncomingMessage): void;
}

// ---------------------------------------------------------------------------
// Bot
// ---------------------------------------------------------------------------

export class TelegramBot {
  private readonly token: string;
  private readonly baseUrl: string;
  private readonly pollIntervalMs: number;
  private readonly allowedUsers: Set<string>;
  private readonly allowedChats: Set<string>;
  private readonly log: Logger;
  private readonly onMessage: (msg: TelegramIncomingMessage) => void;
  private readonly controller = new AbortController();
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private pollActive = false;
  private offset = 0;
  private _startedAt: number | null = null;

  constructor(opts: TelegramBotOptions) {
    this.token = opts.token;
    this.baseUrl = `https://api.telegram.org/bot${opts.token}`;
    this.pollIntervalMs = opts.pollIntervalSec * 1000;
    this.allowedUsers = opts.allowedUsers;
    this.allowedChats = opts.allowedChats;
    this.log = opts.log;
    this.onMessage = opts.onMessage;
  }

  // ------------------------------------------------------------------
  // Lifecycle
  // ------------------------------------------------------------------

  /** Start polling for updates. Idempotent. */
  start(): void {
    if (this.pollActive) return;
    this.pollActive = true;
    this._startedAt = Date.now();
    this.log.info('Telegram bot polling started');
    this.schedulePoll();
  }

  /** Stop polling and cancel all in-flight requests. */
  stop(): void {
    this.pollActive = false;
    this.controller.abort();
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    this.log.info('Telegram bot stopped');
  }

  get startedAt(): number | null {
    return this._startedAt;
  }

  get running(): boolean {
    return this.pollActive;
  }

  // ------------------------------------------------------------------
  // Outgoing — send a message
  // ------------------------------------------------------------------

  async sendMessage(chatId: string | number, text: string): Promise<TgResponse<TgMessage>> {
    const url = `${this.baseUrl}/sendMessage`;
    const body = JSON.stringify({
      chat_id: String(chatId),
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    });

    this.log.debug(`Sending Telegram message to ${chatId} (${text.length} chars)`);

    let lastErr: unknown;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
          signal: AbortSignal.timeout(10_000),
        });
        const data = (await res.json()) as TgResponse<TgMessage>;
        if (!data.ok) {
          throw new Error(`Telegram API error ${data.error_code}: ${data.description}`);
        }
        return data;
      } catch (err) {
        lastErr = err;
        if (attempt < 3) {
          this.log.warn(`Telegram sendMessage attempt ${attempt} failed, retrying in 1s...`);
          await sleep(1000);
        }
      }
    }
    throw lastErr;
  }

  // ------------------------------------------------------------------
  // Health
  // ------------------------------------------------------------------

  async health(): Promise<{ ok: boolean; username?: string; error?: string }> {
    try {
      const url = `${this.baseUrl}/getMe`;
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
      const data = (await res.json()) as TgResponse<TgUser>;
      if (!data.ok || !data.result) {
        return { ok: false, error: data.description ?? 'Unknown error' };
      }
      return { ok: true, username: data.result.username };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }

  // ------------------------------------------------------------------
  // Polling
  // ------------------------------------------------------------------

  private schedulePoll(): void {
    if (!this.pollActive) return;
    this.pollTimer = setTimeout(() => {
      void this.poll().finally(() => this.schedulePoll());
    }, this.pollIntervalMs);
  }

  private async poll(): Promise<void> {
    try {
      const url = `${this.baseUrl}/getUpdates?offset=${this.offset}&timeout=10`;
      const res = await fetch(url, { signal: this.controller.signal });
      const data = (await res.json()) as TgResponse<TgUpdate[]>;

      if (!data.ok) {
        this.log.warn(`Telegram getUpdates failed: ${data.description}`);
        return;
      }

      const updates = data.result ?? [];
      for (const upd of updates) {
        this.offset = upd.update_id + 1;
        const raw = upd.message ?? upd.edited_message;
        if (!raw?.text) continue;
        const msg = { ...raw, text: raw.text };
        this.processMessage(msg);
      }
    } catch (err) {
      if ((err as Error).name === 'AbortError') return;
      this.log.warn(`Telegram poll error: ${(err as Error).message}`);
    }
  }

  private processMessage(msg: TgMessage & { text: string }): void {
    const chatId = String(msg.chat.id);
    const userId = msg.from ? String(msg.from.id) : undefined;

    // Allowlist checks
    if (this.allowedUsers.size > 0 && userId && !this.allowedUsers.has(userId)) {
      this.log.debug(`Ignoring message from user ${userId} (not in allowedUsers)`);
      void this.sendMessage(chatId, '⛔ You are not authorized to interact with this bot.');
      return;
    }
    if (this.allowedChats.size > 0 && !this.allowedChats.has(chatId)) {
      this.log.debug(`Ignoring message from chat ${chatId} (not in allowedChats)`);
      return;
    }

    const incoming: TelegramIncomingMessage = {
      messageId: msg.message_id,
      chatId: msg.chat.id,
      chatType: msg.chat.type,
      userId: msg.from?.id,
      userName: msg.from?.username ?? msg.from?.first_name,
      text: msg.text,
      timestamp: msg.date * 1000,
    };

    this.onMessage(incoming);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Truncate text to fit Telegram's 4096-char message limit.
 * Splits on a newline when possible; otherwise hard-cuts with "…" suffix.
 */
export function truncateForTelegram(text: string, maxLen = 4000): string {
  if (text.length <= maxLen) return text;
  const cut = text.lastIndexOf('\n', maxLen - 20);
  const idx = cut > maxLen / 2 ? cut : maxLen - 20;
  return `${text.slice(0, idx)}\n\n…[truncated ${text.length - idx} chars]`;
}

/**
 * Escape HTML special chars for Telegram's HTML parse mode.
 */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
