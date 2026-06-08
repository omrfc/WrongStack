import * as fs from 'node:fs/promises';
import type { MemoryEntry, MemoryScope } from '../types/memory.js';
import { type FileMemoryBackendOptions, FileMemoryBackend } from './memory-backend.js';
import type { MemoryBackend } from './memory-backend.js';

// ── Graph node and edge types ──────────────────────────────────────────

interface GraphNode {
  id: string;
  entry: MemoryEntry;
  firstSeen: string;
  count: number;
  /** Extracted metadata for fast lookup. */
  type?: MemoryEntry['type'] | undefined;
  tags?: string[] | undefined;
  priority?: MemoryEntry['priority'] | undefined;
}

interface GraphEdge {
  from: string;
  to: string;
  /** Why these nodes are related. */
  relation: 'co_occurring' | 'similar' | 'same_turn' | 'explicit';
  weight: number;
  ts: string;
}

// ── Backend ────────────────────────────────────────────────────────────

export interface GraphMemoryBackendOptions extends FileMemoryBackendOptions {
  /**
   * Path to the graph metadata file (edges + node metadata).
   * Defaults to `<projectDir>/memory-graph.json`.
   */
  graphPath?: string | undefined;
}

/**
 * Graph-based memory backend that tracks relationships between entries.
 * Builds on top of FileMemoryBackend — entries are still persisted as
 * markdown bullets, but the graph layer adds:
 *
 *   - Co-occurrence edges (entries from the same remember() batch)
 *   - Content similarity edges (simple Jaccard on word overlap)
 *   - Turn-based edges (entries created in the same LLM turn)
 *   - Graph traversal queries (find related memories)
 *
 * The graph metadata persists to `<projectDir>/memory-graph.json`.
 */
export class GraphMemoryBackend implements MemoryBackend {
  readonly kind = 'graph';

  private readonly file: FileMemoryBackend;
  private readonly graphFile: string;

  // In-memory graph state — lazily loaded, saved on mutation.
  private nodes = new Map<string, GraphNode>();
  private edges: GraphEdge[] = [];
  private loadedScope: MemoryScope | null = null;
  private loaded = false;

  constructor(opts: GraphMemoryBackendOptions) {
    this.file = new FileMemoryBackend({ paths: opts.paths });
    this.graphFile = opts.graphPath ?? `${opts.paths.projectDir}/memory-graph.json`;
  }

  // ── Backend interface ──────────────────────────────────────────────

  async remember(scope: MemoryScope, entry: MemoryEntry, filePath: string): Promise<void> {
    await this.file.remember(scope, entry, filePath);
    await this.loadGraph(scope);

    const nodeId = this.nodeId(entry);
    const existing = this.nodes.get(nodeId);
    if (existing) {
      existing.count++;
      existing.entry = entry;
      existing.type = entry.type;
      existing.tags = entry.tags;
      existing.priority = entry.priority;
    } else {
      this.nodes.set(nodeId, {
        id: nodeId,
        entry,
        firstSeen: entry.ts,
        count: 1,
        type: entry.type,
        tags: entry.tags,
        priority: entry.priority,
      });

      // Create similarity edges with existing nodes
      for (const [, other] of this.nodes) {
        if (other.id === nodeId) continue;
        const sim = wordOverlap(entry.text, other.entry.text);
        // Also create edges for shared tags
        const tagSim = sharedTags(entry.tags ?? [], other.tags ?? []);
        const weight = Math.max(sim, tagSim * 0.5);
        if (weight > 0.15) {
          this.edges.push({
            from: nodeId,
            to: other.id,
            relation: sim >= tagSim ? 'similar' : 'same_turn',
            weight,
            ts: entry.ts,
          });
        }
      }
    }

    await this.saveGraph(scope);
  }

  async forget(scope: MemoryScope, query: string, filePath: string): Promise<number> {
    const removed = await this.file.forget(scope, query, filePath);
    if (removed > 0) {
      await this.loadGraph(scope);
      // Remove nodes whose entry text matches the query
      const n = query.toLowerCase();
      const toRemove: string[] = [];
      for (const [id, node] of this.nodes) {
        if (node.entry.text.toLowerCase().includes(n)) {
          toRemove.push(id);
        }
      }
      for (const id of toRemove) this.nodes.delete(id);
      this.edges = this.edges.filter((e) => !toRemove.includes(e.from) && !toRemove.includes(e.to));
      await this.saveGraph(scope);
    }
    return removed;
  }

  async readAll(scope: MemoryScope, filePath: string): Promise<string> {
    return this.file.readAll(scope, filePath);
  }

  async list(scope: MemoryScope, filePath: string, limit?: number): Promise<MemoryEntry[]> {
    await this.loadGraph(scope);
    // Merge: file entries are canonical, graph adds metadata and dedup
    const fileEntries = await this.file.list(scope, filePath);
    const nodeMap = new Map(this.nodes.entries());

    // Enrich file entries with graph metadata
    const enriched = fileEntries.map((fe) => {
      const nodeId = this.nodeId(fe);
      const node = nodeMap.get(nodeId);
      if (node) {
        return {
          ...fe,
          type: node.type ?? fe.type,
          tags: node.tags ?? fe.tags,
          priority: node.priority ?? fe.priority,
        };
      }
      return fe;
    });

    // Add graph-only nodes not in file (shouldn't happen normally, but safety)
    const fileIds = new Set(fileEntries.map((e) => this.nodeId(e)));
    for (const [id, node] of this.nodes) {
      if (!fileIds.has(id)) {
        enriched.push(node.entry);
      }
    }

    enriched.sort((a, b) => b.ts.localeCompare(a.ts));
    return limit ? enriched.slice(0, limit) : enriched;
  }

  async search(scope: MemoryScope, query: string, filePath: string, limit?: number): Promise<MemoryEntry[]> {
    await this.loadGraph(scope);
    const needle = query.toLowerCase().split(/\s+/);

    // Get all entries (file-canonical, graph-enriched)
    const all = await this.list(scope, filePath);

    // Score by word overlap + tag match + graph metadata
    const scored = all.map((entry) => {
      const words = entry.text.toLowerCase().split(/\s+/);
      let score = 0;
      for (const n of needle) {
        if (words.some((w) => w.includes(n))) score += 1;
        if (entry.tags?.some((t) => t.toLowerCase().includes(n))) score += 2;
      }
      const node = this.nodes.get(this.nodeId(entry));
      if (node) {
        if (node.priority === 'critical') score += 3;
        else if (node.priority === 'high') score += 2;
        score += node.count * 0.5;
      }
      return { entry, score };
    });

    scored.sort((a, b) => b.score - a.score);
    const matched = scored.filter((s) => s.score > 0).map((s) => s.entry);
    return limit ? matched.slice(0, limit) : matched;
  }

  async clear(scope: MemoryScope, filePath: string): Promise<void> {
    await this.file.clear(scope, filePath);
    this.nodes.clear();
    this.edges = [];
    this.loadedScope = scope;
    this.loaded = true;
    // Write empty graph
    try { await fs.unlink(this.graphFile); } catch { /* ok */ }
  }

  async consolidate(scope: MemoryScope, filePath: string): Promise<number> {
    return this.file.consolidate(scope, filePath);
  }

  // ── Graph-specific queries ─────────────────────────────────────────

  /**
   * Find memories related to the given entry, ordered by edge weight.
   */
  async findRelated(scope: MemoryScope, _filePath: string, entryText: string, limit = 5): Promise<MemoryEntry[]> {
    await this.loadGraph(scope);
    const targetId = this.nodeId({ scope, text: entryText, ts: '' });
    const related = this.edges
      .filter((e) => e.from === targetId || e.to === targetId)
      .sort((a, b) => b.weight - a.weight)
      .slice(0, limit);

    const result: MemoryEntry[] = [];
    for (const edge of related) {
      const otherId = edge.from === targetId ? edge.to : edge.from;
      const node = this.nodes.get(otherId);
      if (node) result.push(node.entry);
    }
    return result;
  }

  /**
   * Get all edges for visualization or traversal.
   */
  getGraph(): { nodes: GraphNode[]; edges: GraphEdge[] } {
    return {
      nodes: [...this.nodes.values()],
      edges: [...this.edges],
    };
  }

  // ── Persistence ────────────────────────────────────────────────────

  private nodeId(entry: MemoryEntry): string {
    // Stable ID from scope + normalized text
    const norm = entry.text.toLowerCase().trim().replace(/\s+/g, ' ');
    return `${entry.scope ?? 'mem'}::${simpleHash(norm)}`;
  }

  private async loadGraph(scope: MemoryScope): Promise<void> {
    if (this.loaded && this.loadedScope === scope) return;
    try {
      const raw = await fs.readFile(this.graphFile, 'utf8');
      const data: { nodes: Array<[string, GraphNode]>; edges: GraphEdge[] } = JSON.parse(raw);
      this.nodes = new Map(data.nodes);
      this.edges = data.edges;
    } catch {
      this.nodes = new Map();
      this.edges = [];
    }
    this.loadedScope = scope;
    this.loaded = true;
  }

  private async saveGraph(scope: MemoryScope): Promise<void> {
    this.loadedScope = scope;
    this.loaded = true;
    try {
      const data = {
        nodes: [...this.nodes.entries()],
        edges: this.edges,
      };
      await fs.mkdir(
        this.graphFile.substring(0, this.graphFile.lastIndexOf('/')),
        { recursive: true },
      );
      // Atomic write via temp file
      const tmp = `${this.graphFile}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(data));
      await fs.rename(tmp, this.graphFile);
    } catch {
      // best-effort — graph is an enhancement, not critical
    }
  }
}

// ── Helpers ────────────────────────────────────────────────────────────

/** Jaccard-style word overlap between two strings. 0.0 = no overlap, 1.0 = identical. */
function wordOverlap(a: string, b: string): number {
  const wordsA = new Set(a.toLowerCase().split(/\s+/).filter((w) => w.length > 2));
  const wordsB = new Set(b.toLowerCase().split(/\s+/).filter((w) => w.length > 2));
  if (wordsA.size === 0 || wordsB.size === 0) return 0;
  let intersection = 0;
  for (const w of wordsA) {
    if (wordsB.has(w)) intersection++;
  }
  return intersection / Math.max(wordsA.size, wordsB.size);
}

/** Tag overlap ratio — how many tags two nodes share. */
function sharedTags(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const setB = new Set(b);
  let shared = 0;
  for (const t of a) if (setB.has(t)) shared++;
  return shared / Math.max(a.length, b.length);
}

/** Fast non-crypto hash for stable node IDs. */
function simpleHash(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h).toString(36);
}
