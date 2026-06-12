import type { Logger } from '@wrongstack/core';
import { sleep } from '@wrongstack/core/utils';
import type { PollLock } from './poll-lock.js';

// ---------------------------------------------------------------------------
// Redaction helpers
// ---------------------------------------------------------------------------
/** Redact the bot token from a URL for safe logging. */
function redactToken(url: string, token: string): string {
  return url.replace(token, '[REDACTED]');
}

// ---------------------------------------------------------------------------
// Telegram Bot API types (subset used by this plugin)
// ---------------------------------------------------------------------------

interface TgUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  username?: string | undefined;
}

interface TgChat {
  id: number;
  type: 'private' | 'group' | 'supergroup' | 'channel';
  title?: string | undefined;
  username?: string | undefined;
}

interface TgMessage {
  message_id: number;
  from?: TgUser | undefined;
  chat: TgChat;
  date: number;
  text?: string | undefined;
}

interface TgUpdate {
  update_id: number;
  message?: TgMessage | undefined;
  edited_message?: TgMessage | undefined;
}

interface TgResponse<T> {
  ok: boolean;
  result?: T | undefined;
  description?: string | undefined;
  error_code?: number | undefined;
}

// ---------------------------------------------------------------------------
// Incoming message shape emitted as a custom event
// ---------------------------------------------------------------------------

export interface TelegramIncomingMessage {
  messageId: number;
  chatId: number;
  chatType: string;
  userId?: number | undefined;
  userName?: string | undefined;
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
  offsetStoragePath?: string | undefined;
  /**
   * Optional cross-process single-poller lock. Telegram allows one
   * `getUpdates` consumer per token; when another wstack instance holds the
   * lock, this bot stands by (no polling) and takes over once the holder
   * stops or its heartbeat goes stale.
   */
  lock?: PollLock | undefined;
  /** How often a standby instance retries acquiring the lock. Default: 15s. */
  standbyRetryMs?: number | undefined;
}

// ---------------------------------------------------------------------------
// Bot
// ---------------------------------------------------------------------------

export class TelegramBot {
  private readonly baseUrl: string;
  /** Base URL with token redacted, safe to use in log calls. */
  private readonly safeBaseUrl: string;
  private readonly pollIntervalMs: number;
  private readonly allowedUsers: Set<string>;
  private readonly allowedChats: Set<string>;
  private readonly log: Logger;
  private readonly onMessage: (msg: TelegramIncomingMessage) => void;
  private readonly controller = new AbortController();
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private pollActive = false;
  private offset = 0;
  /**
   * Consecutive HTTP 409 ("another getUpdates in flight") responses. Two
   * wstack instances polling the same bot token used to fight at full poll
   * speed forever, erroring on every cycle. After CONFLICT_BACKOFF_AFTER
   * consecutive conflicts this instance backs off to a slow poll and warns
   * once; any successful poll resets to the normal cadence.
   */
  private conflictStreak = 0;
  private static readonly CONFLICT_BACKOFF_AFTER = 3;
  private static readonly CONFLICT_POLL_MS = 60_000;
  private _startedAt: number | null = null;
  /** If set, the offset is persisted here after each successful poll. */
  private readonly offsetStoragePath?: string | undefined;
  /** Single-poller election across wstack instances sharing this token. */
  private readonly lock?: PollLock | undefined;
  private readonly standbyRetryMs: number;
  private standbyTimer: ReturnType<typeof setTimeout> | null = null;
  private standbyAnnounced = false;

  // Circular buffer for incoming messages
  private readonly bufferMax: number;
  private readonly buffer: TelegramIncomingMessage[] = [];

  constructor(opts: TelegramBotOptions) {
    this.baseUrl = `https://api.telegram.org/bot${opts.token}`;
    this.safeBaseUrl = redactToken(this.baseUrl, opts.token);
    this.pollIntervalMs = opts.pollIntervalSec * 1000;
    this.allowedUsers = opts.allowedUsers;
    this.allowedChats = opts.allowedChats;
    this.bufferMax = opts.bufferSize;
    this.log = opts.log;
    this.onMessage = opts.onMessage;
    this.offsetStoragePath = opts.offsetStoragePath;
    this.lock = opts.lock;
    this.standbyRetryMs = opts.standbyRetryMs ?? 15_000;
    if (this.lock) {
      this.lock.onLost = () => this.handleLockLost();
    }

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
    this.acquireAndPoll();
  }

  /** Stop polling and cancel all in-flight requests. */
  stop(): void {
    this.pollActive = false;
    this.controller.abort();
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.standbyTimer) {
      clearTimeout(this.standbyTimer);
      this.standbyTimer = null;
    }
    this.lock?.release();
    this.log.info('Telegram bot stopped');
  }

  /** True when the bot is started but waiting for the poll lock. */
  get standby(): boolean {
    return this.pollActive && this.lock !== undefined && !this.lock.held;
  }

  /**
   * Acquire the poll lock (when configured) and start the poll loop, or
   * stand by and retry until the current holder releases it.
   */
  private acquireAndPoll(): void {
    if (!this.pollActive) return;
    if (this.lock && !this.lock.tryAcquire()) {
      if (!this.standbyAnnounced) {
        this.standbyAnnounced = true;
        this.log.info(
          'Telegram: another wstack instance is already polling this bot token — standing by; will take over when it stops.',
        );
      }
      this.standbyTimer = setTimeout(() => this.acquireAndPoll(), this.standbyRetryMs);
      this.standbyTimer.unref?.();
      return;
    }
    if (this.standbyAnnounced) {
      this.standbyAnnounced = false;
      this.log.info('Telegram: poll lock acquired — taking over polling.');
    } else {
      this.log.info(`Telegram bot polling started (${this.safeBaseUrl})`);
    }
    this.schedulePoll();
  }

  /** The lock was stolen while we held it — pause polling and stand by. */
  private handleLockLost(): void {
    if (!this.pollActive) return;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    this.log.warn('Telegram: poll lock lost to another instance — pausing polling and standing by.');
    this.standbyAnnounced = true; // acquireAndPoll already announced via this warn
    this.standbyTimer = setTimeout(() => this.acquireAndPoll(), this.standbyRetryMs);
    this.standbyTimer.unref?.();
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
  getMessages(opts?: { chatId?: string | number | undefined; limit?: number | undefined }): TelegramIncomingMessage[] {
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
      const buffered = this.buffer[i];
      if (buffered && buffered.messageId <= lastMessageId) {
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
          this.log.debug(`Telegram sendMessage attempt ${attempt} failed, retrying in 1s...`);
          await sleep(1000);
        }
      }
    }
    throw lastErr;
  }

  // ------------------------------------------------------------------
  // Health
  // ------------------------------------------------------------------

  async health(): Promise<{ ok: boolean; username?: string | undefined; error?: string | undefined }> {
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
    // Lost the poll lock mid-flight — the standby retry loop owns recovery.
    if (this.lock && !this.lock.held) return;
    const delay =
      this.conflictStreak >= TelegramBot.CONFLICT_BACKOFF_AFTER
        ? TelegramBot.CONFLICT_POLL_MS
        : this.pollIntervalMs;
    this.pollTimer = setTimeout(() => {
      void this.poll().finally(() => this.schedulePoll());
    }, delay);
  }

  private async poll(): Promise<void> {
    try {
      const url = `${this.baseUrl}/getUpdates?offset=${this.offset}&timeout=10`;
      const res = await fetch(url, { signal: this.controller.signal });
      const data = (await res.json()) as TgResponse<TgUpdate[]>;

      if (!data.ok) {
        if (data.error_code === 409) {
          this.conflictStreak++;
          if (this.conflictStreak === TelegramBot.CONFLICT_BACKOFF_AFTER) {
            this.log.warn(
              this.lock
                ? 'Telegram: another consumer outside this machine is polling this bot token (HTTP 409) — backing off to 60s polls. Check other machines/bots using this token, or a registered webhook (deleteWebhook).'
                : 'Telegram: another instance is polling this bot token (HTTP 409) — backing off to 60s polls until it stops.',
            );
          }
        }
        this.log.debug(`Telegram getUpdates failed: ${data.description}`);
        return;
      }
      this.conflictStreak = 0;

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
      this.log.debug(`Telegram poll error: ${(err as Error).message}`);
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
      this.log.debug(`Failed to persist Telegram offset: ${err}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Truncate text to fit Telegram's 4096-char message limit.
 * Preserves semantic boundaries in this priority order:
 *   1. Paragraph break (double newline)
 *   2. Sentence break (. ! ? followed by space/newline)
 *   3. Word break (space)
 *   4. Hard cut with ellipsis
 *
 * When a clean boundary is found, appends "…" to signal intentional truncation.
 */
export function truncateForTelegram(text: string, maxLen = 4000): string {
  if (text.length <= maxLen) return text;

  // Reserve room for truncation suffix
  const cutoff = maxLen - 30;
  if (cutoff <= 0) return `${text.slice(0, maxLen - 1)}…`;

  const searchEnd = Math.min(text.length, maxLen);

  // 1. Paragraph boundary (double newline)
  const paraIdx = text.lastIndexOf('\n\n', searchEnd);
  if (paraIdx > cutoff) {
    return `${text.slice(0, paraIdx)}\n\n…`;
  }

  // 2. Single newline boundary
  const nlIdx = text.lastIndexOf('\n', searchEnd);
  if (nlIdx > cutoff) {
    return `${text.slice(0, nlIdx)}\n…`;
  }

  // 3. Sentence boundary (. ! ? followed by space or newline)
  const sentenceRe = /[.!?](?=\s)/g;
  let match: RegExpExecArray | null;
  let sentenceIdx = -1;
  match = sentenceRe.exec(text);
  while (match !== null) {
    if (match.index >= searchEnd) break;
    if (match.index > cutoff) sentenceIdx = match.index + 1;
    match = sentenceRe.exec(text);
  }
  if (sentenceIdx > cutoff) {
    return `${text.slice(0, sentenceIdx)}…`;
  }

  // 4. Word boundary (space)
  const spaceIdx = text.lastIndexOf(' ', searchEnd);
  if (spaceIdx > cutoff) {
    return `${text.slice(0, spaceIdx)} …`;
  }

  // 5. Hard cut
  return `${text.slice(0, maxLen - 20)}…[+${text.length - maxLen + 20} chars]`;
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
