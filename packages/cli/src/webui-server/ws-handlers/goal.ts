import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { WebSocket } from 'ws';
import type { WsCommon, WsServerMessage } from './index.js';

/**
 * PR 5h of Issue #30: goal ws-handler.
 *
 * Extracted from the inline `handleMessage` switch in webui-server.ts.
 * Reads goal.json from disk and broadcasts to all connected clients.
 */

export interface GoalContext extends WsCommon {
  /** Project root directory where .wrongstack/goal.json lives. */
  projectRoot: string;
}

export async function handleGoalGet(ctx: GoalContext, _ws: WebSocket): Promise<void> {
  try {
    const goalPath = path.join(ctx.projectRoot, '.wrongstack', 'goal.json');
    const raw = await fs.readFile(goalPath, 'utf8');
    const goal = JSON.parse(raw);
    ctx.broadcast({ type: 'goal.updated', payload: goal });
  } catch {
    ctx.broadcast({ type: 'goal.updated', payload: null });
  }
}
