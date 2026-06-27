/**
 * ACPSubagentRunner — `SubagentRunner` implementation for DIR-1.
 *
 * Wraps an external ACP-supporting agent (Claude Code, Gemini CLI, Codex
 * CLI, Cline, Goose, OpenHands, etc.) as a WrongStack subagent. The
 * external agent runs its own agent loop; we send it a task via the ACP
 * v1 protocol and return the result.
 *
 * v1 spec: https://agentclientprotocol.com/protocol/v1/overview
 *
 * Connected to the Director / MultiAgentCoordinator via the
 * `SubagentRunner` interface (same shape as `AgentSubagentRunner`).
 */
import type {
  SubagentError,
  SubagentErrorKind,
  SubagentRunContext,
  SubagentRunOutcome,
  SubagentRunner,
  TaskSpec,
} from '@wrongstack/core';
import {
  ACPSession,
  ACPSessionError,
  textContent,
  type ACPProgressEvent,
  type ACPProgressHandler,
} from '../client/acp-session.js';
import type { ACPSessionErrorKind } from '../client/acp-session.js';
import type { PermissionPolicy } from '../client/permission.js';
import type { McpServer } from '../types/acp-v1.js';

export interface ACPSubagentRunnerOptions {
  /** How to spawn the external agent. */
  command: string;
  args?: string[] | undefined;
  env?: Record<string, string> | undefined;
  cwd?: string | undefined;
  /** Subagent role label — surfaced in errors and used for logging. */
  role?: string | undefined;
  /**
   * Hard wall-clock cap for one prompt turn. Defaults to 5 minutes.
   * Overrides `SubagentRunContext.budget.limits.timeoutMs` if both are set.
   */
  timeoutMs?: number | undefined;
  /**
   * Filesystem sandbox root. Defaults to `options.cwd` (when set) or
   * the process's current working directory. All `fs/read_text_file` /
   * `fs/write_text_file` calls are bounded to this root.
   */
  projectRoot?: string | undefined;
  /**
   * Live progress callback. Forwarded to `ACPSession.prompt` so the host
   * can render the external agent's tool calls / diffs / text as they
   * stream, instead of waiting for the buffered final result.
   */
  onProgress?: ACPProgressHandler | undefined;
  /**
   * Permission policy for the external agent's `session/request_permission`
   * calls. Defaults to the session's own default. Inject the host's
   * confirm/trust UI here so an external agent's file writes / commands
   * are surfaced to a human instead of silently auto-approved.
   */
  permissionPolicy?: PermissionPolicy | undefined;
  /**
   * MCP servers to expose to the external agent (passed through
   * `session/new` / `session/load`). Stdio servers are always sent;
   * HTTP/SSE are filtered by the agent's advertised capabilities.
   */
  mcpServers?: McpServer[] | undefined;
  /**
   * When true, the underlying `ACPSession` is kept open across multiple
   * runner invocations (multi-turn conversation — the external agent
   * keeps its context). The caller MUST call `stop()` to tear it down.
   * Defaults to false (one process per task).
   */
  persistent?: boolean | undefined;
}

/**
 * Static catalog of agent ids → spawn options.
 *
 * The CLI and the host's `buildACPRunner` look up entries by id. The
 * canonical, multi-source catalog is `packages/acp/src/registry/agents.catalog.ts`
 * (the 12-entry static catalog introduced in commit 4ad287b4). This
 * map stays for backward compatibility with existing call sites that
 * import it directly; new code should prefer the registry.
 */
export const ACP_AGENT_COMMANDS: Record<string, ACPSubagentRunnerOptions> = {
  cline: {
    command: 'npx',
    args: ['-y', '@agentify/cline'],
    role: 'cline',
  },
  'gemini-cli': {
    command: 'gemini',
    role: 'gemini-cli',
  },
  copilot: {
    command: 'gh',
    args: ['copilot', 'agent'],
    role: 'copilot',
  },
  openhands: {
    command: 'openhands',
    role: 'openhands',
  },
  goose: {
    command: 'goose',
    role: 'goose',
  },
};

/**
 * Build a one-shot `SubagentRunner` for a single agent invocation. Each
 * call to the returned function spawns a fresh child process, runs one
 * prompt turn, and tears everything down. The cost is ~1 second of
 * process-startup per call; for long-lived sessions (multi-turn
 * conversations), use `makeACPSubagentRunnerWithStop` and call `stop()`
 * explicitly.
 */
export async function makeACPSubagentRunner(
  options: ACPSubagentRunnerOptions,
): Promise<SubagentRunner> {
  const { runner, stop } = await makeACPSubagentRunnerWithStop(options);
  // Wrap so we always tear down after the turn, even if the caller
  // forgot to call `stop()`. stop() is idempotent, so a double-call is
  // safe.
  const wrappedRunner: SubagentRunner = async (task, ctx) => {
    try {
      return await runner(task, ctx);
    } finally {
      stop();
    }
  };
  return wrappedRunner;
}

/**
 * Build a long-lived `SubagentRunner` plus an explicit `stop()` for
 * teardown. The caller is responsible for calling `stop()` when done
 * (or when the host's signal fires). Useful for the `wstack acp spawn`
 * CLI command, which holds the child open for the duration of a user
 * task and tears down on SIGINT.
 */
export async function makeACPSubagentRunnerWithStop(
  options: ACPSubagentRunnerOptions,
): Promise<{ runner: SubagentRunner; stop: () => void | Promise<void> }> {
  const projectRoot = options.projectRoot ?? options.cwd ?? process.cwd();
  const timeoutMs = options.timeoutMs ?? 5 * 60_000;
  const persistent = options.persistent === true;

  // In persistent mode we keep a single session alive across runner calls
  // so the external agent retains its conversation context (multi-turn).
  let shared: ACPSession | null = null;

  const startSession = async (): Promise<ACPSession> => {
    return ACPSession.start({
      command: options.command,
      ...(options.args !== undefined ? { args: options.args } : {}),
      ...(options.env !== undefined ? { env: options.env } : {}),
      ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
      projectRoot,
      timeoutMs,
      role: options.role,
      ...(options.permissionPolicy !== undefined
        ? { permissionPolicy: options.permissionPolicy }
        : {}),
      ...(options.mcpServers !== undefined ? { mcpServers: options.mcpServers } : {}),
    });
  };

  const runner: SubagentRunner = async (
    task: TaskSpec,
    ctx: SubagentRunContext,
  ): Promise<SubagentRunOutcome> => {
    let session: ACPSession;
    const reuse = persistent && shared !== null;
    try {
      session = reuse ? (shared as ACPSession) : await startSession();
      if (persistent) shared = session;
    } catch (err) {
      // init / spawn failure. Throw a structured error so the host can
      // classify it (SubagentErrorKind).
      throw acpErrorToSubagentError(err, options.role ?? 'acp-subagent');
    }

    // Count real tool calls from the captured stream, and keep the
    // budget's idle clock fresh on every update so a long-but-working
    // external agent is never reaped by the watchdog as "stalled".
    const onProgress: ACPProgressHandler = (event: ACPProgressEvent) => {
      try {
        ctx.budget.markActivity();
      } catch {
        // markActivity never throws today; guard defensively anyway.
      }
      options.onProgress?.(event);
    };

    try {
      const result = await session.prompt(
        [textContent(task.description)],
        ctx.signal,
        onProgress,
      );
      // Surface the real tool-call count captured from the stream. A
      // text-less turn is a soft signal (an ACP agent may legitimately
      // end with no message), not an error.
      return {
        result: result.text,
        iterations: 1,
        toolCalls: result.toolCalls.length,
      };
    } catch (err) {
      throw acpErrorToSubagentError(err, options.role ?? 'acp-subagent');
    } finally {
      // One-shot mode closes after each turn. Persistent mode keeps the
      // session open; the caller tears it down via stop().
      if (!persistent) {
        try {
          await session.close();
        } catch {
          // best-effort cleanup
        }
      }
    }
  };

  // In persistent mode stop() closes the long-lived session; in one-shot
  // mode it's a no-op (each session is closed in the runner's finally).
  const stop = async (): Promise<void> => {
    if (shared) {
      const s = shared;
      shared = null;
      try {
        await s.close();
      } catch {
        // best-effort
      }
    }
  };

  return { runner, stop };
}

// ─────────────────────────────────────────────────────────────────────────
// Error mapping
// ─────────────────────────────────────────────────────────────────────────

/**
 * Map an ACPSessionError (or arbitrary Error from the session layer)
 * to a structured `SubagentError` that the existing coordinator can
 * classify and act on. Unknown error shapes get `kind: 'unknown'` —
 * they shouldn't crash the parent.
 */
function acpErrorToSubagentError(
  err: unknown,
  subagentId: string,
): SubagentError {
  if (err instanceof ACPSessionError) {
    const kind = mapACPKind(err.kind);
    return {
      kind,
      message: `${subagentId}: ${err.message}`,
      retryable: isRetryable(kind),
      cause: {
        name: err.name,
        message: err.message,
        ...(err.stack !== undefined ? { stack: err.stack } : {}),
      },
    };
  }
  const message = err instanceof Error ? err.message : String(err);
  return {
    kind: 'bridge_failed',
    message: `${subagentId}: ${message}`,
    retryable: false,
    cause: {
      name: err instanceof Error ? err.name : 'Error',
      message,
      ...(err instanceof Error && err.stack !== undefined ? { stack: err.stack } : {}),
    },
  };
}

function mapACPKind(acpKind: ACPSessionErrorKind): SubagentErrorKind {
  switch (acpKind) {
    case 'spawn_failed':
    case 'init_failed':
    case 'session_create_failed':
    case 'agent_died':
    case 'protocol_error':
      return 'bridge_failed';
    case 'prompt_failed':
      return 'tool_failed';
    case 'auth_failed':
    case 'logout_failed':
      return 'bridge_failed';
    case 'aborted':
      return 'aborted_by_parent';
    case 'closed':
    case 'unsupported_capability':
      return 'unknown';
  }
}

function isRetryable(kind: SubagentErrorKind): boolean {
  // Conservative: spawn / init / protocol / agent-died are NOT
  // retryable as-is (they need config or a re-install). Timeouts and
  // prompt failures might be — the parent's classifier will branch on
  // `kind` and decide.
  switch (kind) {
    case 'provider_5xx':
    case 'provider_rate_limit':
    case 'provider_timeout':
    case 'tool_threw':
    case 'budget_timeout':
      return true;
    default:
      return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Unused but exported for future use
// ─────────────────────────────────────────────────────────────────────────

/** Re-export so the CLI handler can import the session type. */
export type { ACPSession };

/** Exposed for the `wstack acp list` renderer. */
export function describeAgent(id: string): {
  command: string;
  args: readonly string[];
  role: string;
} | null {
  const entry = ACP_AGENT_COMMANDS[id];
  if (!entry) return null;
  return {
    command: entry.command,
    args: entry.args ?? [],
    role: entry.role ?? id,
  };
}
