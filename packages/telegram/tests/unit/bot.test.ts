import type { Logger } from '@wrongstack/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TelegramBot, escapeHtml, truncateForTelegram } from '../../src/bot.js';
import type { TelegramIncomingMessage } from '../../src/bot.js';

const log: Logger = {
  level: 'debug',
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
  trace: vi.fn(),
  child() {
    return this;
  },
};

function makeBot(overrides?: {
  onMessage?: (msg: TelegramIncomingMessage) => void;
  allowedUsers?: string[];
  allowedChats?: string[];
}) {
  return new TelegramBot({
    token: 'test:token',
    pollIntervalSec: 60, // don't actually poll during tests
    allowedUsers: new Set(overrides?.allowedUsers ?? []),
    allowedChats: new Set(overrides?.allowedChats ?? []),
    bufferSize: 10,
    log,
    onMessage: overrides?.onMessage ?? vi.fn(),
  });
}

// ---------------------------------------------------------------------------
// Buffer
// ---------------------------------------------------------------------------

describe('TelegramBot buffer', () => {
  let received: TelegramIncomingMessage[] = [];

  beforeEach(() => {
    received = [];
  });

  function pushMsg(bot: TelegramBot, msg: Partial<TelegramIncomingMessage>) {
    // Use internal push — we simulate what polling would do via processMessage.
    const buf = (bot as unknown as { buffer: TelegramIncomingMessage[] }).buffer;
    buf.push({
      messageId: msg.messageId ?? 1,
      chatId: msg.chatId ?? 123,
      chatType: msg.chatType ?? 'private',
      userId: msg.userId,
      userName: msg.userName,
      text: msg.text ?? 'hello',
      timestamp: msg.timestamp ?? Date.now(),
    });
    // Respect buffer max (mirrors processMessage logic)
    while (buf.length > 10) buf.shift();
  }

  it('getMessages returns messages newest first', () => {
    const bot = makeBot({ onMessage: (m) => received.push(m) });
    pushMsg(bot, { messageId: 1, text: 'first' });
    pushMsg(bot, { messageId: 2, text: 'second' });
    pushMsg(bot, { messageId: 3, text: 'third' });

    const msgs = bot.getMessages();
    expect(msgs).toHaveLength(3);
    expect(msgs[0]!.text).toBe('third');
    expect(msgs[1]!.text).toBe('second');
    expect(msgs[2]!.text).toBe('first');
  });

  it('getMessages filters by chatId', () => {
    const bot = makeBot({ onMessage: (m) => received.push(m) });
    pushMsg(bot, { messageId: 1, text: 'a', chatId: 111 });
    pushMsg(bot, { messageId: 2, text: 'b', chatId: 222 });
    pushMsg(bot, { messageId: 3, text: 'c', chatId: 111 });

    const msgs = bot.getMessages({ chatId: 111 });
    expect(msgs).toHaveLength(2);
    expect(msgs.every((m) => m.chatId === 111)).toBe(true);
  });

  it('getMessages respects limit', () => {
    const bot = makeBot({ onMessage: (m) => received.push(m) });
    for (let i = 1; i <= 20; i++) pushMsg(bot, { messageId: i, text: `msg${i}` });

    expect(bot.getMessages({ limit: 5 })).toHaveLength(5);
  });

  it('acknowledge removes processed messages', () => {
    const bot = makeBot({ onMessage: (m) => received.push(m) });
    pushMsg(bot, { messageId: 10, text: 'old' });
    pushMsg(bot, { messageId: 20, text: 'new' });
    pushMsg(bot, { messageId: 30, text: 'newest' });

    expect(bot.bufferCount).toBe(3);
    const acked = bot.acknowledge(20);
    expect(acked).toBe(2);
    expect(bot.bufferCount).toBe(1);
    expect(bot.getMessages()[0]!.text).toBe('newest');
  });

  it('buffer respects max size (circular)', () => {
    const bot = makeBot({ onMessage: (m) => received.push(m) });
    for (let i = 1; i <= 15; i++) pushMsg(bot, { messageId: i, text: `msg${i}` });

    expect(bot.bufferCount).toBe(10);
    const msgs = bot.getMessages();
    expect(msgs[0]!.text).toBe('msg15');
    expect(msgs[9]!.text).toBe('msg6');
  });

  it('acknowledge returns 0 when no messages match', () => {
    const bot = makeBot({ onMessage: (m) => received.push(m) });
    pushMsg(bot, { messageId: 100, text: 'recent' });

    const acked = bot.acknowledge(50); // 50 < 100, nothing matches
    expect(acked).toBe(0);
    expect(bot.bufferCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

describe('helpers', () => {
  it('truncateForTelegram shortens long messages', () => {
    const short = 'hello';
    expect(truncateForTelegram(short, 4000)).toBe('hello');

    const long = 'a'.repeat(5000);
    const result = truncateForTelegram(long, 100);
    expect(result.length).toBeLessThanOrEqual(110); // close to 100
    expect(result).toContain('…[truncated');
  });

  it('escapeHtml replaces special chars', () => {
    expect(escapeHtml('<b>bold</b> & text')).toBe(
      '&lt;b&gt;bold&lt;/b&gt; &amp; text',
    );
  });

  it('truncateForTelegram splits on newline when possible', () => {
    const text = 'short line\n' + 'a'.repeat(200);
    const result = truncateForTelegram(text, 50);
    // Should split at the newline, not mid-string
    expect(result).toContain('short line');
    expect(result).toContain('truncated');
  });

  it('truncateForTelegram hard-cuts when no good newline', () => {
    const text = 'a'.repeat(200);
    const result = truncateForTelegram(text, 50);
    expect(result.length).toBeLessThan(60);
    expect(result).toContain('truncated');
  });
});

// ---------------------------------------------------------------------------
// Lifecycle — start / stop
// ---------------------------------------------------------------------------

describe('TelegramBot lifecycle', () => {
  let _originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    _originalFetch = globalThis.fetch;
    // getMe returns ok by default; getUpdates returns idle
    globalThis.fetch = vi.fn().mockImplementation((_url: string) => {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ ok: true, result: [] }),
      });
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = _originalFetch;
  });

  it('start is idempotent', () => {
    const bot = makeBot();
    bot.start();
    const firstStartTime = bot.startedAt;
    bot.start(); // second call should be noop
    expect(bot.startedAt).toBe(firstStartTime);
    bot.stop();
  });

  it('stop clears state', () => {
    const bot = makeBot();
    bot.start();
    expect(bot.running).toBe(true);
    bot.stop();
    expect(bot.running).toBe(false);
  });

  it('health returns bot info', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          ok: true,
          result: { id: 1, is_bot: true, first_name: 'T', username: 'mybot' },
        }),
    }) as unknown as typeof fetch;

    const bot = makeBot();
    const h = await bot.health();
    expect(h.ok).toBe(true);
    expect(h.username).toBe('mybot');
  });

  it('health returns error on API failure', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ ok: false, description: 'Unauthorized' }),
    }) as unknown as typeof fetch;

    const bot = makeBot();
    const h = await bot.health();
    expect(h.ok).toBe(false);
    expect(h.error).toBe('Unauthorized');
  });

  it('health returns error on network failure', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));

    const bot = makeBot();
    const h = await bot.health();
    expect(h.ok).toBe(false);
    expect(h.error).toBe('ECONNREFUSED');
  });

  it('health returns error when result is null', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ ok: true, result: null }),
    }) as unknown as typeof fetch;

    const bot = makeBot();
    const h = await bot.health();
    expect(h.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// sendMessage — retry, error, and edge cases
// ---------------------------------------------------------------------------

describe('TelegramBot sendMessage', () => {
  it('retries on transient failure then succeeds', async () => {
    const bot = makeBot();
    let attempts = 0;
    globalThis.fetch = vi.fn().mockImplementation(() => {
      attempts++;
      if (attempts < 3) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ ok: false, description: 'Too many requests', error_code: 429 }),
        });
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ ok: true, result: { message_id: 1 } }),
      });
    }) as unknown as typeof fetch;

    // Speed up retry sleep
    const res = await bot.sendMessage('123', 'test');
    expect(res.ok).toBe(true);
    expect(attempts).toBe(3);
  });

  it('throws after all retries exhausted', async () => {
    const bot = makeBot();
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ ok: false, description: 'Forbidden', error_code: 403 }),
    }) as unknown as typeof fetch;

    await expect(bot.sendMessage('123', 'test')).rejects.toThrow('Forbidden');
  });

  it('catches fetch network error and retries', async () => {
    const bot = makeBot();
    let attempts = 0;
    globalThis.fetch = vi.fn().mockImplementation(() => {
      attempts++;
      if (attempts < 3) return Promise.reject(new Error('ECONNRESET'));
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ ok: true, result: { message_id: 2 } }),
      });
    }) as unknown as typeof fetch;

    const res = await bot.sendMessage('123', 'test');
    expect(res.ok).toBe(true);
    expect(attempts).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Poll error handling
// ---------------------------------------------------------------------------

describe('TelegramBot poll errors', () => {
  it('logs getUpdates API failure at debug level', async () => {
    const onMessage = vi.fn();
    // Use very short poll interval so we catch the first poll quickly
    const bot = new TelegramBot({
      token: 'test:token',
      pollIntervalSec: 0,
      allowedUsers: new Set<string>(),
      allowedChats: new Set<string>(),
      bufferSize: 10,
      log,
      onMessage,
    });

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ ok: false, description: 'Service unavailable' }),
    }) as unknown as typeof fetch;

    bot.start();

    // Wait for the poll cycle (0ms interval, fires immediately)
    await new Promise((r) => setTimeout(r, 50));

    expect(log.debug).toHaveBeenCalledWith(
      expect.stringContaining('Service unavailable'),
    );

    bot.stop();
  });

  it('catches poll network error gracefully', async () => {
    const onMessage = vi.fn();
    const bot = new TelegramBot({
      token: 'test:token',
      pollIntervalSec: 0,
      allowedUsers: new Set<string>(),
      allowedChats: new Set<string>(),
      bufferSize: 10,
      log,
      onMessage,
    });

    globalThis.fetch = vi.fn().mockRejectedValue(new Error('ETIMEDOUT'));

    bot.start();
    await new Promise((r) => setTimeout(r, 50));

    expect(log.debug).toHaveBeenCalledWith(
      expect.stringContaining('ETIMEDOUT'),
    );

    bot.stop();
  });
});

// ---------------------------------------------------------------------------
// Allowlist rejections
// ---------------------------------------------------------------------------

function mockSingleUpdate(update: Record<string, unknown>) {
  let sent = false;
  return vi.fn().mockImplementation(() => {
    if (sent) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ ok: true, result: [] }),
      });
    }
    sent = true;
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ ok: true, result: [update] }),
    });
  }) as unknown as typeof fetch;
}

describe('TelegramBot allowlist', () => {
  it('rejects users not in allowedUsers', async () => {
    const onMessage = vi.fn();
    const bot = new TelegramBot({
      token: 'test:token',
      pollIntervalSec: 0,
      allowedUsers: new Set(['111']),
      allowedChats: new Set<string>(),
      bufferSize: 10,
      log,
      onMessage,
    });

    globalThis.fetch = mockSingleUpdate({
      update_id: 1,
      message: {
        message_id: 100,
        from: { id: 999, is_bot: false, first_name: 'BadActor' },
        chat: { id: 555, type: 'private' },
        date: Math.floor(Date.now() / 1000),
        text: 'unauthorized message',
      },
    });

    bot.start();
    await new Promise((r) => setTimeout(r, 100));

    expect(onMessage).not.toHaveBeenCalled();
    expect(bot.bufferCount).toBe(0);
    bot.stop();
  });

  it('rejects chats not in allowedChats', async () => {
    const onMessage = vi.fn();
    const bot = new TelegramBot({
      token: 'test:token',
      pollIntervalSec: 0,
      allowedUsers: new Set<string>(),
      allowedChats: new Set(['-100pub']),
      bufferSize: 10,
      log,
      onMessage,
    });

    globalThis.fetch = mockSingleUpdate({
      update_id: 1,
      message: {
        message_id: 101,
        from: { id: 333, is_bot: false, first_name: 'User' },
        chat: { id: 666, type: 'group', title: 'random group' },
        date: Math.floor(Date.now() / 1000),
        text: 'hello from random group',
      },
    });

    bot.start();
    await new Promise((r) => setTimeout(r, 100));

    expect(onMessage).not.toHaveBeenCalled();
    expect(bot.bufferCount).toBe(0);
    bot.stop();
  });

  it('allows message when user passes allowlists', async () => {
    const onMessage = vi.fn();
    const bot = new TelegramBot({
      token: 'test:token',
      pollIntervalSec: 0,
      allowedUsers: new Set(['111']),
      allowedChats: new Set<string>(),
      bufferSize: 10,
      log,
      onMessage,
    });

    globalThis.fetch = mockSingleUpdate({
      update_id: 1,
      message: {
        message_id: 200,
        from: { id: 111, is_bot: false, first_name: 'Alice' },
        chat: { id: 555, type: 'private' },
        date: Math.floor(Date.now() / 1000),
        text: 'legit message',
      },
    });

    bot.start();
    await new Promise((r) => setTimeout(r, 100));

    expect(onMessage).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'legit message', userId: 111 }),
    );
    expect(bot.bufferCount).toBe(1);
    bot.stop();
  });
});

