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
  'provider.tool_use_stop': { ctx: Context; id: string; name: string };
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
   * Fired after the user chooses 'always' or 'deny' on a confirmation prompt.
   * The TUI can use this to show a brief notification that the decision was
   * persisted to the trust file (e.g. "✓ always allowed popo.txt" / "✗ denied popo.txt").
   */
  'trust.persisted': {
    tool: string;
    pattern: string;
    decision: 'always' | 'deny';
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
  /**
   * Fired when the subagent budget hits a soft limit and the coordinator
   * is being asked for an extension. The coordinator should call `extend()`
   * to grant more budget, or the promise auto-resolves to `deny` after
   * `timeoutMs` (default 30s), treating it as a hard stop.
   *
   * This event lets the CLI/TUI observe budget pressure in real time,
   * surface extension requests to users, and give the coordinator a
   * hook to implement custom extension policy without coupling to the
   * runner/budget classes.
   */
  'budget.threshold_reached': {
    kind: 'iterations' | 'tool_calls' | 'tokens' | 'cost' | 'timeout';
    used: number;
    limit: number;
    /**
     * Call to grant more of the same budget type. `timeoutMs` extends the
     * wall-clock budget; the coordinator's watchdog observes the patched
     * limit and re-arms its timer for the new remainder.
     */
    extend: (
      extra: Partial<{
        maxIterations: number;
        maxToolCalls: number;
        maxTokens: number;
        maxCostUsd: number;
        timeoutMs: number;
      }>,
    ) => void;
    /** Call to deny the extension — subagent will stop. */
    deny: () => void;
    /** Auto-resolves to deny after timeout. */
    timeoutMs: number;
  };
  'context.repaired': {
    ctx: Context;
    changed: boolean;
    removedToolUses: string[];
    removedToolResults: string[];
    removedMessages: number;
  };
  'compaction.fired': {
    /** Threshold level that triggered compaction (warn / soft / hard). */
    level: 'warn' | 'soft' | 'hard';
    /** Tokens estimated before compaction ran. */
    tokens: number;
    /** Fraction of maxContext at the time compaction fired. */
    load: number;
    /** Provider's max context window in tokens. */
    maxContext: number;
    /** Full compaction report from the compactor. */
    report: { before: number; after: number; reductions: { phase: string; saved: number }[] };
    /** Whether aggressive (summary) mode was used. */
    aggressive: boolean;
  };
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
    /**
     * Absolute path to the per-subagent JSONL transcript on disk, when
     * one was created. Undefined when the subagent shares the parent
     * session writer (in-memory or single-file configurations).
     * Surfaced so the TUI (FleetPanel) and `/fleet log` can show the
     * user *where* to look without computing it from the run id.
     */
    transcriptPath?: string;
  };
  'subagent.task_started': {
    subagentId: string;
    taskId: string;
    description?: string;
  };
  /**
   * Fired by `MultiAgentHost` when a subagent hits a soft budget limit
   * and the coordinator is auto-extending. TUI renders this as a
   * status-line notice: "⚡ agent#name hitting kind limit (used/limit) — extending".
   * After the auto-extend the task either continues or the coordinator
   * denies the extension and the task ends with 'budget_exhausted'.
   */
  'subagent.budget_warning': {
    subagentId: string;
    kind: string;
    used: number;
    limit: number;
  };
  /**
   * Emitted when the coordinator/director actually GRANTS a budget
   * extension to a subagent (the resolution of a `budget.threshold_reached`
   * negotiation). Distinct from `subagent.budget_warning`, which fires when
   * a limit is merely *hit*. UIs use this to render a persistent "⚡ extended
   * ×N" badge so users can see how often an agent self-extended to stay
   * alive. `totalExtensions` is the cumulative count for this subagent across
   * all kinds; `newLimit` is the patched value for `kind`.
   */
  'subagent.budget_extended': {
    subagentId: string;
    kind: string;
    newLimit: number;
    totalExtensions: number;
  };
  /**
   * Per-tool-call event re-emitted from a subagent's own EventBus
   * onto the host EventBus, so the TUI / non-director surfaces can
   * render "AGENT#1 ● bash 250ms" without having to subscribe to
   * the director-only FleetBus. Fired AFTER the tool completes
   * (paired with `tool.executed`). Includes the subagent id so
   * multiple parallel subagents are distinguishable.
   */
  'subagent.tool_executed': {
    subagentId: string;
    taskId?: string;
    name: string;
    durationMs: number;
    ok: boolean;
    input?: unknown;
    outputBytes?: number;
  };
  /**
   * Periodic progress snapshot emitted by the subagent runner every ~25
   * iterations so the user can track what a subagent is doing without
   * looking at the FleetPanel. The leader's TUI surfaces this as a
   * chat history entry: "AGENT#2 💬 L25 · 47 tools · $0.023 · doing grep..."
   * Fired on a best-effort basis — slow subagents may skip emissions if
   * the 25-iteration window passes while the agent is between tool calls.
   */
  'subagent.iteration_summary': {
    subagentId: string;
    iteration: number;
    toolCalls: number;
    costUsd: number;
    currentTool?: string;
    partialText?: string;
  };
  'subagent.task_completed': {
    subagentId: string;
    taskId: string;
    status: 'success' | 'failed' | 'timeout' | 'stopped';
    iterations: number;
    toolCalls: number;
    durationMs: number;
    /**
     * Structured failure envelope when `status !== 'success'`. Carries
     * `kind` (one of `SubagentErrorKind`), `message`, `retryable`, and
     * optional `backoffMs`. UIs branch on `kind` to render the right
     * chip (rate_limit vs auth vs tool_failed). The type is imported
     * lazily as a structural object to avoid a coordination → kernel
     * cycle in the dependency graph.
     */
    error?: {
      kind: string;
      message: string;
      retryable: boolean;
      backoffMs?: number;
      cause?: { name: string; message: string; stack?: string };
    };
  };
  /**
   * Fired by the delegate tool when a subagent finishes. The agent's run
   * loop listens for this to collect `delegateSummaries` for the RunResult,
   * so the CLI/TUI can render flashy completion banners.
   */
  'subagent.done': { summary: string; ok: boolean };
  'mcp.server.connected': { name: string; toolCount: number };
  'mcp.server.reconnected': { name: string; toolCount: number };
  'mcp.server.disconnected': { name: string; reason: string };
  'token.cost_estimate_unavailable': { model: string };
  /** Fired by SessionWriter.writeCheckpoint() after the checkpoint event is appended to JSONL. */
  'checkpoint.written': { promptIndex: number; promptPreview: string; ts: string; fileCount: number };
  /**
   * Fired after a session rewind completes: files are reverted and the session
   * history is truncated. The TUI listens to this to update its checkpoint
   * list and clear history entries that are now invalid.
   */
  'session.rewound': { toPromptIndex: number; revertedFiles: string[]; removedEvents: number };
  /**
   * Fired by the multi-agent coordinator on FleetBus whenever subagent
   * counts change (spawn/stop/complete). The TUI subscribes to render
   * live fleet counters without polling.
   */
  'coordinator.stats': {
    total: number;
    running: number;
    idle: number;
    stopped: number;
    inFlight: number;
    pending: number;
    completed: number;
    subagentStatuses: { subagentId: string; taskId: string; status: string; assigned: boolean }[];
  };
  /**
   * Git-worktree lifecycle, emitted by WorktreeManager. AutoPhase allocates one
   * worktree per phase so parallelizable phases run isolated, then merges them
   * back sequentially. The WebUI/TUI subscribe to render live swim-lanes/DAG.
   */
  'worktree.allocated': {
    handleId: string;
    ownerId: string;
    ownerLabel: string;
    slug: string;
    dir: string;
    branch: string;
    baseBranch: string;
  };
  'worktree.committed': {
    handleId: string;
    ownerId: string;
    branch: string;
    committed: boolean;
    insertions: number;
    deletions: number;
    files: number;
    sha?: string;
  };
  'worktree.merged': {
    handleId: string;
    ownerId: string;
    branch: string;
    baseBranch: string;
    squash: boolean;
  };
  'worktree.conflict': {
    handleId: string;
    ownerId: string;
    branch: string;
    conflictFiles: string[];
  };
  'worktree.released': { handleId: string; ownerId: string; branch: string; kept: boolean };
  'worktree.failed': { handleId: string; ownerId: string; branch?: string; error: string };
  error: { err: Error; phase: string };
}

export type EventName = keyof EventMap;
export type Listener<E extends EventName> = (payload: EventMap[E]) => void;

export interface EventLogger {
  error(msg: string, ctx?: unknown): void;
}

export class EventBus {
  private readonly listeners = new Map<EventName, Set<Listener<EventName>>>();
  private readonly wildcards: Array<{
    match: (event: string) => boolean;
    fn: (event: string, payload: unknown) => void;
  }> = [];
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

  /**
   * Subscribe to all events, regardless of name. Short-hand for
   * `onPattern('*')`. Use for logging, debugging, or forwarding every
   * event to another bus (as FleetBus does).
   *
   * Returns an unsubscribe function.
   */
  onAny(fn: (event: string, payload: unknown) => void): () => void {
    return this.onPattern('*', fn);
  }

  /**
   * Subscribe to all events whose name matches a glob-style prefix.
   * `'tool.*'` matches `tool.started`, `tool.executed`, `tool.progress`, etc.
   * `'*'` matches every event.
   *
   * The handler receives `(eventName, payload)` with the event name as a
   * string and the payload as `unknown`. Use for logging, debugging, or
   * metrics collection across a family of events.
   *
   * Returns an unsubscribe function.
   */
  onPattern(pattern: string, fn: (event: string, payload: unknown) => void): () => void {
    const match = makePatternMatcher(pattern);
    const entry = { match, fn };
    this.wildcards.push(entry);
    return () => {
      const idx = this.wildcards.indexOf(entry);
      if (idx >= 0) this.wildcards.splice(idx, 1);
    };
  }

  /**
   * Subscribe to all events whose name matches a RegExp.
   * More flexible than `onPattern` — use when you need regex features
   * (alternation, character classes, capture groups).
   *
   * Returns an unsubscribe function.
   */
  onRegex(regex: RegExp, fn: (event: string, payload: unknown) => void): () => void {
    const entry = { match: (e: string) => regex.test(e), fn };
    this.wildcards.push(entry);
    return () => {
      const idx = this.wildcards.indexOf(entry);
      if (idx >= 0) this.wildcards.splice(idx, 1);
    };
  }

  emit<E extends EventName>(event: E, payload: EventMap[E]): void {
    const set = this.listeners.get(event);
    if (set) {
      for (const fn of set) {
        try {
          (fn as Listener<E>)(payload);
        } catch (err) {
          this.logger?.error(`EventBus listener for "${event}" threw`, err);
        }
      }
    }
    // Wildcard listeners
    if (this.wildcards.length > 0) {
      const name = event as string;
      for (const { match, fn } of this.wildcards) {
        if (!match(name)) continue;
        try {
          fn(name, payload);
        } catch (err) {
          this.logger?.error(`EventBus wildcard listener for "${name}" threw`, err);
        }
      }
    }
  }

  clear(): void {
    this.listeners.clear();
    this.wildcards.length = 0;
  }

  /**
   * V2-D: introspection helper. Pass an `event` to count handlers for a
   * single key, or omit to get the total across every event. Used by the
   * leak-detection smoke test to flag handler accumulation across runs.
   * Does NOT include wildcard listeners.
   */
  listenerCount(event?: EventName): number {
    if (event !== undefined) return this.listeners.get(event)?.size ?? 0;
    let total = 0;
    for (const set of this.listeners.values()) total += set.size;
    return total;
  }

  /**
   * Number of wildcard listeners currently registered.
   */
  wildcardCount(): number {
    return this.wildcards.length;
  }

  /**
   * True if anything would receive an emit for `event` — a named listener
   * OR a wildcard/regex pattern that matches the event name. Unlike
   * `listenerCount`, this DOES account for wildcards, so callers that gate
   * behavior on "is anyone listening?" (e.g. SubagentBudget deciding whether
   * to negotiate a soft limit vs hard-stop) don't misfire when the only
   * subscriber is a pattern listener like the FleetBus's `onPattern('*')`.
   */
  hasListenerFor(event: string): boolean {
    if ((this.listeners.get(event as EventName)?.size ?? 0) > 0) return true;
    return this.wildcards.some((w) => w.match(event));
  }
}

// ── Scoped EventBus ─────────────────────────────────────────────────────────────

/**
 * A decorator over `EventBus` that records every listener registration
 * (`.on`, `.once`, `.onPattern`, `.onRegex`) so that `teardown()` can
 * remove all of them at once — preventing the memory leaks that occur
 * when dynamic plugins or long-lived TUI/WebUI interfaces forget to
 * call `.off()` during session termination.
 *
 * Usage:
 * ```ts
 * const bus = new ScopedEventBus();
 * bus.on('tool.executed', handler1);   // tracked
 * bus.on('provider.response', handler2); // tracked
 * bus.onPattern('subagent.*', handler3); // tracked
 * // ... later, when the plugin or session is torn down:
 * bus.teardown(); // removes all three listeners
 * ```
 *
 * Also implements `Disposable` (via `[Symbol.dispose]`) for use with
 * the `using` keyword in Node ≥ 22, or can be used manually with
 * `bus.teardown()`.
 */
export class ScopedEventBus extends EventBus {
  // Track registrations by a unique counter key so that EventBus.once()'s
  // internal listener-removal doesn't affect our tracking (once removes the
  // fn from EventBus but we still need to call our unsub during teardown).
  private readonly registrations = new Map<number, () => void>();
  private nextKey = 0;

  /**
   * Identical to `EventBus.on` but the listener is tracked so that
   * `teardown()` will remove it automatically.
   */
  override on<E extends EventName>(event: E, fn: Listener<E>): () => void {
    const key = this.nextKey++;
    const unsub = super.on(event, fn);
    this.registrations.set(key, unsub);
    return () => {
      this.registrations.delete(key);
      unsub();
    };
  }

  /**
   * Identical to `EventBus.once` but the listener is tracked so that
   * `teardown()` will remove it automatically.
   *
   * Uses EventBus's public API directly to avoid triggering our own `on()`
   * override (which would consume a key slot for the wrapper, then orphan
   * our registration entry under a different key).
   */
  override once<E extends EventName>(event: E, fn: Listener<E>): () => void {
    const key = this.nextKey++;
    const wrapper: Listener<E> = (payload) => {
      // Bypass ScopedEventBus.on() — go straight to EventBus.off() so we
      // don't recurse and don't consume another key.
      EventBus.prototype.off.call(this, event, wrapper as Listener<EventName>);
      (fn as Listener<E>)(payload);
    };
    // Use the EventBus prototype directly to register without triggering
    // ScopedEventBus.on() which would consume a second key.
    EventBus.prototype.on.call(this, event, wrapper as Listener<EventName>);
    const unsub = () => {
      this.registrations.delete(key);
      EventBus.prototype.off.call(this, event, wrapper as Listener<EventName>);
    };
    this.registrations.set(key, unsub);
    return unsub;
  }

  /**
   * Subscribe to all events. Alias for `onPattern('*')` — the listener is
   * tracked so that `teardown()` will remove it automatically.
   */
  override onAny(fn: (event: string, payload: unknown) => void): () => void {
    const key = this.nextKey++;
    // Call EventBus.onPattern directly so the wrapper-consumption in
    // ScopedEventBus.on() doesn't re-enter and create a second registration slot.
    const unsub = EventBus.prototype.onPattern.call(this, '*', fn);
    this.registrations.set(key, unsub);
    return () => {
      this.registrations.delete(key);
      unsub();
    };
  }

  /**
   * Identical to `EventBus.onPattern` but the listener is tracked so that
   * `teardown()` will remove it automatically.
   */
  override onPattern(pattern: string, fn: (event: string, payload: unknown) => void): () => void {
    const key = this.nextKey++;
    const unsub = super.onPattern(pattern, fn);
    this.registrations.set(key, unsub);
    return () => {
      this.registrations.delete(key);
      unsub();
    };
  }

  /**
   * Identical to `EventBus.onRegex` but the listener is tracked so that
   * `teardown()` will remove it automatically.
   */
  override onRegex(regex: RegExp, fn: (event: string, payload: unknown) => void): () => void {
    const key = this.nextKey++;
    const unsub = super.onRegex(regex, fn);
    this.registrations.set(key, unsub);
    return () => {
      this.registrations.delete(key);
      unsub();
    };
  }

  /**
   * Remove every listener that was registered through this scoped bus.
   * Idempotent — calling it multiple times is safe.
   *
   * Also available as `[Symbol.dispose]` for explicit resource management:
   * ```ts
   * using scope = new ScopedEventBus();
   * scope.on('tool.executed', handler);
   * // automatically teardown()'d when scope exits
   * ```
   */
  teardown(): void {
    for (const unsub of this.registrations.values()) {
      try { unsub(); } catch { /* ignore — best effort */ }
    }
    this.registrations.clear();
    this.clear();
  }

  /** Alias for `teardown()` — enables `using new ScopedEventBus()` in Node ≥ 22. */
  [Symbol.dispose](): void {
    this.teardown();
  }

  /** Number of tracked registrations. */
  get scopedListenerCount(): number {
    return this.registrations.size;
  }
}

/**
 * Convert a glob-style pattern to a matcher function.
 * Only supports `*` at the end of a prefix — `'tool.*'` becomes
 * "starts with tool.". `'*'` matches everything.
 */
function makePatternMatcher(pattern: string): (event: string) => boolean {
  if (pattern === '*') return () => true;
  if (pattern.endsWith('.*')) {
    const prefix = pattern.slice(0, -2);
    return (e: string) => e.startsWith(`${prefix}.`);
  }
  // Exact match fallback
  return (e: string) => e === pattern;
}
