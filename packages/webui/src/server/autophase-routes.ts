import type { WebSocket } from 'ws';
import type { WSClientMessage } from './types.js';

export interface AutoPhaseRouteHandlers {
  handleMessage: (msg: { type: string; payload?: Record<string, unknown> }) => Promise<void>;
}

export async function handleAutoPhaseRoute(
  _ws: WebSocket,
  msg: WSClientMessage,
  handlers: AutoPhaseRouteHandlers,
): Promise<boolean> {
  if (!msg.type.startsWith('autophase.')) return false;
  await handlers.handleMessage(msg as { type: string; payload?: Record<string, unknown> });
  return true;
}
