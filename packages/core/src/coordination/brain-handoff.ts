/**
 * Brain-arbiter / subagent bridge handoff for the Director.
 *
 * Owns the `ask()` method — a synchronous request/reply path through
 * the in-memory agent bridge to a previously-spawned subagent. Extracted
 * out of `director.ts` so the cross-process message envelope logic
 * lives next to the bridge types it depends on.
 *
 * Public surface (called from `Director`):
 *   - `ask` — request/reply a subagent via the bridge
 */
import { randomUUID } from 'node:crypto';
import type { BridgeMessage } from '../types/agent-bridge.js';
import type { InMemoryAgentBridge } from './agent-bridge.js';

/**
 * Narrow interface the helper needs from the Director. Kept here
 * (instead of importing the full Director class) to avoid a circular
 * import: director.ts re-exports the helpers.
 */
export interface DirectorBrainHost {
  readonly id: string;
  readonly bridge: InMemoryAgentBridge;
  /** Live bridges indexed by subagent id — `ask` requires the target to be spawned. */
  readonly subagentBridges: Map<string, InMemoryAgentBridge>;
}

/**
 * Synchronously ask a subagent something via the bridge. Sends a
 * `task` message addressed to the subagent and awaits a matching
 * reply (matched by message id). Subagent runners that handle these
 * requests subscribe to `ctx.bridge` and reply with a message whose
 * `id` equals the incoming request's id (see `InMemoryAgentBridge`'s
 * `request<T>` implementation).
 *
 * Returns the response payload directly (the bridge wrapper is
 * unwrapped for ergonomics). Times out after `timeoutMs` (default
 * matches the bridge's own default of 30s) — surface those rejections
 * to the caller as actionable errors instead of letting tools hang.
 */
export async function ask<T = unknown>(
  host: DirectorBrainHost,
  subagentId: string,
  payload: unknown,
  timeoutMs?: number,
): Promise<T> {
  if (!host.subagentBridges.has(subagentId)) {
    throw new Error(
      `ask: unknown subagent "${subagentId}" (spawn() it first; current fleet: ${Array.from(host.subagentBridges.keys()).join(', ') || '(empty)'})`,
    );
  }
  const msg: BridgeMessage = {
    id: randomUUID(),
    type: 'task',
    from: host.id,
    to: subagentId,
    payload,
    timestamp: Date.now(),
    priority: 'normal',
  };
  const reply = await host.bridge.request<T>(msg, timeoutMs);
  return reply.payload;
}
