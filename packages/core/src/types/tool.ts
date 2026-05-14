import type { Context } from '../core/context.js';

export type Permission = 'auto' | 'confirm' | 'deny';

export interface JSONSchema {
  type?: string;
  properties?: Record<string, JSONSchema>;
  required?: string[];
  items?: JSONSchema;
  enum?: unknown[];
  description?: string;
  [k: string]: unknown;
}

/**
 * Tool progress event — yielded by `Tool.executeStream` to give the UI
 * something to render while a long-running tool works. The executor
 * publishes each event via EventBus as `tool.progress` so the TUI, logger,
 * and observability layer can consume them uniformly.
 *
 * Keep events small. They are buffered through the EventBus synchronously
 * and rendered on the main thread.
 */
export interface ToolProgressEvent {
  /**
   * - `log`           — verbose informational message (e.g. "scanning…")
   * - `warning`       — non-fatal issue (e.g. "skipped X due to ENOENT")
   * - `metric`        — numeric data (e.g. files scanned so far)
   * - `file_changed`  — a tool that mutates the workspace announces a write
   * - `partial_output` — stream of textual output (bash stdout, fetch body)
   */
  type: 'log' | 'warning' | 'metric' | 'file_changed' | 'partial_output';
  text?: string;
  data?: Record<string, unknown>;
}

/**
 * Terminal event for `executeStream`. The output must match the tool's
 * declared output type — the executor unwraps `output` and treats it like
 * a normal `execute` return value.
 */
export interface ToolFinalEvent<O> {
  type: 'final';
  output: O;
}

export type ToolStreamEvent<O = unknown> = ToolProgressEvent | ToolFinalEvent<O>;

export interface Tool<I = unknown, O = unknown> {
  name: string;
  description: string;
  usageHint?: string;
  inputSchema: JSONSchema;
  permission: Permission;
  mutating: boolean;
  /**
   * Input-field name that the permission policy should match trust rules
   * against. Without this, the policy falls back to a heuristic
   * (`command` / `path` / `url` / `name`) that can collide across tools —
   * e.g. an HTTP tool whose `path` means "request path" would be checked
   * against filesystem-path trust rules. Set explicitly to avoid the
   * cross-tool subject collision.
   *
   * The named field's value must be a string at runtime; non-string values
   * fall back to the heuristic.
   */
  subjectKey?: string;
  maxOutputBytes?: number;
  timeoutMs?: number;
  /**
   * Hint for the TUI spinner — does NOT affect actual timeout enforcement.
   * Use `timeoutMs` for hard limits. Leave undefined when duration varies
   * unpredictably.
   */
  estimatedDurationMs?: number;
  execute(input: I, ctx: Context, opts: { signal: AbortSignal }): Promise<O>;
  /**
   * Optional streaming variant. When defined, the executor prefers this
   * over `execute` — yielded events become `tool.progress` EventBus events
   * and the terminal `final` event provides the output. Tools that don't
   * have intermediate state shouldn't implement this; the default `execute`
   * path is more efficient.
   */
  executeStream?(
    input: I,
    ctx: Context,
    opts: { signal: AbortSignal },
  ): AsyncIterable<ToolStreamEvent<O>>;
  /**
   * Optional teardown hook fired by the executor when the tool's run is
   * aborted (signal triggered). Errors thrown here are swallowed so they
   * never mask the originating failure.
   *
   * **When to use `cleanup` vs `ctx.registerAbortHook`:**
   *
   * - Use `cleanup` for resources **owned by the tool author** that are
   *   established at execute-time: child processes spawned by the tool,
   *   file handles opened by the tool, network connections initiated by
   *   the tool. The lifecycle is co-located with the tool definition, so
   *   readers see the resource and its teardown in one place.
   *
   *   ```ts
   *   async execute(input, ctx, opts) {
   *     const child = spawn(...);
   *     // … tool work …
   *   },
   *   async cleanup(_input, _ctx) {
   *     // best-effort kill of any child still running
   *   }
   *   ```
   *
   * - Use `ctx.registerAbortHook` for **context-scoped teardown** registered
   *   dynamically inside `execute`: when the tool delegates to a library
   *   that needs cancellation, or when the resource is created lazily
   *   somewhere down the call stack and the natural cleanup point isn't
   *   at the tool boundary. The hook fires when the **agent run** ends,
   *   not when this specific tool call aborts.
   *
   *   ```ts
   *   async execute(input, ctx, opts) {
   *     const handle = openHelper();
   *     ctx.registerAbortHook(() => handle.dispose());
   *     // … work …
   *   }
   *   ```
   *
   * If both are registered for the same resource, `cleanup` fires first
   * (on tool abort) and the abort-hook fires after on the wider run abort.
   * Avoid double-free by gating one on the other's effect, or pick a single
   * teardown channel per resource.
   */
  cleanup?(input: I, ctx: Context): Promise<void>;
}

export interface ToolCallContext {
  tool: Tool;
  input: unknown;
  callId: string;
  ctx: Context;
  signal: AbortSignal;
}
