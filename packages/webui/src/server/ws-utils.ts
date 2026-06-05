/**
 * Shared WebSocket utilities for both the standalone WebUI server and the
 * CLI's `--webui` embedded server. Extracted from the duplicated `send` /
 * `broadcast` / `sendResult` / `generateAuthToken` patterns that were
 * copy-pasted between `packages/webui/src/server/index.ts` and
 * `packages/cli/src/webui-server.ts`.
 */
import { randomBytes } from 'node:crypto';
// Value import (not `import type`): we reference `WebSocket.OPEN` below, which
// is a runtime value, not just a type.
import { WebSocket } from 'ws';
import type { ConnectedClient, WSServerMessage } from './types.js';

/**
 * Send a JSON message to a single WebSocket client.
 * No-op when the socket is not in OPEN state (disconnected / closing).
 */
export function send(ws: WebSocket, msg: WSServerMessage): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

/**
 * Broadcast a JSON message to every connected client.
 * Swallows per-socket send errors — a client that disconnected between the
 * readyState check and `ws.send()` is cleaned up by its own `close` handler.
 */
export function broadcast(
  clients: Map<WebSocket, ConnectedClient>,
  msg: WSServerMessage,
): void {
  const data = JSON.stringify(msg);
  for (const [ws] of clients) {
    if (ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(data);
      } catch {
        // Client disconnected between the readyState check and the send —
        // let the 'close' handler remove it from the map naturally.
      }
    }
  }
}

/**
 * Send a success/failure result message (used by key.* and provider.* handlers).
 * The frontend expects `key.operation_result` with `{ success, message }`.
 */
export function sendResult(ws: WebSocket, success: boolean, message: string): void {
  send(ws, { type: 'key.operation_result', payload: { success, message } });
}

/**
 * Extract a human-readable message from an unknown thrown value.
 */
export function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Generate a cryptographically random WebSocket auth token (hex string).
 * Shared between standalone and CLI-embedded WebUI servers.
 */
export function generateAuthToken(): string {
  return randomBytes(16).toString('hex');
}
