import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { SubagentConfig, TaskResult } from '../types/multi-agent.js';
import type { JSONSchema, Tool } from '../types/tool.js';
import type { Director } from './director.js';

/**
 * Opaque host interface so this factory doesn't have to depend on the
 * CLI's `MultiAgentHost`. Any caller that exposes the same three
 * methods can wire `delegate` — including test doubles.
 */
export interface DelegateHost {
  /** True if a Director is already attached and running. */
  isDirectorMode(): boolean;
  /** Build (or return the cached) Director when director mode is on. */
  ensureDirector(): Promise<Director | null>;
  /**
   * Force-promote a non-director session into director mode at runtime.
   * Returns the Director, or null when promotion is impossible (e.g. a
   * non-director coordinator has already spawned subagents in the
   * legacy code path).
   */
  promoteToDirector(): Promise<Director | null>;
  /**
   * Optional: when promotion fails, return the human-readable reason.
   * Used to render an actionable error to the calling model instead of
   * the prior opaque "Director could not be activated" message.
   * Implementations may return null when they don't track the reason.
   */
  getPromotionBlockReason?(): string | null;
}

export interface CreateDelegateToolOptions {
  host: DelegateHost;
  /**
   * Roster used to resolve `role` strings into full `SubagentConfig`s.
   * Typically `FLEET_ROSTER`. When omitted, `delegate({ role })` calls
   * fail and only the explicit `name + provider + model` path works.
   */
  roster?: Record<string, SubagentConfig>;
  /**
   * Default await timeout in milliseconds. `delegate` blocks until the
   * subagent's task resolves; without a cap, a stuck worker would hang
   * the host indefinitely. Set generously (default: 4 hours) so the
   * orchestrator can run multi-step refactors / monorepo audits
   * without being killed for being slow — the orchestrator must
   * decide per-call when a task needs to be cut short.
   */
  defaultTimeoutMs?: number;
  /**
   * Absolute directory under which per-subagent JSONL transcripts live —
   * matches `MultiAgentHostOptions.sessionsRoot`. When set, the delegate
   * tool reads the subagent's transcript on timeout / budget-exhaustion
   * to extract partial output, so the host LLM gets *something* useful
   * back instead of just an error.
   */
  sessionsRoot?: string;
  /**
   * The directorRunId used to namespace transcripts (typically the host
   * session id). Combined with `sessionsRoot` to locate per-subagent
   * JSONLs at `<sessionsRoot>/<runId>/<subagentId>.jsonl`.
   */
  directorRunId?: string;
}

/**
 * `delegate` — the only multi-agent tool a regular (non-director) agent
 * ever needs. It bundles spawn + assign + await into a single call and
 * transparently auto-promotes the host into director mode on first use.
 *
 * The model never has to ask "are we in director mode?" — it just calls
 * `delegate({ role, task })` and gets back a `TaskResult`. The cost of
 * that ergonomic packaging is that `delegate` cannot be used for
 * parallel work as-is; the model must fire multiple `delegate` calls in
 * parallel through the provider's parallel-tool-call surface, or escalate
 * to the explicit `spawn_subagent` + `assign_task` + `await_tasks` flow
 * when it wants fan-out it controls itself.
 */
export function createDelegateTool(opts: CreateDelegateToolOptions): Tool {
  // 4 hours by default. The previous 5-minute default killed any
  // non-trivial fan-out (monorepo audits, multi-file refactors) and
  // forced the orchestrator to constantly pass an explicit timeoutMs.
  // The right model here: the orchestrator should pick a tight value
  // only when it knows the work is small; otherwise let it run.
  const defaultTimeoutMs = opts.defaultTimeoutMs ?? 4 * 60 * 60 * 1000;
  const rosterIds = opts.roster ? Object.keys(opts.roster) : [];

  const inputSchema: JSONSchema = {
    type: 'object',
    properties: {
      task: {
        type: 'string',
        description:
          'What the subagent should do — natural language, complete sentence(s). The subagent has its own tool slice, its own LLM call, and returns when its task is done.',
      },
      role: {
        type: 'string',
        description:
          rosterIds.length > 0
            ? `Roster role (preferred). One of: ${rosterIds.join(', ')}. Picks a pre-tuned config (prompt, budgets, tools) for that role.`
            : 'No roster is configured — pass `name` instead.',
        enum: rosterIds.length > 0 ? rosterIds : undefined,
      },
      name: {
        type: 'string',
        description:
          'Display name for the subagent when not using a roster role. Required when `role` is omitted.',
      },
      provider: {
        type: 'string',
        description:
          'Provider id (e.g. "anthropic", "openai"). Defaults to the host provider when omitted.',
      },
      model: {
        type: 'string',
        description: 'Model id within the provider. Defaults to the host model when omitted.',
      },
      systemPromptOverride: {
        type: 'string',
        description: 'Optional extra prompt text appended to the role baseline.',
      },
      timeoutMs: {
        type: 'number',
        description: `Wall-clock budget for this delegate in milliseconds. No hard cap — set as high as the task realistically needs (a monorepo audit can take hours, a single-file lint takes seconds). Default ${Math.round(defaultTimeoutMs / 1000 / 60)} minutes.`,
      },
      maxIterations: {
        type: 'number',
        description:
          'Maximum LLM iterations the subagent may take. Unset = use the role/coordinator default. Raise this for tasks with many tool-think-tool cycles (deep code analysis, multi-file refactors).',
      },
      maxToolCalls: {
        type: 'number',
        description:
          'Maximum number of tool invocations the subagent may make. Unset = use the role/coordinator default. Raise this for tasks that touch many files (large grep + read + report).',
      },
    },
    required: ['task'],
  };

  return {
    name: 'delegate',
    description:
      "Hand a discrete piece of work to a dedicated subagent and wait for its result. The subagent has its own context, its own LLM call, and its own budget — use this when a task is self-contained, would otherwise blow up your context, or benefits from a specialized role (bug-hunter, security-scanner, refactor-planner, audit-log). YOU decide how big the budget is: pass `timeoutMs`, `maxIterations`, and `maxToolCalls` sized to the actual work. There is no hidden cap forcing a 3-minute / 80-iteration limit — if a monorepo audit needs 2 hours and 500 tool calls, ask for that. Call multiple delegates in parallel through the provider's parallel-tool-call surface to fan work out across roles.",
    usageHint:
      "Set `task` to a complete instruction. Either pick `role` from the roster or pass `name` + `provider` + `model`. For non-trivial work, also pass `timeoutMs` (the wall-clock budget you actually need), `maxIterations`, and `maxToolCalls` — defaults are intentionally generous (4 hours) but the right values depend on scope. Returns the subagent's `TaskResult` — including the textual `result`, iteration count, tool count, and duration. Auto-promotes the host into director mode on first call.",
    permission: 'auto',
    mutating: false,
    inputSchema,
    async execute(input: unknown) {
      const i = (input ?? {}) as {
        task?: string;
        role?: string;
        name?: string;
        provider?: string;
        model?: string;
        systemPromptOverride?: string;
        timeoutMs?: number;
        maxIterations?: number;
        maxToolCalls?: number;
      };

      if (typeof i.task !== 'string' || !i.task.trim()) {
        return { ok: false, error: '`task` is required.' };
      }

        try {
          let director = await opts.host.ensureDirector();
          if (!director) {
            director = await opts.host.promoteToDirector();
          }
          if (!director) {
            const reason = opts.host.getPromotionBlockReason?.();
            return {
              ok: false,
              error:
                reason ??
                'Director could not be activated — multi-agent host already running in legacy non-director mode. Restart with `--director` for fleet support.',
            };
          }

          const timeoutMs = i.timeoutMs ?? defaultTimeoutMs;

          let cfg: SubagentConfig;
          if (i.role) {
            const base = opts.roster?.[i.role];
            if (!base) {
              return {
                ok: false,
                error: `Unknown role "${i.role}". Available: ${rosterIds.join(', ') || '(no roster configured)'}.`,
              };
            }
            cfg = instantiateRosterConfig(i.role, base);
            if (i.systemPromptOverride) cfg.systemPromptOverride = i.systemPromptOverride;
            if (i.provider) cfg.provider = i.provider;
            if (i.model) cfg.model = i.model;
          } else {
            if (!i.name) {
              return {
                ok: false,
                error: 'Either `role` (from the roster) or `name` is required.',
              };
            }
            cfg = {
              name: i.name,
              provider: i.provider,
              model: i.model,
              systemPromptOverride: i.systemPromptOverride,
            };
          }

          if (typeof i.maxIterations === 'number' && i.maxIterations > 0) {
            cfg.maxIterations = i.maxIterations;
          }
          if (typeof i.maxToolCalls === 'number' && i.maxToolCalls > 0) {
            cfg.maxToolCalls = i.maxToolCalls;
          }

          const SUBAGENT_TIMEOUT_BUFFER_MS = 30_000;
          const desiredSubTimeout = Math.max(30_000, timeoutMs - SUBAGENT_TIMEOUT_BUFFER_MS);
          if (!cfg.timeoutMs || cfg.timeoutMs > desiredSubTimeout) {
            cfg.timeoutMs = desiredSubTimeout;
          }

          const subagentId = await director.spawn(cfg);
          const taskId = await director.assign({
            id: `${randomUUID()}`,
            description: i.task,
            subagentId,
          });
          const result = await Promise.race<TaskResult | { __timeout: true }>([
            director.awaitTasks([taskId]).then((r) => {
              if (!r[0]) throw new Error(`Task "${taskId}" not found in completed results`);
              return r[0];
            }),
            new Promise<{ __timeout: true }>((resolve) =>
              setTimeout(() => resolve({ __timeout: true }), timeoutMs),
            ),
          ]);

          if ('__timeout' in result) {
            const partial = await readSubagentPartial(opts, subagentId);
            return {
              ok: false,
              stopReason: 'host_timeout',
              error: `Subagent did not finish within ${timeoutMs}ms.`,
              hint: 'Reduce scope of the next delegate, raise timeoutMs, or use spawn_subagent + await_tasks for long-running work.',
              subagentId,
              taskId,
              partial,
            };
          }

          const baseStopReason: StopReason =
            result.status === 'success'
              ? 'end_turn'
              : result.status === 'timeout'
                ? 'subagent_timeout'
                : result.status === 'stopped'
                  ? 'aborted'
                  : 'budget_exhausted';
          const partial =
            result.status === 'success' ? undefined : await readSubagentPartial(opts, subagentId);

          const errorKind = result.error?.kind;
          const retryable = result.error?.retryable;
          const backoffMs = result.error?.backoffMs;
          return {
            ok: result.status === 'success',
            status: result.status,
            stopReason: baseStopReason,
            errorKind,
            retryable,
            backoffMs,
            subagentId: result.subagentId,
            taskId: result.taskId,
            result: result.result,
            error: result.error,
            iterations: result.iterations,
            toolCalls: result.toolCalls,
            durationMs: result.durationMs,
            ...(partial ? { partial } : {}),
            ...(hintForKind(errorKind, retryable, backoffMs)
              ? { hint: hintForKind(errorKind, retryable, backoffMs) }
              : {}),
          };
        } catch (err) {
          return {
            ok: false,
            stopReason: 'error' as const,
            error: err instanceof Error ? err.message : String(err),
          };
        }
    },
  };
}

function instantiateRosterConfig(role: string, base: SubagentConfig): SubagentConfig {
  return {
    ...base,
    // Roster entries are templates. Give each spawn a fresh id so
    // parallel or repeated delegates can use the same role safely.
    id: `${role}-${randomUUID().slice(0, 8)}`,
  };
}

type StopReason =
  | 'end_turn'
  | 'budget_exhausted'
  | 'subagent_timeout'
  | 'host_timeout'
  | 'aborted'
  | 'error';

/**
 * Per-kind orchestrator hint. Returned alongside the structured error
 * so the calling model has a concrete next step instead of "task
 * failed, good luck". Returns undefined for success / unknown kinds —
 * the caller checks for presence before including in output.
 */
function hintForKind(
  kind: string | undefined,
  retryable: boolean | undefined,
  backoffMs: number | undefined,
): string | undefined {
  if (!kind) return undefined;
  switch (kind) {
    case 'provider_rate_limit':
      return `Provider rate-limited. Retry safe after ${backoffMs ?? 5000}ms backoff. Consider a smaller model or fewer parallel delegates.`;
    case 'provider_5xx':
      return `Provider server error. Retry safe after ${backoffMs ?? 3000}ms backoff — usually transient.`;
    case 'provider_timeout':
      return 'Provider network timeout. Retry safe; reduce input size if it persists.';
    case 'provider_auth':
      return 'Provider rejected credentials. Cannot retry — fix the API key / config and re-invoke.';
    case 'context_overflow':
      return 'Subagent context exceeded the model limit. Narrow the task, use a larger-context model, or split into multiple delegates.';
    case 'budget_iterations':
    case 'budget_tool_calls':
    case 'budget_tokens':
    case 'budget_cost':
      return 'Subagent exhausted its budget. The coordinator may auto-extend; otherwise raise the matching `max*` field (e.g. maxToolCalls: 600) on the next delegate, or split the task.';
    case 'budget_timeout':
      return 'Subagent hit its wall-clock budget. Raise `timeoutMs` on the next delegate or split the task.';
    case 'aborted_by_parent':
      return 'Subagent was aborted (user Ctrl+C, parent unwound, or sibling failure cascade). Not retryable until the abort condition is resolved.';
    case 'empty_response':
      return 'Subagent ended its turn with no text and no tool calls. Almost always a prompt / config issue — clarify the task or check the model.';
    case 'tool_failed':
      return 'A tool inside the subagent returned ok:false. Inspect `partial.lastAssistantText` for the agent reasoning, then retry with corrected inputs.';
    case 'bridge_failed':
      return 'Parent-child bridge transport failed. This is rare — restart the session and retry.';
    default:
      return retryable
        ? 'Failure classified as retryable. Try again with the same input.'
        : undefined;
  }
}

/**
 * Parse the per-subagent JSONL at `<sessionsRoot>/<runId>/<subagentId>.jsonl`
 * and pull out the last few useful pieces — the most recent assistant
 * text response, the stop reason, and a count of tool calls. Used by
 * `delegate` when the subagent timed out or exhausted budget without
 * returning a clean `finalText`, so the host LLM still sees what work
 * actually happened.
 */
async function readSubagentPartial(
  opts: CreateDelegateToolOptions,
  subagentId: string,
): Promise<
  | {
      lastAssistantText?: string;
      lastStopReason?: string;
      toolUsesObserved: number;
      events: number;
    }
  | undefined
> {
  if (!opts.sessionsRoot) return undefined;
  // Locate the JSONL. When `directorRunId` is provided we know the
  // exact path; otherwise scan the sessionsRoot for any subdir
  // containing this subagent id.
  const candidates: string[] = [];
  if (opts.directorRunId) {
    candidates.push(path.join(opts.sessionsRoot, opts.directorRunId, `${subagentId}.jsonl`));
  } else {
    try {
      const runDirs = await fsp.readdir(opts.sessionsRoot);
      for (const r of runDirs) {
        candidates.push(path.join(opts.sessionsRoot, r, `${subagentId}.jsonl`));
      }
    } catch {
      return undefined;
    }
  }
  for (const file of candidates) {
    let raw: string;
    try {
      raw = await fsp.readFile(file, 'utf8');
    } catch {
      continue;
    }
    const lines = raw.split('\n').filter((l) => l.trim());
    let lastAssistantText: string | undefined;
    let lastStopReason: string | undefined;
    let toolUses = 0;
    for (const line of lines) {
      try {
        const ev = JSON.parse(line) as {
          type: string;
          content?: unknown;
          stopReason?: string;
          name?: string;
        };
        if (ev.type === 'tool_use') toolUses += 1;
        if (ev.type === 'llm_response') {
          if (typeof ev.stopReason === 'string') lastStopReason = ev.stopReason;
          if (Array.isArray(ev.content)) {
            const txt = (ev.content as Array<{ type?: string; text?: string }>)
              .filter((b) => b.type === 'text')
              .map((b) => b.text ?? '')
              .join('\n')
              .trim();
            if (txt) lastAssistantText = txt;
          }
        }
      } catch {
        // skip
      }
    }
    return {
      lastAssistantText,
      lastStopReason,
      toolUsesObserved: toolUses,
      events: lines.length,
    };
  }
  return undefined;
}
