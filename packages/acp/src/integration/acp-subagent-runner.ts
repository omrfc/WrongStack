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
import { ACPSession, ACPSessionError } from '../client/acp-session.js';
import type { ACPSessionErrorKind } from '../client/acp-session.js';

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
): Promise<{ runner: SubagentRunner; stop: () => void }> {
  const projectRoot = options.projectRoot ?? options.cwd ?? process.cwd();
  const timeoutMs = options.timeoutMs ?? 5 * 60_000;

  const runner: SubagentRunner = async (
    task: TaskSpec,
    ctx: SubagentRunContext,
  ): Promise<SubagentRunOutcome> => {
    let session: ACPSession | null = null;
    try {
      session = await ACPSession.start({
        command: options.command,
        ...(options.args !== undefined ? { args: options.args } : {}),
        ...(options.env !== undefined ? { env: options.env } : {}),
        ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
        projectRoot,
        timeoutMs,
        role: options.role,
      });
    } catch (err) {
      // init / spawn failure. Throw a structured error so the host can
      // classify it (SubagentErrorKind).
      throw acpErrorToSubagentError(err, options.role ?? 'acp-subagent');
    }

    try {
      const result = await session.prompt(task.description, ctx.signal);
      // We don't surface plan/usage in the simple SubagentRunOutcome;
      // a future PR can add them if the TUI/renderer wants to display
      // them. Treat "no text emitted" as a soft signal (an ACP agent
      // may legitimately end with no message), not an error.
      return {
        result: result.text,
        iterations: 1,
        toolCalls: 0,
      };
    } catch (err) {
      if (err instanceof ACPSessionError && err.kind === 'aborted') {
        // The host's AbortController fired. Surface a structured
        // 'aborted_by_parent' so the coordinator's classifier can
        // branch correctly.
        throw acpErrorToSubagentError(err, options.role ?? 'acp-subagent');
      }
      throw acpErrorToSubagentError(err, options.role ?? 'acp-subagent');
    } finally {
      // Per design: stop() is idempotent. We always close after a turn
      // — multi-turn conversations are a future feature, not v1.
      try {
        await session.close();
      } catch {
        // best-effort cleanup
      }
    }
  };

  // No long-lived resources outside of `session`, which is created
  // and destroyed per call. `stop()` is a no-op kept for API parity
  // with the previous version.
  const stop = (): void => {
    // no-op; session is closed in the runner's finally block.
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
