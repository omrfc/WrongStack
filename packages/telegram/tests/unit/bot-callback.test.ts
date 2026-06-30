import type { Logger } from '@wrongstack/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TelegramBot } from '../../src/bot.js';

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
  allowedUsers?: string[];
  allowedChats?: string[];
}) {
  return new TelegramBot({
    token: 'test:token',
    // pollIntervalSec is irrelevant — these tests never call bot.start().
    // They exercise the callback dispatch path directly, bypassing the
    // polling loop. This keeps the test worker from leaking a polling
    // timer into the vitest exit handshake.
    pollIntervalSec: 60,
    allowedUsers: new Set(overrides?.allowedUsers ?? []),
    allowedChats: new Set(overrides?.allowedChats ?? []),
    bufferSize: 10,
    log,
    onMessage: vi.fn(),
  });
}

// ---------------------------------------------------------------------------
// Callback waiter
// ---------------------------------------------------------------------------

describe('TelegramBot awaitCallback', () => {
  let bot: TelegramBot;
  let _originalFetch: typeof globalThis.fetch;
  let fetched: Array<{ url: string; body: string }>;

  beforeEach(() => {
    bot = makeBot();
    _originalFetch = globalThis.fetch;
    fetched = [];
    globalThis.fetch = vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
      fetched.push({ url: String(_url), body: String(init?.body ?? '') });
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ ok: true, result: true }),
      });
    }) as never as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = _originalFetch;
    bot.stop();
  });

  // Helper: invoke the private dispatchCallback directly. The bot has
  // a polling loop and a fetch-driven callback dispatcher; for unit
  // testing the dispatcher in isolation we bypass the loop entirely.
  // This is a standard pattern for testing private methods in TS:
  // the alternative (a public test-only hook) pollutes the public API.
  function dispatchDirectly(cq: {
    id: string;
    from?: { username?: string; first_name?: string };
    message?: { message_id: number; chat: { id: number; type: string } };
    data?: string;
  }) {
    return (bot as unknown as {
      dispatchCallback(cq: typeof cq): Promise<void>;
    }).dispatchCallback(cq);
  }

  it('resolves with approved=true when a matching :yes callback arrives', async () => {
    const key = 'approve:abc:yes';
    const promise = bot.awaitCallback(key, 5_000);

    await dispatchDirectly({
      id: 'cb-1',
      from: { username: 'alice', first_name: 'Alice' },
      message: { message_id: 1, chat: { id: 99, type: 'private' } },
      data: key,
    });

    const result = await promise;
    expect(result.approved).toBe(true);
    expect(result.fromUser).toBe('alice');

    const ack = fetched.find((c) => c.url.endsWith('/answerCallbackQuery'));
    expect(ack).toBeDefined();
    expect(ack!.body).toContain('cb-1');
    expect(ack!.body).toContain('Approved');
  });

  it('resolves with approved=false when a matching :no callback arrives', async () => {
    const key = 'approve:xyz:no';
    const promise = bot.awaitCallback(key, 5_000);

    await dispatchDirectly({
      id: 'cb-2',
      from: { first_name: 'Bob' },
      message: { message_id: 2, chat: { id: 100, type: 'private' } },
      data: key,
    });

    const result = await promise;
    expect(result.approved).toBe(false);
    expect(result.fromUser).toBe('Bob');
  });

  it('times out and resolves with approved=false / fromUser=timeout', async () => {
    const start = Date.now();
    const result = await bot.awaitCallback('approve:nobody:yes', 200);
    const elapsed = Date.now() - start;

    expect(result.approved).toBe(false);
    expect(result.fromUser).toBe('timeout');
    expect(elapsed).toBeGreaterThanOrEqual(190);
    expect(elapsed).toBeLessThan(500);
  });

  it('stop() rejects pending waiters so the host does not hang', async () => {
    const localBot = makeBot();
    const promise = localBot.awaitCallback('approve:zzz:yes', 30_000);

    localBot.stop();

    const result = await promise;
    expect(result.approved).toBe(false);
    expect(result.fromUser).toBe('shutdown');
    // stop() also clears the waiter map; further registrations are fine.
    expect(localBot['callbackWaiters' as keyof typeof localBot]).toBeDefined();
  });

  it('an unmatched callback_query is logged at debug but does not throw', async () => {
    // No waiter registered for "something:else" — dispatch must log
    // and complete without resolving any promise.
    await dispatchDirectly({
      id: 'cb-3',
      from: { first_name: 'X' },
      message: { message_id: 3, chat: { id: 1, type: 'private' } },
      data: 'something:else',
    });

    expect(log.debug).toHaveBeenCalledWith(expect.stringContaining('Unmatched callback_query'));
  });

  it('answerCallbackQuery failure does not block the waiter from resolving', async () => {
    // Replace fetch with one that rejects on answerCallbackQuery but
    // resolves on everything else (no real call is expected here
    // except the ack).
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('Network down')) as never as typeof fetch;

    const key = 'approve:net:yes';
    const promise = bot.awaitCallback(key, 5_000);

    await dispatchDirectly({
      id: 'cb-net',
      from: { username: 'net' },
      data: key,
    });

    const result = await promise;
    expect(result.approved).toBe(true);
    expect(result.fromUser).toBe('net');
  });
});

// ---------------------------------------------------------------------------
// Allowlist — callback bypass protection
// ---------------------------------------------------------------------------

describe('TelegramBot allowlist on callback_query', () => {
  let bot: TelegramBot;
  let _originalFetch: typeof globalThis.fetch;
  let fetched: Array<{ url: string; body: string }>;

  beforeEach(() => {
    // Configure the bot with allowlists that explicitly EXCLUDE the
    // from.user / chat.id values used in these tests, so the dispatch
    // path takes the deny branch.
    bot = makeBot({ allowedUsers: ['999'], allowedChats: ['999'] });
    _originalFetch = globalThis.fetch;
    fetched = [];
    globalThis.fetch = vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
      fetched.push({ url: String(_url), body: String(init?.body ?? '') });
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ ok: true, result: true }),
      });
    }) as never as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = _originalFetch;
    bot.stop();
  });

  function dispatchDirectly(cq: {
    id: string;
    from?: { id: number; username?: string; first_name?: string };
    message?: { message_id: number; chat: { id: number; type: string } };
    data?: string;
  }) {
    return (bot as unknown as {
      dispatchCallback(cq: typeof cq): Promise<void>;
    }).dispatchCallback(cq);
  }

  it('blocks a callback from a user not on the allowedUsers list and resolves the waiter with from=blocked', async () => {
    const key = 'approve:abc:yes';
    const promise = bot.awaitCallback(key, 5_000);
    await dispatchDirectly({
      id: 'cb-block-user',
      from: { id: 42, username: 'mallory' },
      message: { message_id: 1, chat: { id: 999, type: 'private' } },
      data: key,
    });
    // The hijack-rejection path must resolve the waiter immediately
    // with the `blocked` sentinel rather than letting it fall through
    // to its 5 s timeout — agents need to distinguish a security
    // rejection from a passive user timeout.
    const result = await promise;
    expect(result.approved).toBe(false);
    expect(result.fromUser).toBe('blocked');
    const ack = fetched.find((c) => c.url.endsWith('/answerCallbackQuery'));
    expect(ack).toBeDefined();
    // Allowlist rejection must use a visible toast (show_alert=true) so the
    // blocked user understands why their tap did nothing.
    expect(ack!.body).toContain('"show_alert":true');
    bot.stop();
  });

  it('blocks a callback from a chat not on the allowedChats list', async () => {
    const key = 'approve:def:yes';
    const promise = bot.awaitCallback(key, 5_000);
    await dispatchDirectly({
      id: 'cb-block-chat',
      from: { id: 999, username: 'alice' }, // allowed user…
      message: { message_id: 1, chat: { id: 7, type: 'private' } }, // …in a non-allowlisted chat
      data: key,
    });
    const result = await promise;
    expect(result.approved).toBe(false);
    expect(result.fromUser).toBe('blocked');
    bot.stop();
  });

  it('lets a callback through when both user and chat are allowlisted', async () => {
    // Rebuild with allowlists that DO include user 42 and chat 7.
    bot.stop();
    bot = makeBot({ allowedUsers: ['42'], allowedChats: ['7'] });
    _originalFetch = globalThis.fetch;
    fetched = [];
    globalThis.fetch = vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
      fetched.push({ url: String(_url), body: String(init?.body ?? '') });
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ ok: true, result: true }),
      });
    }) as never as typeof fetch;

    const key = 'approve:ghi:yes';
    const promise = bot.awaitCallback(key, 5_000);
    await dispatchDirectly({
      id: 'cb-allow',
      from: { id: 42, username: 'bob' },
      message: { message_id: 1, chat: { id: 7, type: 'private' } },
      data: key,
    });
    const result = await promise;
    expect(result.approved).toBe(true);
    expect(result.fromUser).toBe('bob');
  });
});
