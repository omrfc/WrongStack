import type { WebSocket } from 'ws';
import type { WSClientMessage } from './types.js';

export interface BrainRouteHandlers {
  status: (ws: WebSocket, msg: WSClientMessage) => Promise<void> | void;
  risk: (ws: WebSocket, msg: WSClientMessage) => Promise<void> | void;
  ask: (ws: WebSocket, msg: WSClientMessage) => Promise<void> | void;
}

export async function handleBrainRoute(
  ws: WebSocket,
  msg: WSClientMessage,
  handlers: BrainRouteHandlers,
): Promise<boolean> {
  switch (msg.type) {
    case 'brain.status':
      await handlers.status(ws, msg);
      return true;
    case 'brain.risk':
      await handlers.risk(ws, msg);
      return true;
    case 'brain.ask':
      await handlers.ask(ws, msg);
      return true;
    default:
      return false;
  }
}
