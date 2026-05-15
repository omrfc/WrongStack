import type { ToolResultBlock, ToolUseBlock } from '../types/blocks.js';
import type { Tool } from '../types/tool.js';

/**
 * Input for a single tool execution, scoped to a single iteration's budget.
 */
export interface ToolExecution {
  toolUse: ToolUseBlock;
  result: ToolResultBlock;
  /** True if the tool was not found in the registry. */
  unknownTool?: boolean;
  /** True if the tool execution threw an exception. */
  threw?: boolean;
}

/**
 * Output from a single tool execution.
 */
export interface ToolExecutionOutput {
  result: ToolResultBlock | ToolConfirmPendingResult;
  tool?: Tool;
  durationMs: number;
}

/**
 * Result of running a batch of tools for a single agent iteration.
 */
export interface ToolBatchResult {
  outputs: ToolExecutionOutput[];
  remainingBudget: number;
}

export type ConfirmAwaiter = (
  tool: Tool,
  input: unknown,
  toolUseId: string,
  suggestedPattern: string,
) => Promise<'yes' | 'no' | 'always' | 'deny'>;

export interface ToolExecutorOptions {
  permissionPolicy: import('../types/permission.js').PermissionPolicy;
  secretScrubber: import('../types/secret-scrubber.js').SecretScrubber;
  renderer?: import('../types/renderer.js').Renderer | undefined;
  /**
   * Optional event bus. When provided, the executor emits `tool.started`
   * before invoking each tool's `execute()`. Closes the observability gap
   * between "model decided to call tool" and "tool finished".
   */
  events?: import('../kernel/events.js').EventBus | undefined;
  /**
   * Optional tracer. When provided, every tool execution opens a
   * `tool.<name>` span with attributes for tool name, permission decision,
   * input size, output size, and outcome. Spans are no-op by default.
   */
  tracer?: import('../types/observability.js').Tracer | undefined;
  /**
   * Async callback invoked when a tool needs user confirmation.
   * When omitted and confirmation is required, the executor returns a
   * failure result immediately (TUI path). When provided (CLI path),
   * the callback handles the interactive prompt and returns a decision.
   */
  confirmAwaiter?: ConfirmAwaiter | undefined;
  iterationTimeoutMs?: number;
  perIterationOutputCapBytes?: number;
}

export interface ToolExecutorInit {
  registry: import('../registry/tool-registry.js').ToolRegistry;
  options: ToolExecutorOptions;
}

/**
 * Result returned by executeBatch when a tool needs confirmation and
 * no confirmAwaiter is available. The TUI catches this and surfaces a
 * confirmation dialog; once resolved the tool is re-executed.
 * The string tag identifies it as a "pending confirm" result so callers
 * can distinguish it from an error without inspecting content strings.
 */
export interface ToolConfirmPendingResult {
  type: 'tool_confirm_pending';
  toolUseId: string;
  toolName: string;
  input: unknown;
  suggestedPattern: string;
}

export type ToolExecutorStrategy = 'parallel' | 'sequential' | 'smart';
