import * as path from 'node:path';
import type { TextBlock } from '../types/blocks.js';
import type { Message } from '../types/messages.js';
import type { Provider, Usage } from '../types/provider.js';
import type { SessionWriter } from '../types/session.js';
import type { ContextEvidenceState } from '../types/context-evidence.js';
import type { TokenCounter } from '../types/token-counter.js';
import type { Tool } from '../types/tool.js';
import { createContextEvidenceState } from '../utils/context-evidence.js';
import { ConversationState } from './conversation-state.js';
import type { RunEnv } from './run-env.js';

export interface TodoItem {
  id: string;
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  activeForm?: string | undefined;
  /** When promoted from a plan item, stores the plan item's id. */
  promotedFromPlan?: string | undefined;
  /** When promoted from a task, stores the task's id. */
  promotedFromTask?: string | undefined;
}

export interface RunOptions {
  signal?: AbortSignal | undefined;
  model?: string | undefined;
  executionStrategy?: 'parallel' | 'sequential' | 'smart' | undefined;
  maxIterations?: number | undefined;
  /**
   * Enable autonomous continue for this specific run. When true, the agent
   * loop re-runs on `[continue]`/`[next step]`/`[proceed]` markers or
   * `continue_to_next_iteration()` tool calls instead of returning.
   * Overrides `AgentInit.autonomousContinue` for this call only.
   */
  autonomousContinue?: boolean | undefined;
}

export interface ContextInit {
  systemPrompt: TextBlock[];
  provider: Provider;
  session: SessionWriter;
  signal: AbortSignal;
  tokenCounter: TokenCounter;
  cwd: string;
  projectRoot: string;
  /** Mutable working directory. Defaults to `cwd`. Must stay within `projectRoot`. */
  workingDir?: string | undefined;
  /**
   * When false, file tools and `setWorkingDir()` are confined to `projectRoot`.
   * Defaults to `false` (restrictive) when omitted so directly-constructed
   * contexts (tests, embedded callers) keep the safe behavior; the runtime
   * passes the config-derived value (default `true` — permissive) explicitly.
   */
  allowOutsideProjectRoot?: boolean | undefined;
  model: string;
  tools?: Tool[] | undefined;
  /** Agent id performing this run (e.g. 'leader', 'executor', 'tech-stack'). */
  agentId?: string | undefined;
  /** Human-readable agent name. */
  agentName?: string | undefined;
  /**
   * Session-level trace ID for correlating storage events with agent
   * iterations in observability pipelines. Stored on the SessionWriter
   * so that storage operations can emit it in `storage.*` events.
   * When set, the Context constructor propagates it to
   * `session.traceId` automatically.
   */
  traceId?: string | undefined;
}

/**
 * L1-A: `Context` is the live agent-run object. Its read-only environment
 * shape is exposed by the `RunEnv` interface (every field below the
 * conversation state) and its mutable shape by `ConversationState` (the
 * `state` accessor). New code should declare the narrower type at its
 * parameter — pass `ctx` for it. Existing tools that accept `Context`
 * still work because `Context` structurally satisfies both.
 *
 * The single source of truth for the project directory is `projectRoot`.
 * All tools (read/write/bash/exec) resolve paths relative to this.
 * Sessions, config, memory, and logs are also stored under this root.
 *
 * There IS a mutable `workingDir` (separate from `projectRoot`) that can be
 * changed at runtime via `setWorkingDir()`. It starts as `cwd` and allows
 * the agent and user to navigate within the project without spawning a new
 * process. All changes must stay inside `projectRoot`.
 */
export class Context implements RunEnv {
  messages: Message[] = [];
  todos: TodoItem[] = [];
  /**
   * Files whose content the **user / model has explicitly seen** via the
   * `read` tool (or an edit's auto-read, which surfaces the content to the
   * model). This is the set the permission policy's write-smart-bypass
   * (step 7) checks — writing a file the model has already read is treated
   * as "no new content to approve". It must NEVER contain files only touched
   * by `edit`/`write`, otherwise the model could repeatedly overwrite a file
   * whose content the user never saw (P1 #1, before-release.md).
   *
   * Tool-driven mutations record via `writtenFiles` + `recordRead(..., 'write')`
   * so mtime tracking still works without widening the bypass.
   */
  readFiles = new Set<string>();
  /**
   * Files written by `edit`/`write` in this session. Tracked for observability
   * and to keep `readFiles` (the permission-bypass source of truth) clean.
   * `recordRead(path, mtime, 'write')` adds here instead of `readFiles`.
   */
  writtenFiles = new Set<string>();
  fileMtimes = new Map<string, number>();
  /**
   * Structured side-effect records accumulated during the current run
   * (P2 #5). Populated by `recordSideEffect()` — read by /diag for an
   * in-memory audit trail without parsing the JSONL file. Cleared by
   * `clearFileTracking()` alongside read/written-file tracking.
   */
  sideEffects: import('../types/side-effect.js').SideEffect[] = [];
  contextEvidence: ContextEvidenceState = createContextEvidenceState();
  systemPrompt: TextBlock[];
  provider: Provider;
  session: SessionWriter;
  signal: AbortSignal;
  tokenCounter: TokenCounter;
  cwd: string;
  projectRoot: string;
  /** Mutable working directory — starts as `cwd`. Change via `setWorkingDir()`. */
  workingDir: string;
  /**
   * When true, file tools (via `_util.ts`) and `setWorkingDir()` reject paths
   * outside `projectRoot`. When false, those boundary checks are bypassed so
   * tools may reach paths outside the project (still gated by permission
   * tiers). Mutable so `/settings` can toggle it live on the running session.
   */
  allowOutsideProjectRoot: boolean;
  model: string;
  tools: Tool[] = [];
  meta: Record<string, unknown> = {};
  /** Agent id performing this run (e.g. 'leader', 'executor'). */
  agentId: string;
  /** Human-readable agent name. */
  agentName: string;
  /**
   * Session-level trace ID for correlating storage events with agent
   * iterations. Stored here and also propagated to `session.traceId`
   * so storage operations can include it in `storage.*` events.
   */
  traceId: string | undefined;

  /** Callbacks fired when `setWorkingDir()` changes the working directory. */
  private _onWorkingDirChanged: Array<(newDir: string, oldDir: string) => void> = [];

  /**
   * Set to true when the conversation gains new tool_use or tool_result
   * blocks — the only time repairToolUseAdjacency() can find new issues.
   * buildAndRunRequestPipeline() checks this flag to skip an O(n) scan
   * on iterations where no tool content was added (pure text responses).
   */
  toolAdjacencyDirty = false;

  /**
   * H1: pre-computed total-request token estimate from the most recent
   * `estimateRequestTokens()` call in the agent loop's pre-flight step.
   * The middleware that decides when to compact, the `emitContextPct`
   * helper that drives the live context-fill bar, and the pre-flight
   * itself all need this number; previously each one walked the same
   * messages/system/tools arrays independently. Stashing it here lets
   * the three call sites share a single compute per iteration.
   *
   * The value is the **uncalibrated** total. Callers that want the
   * calibrated number apply the per-(provider,model) ratio themselves.
   */
  lastRequestTokens: number | undefined = undefined;

  constructor(init: ContextInit) {
    this.systemPrompt = init.systemPrompt;
    this.provider = init.provider;
    this.session = init.session;
    this.signal = init.signal;
    this.tokenCounter = init.tokenCounter;
    this.cwd = init.cwd;
    this.projectRoot = init.projectRoot;
    this.workingDir = init.workingDir ?? init.cwd;
    this.allowOutsideProjectRoot = init.allowOutsideProjectRoot ?? false;
    this.model = init.model;
    this.tools = init.tools ?? [];
    this.agentId = init.agentId ?? 'unknown';
    this.agentName = init.agentName ?? 'Unknown Agent';
    this.traceId = init.traceId;
    this.allowOutsideProjectRoot = init.allowOutsideProjectRoot ?? false;
    // Propagate traceId to the SessionWriter so storage operations
    // can read it without needing a direct handle on the Context.
    this.session.traceId = init.traceId;
  }

  /**
   * Observable wrapper over the mutable conversation state. Lazy so
   * subsystems that don't subscribe pay nothing. Mutations made directly
   * on `ctx.messages` / `ctx.todos` are still visible through this
   * wrapper's read API (it holds a reference, not a copy) but only
   * mutations that go through `state.appendMessage()` etc. fire
   * `onChange`. New code should prefer the wrapper API.
   */
  private _state: ConversationState | null = null;
  get state(): ConversationState {
    if (!this._state) this._state = new ConversationState(this);
    return this._state;
  }

  /**
   * Register a teardown hook tied to the current run's abort signal.
   * Hooks registered before a run starts are stored and fired when the
   * next run ends; there is no immediate fire when no run is active.
   *
   * **Scope:** these hooks fire on the **whole agent run's** abort, not on
   * an individual tool call. For per-tool teardown of resources owned by
   * the tool author (child processes, handles), prefer `Tool.cleanup` —
   * see its JSDoc for the full rule.
   */
  private abortHooks = new Set<() => void | Promise<void>>();
  registerAbortHook(fn: () => void | Promise<void>): () => void {
    this.abortHooks.add(fn);
    return () => this.abortHooks.delete(fn);
  }
  async drainAbortHooks(): Promise<void> {
    const snapshot = [...this.abortHooks].reverse();
    // Clear before running so new hooks registered during iteration
    // fire on the next abort cycle (not the current one — hook chains
    // are intentionally not supported).
    this.abortHooks.clear();
    for (const fn of snapshot) {
      try {
        await fn();
      } catch {
        // hooks must be best-effort; swallow so siblings still fire
      }
    }
  }

  /**
   * Record that a file's content was seen / mtime was observed.
   *
   * `source` controls which tracking set is populated — and therefore whether
   * the permission policy's write-smart-bypass (step 7) will auto-approve a
   * subsequent `write` to this path:
   *
   * - `'user'` (default): the model/user saw the content (via `read`, or an
   *   edit's auto-read that surfaced it). Adds to `readFiles` → bypass applies.
   * - `'write'`: a tool wrote the file (`edit`/`write`) and is recording the
   *   new mtime so subsequent edits detect external modification. Adds to
   *   `writtenFiles` only — the bypass does NOT apply, because the user never
   *   approved the new content (P1 #1, before-release.md).
   *
   * `fileMtimes` is updated in both cases so mtime-based staleness checks work.
   */
  recordRead(absPath: string, mtimeMs: number, source: 'user' | 'write' = 'user'): void {
    this.fileMtimes.set(absPath, mtimeMs);
    if (source === 'write') {
      this.writtenFiles.add(absPath);
    } else {
      this.readFiles.add(absPath);
    }
  }

  /** Clear accumulated file-read metadata after compaction or at boundaries
   *  where stale read history could cause tools to skip legitimate re-reads.
   *  The agent re-populates this naturally on the next file access. */
  clearFileTracking(): void {
    this.readFiles.clear();
    this.writtenFiles.clear();
    this.fileMtimes.clear();
    this.sideEffects = [];
  }

  /**
   * Record a structured side effect for the audit trail (P2 #5).
   * Called by tools that perform non-filesystem mutations (bash, install,
   * fetch) so /diag and session replay can show what the agent did beyond
   * file edits.
   *
   * Unlike recordFileChange(), this does NOT support undo — it is purely
   * for observability and audit. The event is appended to the session
   * JSONL fire-and-forget; errors are swallowed so recording never blocks
   * tool execution.
   */
  recordSideEffect(sideEffect: import('../types/side-effect.js').SideEffect): void {
    this.sideEffects.push(sideEffect);
    this.session.append({
      type: 'side_effect',
      ts: sideEffect.ts,
      toolUseId: sideEffect.toolUseId,
      toolName: sideEffect.toolName,
      input: sideEffect.input,
      outcome: sideEffect.outcome,
      risk: sideEffect.risk,
    }).catch(() => { /* best-effort — never block tool execution */ });
  }

  /**
   * True if the model/user has explicitly seen this file's content via `read`
   * (or an edit auto-read). Tool-only writes (`source: 'write'`) do NOT count
   * — this is the source of truth for the permission policy's write bypass.
   */
  hasRead(absPath: string): boolean {
    return this.readFiles.has(absPath);
  }

  /** True if `edit`/`write` wrote this file in the current session. */
  hasWritten(absPath: string): boolean {
    return this.writtenFiles.has(absPath);
  }

  lastReadMtime(absPath: string): number | undefined {
    return this.fileMtimes.get(absPath);
  }

  /**
   * Change the working directory for path resolution. Resolves relative paths
   * against `projectRoot` and validates the result is within the project root.
   * Fires all registered `onWorkingDirChanged` callbacks.
   * Returns the resolved absolute path.
   */
  setWorkingDir(dir: string): string {
    const resolved = path.isAbsolute(dir)
      ? path.resolve(dir)
      : path.resolve(this.projectRoot, dir);

    // Validate containment within projectRoot — unless filesystem access is
    // unrestricted, in which case the working dir may leave the project root.
    if (!this.allowOutsideProjectRoot) {
      const root = path.resolve(this.projectRoot);
      const rel = path.relative(root, resolved);
      if (rel.startsWith('..') || path.isAbsolute(rel)) {
        throw new Error(
          `Working directory "${resolved}" is outside project root "${root}"`,
        );
      }
    }

    const old = this.workingDir;
    this.workingDir = resolved;
    // Fire callbacks (catch errors so one bad listener doesn't break others)
    for (const cb of this._onWorkingDirChanged) {
      try { cb(resolved, old); } catch { /* best-effort */ }
    }
    return resolved;
  }

  /**
   * Register a callback that fires when the working directory changes.
   * Returns an unsubscribe function. Callbacks are fired synchronously
   * inside `setWorkingDir()` — errors in callbacks are swallowed so one
   * bad listener doesn't prevent others from executing.
   */
  onWorkingDirChanged(cb: (newDir: string, oldDir: string) => void): () => void {
    this._onWorkingDirChanged.push(cb);
    return () => {
      const idx = this._onWorkingDirChanged.indexOf(cb);
      if (idx >= 0) this._onWorkingDirChanged.splice(idx, 1);
    };
  }

  usage(): Usage {
    return this.tokenCounter.total();
  }
}
