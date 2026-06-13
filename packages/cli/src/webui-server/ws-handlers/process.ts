import type { WebSocket } from 'ws';
import type { WsCommon, WsServerMessage } from './index.js';

/**
 * PR 5g of Issue #30: process ws-handlers.
 *
 * Extracted from the inline `handleMessage` switch in webui-server.ts.
 * These handlers manage the process registry (list, kill, killAll).
 */

export interface ProcessContext extends WsCommon {
  /** No extra fields needed — process registry is a global singleton. */
}

/** Helper to send a success/failure result message. */
function sendResult(
  ctx: ProcessContext,
  ws: WebSocket,
  success: boolean,
  message: string,
): void {
  ctx.send(ws, { type: 'key.operation_result', payload: { success, message } });
}

export async function handleProcessList(ctx: ProcessContext, ws: WebSocket): Promise<void> {
  try {
    const { getProcessRegistry } = await import('@wrongstack/tools');
    const procs = getProcessRegistry().list();
    ctx.send(ws, {
      type: 'process.list',
      payload: {
        processes: procs.map((p) => ({
          pid: p.pid,
          command: p.command,
          tool: p.name,
          startedAt: p.startedAt,
          status: p.killed ? ('killed' as const) : ('running' as const),
          protected: p.protected,
        })),
      },
    });
  } catch {
    ctx.send(ws, { type: 'process.list', payload: { processes: [] } });
  }
}

export async function handleProcessKill(
  ctx: ProcessContext,
  ws: WebSocket,
  pid: number,
): Promise<void> {
  try {
    const { getProcessRegistry } = await import('@wrongstack/tools');
    const proc = getProcessRegistry().get(pid);
    if (proc?.protected) {
      sendResult(ctx, ws, false, `Cannot kill protected process (PID ${pid})`);
      return;
    }
    getProcessRegistry().kill(pid);
    sendResult(ctx, ws, true, `Killed PID ${pid}`);
  } catch (err) {
    sendResult(ctx, ws, false, err instanceof Error ? err.message : String(err));
  }
}

export async function handleProcessKillAll(ctx: ProcessContext, ws: WebSocket): Promise<void> {
  try {
    const { getProcessRegistry } = await import('@wrongstack/tools');
    getProcessRegistry().killAll();
    sendResult(ctx, ws, true, 'All processes killed');
  } catch (err) {
    sendResult(ctx, ws, false, err instanceof Error ? err.message : String(err));
  }
}
