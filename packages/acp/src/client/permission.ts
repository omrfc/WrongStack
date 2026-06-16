/**
 * Permission policy for ACP v1 client sessions.
 *
 * ACP agents can call `session/request_permission` to ask the user
 * before executing a tool call. The client is expected to surface
 * the question, get a decision, and respond. This module is the seam
 * where WrongStack-specific permission UI can plug in; for v1 we ship
 * a minimal default that auto-approves the first `allow_once` option
 * (or `allow_always` if present) and rejects on abort.
 */
import type {
  PermissionOption,
  RequestPermissionOutcome,
  ToolCallUpdateNotification,
} from '../types/acp-v1.js';

/** A single permission decision request. */
export interface PermissionRequest {
  toolCall: ToolCallUpdateNotification;
  options: readonly PermissionOption[];
  signal: AbortSignal;
}

/** A permission policy decides how to respond to a request. */
export type PermissionPolicy = (
  req: PermissionRequest,
) => Promise<RequestPermissionOutcome>;

/**
 * Default policy: pick the safest-looking allow option if the signal
 * is not aborted, otherwise report cancelled. Order of preference:
 *
 *   1. `allow_always`
 *   2. `allow_once`
 *   3. anything else with `optionId` (last resort)
 *
 * Real WrongStack permission UIs replace this; the contract is the
 * `PermissionPolicy` function type, not the implementation.
 */
export const defaultPermissionPolicy: PermissionPolicy = async (req) => {
  if (req.signal.aborted) return { outcome: 'cancelled' };

  const ranked = [...req.options].sort((a, b) => {
    const score = (k: PermissionOption['kind']): number => {
      if (k === 'allow_always') return 0;
      if (k === 'allow_once') return 1;
      if (k === 'reject_once') return 2;
      return 3;
    };
    return score(a.kind) - score(b.kind);
  });
  const chosen = ranked[0];
  if (!chosen || chosen.kind === 'reject_once' || chosen.kind === 'reject_always') {
    return { outcome: 'cancelled' };
  }
  return { outcome: 'selected', optionId: chosen.optionId };
};
