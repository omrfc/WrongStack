import type { Logger } from '@wrongstack/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TelegramBot } from '../../src/bot.js';
import { makeTelegramApproveTool } from '../../src/tools/telegram-approve.js';

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

function makeBot(overrides?: { allowedUsers?: string[]; allowedChats?: string[] }) {
  return new TelegramBot({
    token: 'test:token',
    pollIntervalSec: 60,
    allowedUsers: new Set(overrides?.allowedUsers ?? []),
    allowedChats: new Set(overrides?.allowedChats ?? []),
    bufferSize: 10,
    log,
    onMessage: vi.fn(),
  });
}

function makeTool(bot: TelegramBot, chatId = '999') {
  return makeTelegramApproveTool({
    bot,
    getDefaultChatId: () => chatId,
    maxMessageLength: 4000,
    log,
  });
}

describe('telegram_approve tool', () => {
  let _originalFetch: typeof globalThis.fetch;
  let sentBodies: string[];

  beforeEach(() => {
    _originalFetch = globalThis.fetch;
    sentBodies = [];
    // Default: sendMessage succeeds, no polls return anything.
    globalThis.fetch = vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
      if (init?.body) sentBodies.push(String(init.body));
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ ok: true, result: { message_id: 42 } }),
      });
    }) as never as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = _originalFetch;
  });

  it('returns approved=false and fromUser=timeout when no callback arrives', async () => {
    const bot = makeBot();
    const tool = makeTool(bot);

    const start = Date.now();
    const result = await tool.execute({ prompt: 'Continue?', timeout_ms: 150 });
    const elapsed = Date.now() - start;

    expect(result.approved).toBe(false);
    expect(result.from).toBe('timeout');
    expect(result.prompt_message_id).toBe(42);
    expect(elapsed).toBeGreaterThanOrEqual(140);

    // One outbound sendMessage with the prompt + inline keyboard.
    const prompts = sentBodies.filter((b) => b.includes('Continue?'));
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('inline_keyboard');
    expect(prompts[0]).toContain(':yes');
    expect(prompts[0]).toContain(':no');
  });

  it('truncates details to fit Telegram', async () => {
    const bot = makeBot();
    const tool = makeTool(bot);

    await tool.execute({
      prompt: 'Go?',
      details: 'a'.repeat(2000),
      timeout_ms: 100,
    });

    const prompt = sentBodies.find((b) => b.includes('Go?'))!;
    expect(prompt.length).toBeLessThan(2000); // well under Telegram's 4096
  });

  it('throws when no chat_id is provided and no default is set', async () => {
    const bot = makeBot();
    const tool = makeTelegramApproveTool({
      bot,
      getDefaultChatId: () => undefined,
      maxMessageLength: 4000,
      log,
    });

    await expect(tool.execute({ prompt: 'x' })).rejects.toThrow('No chat_id provided');
  });

  it('caps timeout_ms to the documented 600 000 ms ceiling', async () => {
    const bot = makeBot();
    const tool = makeTool(bot);

    const start = Date.now();
    const result = await tool.execute({ prompt: 'x', timeout_ms: 10 });
    const elapsed = Date.now() - start;

    expect(result.approved).toBe(false);
    expect(result.from).toBe('timeout');
    expect(elapsed).toBeGreaterThanOrEqual(950); // not 10 ms — clamped >=1000 ms minimum
    expect(elapsed).toBeLessThan(1500);
  });

  it('resolves approved=true when a matching yes-key arrives via bot.awaitCallback', async () => {
    const bot = makeBot();
    const tool = makeTool(bot);

    // Kick off the approval request, then race a waiter that fires yes.
    const execPromise = tool.execute({ prompt: 'ok?', timeout_ms: 5_000 });

    // Wait a tick so the tool has registered its two awaitCallback keys.
    await new Promise((r) => setTimeout(r, 5));

    // Find the registered yes key from the outbound prompt body so we
    // simulate the exact key the bot will see.
    const prompt = sentBodies.find((b) => b.includes('ok?'))!;
    const yesMatch = prompt.match(/"callback_data":"(approve:[^"]+:yes)"/);
    expect(yesMatch).not.toBeNull();
    const yesKey = yesMatch![1]!;

    await (
      bot as unknown as {
        dispatchCallback(cq: {
          id: string;
          from?: { username?: string; first_name?: string };
          data?: string;
        }): Promise<void>;
      }
    ).dispatchCallback({
      id: 'cb-approve',
      from: { username: 'alice' },
      data: yesKey,
    });

    const result = await execPromise;
    expect(result.approved).toBe(true);
    expect(result.from).toBe('alice');
  });
});

// ---------------------------------------------------------------------------
// Allowlist enforcement end-to-end (tool + dispatchCallback integration)
// ---------------------------------------------------------------------------

describe('telegram_approve with bot allowlist', () => {
  let _originalFetch: typeof globalThis.fetch;
  let sentBodies: string[];
  let ackCalls: Array<{ url: string; body: string }>;

  beforeEach(() => {
    _originalFetch = globalThis.fetch;
    sentBodies = [];
    ackCalls = [];
    globalThis.fetch = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      const u = String(url);
      const b = String(init?.body ?? '');
      if (b) sentBodies.push(b);
      if (u.endsWith('/answerCallbackQuery')) {
        ackCalls.push({ url: u, body: b });
      }
      // sendMessage needs a real-looking response so the tool picks up
      // prompt_message_id; answerCallbackQuery can return anything.
      if (u.endsWith('/sendMessage')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ ok: true, result: { message_id: 42 } }),
        });
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ ok: true, result: true }),
      });
    }) as never as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = _originalFetch;
  });

  it('an allowlisted user gets approved=true', async () => {
    // Allowlist ONLY user 1; chat 999 is also on the allowlist so
    // the chat-side check passes for the test setup.
    const bot = makeBot({ allowedUsers: ['1'], allowedChats: ['999'] });
    const tool = makeTool(bot);
    const execPromise = tool.execute({ prompt: 'ok?', timeout_ms: 5_000 });
    await new Promise((r) => setTimeout(r, 5));
    const prompt = sentBodies.find((b) => b.includes('ok?'))!;
    const yesMatch = prompt.match(/"callback_data":"(approve:[^"]+:yes)"/);
    expect(yesMatch).not.toBeNull();
    const yesKey = yesMatch![1]!;

    await (
      bot as unknown as {
        dispatchCallback(cq: {
          id: string;
          from?: { id: number; username?: string };
          message?: { message_id: number; chat: { id: number; type: string } };
          data?: string;
        }): Promise<void>;
      }
    ).dispatchCallback({
      id: 'cb-ok',
      from: { id: 1, username: 'alice' },
      message: { message_id: 1, chat: { id: 999, type: 'private' } },
      data: yesKey,
    });

    const result = await execPromise;
    expect(result.approved).toBe(true);
    expect(result.from).toBe('alice');
    // No "Not authorized" toast was sent — the allowlist check passed.
    expect(ackCalls.find((c) => c.body.includes('Not authorized'))).toBeUndefined();
    bot.stop();
  });

  it('a non-allowlisted user receives the "Not authorized" toast and the tool resolves with approved=false / from=timeout', async () => {
    // Allowlist user 1; mallory (id 2) is NOT on it.
    const bot = makeBot({ allowedUsers: ['1'], allowedChats: ['999'] });
    const tool = makeTool(bot);
    const execPromise = tool.execute({ prompt: 'Sensitive op?', timeout_ms: 200 });
    await new Promise((r) => setTimeout(r, 5));
    const prompt = sentBodies.find((b) => b.includes('Sensitive op?'))!;
    const yesMatch = prompt.match(/"callback_data":"(approve:[^"]+:yes)"/);
    expect(yesMatch).not.toBeNull();
    const yesKey = yesMatch![1]!;

    // Mallory presses Approve.
    await (
      bot as unknown as {
        dispatchCallback(cq: {
          id: string;
          from?: { id: number; username?: string };
          message?: { message_id: number; chat: { id: number; type: string } };
          data?: string;
        }): Promise<void>;
      }
    ).dispatchCallback({
      id: 'cb-hijack',
      from: { id: 2, username: 'mallory' },
      message: { message_id: 1, chat: { id: 999, type: 'private' } },
      data: yesKey,
    });

    const result = await execPromise;
    // Critical assertion: even though data ends with ":yes", the tool
    // returns approved=false. The waiter was NOT resolved by the
    // hijack attempt via timeout — it was rejected with the
    // dedicated `blocked` sentinel so the agent can distinguish a
    // security event from a passive user-side timeout.
    expect(result.approved).toBe(false);
    expect(result.from).toBe('blocked');
    // Mallory got the "Not authorized" toast (show_alert=true) so she
    // understands why her tap was rejected.
    const denied = ackCalls.find((c) => c.body.includes('Not authorized'));
    expect(denied).toBeDefined();
    expect(denied!.body).toContain('"show_alert":true');
    bot.stop();
  });

  it('a non-allowlisted chat produces the same deny outcome', async () => {
    // Allowlist user 42 in chat 999 only. A press from the same user
    // but a different chat (id 7) must be blocked.
    const bot = makeBot({ allowedUsers: ['42'], allowedChats: ['999'] });
    const tool = makeTool(bot);
    const execPromise = tool.execute({ prompt: 'Cross-chat?', timeout_ms: 200 });
    await new Promise((r) => setTimeout(r, 5));
    const prompt = sentBodies.find((b) => b.includes('Cross-chat?'))!;
    const yesMatch = prompt.match(/"callback_data":"(approve:[^"]+:yes)"/);
    expect(yesMatch).not.toBeNull();
    const yesKey = yesMatch![1]!;

    await (
      bot as unknown as {
        dispatchCallback(cq: {
          id: string;
          from?: { id: number; username?: string };
          message?: { message_id: number; chat: { id: number; type: string } };
          data?: string;
        }): Promise<void>;
      }
    ).dispatchCallback({
      id: 'cb-cross-chat',
      from: { id: 42, username: 'bob' }, // allowed user…
      message: { message_id: 1, chat: { id: 7, type: 'group' } }, // …in a non-allowlisted chat
      data: yesKey,
    });

    const result = await execPromise;
    expect(result.approved).toBe(false);
    expect(result.from).toBe('blocked');
    const denied = ackCalls.find((c) => c.body.includes('Not authorized'));
    expect(denied).toBeDefined();
    expect(denied!.body).toContain('"show_alert":true');
    bot.stop();
  });

  it('a non-allowlisted user pressing Deny yields from=blocked (not timeout)', async () => {
    // Same allowlist shape as the previous test, but the hijacker's tap
    // lands on the ":no" key. The guard must still resolve the waiter
    // with the blocked sentinel — confirming the deny path doesn't
    // special-case :yes vs :no.
    const bot = makeBot({ allowedUsers: ['1'], allowedChats: ['999'] });
    const tool = makeTool(bot);
    const execPromise = tool.execute({ prompt: 'Deny-bot?', timeout_ms: 200 });
    await new Promise((r) => setTimeout(r, 5));
    const prompt = sentBodies.find((b) => b.includes('Deny-bot?'))!;
    const noMatch = prompt.match(/"callback_data":"(approve:[^"]+:no)"/);
    expect(noMatch).not.toBeNull();
    const noKey = noMatch![1]!;

    await (
      bot as unknown as {
        dispatchCallback(cq: {
          id: string;
          from?: { id: number; username?: string };
          message?: { message_id: number; chat: { id: number; type: string } };
          data?: string;
        }): Promise<void>;
      }
    ).dispatchCallback({
      id: 'cb-deny-hijack',
      from: { id: 2, username: 'mallory' },
      message: { message_id: 1, chat: { id: 999, type: 'private' } },
      data: noKey,
    });

    const result = await execPromise;
    expect(result.approved).toBe(false);
    expect(result.from).toBe('blocked');
    bot.stop();
  });

  it('after a blocked rejection, a follow-up legitimate tap is silently ignored (no double-resolve)', async () => {
    // Once the hijack resolves the waiter with `blocked`, the legitimate
    // user's tap arrives later. The allowlist passes for the legitimate
    // user (alice), but the waiter was already deleted — so her tap is
    // treated as an unmatched callback and must NOT mutate the already
    // resolved Promise. This guards against the classic double-resolve
    // bug. Mallory (id 2) is intentionally NOT on the allowlist so her
    // tap takes the blocked-path; alice (id 1) IS allowlisted so her
    // tap would normally resolve the waiter.
    const bot = makeBot({ allowedUsers: ['1'], allowedChats: ['999'] });
    const tool = makeTool(bot);
    const execPromise = tool.execute({ prompt: 'Race?', timeout_ms: 1_000 });
    await new Promise((r) => setTimeout(r, 5));
    const prompt = sentBodies.find((b) => b.includes('Race?'))!;
    const yesMatch = prompt.match(/"callback_data":"(approve:[^"]+:yes)"/);
    expect(yesMatch).not.toBeNull();
    const yesKey = yesMatch![1]!;

    // Mallory (id 2) presses Approve first — hijack path resolves
    // the waiter with `blocked`. Alice (id 1) hasn't tapped yet.
    await (
      bot as unknown as {
        dispatchCallback(cq: {
          id: string;
          from?: { id: number; username?: string };
          message?: { message_id: number; chat: { id: number; type: string } };
          data?: string;
        }): Promise<void>;
      }
    ).dispatchCallback({
      id: 'cb-1',
      from: { id: 2, username: 'mallory' },
      message: { message_id: 1, chat: { id: 999, type: 'private' } },
      data: yesKey,
    });
    // Alice presses Approve a moment later. The waiter was already
    // deleted by the hijack path; this tap must not throw, must not
    // race the resolved Promise, and must not produce a second ack.
    await new Promise((r) => setTimeout(r, 10));
    await (
      bot as unknown as {
        dispatchCallback(cq: {
          id: string;
          from?: { id: number; username?: string };
          message?: { message_id: number; chat: { id: number; type: string } };
          data?: string;
        }): Promise<void>;
      }
    ).dispatchCallback({
      id: 'cb-2',
      from: { id: 1, username: 'alice' },
      message: { message_id: 1, chat: { id: 999, type: 'private' } },
      data: yesKey,
    });

    const result = await execPromise;
    // The first call wins: hijack -> blocked. Alice's tap is a no-op.
    expect(result.approved).toBe(false);
    expect(result.from).toBe('blocked');
    // Two ack calls: one for the blocked toast, one for Alice's "Approved".
    // (Alice's tap is still acknowledged so her client stops spinning.)
    expect(ackCalls).toHaveLength(2);
    expect(ackCalls[0]!.body).toContain('Not authorized');
    expect(ackCalls[1]!.body).toContain('Approved');
    bot.stop();
  });
});

