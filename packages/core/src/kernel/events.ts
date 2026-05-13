/**
 * EventBus — observe-only typed event bus.
 * Subscribers cannot modify or cancel. Subscriber exceptions are caught.
 */

import type { Usage } from '../types/provider.js';
import type { Context } from '../core/context.js';

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
   * `output` is a truncated preview of the tool's serialized result text
   * (capped at ~400 chars by the emitter). UIs render this inline in the
   * tool history line without re-fetching from the session log.
   */
  'tool.executed': {
    name: string;
    durationMs: number;
    ok: boolean;
    input?: unknown;
    output?: string;
  };
  'token.threshold': { used: number; limit: number };
  'compaction.fired': { before: number; after: number };
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
}
