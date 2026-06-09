/**
 * WrongStack error hierarchy.
 *
 * Every error thrown by the framework is a `WrongStackError` with a
 * machine-readable `code`, a `subsystem` tag, and a `severity` level.
 * This lets consumers (CLI, TUI, plugins, tests) branch on structured
 * data instead of parsing error messages.
 */

// ── Error codes ──────────────────────────────────────────────────────

/**
 * Machine-readable error codes as frozen constants.
 *
 * Use `ERROR_CODES.X` instead of raw string literals for:
 * - IDE autocomplete and compile-time validation
 * - Safe refactoring (rename updates all usages)
 * - Plugin extensibility (extend the object to add custom codes)
 *
 * The `ErrorCode` type is derived from this object, so adding a new
 * code here automatically updates the type without extra changes.
 */
export const ERROR_CODES = {
  // Provider
  PROVIDER_RATE_LIMITED: 'PROVIDER_RATE_LIMITED',
  PROVIDER_AUTH_FAILED: 'PROVIDER_AUTH_FAILED',
  PROVIDER_OVERLOADED: 'PROVIDER_OVERLOADED',
  PROVIDER_INVALID_REQUEST: 'PROVIDER_INVALID_REQUEST',
  PROVIDER_SERVER_ERROR: 'PROVIDER_SERVER_ERROR',
  PROVIDER_NETWORK_ERROR: 'PROVIDER_NETWORK_ERROR',
  PROVIDER_CONTEXT_OVERFLOW: 'PROVIDER_CONTEXT_OVERFLOW',
  // Tool
  TOOL_NOT_FOUND: 'TOOL_NOT_FOUND',
  TOOL_PERMISSION_DENIED: 'TOOL_PERMISSION_DENIED',
  TOOL_EXECUTION_FAILED: 'TOOL_EXECUTION_FAILED',
  TOOL_TIMEOUT: 'TOOL_TIMEOUT',
  TOOL_INPUT_INVALID: 'TOOL_INPUT_INVALID',
  // Config
  CONFIG_INVALID: 'CONFIG_INVALID',
  CONFIG_NOT_FOUND: 'CONFIG_NOT_FOUND',
  CONFIG_PARSE_FAILED: 'CONFIG_PARSE_FAILED',
  CONFIG_MIGRATION_NEEDED: 'CONFIG_MIGRATION_NEEDED',
  // Plugin
  PLUGIN_LOAD_FAILED: 'PLUGIN_LOAD_FAILED',
  PLUGIN_API_MISMATCH: 'PLUGIN_API_MISMATCH',
  PLUGIN_MISSING_DEPENDENCY: 'PLUGIN_MISSING_DEPENDENCY',
  // Agent
  AGENT_ITERATION_LIMIT: 'AGENT_ITERATION_LIMIT',
  AGENT_CONTEXT_OVERFLOW: 'AGENT_CONTEXT_OVERFLOW',
  AGENT_ABORTED: 'AGENT_ABORTED',
  AGENT_RUN_FAILED: 'AGENT_RUN_FAILED',
  // Session
  SESSION_NOT_FOUND: 'SESSION_NOT_FOUND',
  SESSION_CORRUPTED: 'SESSION_CORRUPTED',
  SESSION_WRITE_FAILED: 'SESSION_WRITE_FAILED',
  // Container / Registry
  CONTAINER_TOKEN_ALREADY_BOUND: 'CONTAINER_TOKEN_ALREADY_BOUND',
  CONTAINER_TOKEN_NOT_BOUND: 'CONTAINER_TOKEN_NOT_BOUND',
  CONTAINER_CIRCULAR_DEPENDENCY: 'CONTAINER_CIRCULAR_DEPENDENCY',
  REGISTRY_DUPLICATE: 'REGISTRY_DUPLICATE',
  REGISTRY_NOT_FOUND: 'REGISTRY_NOT_FOUND',
  REGISTRY_INVALID: 'REGISTRY_INVALID',
  // File system
  FS_READ_FAILED: 'FS_READ_FAILED',
  FS_WRITE_FAILED: 'FS_WRITE_FAILED',
  FS_MKDIR_FAILED: 'FS_MKDIR_FAILED',
  FS_DELETE_FAILED: 'FS_DELETE_FAILED',
  FS_ATOMIC_WRITE_FAILED: 'FS_ATOMIC_WRITE_FAILED',
  // SDD (Spec-Driven Development)
  SDD_VALIDATION_FAILED: 'SDD_VALIDATION_FAILED',
  SDD_PARSE_FAILED: 'SDD_PARSE_FAILED',
  SDD_INVALID_STATE: 'SDD_INVALID_STATE',
  SDD_NOT_READY: 'SDD_NOT_READY',
  // General
  UNKNOWN: 'UNKNOWN',
} as const;

/**
 * Union type derived from `ERROR_CODES`. Using `typeof ERROR_CODES[keyof typeof ERROR_CODES]`
 * instead of a string literal union means TypeScript auto-updates the type whenever
 * a new code is added to `ERROR_CODES` — no need to keep two lists in sync.
 */
export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

export type ErrorSubsystem =
  | 'provider'
  | 'tool'
  | 'config'
  | 'plugin'
  | 'agent'
  | 'session'
  | 'sdd'
  | 'container'
  | 'fs'
  | 'general';
export type ErrorSeverity = 'fatal' | 'error' | 'warning';

// ── Base error class ─────────────────────────────────────────────────

export class WrongStackError extends Error {
  readonly code: ErrorCode;
  readonly subsystem: ErrorSubsystem;
  readonly severity: ErrorSeverity;
  readonly recoverable: boolean;
  readonly context?: Record<string, unknown> | undefined;

  constructor(opts: {
    message: string;
    code: ErrorCode;
    subsystem: ErrorSubsystem;
    severity?: ErrorSeverity | undefined;
    recoverable?: boolean | undefined;
    context?: Record<string, unknown> | undefined;
    cause?: unknown | undefined;
  }) {
    super(opts.message, { cause: opts.cause });
    this.name = 'WrongStackError';
    this.code = opts.code;
    this.subsystem = opts.subsystem;
    this.severity = opts.severity ?? 'error';
    this.recoverable = opts.recoverable ?? false;
    this.context = opts.context;
  }

  /**
   * Render a one-line user-facing description.
   * Subclasses should override for domain-specific formatting.
   */
  describe(): string {
    const ctx = this.context ? ` ${formatContext(this.context)}` : '';
    return `${this.code}: ${this.message}${ctx}`;
  }
}

function formatContext(ctx: Record<string, unknown>): string {
  const parts = Object.entries(ctx)
    .filter(([, v]) => v !== undefined)
    .slice(0, 3)
    .map(([k, v]) => `${k}=${String(v)}`);
  return parts.length > 0 ? `[${parts.join(' ')}]` : '';
}

// ── Specific error classes ───────────────────────────────────────────

/**
 * Tool execution errors — thrown by ToolExecutor and individual tools.
 */
export class ToolError extends WrongStackError {
  readonly toolName: string;

  constructor(opts: {
    message: string;
    code: Extract<
      ErrorCode,
      | 'TOOL_NOT_FOUND'
      | 'TOOL_PERMISSION_DENIED'
      | 'TOOL_EXECUTION_FAILED'
      | 'TOOL_TIMEOUT'
      | 'TOOL_INPUT_INVALID'
    >;
    toolName: string;
    recoverable?: boolean | undefined;
    context?: Record<string, unknown> | undefined;
    cause?: unknown | undefined;
  }) {
    super({
      message: opts.message,
      code: opts.code,
      subsystem: 'tool',
      recoverable: opts.recoverable,
      context: { tool: opts.toolName, ...opts.context },
      cause: opts.cause,
    });
    this.name = 'ToolError';
    this.toolName = opts.toolName;
  }
}

/**
 * Config loading / validation errors.
 */
export class ConfigError extends WrongStackError {
  constructor(opts: {
    message: string;
    code: Extract<
      ErrorCode,
      'CONFIG_INVALID' | 'CONFIG_NOT_FOUND' | 'CONFIG_PARSE_FAILED' | 'CONFIG_MIGRATION_NEEDED'
    >;
    context?: Record<string, unknown> | undefined;
    cause?: unknown | undefined;
  }) {
    super({
      message: opts.message,
      code: opts.code,
      subsystem: 'config',
      severity: 'fatal',
      recoverable: false,
      context: opts.context,
      cause: opts.cause,
    });
    this.name = 'ConfigError';
  }
}

/**
 * Plugin loading / lifecycle errors.
 */
export class PluginError extends WrongStackError {
  readonly pluginName: string;

  constructor(opts: {
    message: string;
    code: Extract<
      ErrorCode,
      'PLUGIN_LOAD_FAILED' | 'PLUGIN_API_MISMATCH' | 'PLUGIN_MISSING_DEPENDENCY'
    >;
    pluginName: string;
    context?: Record<string, unknown> | undefined;
    cause?: unknown | undefined;
  }) {
    super({
      message: opts.message,
      code: opts.code,
      subsystem: 'plugin',
      severity: 'error',
      recoverable: opts.code === ERROR_CODES.PLUGIN_MISSING_DEPENDENCY,
      context: { plugin: opts.pluginName, ...opts.context },
      cause: opts.cause,
    });
    this.name = 'PluginError';
    this.pluginName = opts.pluginName;
  }
}

/**
 * Agent runtime errors — thrown by Agent.run when a non-WrongStackError
 * escapes the inner loop, so callers always see a structured error.
 */
export class AgentError extends WrongStackError {
  constructor(opts: {
    message: string;
    code: Extract<
      ErrorCode,
      'AGENT_ITERATION_LIMIT' | 'AGENT_CONTEXT_OVERFLOW' | 'AGENT_ABORTED' | 'AGENT_RUN_FAILED'
    >;
    recoverable?: boolean | undefined;
    context?: Record<string, unknown> | undefined;
    cause?: unknown | undefined;
  }) {
    super({
      message: opts.message,
      code: opts.code,
      subsystem: 'agent',
      severity: opts.code === ERROR_CODES.AGENT_ABORTED ? 'warning' : 'error',
      recoverable: opts.recoverable ?? opts.code === ERROR_CODES.AGENT_ITERATION_LIMIT,
      context: opts.context,
      cause: opts.cause,
    });
    this.name = 'AgentError';
  }
}

/**
 * Wrap an arbitrary thrown value into a `WrongStackError` so the caller
 * always gets a structured error. Pass-throughs WrongStackError instances
 * unchanged; raw `Error`s and primitives get an `AGENT_RUN_FAILED` wrapper
 * with the original preserved as `cause`.
 */
export function toWrongStackError(
  err: unknown,
  code: Extract<ErrorCode, 'AGENT_RUN_FAILED' | 'AGENT_ABORTED' | 'UNKNOWN'> = ERROR_CODES.AGENT_RUN_FAILED,
): WrongStackError {
  if (err instanceof WrongStackError) return err;
  const message = err instanceof Error ? err.message : String(err);
  return new AgentError({
    message,
    code: code === 'UNKNOWN' ? ERROR_CODES.AGENT_RUN_FAILED : code,
    cause: err,
  });
}

/**
 * Session storage errors.
 */
export class SessionError extends WrongStackError {
  readonly sessionId?: string | undefined;

  constructor(opts: {
    message: string;
    code: Extract<ErrorCode, 'SESSION_NOT_FOUND' | 'SESSION_CORRUPTED' | 'SESSION_WRITE_FAILED'>;
    sessionId?: string | undefined;
    context?: Record<string, unknown> | undefined;
    cause?: unknown | undefined;
  }) {
    super({
      message: opts.message,
      code: opts.code,
      subsystem: 'session',
      severity: opts.code === ERROR_CODES.SESSION_WRITE_FAILED ? 'error' : 'warning',
      recoverable: opts.code !== ERROR_CODES.SESSION_CORRUPTED,
      context: { sessionId: opts.sessionId, ...opts.context },
      cause: opts.cause,
    });
    this.name = 'SessionError';
    this.sessionId = opts.sessionId;
  }
}

/**
 * SDD (Spec-Driven Development) errors — spec validation, parsing, and
 * state machine violations in the AISpecBuilder, TaskFlow, and TaskTracker.
 */
export class SddError extends WrongStackError {
  constructor(opts: {
    message: string;
    code: Extract<
      ErrorCode,
      'SDD_VALIDATION_FAILED' | 'SDD_PARSE_FAILED' | 'SDD_INVALID_STATE' | 'SDD_NOT_READY'
    >;
    context?: Record<string, unknown> | undefined;
    cause?: unknown | undefined;
  }) {
    super({
      message: opts.message,
      code: opts.code,
      subsystem: 'sdd',
      severity: opts.code === ERROR_CODES.SDD_PARSE_FAILED ? 'warning' : 'error',
      recoverable: opts.code === ERROR_CODES.SDD_NOT_READY,
      context: opts.context,
      cause: opts.cause,
    });
    this.name = 'SddError';
  }
}

/**
 * File system operation errors.
 */
export class FsError extends WrongStackError {
  readonly path?: string | undefined;

  constructor(opts: {
    message: string;
    code: Extract<
      ErrorCode,
      'FS_READ_FAILED' | 'FS_WRITE_FAILED' | 'FS_MKDIR_FAILED' | 'FS_DELETE_FAILED' | 'FS_ATOMIC_WRITE_FAILED'
    >;
    path?: string | undefined;
    context?: Record<string, unknown> | undefined;
    cause?: unknown | undefined;
  }) {
    super({
      message: opts.message,
      code: opts.code,
      subsystem: 'fs',
      severity: 'error',
      recoverable: opts.code !== ERROR_CODES.FS_READ_FAILED,
      context: { path: opts.path, ...opts.context },
      cause: opts.cause,
    });
    this.name = 'FsError';
    this.path = opts.path;
  }
}

// ── Type guards ──────────────────────────────────────────────────────

export function isWrongStackError(err: unknown): err is WrongStackError {
  return err instanceof WrongStackError;
}

export function isToolError(err: unknown): err is ToolError {
  return err instanceof ToolError;
}

export function isConfigError(err: unknown): err is ConfigError {
  return err instanceof ConfigError;
}

export function isPluginError(err: unknown): err is PluginError {
  return err instanceof PluginError;
}

export function isSessionError(err: unknown): err is SessionError {
  return err instanceof SessionError;
}

export function isAgentError(err: unknown): err is AgentError {
  return err instanceof AgentError;
}

export function isFsError(err: unknown): err is FsError {
  return err instanceof FsError;
}

export function isSddError(err: unknown): err is SddError {
  return err instanceof SddError;
}
