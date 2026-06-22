import type { WebSocket } from 'ws';
import { describe, expect, it, vi } from 'vitest';
import { handleMailboxRoute, type MailboxRouteHandlers } from '../../src/server/mailbox-routes.js';
import type { WSClientMessage } from '../../src/server/types.js';

function mockWs(): WebSocket & { send: ReturnType<typeof vi.fn> } {
  return { readyState: 1, send: vi.fn() } as never as WebSocket & { send: ReturnType<typeof vi.fn> };
}

function sentMessages(ws: { send: ReturnType<typeof vi.fn> }): unknown[] {
  return ws.send.mock.calls.map(([raw]) => JSON.parse(String(raw)) as unknown);
}

function handlers(): MailboxRouteHandlers {
  return {
    messages: vi.fn(),
    agents: vi.fn(),
    clear: vi.fn(),
    purge: vi.fn(),
  };
}

describe('handleMailboxRoute', () => {
  it('returns false for non-mailbox messages and does not send', async () => {
    const ws = mockWs();
    const h = handlers();

    await expect(handleMailboxRoute(ws, { type: 'chat.ready', payload: {} } as WSClientMessage, h)).resolves.toBe(false);

    expect(h.messages).not.toHaveBeenCalled();
    expect(h.agents).not.toHaveBeenCalled();
    expect(h.clear).not.toHaveBeenCalled();
    expect(h.purge).not.toHaveBeenCalled();
    expect(sentMessages(ws)).toEqual([]);
  });

  it.each([
    ['mailbox.messages', 'messages'],
    ['mailbox.agents', 'agents'],
    ['mailbox.clear', 'clear'],
    ['mailbox.purge', 'purge'],
  ] as const)('dispatches %s to %s', async (type, handlerName) => {
    const ws = mockWs();
    const h = handlers();
    const msg = { type, payload: { limit: 10 } } as never as WSClientMessage;

    await expect(handleMailboxRoute(ws, msg, h)).resolves.toBe(true);

    expect(h[handlerName]).toHaveBeenCalledTimes(1);
  });

  it('forwards the original message object to payload-bearing handlers', async () => {
    const ws = mockWs();
    const h = handlers();
    const msg = { type: 'mailbox.purge', payload: { completedMaxAgeMs: 1 } } as never as WSClientMessage;

    await expect(handleMailboxRoute(ws, msg, h)).resolves.toBe(true);

    expect(h.purge).toHaveBeenCalledWith(ws, msg);
    expect(sentMessages(ws)).toEqual([]);
  });
});
