import type { WebSocket } from 'ws';
import { describe, expect, it, vi } from 'vitest';
import { handleAutoPhaseRoute, type AutoPhaseRouteHandlers } from '../../src/server/autophase-routes.js';
import type { WSClientMessage } from '../../src/server/types.js';

function mockWs(): WebSocket & { send: ReturnType<typeof vi.fn> } {
  return { readyState: 1, send: vi.fn() } as unknown as WebSocket & { send: ReturnType<typeof vi.fn> };
}

function sentMessages(ws: { send: ReturnType<typeof vi.fn> }): unknown[] {
  return ws.send.mock.calls.map(([raw]) => JSON.parse(String(raw)) as unknown);
}

function handlers(): AutoPhaseRouteHandlers {
  return {
    handleMessage: vi.fn(),
  };
}

describe('handleAutoPhaseRoute', () => {
  it('returns false for non-autophase messages and does not send', async () => {
    const ws = mockWs();
    const h = handlers();

    await expect(handleAutoPhaseRoute(ws, { type: 'chat.ready', payload: {} } as WSClientMessage, h)).resolves.toBe(false);

    expect(h.handleMessage).not.toHaveBeenCalled();
    expect(sentMessages(ws)).toEqual([]);
  });

  it('dispatches autophase-prefixed messages', async () => {
    const ws = mockWs();
    const h = handlers();
    const msg = { type: 'autophase.start', payload: { graphId: 'g1' } } as unknown as WSClientMessage;

    await expect(handleAutoPhaseRoute(ws, msg, h)).resolves.toBe(true);

    expect(h.handleMessage).toHaveBeenCalledWith(msg);
    expect(sentMessages(ws)).toEqual([]);
  });

  it('dispatches unknown autophase-prefixed messages to the AutoPhase handler', async () => {
    const ws = mockWs();
    const h = handlers();
    const msg = { type: 'autophase.custom', payload: { value: 1 } } as unknown as WSClientMessage;

    await expect(handleAutoPhaseRoute(ws, msg, h)).resolves.toBe(true);

    expect(h.handleMessage).toHaveBeenCalledWith(msg);
  });
});
