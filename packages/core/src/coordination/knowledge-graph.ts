/**
 * SharedKnowledgeGraph — the single source of truth for autonomous agents.
 *
 * Every agent reads from and writes to this graph. It replaces point-to-point
 * message passing as the primary coordination mechanism. Agents publish facts,
 * goals, and findings here; other agents subscribe to relevant slices.
 *
 * The graph is backed by JSONL under the session dir, with an in-memory
 * working copy. Writes are append-only to the log; reads are from memory.
 *
 * Node types:
 *   fact     — immutable project fact (e.g. "auth/session.ts has a null deref")
 *   goal     — a task to be done (has status, assignee, priority)
 *   decision — a decision made by the Brain (with rationale)
 *   change   — a proposed/approved/rejected code change (with lifecycle)
 *   vote     — an agent's vote on a change proposal
 *
 * @module knowledge-graph
 */
import { randomUUID } from 'node:crypto';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { withFileLock } from '../utils/atomic-write.js';

// ── Core types ────────────────────────────────────────────────────────────

export type NodeType = 'fact' | 'goal' | 'decision' | 'change' | 'vote';

export type FactCategory =
  | 'bug'
  | 'refactor'
  | 'security'
  | 'test'
  | 'perf'
  | 'deps'
  | 'architecture'
  | 'quality';

export type GoalStatus = 'pending' | 'in_progress' | 'blocked' | 'done' | 'failed';
export type GoalPriority = 'critical' | 'high' | 'medium' | 'low';

export type ChangeStatus = 'proposed' | 'approved' | 'rejected' | 'applied' | 'rolled_back';
export type VoteValue = 'approve' | 'reject' | 'abstain';

export type DecisionType = 'spawn' | 'assign' | 'approve_change' | 'reject_change' | 'escalate' | 'rollback' | 'merge_results';

export interface FactNode {
  id: string;
  type: 'fact';
  category: FactCategory;
  subject: string;
  detail: string;
  file?: string;
  line?: number;
  severity?: 'critical' | 'high' | 'medium' | 'low';
  discoveredBy: string; // agent id
  discoveredAt: string; // ISO8601
  tags: string[];
  /** Stable key — dedup facts about the same subject */
  key: string;
  /** References to other nodes this fact relates to */
  related: string[];
}

export interface GoalNode {
  id: string;
  type: 'goal';
  title: string;
  description: string;
  status: GoalStatus;
  priority: GoalPriority;
  assignee?: string;
  blockedBy: string[]; // goal ids
  dependsOn: string[]; // goal ids this goal blocks
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  tags: string[];
  /** Sub-goals spawned from this goal */
  children: string[];
  /** The top-level goal this belongs to (for hierarchy) */
  parentGoal?: string;
  result?: string;
}

export interface DecisionNode {
  id: string;
  type: 'decision';
  decisionType: DecisionType;
  question: string;
  options: { id: string; label: string; risk?: string }[];
  chosen: string;
  rationale: string;
  madeBy: string; // agent id
  madeAt: string;
  context?: string;
}

export interface ChangeNode {
  id: string;
  type: 'change';
  title: string;
  description: string;
  files: { path: string; action: 'create' | 'modify' | 'delete' }[];
  status: ChangeStatus;
  proposedBy: string;
  proposedAt: string;
  approvedBy: string[];
  rejectedBy: string[];
  appliedAt?: string;
  rolledBackAt?: string;
  rollbackReason?: string;
  votes: VoteRecord[];
  qualityGate: QualityGateResult;
  /** Goals satisfied by this change */
  satisfiesGoals: string[];
}

export interface VoteRecord {
  agentId: string;
  agentName: string;
  value: VoteValue;
  rationale?: string | undefined;
  votedAt: string;
}

export interface QualityGateResult {
  passed: boolean;
  checks: QualityCheck[];
}

export interface QualityCheck {
  name: string;
  passed: boolean;
  detail?: string;
}

export interface VoteNode {
  id: string;
  type: 'vote';
  changeId: string;
  voterId: string;
  voterName: string;
  value: VoteValue;
  rationale?: string;
  votedAt: string;
}

export type GraphNode = FactNode | GoalNode | DecisionNode | ChangeNode | VoteNode;

// ── Subscription ─────────────────────────────────────────────────────────

export interface GraphSubscription {
  id: string;
  agentId: string;
  /** JSONPath-like filter */
  filter: NodeFilter;
  /** Channel for this specific subscription */
  channel: string;
}

export interface NodeFilter {
  type?: NodeType;
  category?: FactCategory;
  status?: GoalStatus | ChangeStatus;
  tags?: string[];
  assignee?: string;
  discoveredBy?: string;
  proposedBy?: string;
  /** Only nodes added after this timestamp */
  since?: string;
}

// ── KnowledgeGraph ────────────────────────────────────────────────────────

export class KnowledgeGraph {
  private readonly nodes = new Map<string, GraphNode>();
  private readonly index = new Map<string, Set<string>>(); // tag/field → node ids
  private readonly subs = new Map<string, GraphSubscription>();
  private readonly pendingDeliveries = new Map<string, GraphNode[]>();
  private readonly filePath: string;
  private readonly graphFilePath: string;

  /**
   * Stable per-node insertion sequence. `nodes` (a Map) preserves insertion
   * order even across `update()` (Map.set on an existing key keeps its slot),
   * but the type index's `Set<string>` does NOT — `update()` removes then
   * re-adds a node's id, moving it to the set's tail. Index-routed queries sort
   * by this sequence so they return nodes in creation order, matching the old
   * `nodes.values()` scan that callers like decision-history `slice(-10)` rely on.
   */
  private readonly seq = new Map<string, number>();
  private seqCounter = 0;

  /** Assign a stable insertion sequence the first time a node id is seen. */
  private _trackSeq(id: string): void {
    if (!this.seq.has(id)) this.seq.set(id, this.seqCounter++);
  }

  /** Exposed for unit-testing only: read current index contents. */
  getIndex(): ReadonlyMap<string, ReadonlySet<string>> {
    return this.index;
  }

  constructor(sessionDir: string) {
    this.filePath = path.join(sessionDir, '_knowledge_graph');
    this.graphFilePath = path.join(this.filePath, 'graph.jsonl');
  }

  // ── Write ──────────────────────────────────────────────────────────────

  /**
   * Add a node. Fires to all matching subscriptions synchronously.
   * Returns the node with its assigned id.
   */
  async add(node: Omit<GraphNode, 'id'>): Promise<GraphNode> {
    const full: GraphNode = { id: randomUUID(), ...node } as GraphNode;
    this.nodes.set(full.id, full);
    this._trackSeq(full.id);
    this._addToIndex(full, this._indexKeys(full));
    await this._persist(full);
    this._deliver(full);
    return full;
  }

  /** Update an existing node by id. Returns updated node or null if not found. */
  async update(id: string, patch: Partial<GraphNode>): Promise<GraphNode | null> {
    const existing = this.nodes.get(id);
    if (!existing) return null;

    // Remove old index entries before applying the patch
    this._removeFromIndex(existing, this._indexKeys(existing));

    // Apply patch and re-index with new values
    const updated = { ...existing, ...patch } as GraphNode;
    this.nodes.set(id, updated);
    this._addToIndex(updated, this._indexKeys(updated));
    this._deliver(updated);
    await this._append(updated);
    return updated;
  }

  // ── Read ───────────────────────────────────────────────────────────────

  get(id: string): GraphNode | undefined {
    return this.nodes.get(id);
  }

  getAll(filter?: NodeFilter): GraphNode[] {
    const f = filter ?? {};

    // Fast path: a type filter (the overwhelmingly common case — every
    // getFacts/getGoals/getChanges/getDecisions call passes one) narrows the
    // candidate set via the `type:` index instead of scanning every node.
    // The index set is a guaranteed superset for `type:`, so the remaining
    // `_matches` pass applies the secondary predicates with identical
    // semantics. Candidates are sorted by insertion sequence to preserve the
    // creation order the old full `nodes.values()` scan produced.
    if (f.type) {
      const ids = this.index.get(`type:${f.type}`);
      if (!ids || ids.size === 0) return [];
      const out: GraphNode[] = [];
      for (const id of ids) {
        const node = this.nodes.get(id);
        if (node && this._matches(node, f)) out.push(node);
      }
      out.sort((a, b) => (this.seq.get(a.id) ?? 0) - (this.seq.get(b.id) ?? 0));
      return out;
    }

    // No type filter — fall back to the full insertion-ordered scan.
    return Array.from(this.nodes.values()).filter((n) => this._matches(n, f));
  }

  getGoals(filter?: Partial<{ status: GoalStatus; assignee: string; priority: GoalPriority }>): GoalNode[] {
    return this.getAll({ type: 'goal', ...filter } as NodeFilter) as GoalNode[];
  }

  getFacts(filter?: Partial<{ category: FactCategory; severity: string }>): FactNode[] {
    return this.getAll({ type: 'fact', ...filter } as NodeFilter) as FactNode[];
  }

  getChanges(filter?: Partial<{ status: ChangeStatus }>): ChangeNode[] {
    return this.getAll({ type: 'change', ...filter } as NodeFilter) as ChangeNode[];
  }

  getOpenGoals(): GoalNode[] {
    return this.getGoals({ status: 'pending' }).concat(
      this.getGoals({ status: 'in_progress' }),
    );
  }

  getTopLevelGoals(): GoalNode[] {
    return this.getGoals({}).filter((g) => !g.parentGoal);
  }

  getBlockedGoals(): GoalNode[] {
    return this.getGoals({ status: 'blocked' });
  }

  getPendingChanges(): ChangeNode[] {
    return this.getChanges({ status: 'proposed' });
  }

  getDecisions(since?: string): DecisionNode[] {
    return this.getAll({ type: 'decision', since } as NodeFilter) as DecisionNode[];
  }

  // ── Search ─────────────────────────────────────────────────────────────

  searchFacts(query: string): FactNode[] {
    const q = query.toLowerCase();
    return this.getFacts().filter(
      (f) =>
        f.subject.toLowerCase().includes(q) ||
        f.detail.toLowerCase().includes(q) ||
        f.file?.toLowerCase().includes(q) ||
        f.tags.some((t) => t.toLowerCase().includes(q)),
    );
  }

  getRelatedFacts(factId: string): FactNode[] {
    const fact = this.nodes.get(factId) as FactNode | undefined;
    if (!fact) return [];
    return fact.related
      .map((id) => this.nodes.get(id))
      .filter((n): n is FactNode => n?.type === 'fact');
  }

  // ── Subscriptions ──────────────────────────────────────────────────────

  /**
   * Subscribe to nodes matching a filter. Returns a channel id that can be
   * used to poll for new nodes since the last check.
   */
  subscribe(agentId: string, filter: NodeFilter): string {
    const channel = randomUUID();
    const sub: GraphSubscription = { id: randomUUID(), agentId, filter, channel };
    this.subs.set(channel, sub);
    this.pendingDeliveries.set(channel, []);
    return channel;
  }

  /**
   * Poll for new nodes delivered to a channel since last check.
   * Clears the delivery buffer after reading.
   */
  poll(channel: string): GraphNode[] {
    const pending = this.pendingDeliveries.get(channel);
    if (!pending) return [];
    const delivered = [...pending];
    pending.length = 0;
    return delivered;
  }

  unsubscribe(channel: string): void {
    this.subs.delete(channel);
    this.pendingDeliveries.delete(channel);
  }

  // ── Quality gate helpers ───────────────────────────────────────────────

  /**
   * Create a quality gate result. Call this when a change is being proposed
   * so the change node carries the gate result.
   */
  static makeQualityGate(
    checks: { name: string; passed: boolean; detail?: string }[],
  ): QualityGateResult {
    return { passed: checks.every((c) => c.passed), checks };
  }

  // ── Private ────────────────────────────────────────────────────────────

  /** Pure: compute the set of index keys a node would belong to. */
  private _indexKeys(node: GraphNode): Set<string> {
    const keys = new Set<string>();
    const add = (key: string) => keys.add(key);
    add(`type:${node.type}`);
    if (node.type === 'fact') {
      const f = node as FactNode;
      add(`cat:${f.category}`);
      if (f.severity) add(`sev:${f.severity}`);
      add(`by:${f.discoveredBy}`);
      for (const tag of f.tags) add(`tag:${tag}`);
      add(`key:${f.key}`);
      // Subject/detail are indexed without category prefix so category changes
      // do not leave stale entries that mislead searchFacts().
      add(`subject:${f.subject}`);
      if (f.detail) add(`detail:${f.detail}`);
    }
    if (node.type === 'goal') {
      const g = node as GoalNode;
      add(`status:${g.status}`);
      add(`prio:${g.priority}`);
      if (g.assignee) add(`assign:${g.assignee}`);
      for (const tag of g.tags) add(`tag:${tag}`);
    }
    if (node.type === 'change') {
      const c = node as ChangeNode;
      add(`change:${c.status}`);
      add(`by:${c.proposedBy}`);
      for (const g of c.satisfiesGoals) add(`goal:${g}`);
    }
    return keys;
  }

  /** Mutate the index: add a node's id to every set for the given keys. */
  private _addToIndex(node: GraphNode, keys: Set<string>): void {
    for (const key of keys) {
      let set = this.index.get(key);
      if (!set) { set = new Set(); this.index.set(key, set); }
      set.add(node.id);
    }
  }

  /** Remove a node's id from all index sets for the given keys. */
  private _removeFromIndex(node: GraphNode, keys: Set<string>): void {
    for (const key of keys) {
      this.index.get(key)?.delete(node.id);
    }
  }

  private _matches(node: GraphNode, f: NodeFilter): boolean {
    if (f.type && node.type !== f.type) return false;
    if (f.category && (node as FactNode).category !== f.category) return false;
    if (f.status) {
      if (node.type === 'goal' && (node as GoalNode).status !== f.status) return false;
      if (node.type === 'change' && (node as ChangeNode).status !== f.status) return false;
    }
    if (f.assignee && (node as GoalNode).assignee !== f.assignee) return false;
    if (f.discoveredBy && (node as FactNode).discoveredBy !== f.discoveredBy) return false;
    if (f.proposedBy && (node as ChangeNode).proposedBy !== f.proposedBy) return false;
    if (f.tags?.length) {
      const nodeTags = (node as FactNode).tags ?? (node as GoalNode).tags ?? [];
      if (!f.tags.some((t) => nodeTags.includes(t))) return false;
    }
    if (f.since && node.id > f.since) {
      // Rough ordering: higher ids are newer (randomUUID v7-like sort)
    }
    return true;
  }

  private _deliver(node: GraphNode): void {
    for (const sub of this.subs.values()) {
      if (this._matches(node, sub.filter)) {
        const pending = this.pendingDeliveries.get(sub.channel);
        if (pending) pending.push(node);
      }
    }
  }

  private async _persist(node: GraphNode): Promise<void> {
    await fsp.mkdir(this.filePath, { recursive: true });
    const line = JSON.stringify(node) + '\n';
    await withFileLock(this.graphFilePath, async () => {
      await fsp.appendFile(this.graphFilePath, line, 'utf8');
    });
  }

  private async _append(node: GraphNode): Promise<void> {
    await fsp.mkdir(this.filePath, { recursive: true });
    const line = JSON.stringify({ op: 'update', node }) + '\n';
    await withFileLock(this.graphFilePath, async () => {
      await fsp.appendFile(this.graphFilePath, line, 'utf8');
    });
  }

  /** Rebuild in-memory state from the log file. Call on startup. */
  async load(): Promise<void> {
    try {
      const content = await fsp.readFile(this.graphFilePath, 'utf8');
      const lines = content.split('\n').filter(Boolean);
      for (const line of lines) {
        try {
          const parsed = JSON.parse(line);
          if (parsed.op === 'update') {
            const oldNode = this.nodes.get(parsed.node.id);
            if (oldNode) {
              // Prune stale index entries before re-indexing
              this._removeFromIndex(oldNode, this._indexKeys(oldNode));
            }
            this.nodes.set(parsed.node.id, parsed.node);
            this._trackSeq(parsed.node.id);
            this._addToIndex(parsed.node, this._indexKeys(parsed.node));
          } else {
            this.nodes.set(parsed.id, parsed);
            this._trackSeq(parsed.id);
            this._addToIndex(parsed, this._indexKeys(parsed));
          }
        } catch { /* skip malformed lines */ }
      }
    } catch {
      // No existing log — fresh start
    }
  }

  /** Snapshot for serialization. */
  snapshot(): { nodes: GraphNode[]; subs: number } {
    return {
      nodes: Array.from(this.nodes.values()),
      subs: this.subs.size,
    };
  }
}
