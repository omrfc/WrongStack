import type { Agent } from '@wrongstack/core';
import type { WebSocket } from 'ws';
import type { WsCommon } from './index.js';

/**
 * PR 5f of Issue #30: preference WebSocket handlers — `prefs.get`,
 * `prefs.update`, and `autonomy.switch`.
 *
 * The durable logic (which keys are persisted, the config.json key
 * mapping, and the live pref snapshot off `ctx.meta`) lives in runWebUI's
 * `prefSnapshot` / `persistPrefsToConfig` closures and the host's real
 * autonomy setter; they're threaded in here as callbacks. The handlers
 * themselves just write `ctx.meta`, fan the snapshot out, and persist.
 */

export interface PrefsContext extends WsCommon {
  /** The running agent — preferences live on `agent.ctx.meta`. */
  agent: Agent;
  /** Snapshot the durable prefs off ctx.meta (runWebUI closure). */
  prefSnapshot: () => Record<string, unknown>;
  /** Persist the durable keys to config.json, fire-and-forget (runWebUI closure). */
  persistPrefs: (payload: Record<string, unknown>) => Promise<void>;
  /** Flip the CLI's real autonomy state (same setter the TUI uses), if wired. */
  onAutonomySwitch: ((mode: string) => void) | undefined;
}

function sendResult(ctx: WsCommon, ws: WebSocket, success: boolean, message: string): void {
  ctx.send(ws, { type: 'key.operation_result', payload: { success, message } });
}

export function handlePrefsGet(ctx: PrefsContext, ws: WebSocket): void {
  // Return the current pref snapshot from context.meta so the frontend
  // can seed its local-prefs store from the server's truth.
  ctx.send(ws, { type: 'prefs.updated', payload: ctx.prefSnapshot() });
}

export function handlePrefsUpdate(
  ctx: PrefsContext,
  _ws: WebSocket,
  payload: Record<string, unknown>,
): void {
  // Batch preference update. Merge arbitrary key/value pairs into
  // context.meta so the runtime can read them immediately, persist the
  // durable keys to config.json, then broadcast the full snapshot so all
  // browser tabs stay in sync.
  for (const [key, val] of Object.entries(payload)) {
    ctx.agent.ctx.meta[key] = val;
  }
  void ctx.persistPrefs(payload);
  ctx.broadcast({ type: 'prefs.updated', payload: ctx.prefSnapshot() });
}

export function handleAutonomySwitch(ctx: PrefsContext, ws: WebSocket, mode: string): void {
  ctx.agent.ctx.meta['autonomy'] = mode;
  // Flip the CLI's REAL autonomy state (same setter the TUI uses) — meta
  // alone is advisory and the running loop never reads it.
  ctx.onAutonomySwitch?.(mode);
  sendResult(ctx, ws, true, `Autonomy mode set to "${mode}"`);
  ctx.broadcast({ type: 'prefs.updated', payload: { autonomy: mode } });
  void ctx.persistPrefs({ autonomy: mode });
}
