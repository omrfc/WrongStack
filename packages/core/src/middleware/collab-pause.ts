import type { CollaborationBus, InjectedToolResult } from '../coordination/collab-bus.js';
import type { ToolCallPipelinePayload } from '../core/agent.js';

/**
 * collabPauseMiddleware — gates the agent's `toolCall` pipeline on
 * the collaboration pause signal.
 *
 * Position: must be installed as the *first* middleware in the
 * `toolCall` pipeline so it runs before permission checks, retries,
 * and the tool itself. That way the controller can halt an agent
 * regardless of what the model is about to do.
 *
 * Semantics:
 *   - When the bus is not paused: pass through (`next()`).
 *   - When the bus is paused: await `bus.waitForResume(timeoutMs)`.
 *     The default timeout is 60s — long enough for a human to think,
 *     short enough that a forgotten controller doesn't pin the agent
 *     forever. The auto-resume on timeout is logged below.
 *
 * Phase 3 of idea #13. Manual tool-call injection (a controller
 * "writing" a tool result) is *not* in scope for this middleware —
 * that requires splicing the injected result into the agent's
 * message stream and is a follow-up.
 */

export interface CollabPauseMiddlewareOptions {
  /**
   * How long to wait for a resume before auto-resuming the bus.
   * Defaults to 60_000 ms. Set to 0 for an unbounded wait (the
   * caller is then responsible for cancellation via the bus itself).
   */
  defaultTimeoutMs?: number;
  /**
   * Optional logger — receives a debug line on pause entry and on
   * timeout-driven auto-resume. Matches the `Logger` token surface
   * so the runtime can pass its existing logger.
   */
  logger?: {
    debug?: (msg: string) => void;
    warn?: (msg: string) => void;
  };
}

export function collabPauseMiddleware(
  bus: CollaborationBus,
  opts: CollabPauseMiddlewareOptions = {},
) {
  const timeoutMs = opts.defaultTimeoutMs ?? 60_000;
  const logger = opts.logger;

  return async function collabPause(
    payload: ToolCallPipelinePayload,
    next: () => Promise<void>,
  ): Promise<void> {
    if (!bus.isPaused()) {
      // Fast path: not paused. We still call next() unconditionally
      // so the rest of the pipeline runs as if we weren't here.
      return next();
    }
    const state = bus.getState();
    logger?.debug?.(
      `collab-pause: tool '${payload.toolUse.name}' blocked — bus paused by ${
        state.pausedBy ?? '?'
      } at ${state.pausedAt ?? '?'}, waiting up to ${timeoutMs}ms for resume`,
    );
    const resumed = await bus.waitForResume(timeoutMs);
    if (!resumed) {
      logger?.warn?.(
        `collab-pause: timeout after ${timeoutMs}ms — auto-resuming the bus to unblock the agent loop`,
      );
    } else {
      logger?.debug?.(`collab-pause: resumed — proceeding with tool '${payload.toolUse.name}'`);
    }
    return next();
  };
}

/**
 * collabInjectMiddleware — Phase 4 of idea #13. Splices
 * controller-injected tool results into the toolCall pipeline.
 *
 * Position: should run AFTER `collabPauseMiddleware` so the
 * controller has a chance to pause + inject before the next tool
 * executes. Install order:
 *   - `pipeline.toolCall.prepend(collabPause)`
 *   - `pipeline.toolCall.prepend(collabInject)`  // runs second
 *
 * Semantics:
 *   - On every tool call, the middleware asks the bus for an
 *     injection matching `payload.toolUse.id`.
 *   - If one is queued, the payload's `result` is replaced with
 *     a synthetic ToolResultBlock carrying the injected content +
 *     `is_error` flag. The real `next()` is NOT called — the
 *     downstream tool executor sees a payload that's already
 *     "complete" and skips the actual tool.
 *   - The injection is consumed once and removed from the bus.
 *
 * Why this shape: by replacing the result *before* the executor
 * runs, we keep the kernel's `ToolExecutor` untouched. The agent
 * loop's existing `tool.executed` event still fires (carrying
 * the injected content), so the session log + observers see a
 * normal-looking call — just with the controller's intent in
 * the result instead of the real tool's output.
 */
export function collabInjectMiddleware(
  bus: CollaborationBus,
  opts: {
    logger?: {
      debug?: (msg: string) => void;
      warn?: (msg: string) => void;
    };
  } = {},
) {
  const logger = opts.logger;
  return async function collabInject(
    payload: ToolCallPipelinePayload,
    next: () => Promise<void>,
  ): Promise<void> {
    const injected = bus.takeInjection(payload.toolUse.id);
    if (!injected) {
      // No manual injection — proceed normally.
      return next();
    }
    logger?.debug?.(
      `collab-inject: tool '${payload.toolUse.name}' (id ${payload.toolUse.id}) — using controller-injected result (reason: ${injected.reason})`,
    );
    // Splice the injected content into the payload's result block.
    // The downstream tool executor reads `payload.result` to decide
    // whether to call the tool — we set it here so the executor
    // short-circuits.
    payload.result = {
      type: 'tool_result' as const,
      tool_use_id: payload.toolUse.id,
      content:
        typeof injected.content === 'string'
          ? injected.content
          : JSON.stringify(injected.content),
      is_error: injected.isError,
    };
    // Don't call next() — the executor path is skipped because
    // `payload.result` is already populated.
  };
}

// Re-export so callers that import from this module get the type
// without an extra import.
export type { InjectedToolResult };
