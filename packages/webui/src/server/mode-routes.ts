import type { WebSocket } from 'ws';
import type { WSClientMessage } from './types.js';

export interface ModeRouteHandlers {
  listModes: (ws: WebSocket) => Promise<void>;
  switchMode: (ws: WebSocket, msg: WSClientMessage) => Promise<void>;
}

export async function handleModeRoute(
  ws: WebSocket,
  msg: WSClientMessage,
  handlers: ModeRouteHandlers,
): Promise<boolean> {
  switch (msg.type) {
    case 'modes.list':
      await handlers.listModes(ws);
      return true;
    case 'mode.switch':
      await handlers.switchMode(ws, msg);
      return true;
    default:
      return false;
  }
}
