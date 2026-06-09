/**
 * Shared memory-operation WebSocket handlers for both the standalone WebUI
 * server and the CLI's `--webui` embedded server. Extracted from the
 * duplicated switch cases in `index.ts` and `cli/src/webui-server.ts`.
 *
 * Each function handles the full request→response cycle for one message
 * type. Callers drop them into their switch statement:
 *
 *   case 'memory.list': return handleMemoryList(ws, memoryStore);
 */

import type { WebSocket } from 'ws';
import type { MemoryStore } from '@wrongstack/core';
import { send, sendResult, errMessage } from './ws-utils.js';

// ── Shared handlers ───────────────────────────────────────────────────

/**
 * List all memory entries across all scopes.
 * Responds with `{ type: 'memory.list', payload: { text } }`.
 */
export async function handleMemoryList(
  ws: WebSocket,
  memoryStore: MemoryStore,
): Promise<void> {
  try {
    const text = await memoryStore.readAll();
    send(ws, { type: 'memory.list', payload: { text } });
  } catch (err) {
    send(ws, {
      type: 'memory.list',
      payload: { text: '', error: errMessage(err) },
    });
  }
}

/**
 * Persist a new memory entry.
 * Responds with `{ type: 'key.operation_result', payload: { success, message } }`.
 */
export async function handleMemoryRemember(
  ws: WebSocket,
  msg: unknown,
  memoryStore: MemoryStore,
): Promise<void> {
  const { text, scope } = (
    msg as {
      payload: {
        text: string;
        scope?: 'project-agents' | 'project-memory' | 'user-memory' | undefined;
      };
    }
  ).payload;
  try {
    await memoryStore.remember(text, scope ?? 'project-memory');
    sendResult(ws, true, 'Saved to memory');
  } catch (err) {
    sendResult(ws, false, errMessage(err));
  }
}

/**
 * Remove memory entries matching the given text.
 * Responds with `{ type: 'key.operation_result', payload: { success, message } }`.
 */
export async function handleMemoryForget(
  ws: WebSocket,
  msg: unknown,
  memoryStore: MemoryStore,
): Promise<void> {
  const { text, scope } = (
    msg as {
      payload: {
        text: string;
        scope?: 'project-agents' | 'project-memory' | 'user-memory' | undefined;
      };
    }
  ).payload;
  try {
    const removed = await memoryStore.forget(text, scope ?? 'project-memory');
    sendResult(
      ws,
      removed > 0,
      removed > 0
        ? `Removed ${removed} entr${removed === 1 ? 'y' : 'ies'}`
        : 'No matching entries',
    );
  } catch (err) {
    sendResult(ws, false, errMessage(err));
  }
}
