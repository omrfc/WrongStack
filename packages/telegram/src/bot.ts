import type { Logger } from '@wrongstack/core';

// ---------------------------------------------------------------------------
// Redaction helpers
// ---------------------------------------------------------------------------


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
  /** Max messages to buffer for the agent to read. Default: 50. */
  bufferSize: number;
  log: Logger;
  /** Called for each incoming message that passes allowlist checks. */
  onMessage(msg: TelegramIncomingMessage): void;
  /**
   * Optional path to a file that stores the polling offset. When provided,
   * the offset is persisted on every successful poll and restored on startup,
   * preventing message replay after crashes or restarts.
   */
  offsetStoragePath?: string;
}

// ---------------------------------------------------------------------------
// Bot
// ---------------------------------------------------------------------------

export class TelegramBot {
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
  /** If set, the offset is persisted here after each successful poll. */
  private readonly offsetStoragePath?: string;

  // Circular buffer for incoming messages
  private readonly bufferMax: number;
  private readonly buffer: TelegramIncomingMessage[] = [];

  constructor(opts: TelegramBotOptions) {
    this.baseUrl = `https://api.telegram.org/bot${opts.token}`;
    this.pollIntervalMs = opts.pollIntervalSec * 1000;
    this.allowedUsers = opts.allowedUsers;
    this.allowedChats = opts.allowedChats;
    this.bufferMax = opts.bufferSize;
    this.log = opts.log;
    this.onMessage = opts.onMessage;
    this.offsetStoragePath = opts.offsetStoragePath;

    // Restore persisted offset so a crash/restart doesn't cause message replay.
    if (this.offsetStoragePath) {
      void this.loadOffset();
    }
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
  // Buffer — incoming messages the agent can read
  // ------------------------------------------------------------------

  /** Return buffered messages, newest first. Optionally filter by chat. */
  getMessages(opts?: { chatId?: string | number; limit?: number }): TelegramIncomingMessage[] {
    let msgs = [...this.buffer].reverse();
    if (opts?.chatId) {
      const cid = String(opts.chatId);
      msgs = msgs.filter((m) => String(m.chatId) === cid);
    }
    const limit = opts?.limit ?? 20;
    return msgs.slice(0, limit);
  }

  /** Drop messages older than the given message ID from the buffer. */
  acknowledge(lastMessageId: number): number {
    const before = this.buffer.length;
    let i = this.buffer.length;
    while (i-- > 0) {
      if (this.buffer[i]!.messageId <= lastMessageId) {
        this.buffer.splice(0, i + 1);
        break;
      }
    }
    return before - this.buffer.length;
  }

  get bufferCount(): number {
    return this.buffer.length;
  }

  // ------------------------------------------------------------------
  // Outgoing — send a message
  // ------------------------------------------------------------------

  async sendMessage(chatId: string | number, text: string): Promise<TgResponse<TgMessage>> {
    const url = `${this.baseUrl}/sendMessage`;
    const body = JSON.stringify({
      chat_id: String(chatId),
      text,
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

      // Persist offset after each successful poll to prevent message replay
      // after crashes or restarts.
      if (this.offsetStoragePath && this.offset > 0) {
        void this.saveOffset();
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

    // Push to circular buffer
    this.buffer.push(incoming);
    while (this.buffer.length > this.bufferMax) this.buffer.shift();

    this.onMessage(incoming);
  }

  private async loadOffset(): Promise<void> {
    if (!this.offsetStoragePath) return;
    try {
      const { readFileSync } = await import('node:fs');
      const raw = readFileSync(this.offsetStoragePath, 'utf8').trim();
      const n = Number.parseInt(raw, 10);
      if (Number.isFinite(n) && n >= 0) {
        this.offset = n;
        this.log.debug(`Telegram polling offset restored: ${this.offset}`);
      }
    } catch {
      // File doesn't exist yet — start from 0, which is correct.
    }
  }

  private async saveOffset(): Promise<void> {
    if (!this.offsetStoragePath) return;
    try {
      const { writeFileSync } = await import('node:fs');
      // Write atomically so a crash mid-write can't leave a corrupt file.
      writeFileSync(this.offsetStoragePath, String(this.offset), 'utf8');
    } catch (err) {
      this.log.warn(`Failed to persist Telegram offset: ${err}`);
    }
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
