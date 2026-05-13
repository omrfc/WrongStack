import type { Message } from '../types/messages.js';
import type { TextBlock } from '../types/blocks.js';
import type { SessionWriter } from '../types/session.js';
import type { Provider, Usage } from '../types/provider.js';
import type { TokenCounter } from '../types/token-counter.js';
import type { Tool } from '../types/tool.js';

export interface TodoItem {
  id: string;
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  activeForm?: string;
}

export interface RunOptions {
  signal?: AbortSignal;
  model?: string;
  executionStrategy?: 'parallel' | 'sequential' | 'smart';
  maxIterations?: number;
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
  tools?: Tool[];
}

export class Context {
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
   * Register a teardown hook tied to the current run's abort signal. The
   * hook fires when the run aborts OR ends normally — Agent.run wires
   * this through a RunController. When no run is active the hook fires
   * immediately so callers don't leak resources.
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
