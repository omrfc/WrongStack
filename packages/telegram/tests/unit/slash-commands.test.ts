import type { Logger } from '@wrongstack/core';
import { describe, expect, it, vi } from 'vitest';
import { TelegramBot } from '../../src/bot.js';
import type { TelegramIncomingMessage } from '../../src/bot.js';
import type { TelegramPluginConfig } from '../../src/config.js';
import {
  tgChatIdCommand,
  tgSendCommand,
  tgStatusCommand,
} from '../../src/slash-commands/index.js';

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

function makeBot() {
  return new TelegramBot({
    token: 'test:token',
    pollIntervalSec: 60,
    allowedUsers: new Set<string>(),
    allowedChats: new Set<string>(),
    bufferSize: 10,
    log,
    onMessage: vi.fn(),
  });
}

function makeConfig(overrides?: Partial<TelegramPluginConfig>): TelegramPluginConfig {
  return {
    botToken: 'test:token',
    pollIntervalSec: 2,
    notifyOnSessionEnd: true,
    longToolThresholdMs: 30_000,
    maxMessageLength: 4000,
    allowedUsers: [111, 222],
    allowedChats: ['-100123'],
    notifyChatId: '999',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// /telegram:status
// ---------------------------------------------------------------------------

describe('tgStatusCommand', () => {
  it('shows connected bot status', async () => {
    const bot = makeBot();
    bot.start();
    // Mock health to return a healthy bot
    bot.health = vi.fn().mockResolvedValue({ ok: true, username: 'test_bot' });

    const cmd = tgStatusCommand(bot, makeConfig());
    const res = await cmd.run('', null as never);

    expect(res?.message).toContain('✅ @test_bot');
    expect(res?.message).toContain('Running:   yes');
    expect(res?.message).toContain('every 2s');
    expect(res?.message).toContain('2 users');
    expect(res?.message).toContain('1 chats');
    expect(res?.message).toContain('sessionEnd=true');
    expect(res?.message).toContain('longTool=30000ms');
  });

  it('shows offline bot status', async () => {
    const bot = makeBot();
    bot.health = vi.fn().mockResolvedValue({ ok: false, error: 'Network error' });

    const cmd = tgStatusCommand(bot, makeConfig());
    const res = await cmd.run('', null as never);

    expect(res?.message).toContain('❌ Network error');
    expect(res?.message).toContain('Running:   no');
  });

  it('shows "offline" when health has no error message', async () => {
    const bot = makeBot();
    bot.health = vi.fn().mockResolvedValue({ ok: false });

    const cmd = tgStatusCommand(bot, makeConfig());
    const res = await cmd.run('', null as never);

    expect(res?.message).toContain('❌ offline');
  });

  it('shows N/A when bot never started', async () => {
    const bot = makeBot();
    bot.health = vi.fn().mockResolvedValue({ ok: true, username: 'b' });

    const cmd = tgStatusCommand(bot, makeConfig());
    const res = await cmd.run('', null as never);

    expect(res?.message).toContain('Started:   N/A');
  });

  it('shows everyone when no allowlists set', async () => {
    const bot = makeBot();
    bot.health = vi.fn().mockResolvedValue({ ok: true, username: 'b' });

    const cfg = makeConfig({ allowedUsers: [], allowedChats: [] });
    const cmd = tgStatusCommand(bot, cfg);
    const res = await cmd.run('', null as never);

    expect(res?.message).toContain('everyone (users)');
    expect(res?.message).toContain('everyone (chats)');
  });

  it('shows "off" when notifications disabled', async () => {
    const bot = makeBot();
    bot.health = vi.fn().mockResolvedValue({ ok: true, username: 'b' });

    const cfg = makeConfig({ notifyOnSessionEnd: false, longToolThresholdMs: 0 });
    const cmd = tgStatusCommand(bot, cfg);
    const res = await cmd.run('', null as never);

    expect(res?.message).toContain('sessionEnd=false');
    expect(res?.message).toContain('longTool=off');
  });

  it('falls back to false when notifyOnSessionEnd is undefined', async () => {
    const bot = makeBot();
    bot.health = vi.fn().mockResolvedValue({ ok: true, username: 'b' });

    const cfg = makeConfig({ notifyOnSessionEnd: undefined, longToolThresholdMs: 0 });
    const cmd = tgStatusCommand(bot, cfg);
    const res = await cmd.run('', null as never);

    expect(res?.message).toContain('sessionEnd=false');
  });

  it('falls back to "connected" when username missing', async () => {
    const bot = makeBot();
    bot.health = vi.fn().mockResolvedValue({ ok: true });

    const cmd = tgStatusCommand(bot, makeConfig());
    const res = await cmd.run('', null as never);

    expect(res?.message).toContain('✅ @connected');
  });

  it('shows polling fallback when pollIntervalSec not set', async () => {
    const bot = makeBot();
    bot.health = vi.fn().mockResolvedValue({ ok: true, username: 'b' });

    const cfg = makeConfig({ pollIntervalSec: undefined as unknown as number });
    const cmd = tgStatusCommand(bot, cfg);
    const res = await cmd.run('', null as never);

    expect(res?.message).toContain('every 2s');
  });

  it('shows everyone when allowedUsers undefined', async () => {
    const bot = makeBot();
    bot.health = vi.fn().mockResolvedValue({ ok: true, username: 'b' });

    const cfg = makeConfig({ allowedUsers: undefined, allowedChats: undefined });
    const cmd = tgStatusCommand(bot, cfg);
    const res = await cmd.run('', null as never);

    expect(res?.message).toContain('everyone (users)');
    expect(res?.message).toContain('everyone (chats)');
  });
});

// ---------------------------------------------------------------------------
// /telegram:send
// ---------------------------------------------------------------------------

describe('tgSendCommand', () => {
  it('shows usage when no args', async () => {
    const bot = makeBot();
    const cmd = tgSendCommand(bot, '999');
    const res = await cmd.run('', null as never);

    expect(res?.message).toContain('Usage:');
  });

  it('sends with explicit chat_id in args', async () => {
    const bot = makeBot();
    const sendSpy = vi.fn().mockResolvedValue({
      ok: true,
      result: { message_id: 42, chat: { id: 123, type: 'private' } },
    });
    bot.sendMessage = sendSpy;

    const cmd = tgSendCommand(bot, '999');
    const res = await cmd.run('123456 Hello world!', null as never);

    expect(sendSpy).toHaveBeenCalledWith('123456', 'Hello world!');
    expect(res?.message).toContain('✅');
    expect(res?.message).toContain('123456');
    expect(res?.message).toContain('msg_id=42');
  });

  it('uses default chatId when no id in args', async () => {
    const bot = makeBot();
    const sendSpy = vi.fn().mockResolvedValue({
      ok: true,
      result: { message_id: 7 },
    });
    bot.sendMessage = sendSpy;

    const cmd = tgSendCommand(bot, '888');
    const res = await cmd.run('Just a message', null as never);

    expect(sendSpy).toHaveBeenCalledWith('888', 'Just a message');
    expect(res?.message).toContain('✅');
  });

  it('shows error when no default and no chat_id in args', async () => {
    const bot = makeBot();
    const cmd = tgSendCommand(bot, undefined);
    const res = await cmd.run('Hello', null as never);

    expect(res?.message).toContain('No chat_id provided');
  });

  it('handles send failure gracefully', async () => {
    const bot = makeBot();
    bot.sendMessage = vi.fn().mockRejectedValue(new Error('Bot blocked by user'));

    const cmd = tgSendCommand(bot, '999');
    const res = await cmd.run('Hello', null as never);

    expect(res?.message).toContain('❌');
    expect(res?.message).toContain('Bot blocked by user');
  });

  it('handles send result without message_id', async () => {
    const bot = makeBot();
    bot.sendMessage = vi.fn().mockResolvedValue({
      ok: true,
      result: undefined,
    });

    const cmd = tgSendCommand(bot, '999');
    const res = await cmd.run('hi', null as never);

    expect(res?.message).toContain('msg_id=?');
  });
});

// ---------------------------------------------------------------------------
// /telegram:chatid
// ---------------------------------------------------------------------------

describe('tgChatIdCommand', () => {
  it('shows configured chat ID', async () => {
    const cmd = tgChatIdCommand('123456');
    const res = await cmd.run('', null as never);
    expect(res?.message).toContain('123456');
  });

  it('shows message when no chat ID configured', async () => {
    const cmd = tgChatIdCommand(undefined);
    const res = await cmd.run('', null as never);
    expect(res?.message).toContain('No notifyChatId configured');
  });
});
