export type MemoryScope = 'project-agents' | 'project-memory' | 'user-memory';

// ── Memory categories ──────────────────────────────────────────────────

export type MemoryType = 'fact' | 'decision' | 'convention' | 'preference' | 'reference' | 'anti_pattern';

export const MEMORY_TYPE_LABELS: Record<MemoryType, string> = {
  fact: 'Fact',
  decision: 'Decision',
  convention: 'Convention',
  preference: 'Preference',
  reference: 'Reference',
  anti_pattern: 'Anti-pattern',
};

export type MemoryPriority = 'critical' | 'high' | 'medium' | 'low';

export interface MemoryEntry {
  scope: MemoryScope;
  text: string;
  ts: string;
  /** Category — helps the agent decide whether to inject or ignore. */
  type?: MemoryType | undefined;
  /** Free-form tags for grouping (e.g. ["build", "pnpm", "typescript"]). */
  tags?: string[] | undefined;
  /** Priority — critical entries are always injected; low may be skipped. */
  priority?: MemoryPriority | undefined;
  /** Session or agent that created this entry. */
  source?: string | undefined;
  /** 0.0–1.0 confidence. Low-confidence entries are injected less often. */
  confidence?: number | undefined;
  /** ISO timestamp of last access (read or injection into context). */
  lastAccessed?: string | undefined;
}

// ── Memory events — emitted by DefaultMemoryStore so plugins can react ──

export interface MemoryRememberedPayload {
  scope: MemoryScope;
  text: string;
  ts: string;
  type?: MemoryType | undefined;
  tags?: string[] | undefined;
  priority?: MemoryPriority | undefined;
}

export interface MemoryForgottenPayload {
  scope: MemoryScope;
  query: string;
  removed: number;
}

export interface MemoryClearedPayload {
  /** Scope that was cleared, or undefined when all scopes were cleared. */
  scope?: MemoryScope | undefined;
}

export interface MemoryConsolidatedPayload {
  scope: MemoryScope;
  /** Entries removed by deduplication. */
  removed: number;
}

// ── Relevance scoring ──────────────────────────────────────────────────

/**
 * Context used to score memory relevance for context injection.
 * Passed by the system prompt builder.
 */
export interface MemoryRelevanceContext {
  /** Current user message or task description. */
  currentTask: string;
  /** Active skills in this session (e.g. ["typescript-strict", "git-flow"]). */
  activeSkills?: string[] | undefined;
  /** Active mode (e.g. "Teach", "Brief", "Code Reviewer"). */
  activeMode?: string | undefined;
  /** Available tools — memories referencing relevant tools score higher. */
  toolNames?: string[] | undefined;
}

export interface ScoredEntry extends MemoryEntry {
  score: number;
  matchReason: string;
}

// ── Store interface ────────────────────────────────────────────────────

export interface MemoryStore {
  readAll(): Promise<string>;
  read(scope: MemoryScope): Promise<string>;
  remember(text: string, scope?: MemoryScope, metadata?: Omit<Partial<MemoryEntry>, 'scope' | 'text' | 'ts'>): Promise<void>;
  forget(query: string, scope?: MemoryScope): Promise<number>;
  consolidate(scope: MemoryScope): Promise<void>;
  clear(scope?: MemoryScope): Promise<void>;
  /** List entries, newest first. */
  list(scope?: MemoryScope, limit?: number): Promise<MemoryEntry[]>;
  /** Search by content (substring or semantic). */
  search(query: string, scope?: MemoryScope, limit?: number): Promise<MemoryEntry[]>;
  /** Access the backend for advanced queries. */
  getBackend?(): unknown;
  /** Graph-based related memory traversal. */
  findRelated?(text: string, scope?: MemoryScope, limit?: number): Promise<MemoryEntry[]>;
  /**
   * Score and rank memories by relevance to the current context.
   * Returns only entries that meet a relevance threshold.
   */
  scoreRelevant?(ctx: MemoryRelevanceContext, scope?: MemoryScope, limit?: number): Promise<ScoredEntry[]>;
  /**
   * Attach a trace ID to this store so that all subsequent `storage.*`
   * events include it for observability correlation. Mutates the store
   * in place and returns the same instance (convenience chaining).
   */
  withTraceId(traceId: string): MemoryStore;
}
