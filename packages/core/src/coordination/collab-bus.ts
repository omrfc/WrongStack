/**
 * CollaborationBus — kernel-level pause/resume signal for the
 * collaboration `controller` role (Phase 3 of idea #13 from IDEAS.md).
 *
 * The bus is a single-process singleton. The webui server (which hosts
 * the agent loop) creates one at boot, passes it to both the agent's
 * `toolCall` pipeline (as a middleware) and the `CollaborationWsHandler`
 * (which toggles it on client requests).
 *
 * Semantics:
 *   - `requestPause(by)` flips the bus into the "paused" state. The
 *     state has no timeout of its own — the *middleware* decides how
 *     long to wait before auto-resuming (default 60s).
 *   - `resume()` returns the bus to the running state. Idempotent:
 *     calling resume() when not paused is a no-op returning `false`.
 *   - `waitForResume(timeoutMs)` is what the middleware calls. It
 *     returns `true` if the bus was resumed in time, `false` if the
 *     timeout fired (in which case it also auto-resumes, so the agent
 *     loop is never permanently stuck).
 *   - `getState()` returns a snapshot for observability surfaces
 *     (UI badges, CLI `/collab status`).
 *
 * Why a separate bus object rather than putting state on RunController?
 *
 *   - The RunController is per-run; the bus is per-process. A single
 *     pause signal across the whole webui process is the right
 *     granularity (the webui hosts exactly one Agent.run at a time).
 *   - The bus can be unit-tested without spinning up an Agent. The
 *     middleware can be tested by injecting a fake bus.
 *   - Future multi-session webui (when the bus is upgraded to filter
 *     by sessionId) does not require touching the agent loop — the
 *     middleware already receives the sessionId in its payload.
 */

export type CollabBusState = {
  paused: boolean;
  pausedAt: string | null;
  pausedBy: string | null;
};

export class CollaborationBus {
  private pausePromise: Promise<void> | null = null;
  private pauseResolve: (() => void) | null = null;
  private pausedAtMs: number | null = null;
  private pausedBy: string | null = null;

  // ── State queries ──────────────────────────────────────────────────────

  isPaused(): boolean {
    return this.pausePromise !== null;
  }

  getState(): CollabBusState {
    return {
      paused: this.isPaused(),
      pausedAt: this.pausedAtMs ? new Date(this.pausedAtMs).toISOString() : null,
      pausedBy: this.pausedBy,
    };
  }

  // ── Pause / resume control ─────────────────────────────────────────────

  /**
   * Pause the agent loop. Idempotent: a second `requestPause` while
   * already paused is a no-op (the original pause wins; we do not
   * overwrite `pausedBy`). Returns true when the state actually
   * transitioned, false when it was already paused.
   */
  requestPause(byParticipant: string): boolean {
    if (this.isPaused()) return false;
    this.pausedAtMs = Date.now();
    this.pausedBy = byParticipant;
    this.pausePromise = new Promise<void>((resolve) => {
      this.pauseResolve = resolve;
    });
    return true;
  }

  /**
   * Resume the agent loop. Returns true when the state actually
   * transitioned from paused → running, false when it was already
   * running (no-op).
   */
  resume(): boolean {
    if (!this.isPaused()) return false;
    if (this.pauseResolve) this.pauseResolve();
    this.pausePromise = null;
    this.pauseResolve = null;
    this.pausedAtMs = null;
    this.pausedBy = null;
    return true;
  }

  // ── Wait semantics (consumed by the middleware) ────────────────────────

  /**
   * Block until the bus is resumed or the timeout fires. Returns:
   *   - `true`  → bus was resumed in time
   *   - `false` → timeout fired; bus was auto-resumed as a side effect
   *
   * When `timeoutMs` is `0` the wait is unbounded (the middleware must
   * be paired with an external AbortSignal in that case — we don't
   * expose one here to keep the API simple).
   */
  async waitForResume(timeoutMs: number): Promise<boolean> {
    if (!this.isPaused()) return true;
    if (!this.pausePromise) return true;
    if (timeoutMs === 0) {
      // Unbounded — caller is responsible for cancellation.
      await this.pausePromise;
      return true;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), timeoutMs);
    });
    const resumedPromise = this.pausePromise.then(() => 'resumed' as const);
    const winner = await Promise.race([resumedPromise, timeoutPromise]);
    if (timer) clearTimeout(timer);
    if (winner === 'timeout') {
      // Auto-resume to unblock the agent loop. The middleware logs this;
      // the UI surfaces it as "pause expired".
      this.resume();
      return false;
    }
    return true;
  }

  // ── Manual tool-call injection (Phase 4) ─────────────────────────────────
  //
  // A controller can ask the agent loop to use a specific tool_result
  // for a given tool_use_id — bypassing the real tool execution. This
  // is "I want the agent to think the read returned THIS content" or
  // "skip the bash call, just give it the answer I typed". The
  // injection is matched by tool_use_id, consumed once, and discarded.

  private readonly injectionQueue = new Map<string, InjectedToolResult>();

  /**
   * Queue a manual tool result. The next time the agent's toolCall
   * pipeline sees a matching `toolUse.id`, the
   * `collabInjectMiddleware` consumes this entry and replaces the
   * real tool execution. Returns `false` if an injection for the
   * same id is already queued (idempotent — first write wins).
   */
  injectToolResult(input: InjectedToolResult): boolean {
    if (this.injectionQueue.has(input.toolUseId)) return false;
    this.injectionQueue.set(input.toolUseId, input);
    return true;
  }

  /**
   * Pop an injection from the queue. Returns the payload (and
   * removes it) if one is pending, or `null` when nothing matches.
   * Called by the middleware on every tool call.
   */
  takeInjection(toolUseId: string): InjectedToolResult | null {
    const v = this.injectionQueue.get(toolUseId);
    if (!v) return null;
    this.injectionQueue.delete(toolUseId);
    return v;
  }

  /** Inspect the queue size (for observability / tests). */
  pendingInjectionCount(): number {
    return this.injectionQueue.size;
  }
}

/**
 * Payload for a queued manual tool-call injection. The middleware
 * splices this into the toolCall pipeline as a synthetic result.
 */
export interface InjectedToolResult {
  toolUseId: string;
  /** Serialized content the model will see (string, JSON, etc.). */
  content: unknown;
  /** When true, the result is rendered as a tool error. */
  isError: boolean;
  /**
   * Free-form context surfaced in the broadcast and the audit log,
   * e.g. "controller: read returned the right file but with these
   * contents" or "controller: skipped the destructive bash call".
   */
  reason: string;
  /** Participant id of the controller who issued the injection. */
  authorId: string;
}
