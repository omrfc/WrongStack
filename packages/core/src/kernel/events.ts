/**
 * EventBus — observe-only typed event bus.
 * Subscribers cannot modify or cancel. Subscriber exceptions are caught.
 */

import type { Context } from '../core/context.js';
import type { Usage } from '../types/provider.js';
import type { Tool, ToolProgressEvent } from '../types/tool.js';

export interface EventMap {
  'session.started': { id: string };
  'session.ended': { id: string; usage: Usage };
  'session.damaged': { sessionId: string; detail: string };
  'iteration.started': { ctx: Context; index: number };
  'iteration.completed': { ctx: Context; index: number };
  /**
   * Fired when the agent hits its iteration limit. Listeners (CLI/TUI) can
   * call `grant(extra)` to allow more iterations, or `deny()` to stop.
   * If no listener responds within 30s the run ends with 'max_iterations'.
   */
  'iteration.limit_reached': {
    currentIterations: number;
    currentLimit: number;
    grant: (extraIterations: number) => void;
    deny: () => void;
  };
  'provider.response': { ctx: Context; usage: Usage; stopReason: string };
  'provider.text_delta': { ctx: Context; text: string };
  'provider.thinking_delta': { ctx: Context; text: string };
  'provider.tool_use_start': { ctx: Context; id: string; name: string };
  'provider.tool_use_stop': { ctx: Context; id: string };
  /**
   * Fired before each retry of a failed provider call. `attempt` is 1-based
   * (the first retry is attempt 1, etc.). `description` is the human-readable
   * one-liner from `ProviderError.describe()` — render this in the CLI/TUI
   * instead of grepping logger output for the raw JSON body.
   */
  'provider.retry': {
    providerId: string;
    attempt: number;
    delayMs: number;
    status: number;
    description: string;
  };
  /**
   * Fired once when a provider call ultimately fails (retries exhausted, or
   * non-retryable error). Same shape as `provider.retry` minus the delay.
   */
  'provider.error': {
    providerId: string;
    status: number;
    description: string;
    retryable: boolean;
  };
  'tool.started': { name: string; id: string; input?: unknown };
  /**
   * Fired for each ToolProgressEvent yielded by `Tool.executeStream`. UIs
   * subscribe to render incremental progress (streaming bash output, file
   * tree counts, etc.) without the tool having to know about the UI.
   */
  'tool.progress': { name: string; id: string; event: ToolProgressEvent };
  /**
   * Fired when a tool call needs user confirmation and no confirmHandler
   * is registered on the executor. The TUI renders a confirmation dialog
   * from this event. Resolution is driven by calling the resolve function
   * passed in the payload with a decision string ('yes' | 'no' | 'always' | 'deny').
   */
  'tool.confirm_needed': {
    tool: Tool;
    input: unknown;
    toolUseId: string;
    suggestedPattern: string;
    resolve: (decision: 'yes' | 'no' | 'always' | 'deny') => void;
  };
  /**
   * `output` is a truncated preview of the tool's serialized result text
   * (capped at ~400 chars by the emitter). UIs render this inline in the
   * tool history line without re-fetching from the session log.
   */
  'tool.executed': {
    /**
     * The tool_use id (e.g. "toolu_…") issued by the provider for this call.
     * Pairs with `tool.started.id` so subscribers can correlate start/finish
     * even when the model fires multiple tools in parallel with identical
     * inputs. Optional only for legacy emit sites — new code should always
     * set it.
     */
    id?: string;
    name: string;
    durationMs: number;
    ok: boolean;
    input?: unknown;
    output?: string;
    /**
     * Full UTF-8 byte length of the serialized tool result that the model
     * actually sees (post-cap, post-scrub). The `output` preview is capped
     * at ~400 chars for transport; this number lets UIs surface what the
     * model is really paying tokens for. Optional only for legacy emit
     * sites that may not yet populate it.
     */
    outputBytes?: number;
    /**
     * Estimated token count for the full result body the model sees.
     * Computed from `outputBytes` with the standard ~3.5 chars/token
     * heuristic. Cheap to show in the TUI; not authoritative — the real
     * provider count lives in `provider.response.usage`. */
    outputTokens?: number;
    /**
     * For tools whose output has a clear "line" notion (file reads with
     * numbered prefixes, grep hits, bash stdout), the agent counts the
     * actual lines the model received and forwards it here. Undefined
     * for tools without a meaningful line count. */
    outputLines?: number;
  };
  'token.threshold': { used: number; limit: number };
  'compaction.fired': { before: number; after: number };
  /**
   * Fired when the auto-compaction middleware's compactor.compact() call
   * throws. Compaction is best-effort by design so we don't crash the agent
   * loop, but a persistent failure (misconfigured summarizer model, network
   * outage) means the next iteration may hit context overflow. Observability
   * layers / dashboards subscribe to this to surface the silent regression.
   */
  'compaction.failed': {
    err: Error;
    aggressive: boolean;
    level: 'warn' | 'soft' | 'hard';
    tokens: number;
    maxContext: number;
    load: number;
    fatal: boolean;
  };
  /**
   * Subagent lifecycle events. Emitted by `MultiAgentHost` so the TUI can
   * surface what's happening in the fleet without needing director-mode
   * (which renders the live FleetPanel). These complement the FleetBus
   * (director-only) by giving the TUI a uniform feed for both `/spawn`
   * and director-orchestrated work.
   */
  'subagent.spawned': {
    subagentId: string;
    taskId: string;
    name?: string;
    provider?: string;
    model?: string;
    description?: string;
  };
  'subagent.task_started': {
    subagentId: string;
    taskId: string;
    description?: string;
  };
  'subagent.task_completed': {
    subagentId: string;
    taskId: string;
    status: 'success' | 'failed' | 'timeout' | 'stopped';
    iterations: number;
    toolCalls: number;
    durationMs: number;
    error?: string;
  };
  'mcp.server.connected': { name: string; toolCount: number };
  'mcp.server.reconnected': { name: string; toolCount: number };
  'mcp.server.disconnected': { name: string; reason: string };
  'token.cost_estimate_unavailable': { model: string };
  error: { err: Error; phase: string };
}

export type EventName = keyof EventMap;
export type Listener<E extends EventName> = (payload: EventMap[E]) => void;

export interface EventLogger {
  error(msg: string, ctx?: unknown): void;
}

export class EventBus {
  private readonly listeners = new Map<EventName, Set<Listener<EventName>>>();
  private logger?: EventLogger;

  setLogger(logger: EventLogger): void {
    this.logger = logger;
  }

  on<E extends EventName>(event: E, fn: Listener<E>): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(fn as Listener<EventName>);
    return () => this.off(event, fn);
  }

  off<E extends EventName>(event: E, fn: Listener<E>): void {
    this.listeners.get(event)?.delete(fn as Listener<EventName>);
  }

  once<E extends EventName>(event: E, fn: Listener<E>): () => void {
    const wrapper: Listener<E> = (payload) => {
      this.off(event, wrapper as Listener<EventName>);
      (fn as Listener<E>)(payload);
    };
    this.on(event, wrapper as Listener<E>);
    return () => {
      this.off(event, wrapper as Listener<EventName>);
    };
  }

  emit<E extends EventName>(event: E, payload: EventMap[E]): void {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const fn of set) {
      try {
        (fn as Listener<E>)(payload);
      } catch (err) {
        this.logger?.error(`EventBus listener for "${event}" threw`, err);
      }
    }
  }

  clear(): void {
    this.listeners.clear();
  }

  /**
   * V2-D: introspection helper. Pass an `event` to count handlers for a
   * single key, or omit to get the total across every event. Used by the
   * leak-detection smoke test to flag handler accumulation across runs.
   */
  listenerCount(event?: EventName): number {
    if (event !== undefined) return this.listeners.get(event)?.size ?? 0;
    let total = 0;
    for (const set of this.listeners.values()) total += set.size;
    return total;
  }
}
