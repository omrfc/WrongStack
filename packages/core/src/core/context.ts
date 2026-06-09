import type { TextBlock } from '../types/blocks.js';
import type { Message } from '../types/messages.js';
import type { Provider, Usage } from '../types/provider.js';
import type { SessionWriter } from '../types/session.js';
import type { TokenCounter } from '../types/token-counter.js';
import type { Tool } from '../types/tool.js';
import { ConversationState } from './conversation-state.js';
import type { RunEnv } from './run-env.js';

export interface TodoItem {
  id: string;
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  activeForm?: string | undefined;
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
  model: string;
  tools?: Tool[] | undefined;
}

/**
 * L1-A: `Context` is the live agent-run object. Its read-only environment
 * shape is exposed by the `RunEnv` interface (every field below the
 * conversation state) and its mutable shape by `ConversationState` (the
 * `state` accessor). New code should declare the narrower type at its
 * parameter — pass `ctx` for it. Existing tools that accept `Context`
 * still work because `Context` structurally satisfies both.
 */
export class Context implements RunEnv {
  messages: Message[] = [];
  todos: TodoItem[] = [];
  readFiles = new Set<string>();
  fileMtimes = new Map<string, number>();
  systemPrompt: TextBlock[];
  provider: Provider;
  session: SessionWriter;
  signal: AbortSignal;
  tokenCounter: TokenCounter;
  cwd: string;
  projectRoot: string;
  model: string;
  tools: Tool[] = [];
  meta: Record<string, unknown> = {};

  /**
   * Set to true when the conversation gains new tool_use or tool_result
   * blocks — the only time repairToolUseAdjacency() can find new issues.
   * buildAndRunRequestPipeline() checks this flag to skip an O(n) scan
   * on iterations where no tool content was added (pure text responses).
   */
  toolAdjacencyDirty = false;

  constructor(init: ContextInit) {
    this.systemPrompt = init.systemPrompt;
    this.provider = init.provider;
    this.session = init.session;
    this.signal = init.signal;
    this.tokenCounter = init.tokenCounter;
    this.cwd = init.cwd;
    this.projectRoot = init.projectRoot;
    this.model = init.model;
    this.tools = init.tools ?? [];
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

  recordRead(absPath: string, mtimeMs: number): void {
    this.readFiles.add(absPath);
    this.fileMtimes.set(absPath, mtimeMs);
  }

  /** Clear accumulated file-read metadata after compaction or at boundaries
   *  where stale read history could cause tools to skip legitimate re-reads.
   *  The agent re-populates this naturally on the next file access. */
  clearFileTracking(): void {
    this.readFiles.clear();
    this.fileMtimes.clear();
  }

  hasRead(absPath: string): boolean {
    return this.readFiles.has(absPath);
  }

  lastReadMtime(absPath: string): number | undefined {
    return this.fileMtimes.get(absPath);
  }

  usage(): Usage {
    return this.tokenCounter.total();
  }
}
