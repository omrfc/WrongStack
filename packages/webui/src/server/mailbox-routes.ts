import type { WebSocket } from 'ws';
import type { WSClientMessage } from './types.js';

export interface MailboxRouteHandlers {
  messages: (ws: WebSocket, msg: WSClientMessage) => Promise<void> | void;
  agents: (ws: WebSocket, msg: WSClientMessage) => Promise<void> | void;
  clear: (ws: WebSocket, msg: WSClientMessage) => Promise<void> | void;
  purge: (ws: WebSocket, msg: WSClientMessage) => Promise<void> | void;
}

export async function handleMailboxRoute(
  ws: WebSocket,
  msg: WSClientMessage,
  handlers: MailboxRouteHandlers,
): Promise<boolean> {
  switch (msg.type) {
    case 'mailbox.messages':
      await handlers.messages(ws, msg);
      return true;
    case 'mailbox.agents':
      await handlers.agents(ws, msg);
      return true;
    case 'mailbox.clear':
      await handlers.clear(ws, msg);
      return true;
    case 'mailbox.purge':
      await handlers.purge(ws, msg);
      return true;
    default:
      return false;
  }
}
