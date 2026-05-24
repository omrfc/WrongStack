import type {
  TaskFilter,
  TaskGraph,
  TaskNode,
  TaskProgress,
  TaskSort,
} from '../types/task-graph.js';
import { computeTaskProgress } from '../types/task-graph.js';

export interface TaskStore {
  saveGraph(graph: TaskGraph): Promise<void>;
  loadGraph(id: string): Promise<TaskGraph | null>;
  listGraphs(): Promise<{ id: string; title: string; updatedAt: number }[]>;
  deleteGraph(id: string): Promise<void>;
}

export interface TaskTrackerOptions {
  store: TaskStore;
  /**
   * Called when an in-the-background persistence (`saveGraph`) rejects.
   * The synchronous TaskTracker methods (addNode/addEdge/updateNodeStatus)
   * fire-and-forget their writes; without this, a failing store silently
   * loses graph mutations. Defaults to a console.warn.
   */
  onPersistError?: (err: unknown) => void;
}

export interface TaskTransition {
  from: TaskNode['status'];
  to: TaskNode['status'];
  timestamp: number;
  reason?: string;
}

export class TaskTracker {
  private graph: TaskGraph | null = null;
  private transitions: TaskTransition[] = [];

  constructor(private readonly opts: TaskTrackerOptions) {}

  async createGraph(specId: string, title: string): Promise<TaskGraph> {
    this.graph = {
      id: crypto.randomUUID(),
      specId,
      title,
      nodes: new Map(),
      edges: [],
      rootNodes: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    await this.opts.store.saveGraph(this.graph);
    return this.graph;
  }

  async loadGraph(id: string): Promise<TaskGraph | null> {
    this.graph = await this.opts.store.loadGraph(id);
    return this.graph;
  }

  addNode(node: Omit<TaskNode, 'id' | 'createdAt' | 'updatedAt'>): TaskNode {
    if (!this.graph) throw new Error('No graph loaded');

    const now = Date.now();
    const newNode: TaskNode = {
      ...node,
      id: crypto.randomUUID(),
      status: node.status ?? 'pending',
      createdAt: now,
      updatedAt: now,
    };

    this.graph.nodes.set(newNode.id, newNode);

    if (!node.parentId) {
      this.graph.rootNodes.push(newNode.id);
    }

    this.graph.updatedAt = now;
    this.persist();

    return newNode;
  }

  addEdge(from: string, to: string, type: TaskGraph['edges'][0]['type'] = 'depends_on'): void {
    if (!this.graph) throw new Error('No graph loaded');

    this.graph.edges.push({
      id: crypto.randomUUID(),
      from,
      to,
      type,
    });
    this.graph.updatedAt = Date.now();
    this.persist();
  }

  updateNodeStatus(id: string, status: TaskNode['status'], reason?: string): void {
    if (!this.graph) throw new Error('No graph loaded');

    const node = this.graph.nodes.get(id);
    if (!node) throw new Error(`Node ${id} not found`);

    const from = node.status;
    const now = Date.now();
    node.status = status;
    node.updatedAt = now;

    if (status === 'completed') {
      node.completedAt = now;
      node.startedAt = node.startedAt ?? now; // ensure startedAt is set
    }
    if (status === 'in_progress') {
      node.startedAt = now;
    }

    this.transitions.push({ from, to: status, timestamp: now, reason });

    // Auto-unblock dependents
    if (status === 'completed') {
      this.unblockDependents(id);
    }

    // Auto-block blockers
    if (status === 'in_progress') {
      this.checkAndBlockIfNeeded(id);
    }

    this.graph.updatedAt = now;
    this.persist();
  }

  /**
   * Update node fields (title, description, priority, estimateHours, tags).
   * Does NOT change status. Use updateNodeStatus for status changes.
   */
  updateNode(id: string, patch: Partial<Pick<TaskNode, 'title' | 'description' | 'priority' | 'estimateHours' | 'tags'>>): void {
    if (!this.graph) throw new Error('No graph loaded');
    const node = this.graph.nodes.get(id);
    if (!node) throw new Error(`Node ${id} not found`);

    if (patch.title !== undefined) node.title = patch.title;
    if (patch.description !== undefined) node.description = patch.description;
    if (patch.priority !== undefined) node.priority = patch.priority;
    if (patch.estimateHours !== undefined) node.estimateHours = patch.estimateHours;
    if (patch.tags !== undefined) node.tags = patch.tags;
    node.updatedAt = Date.now();
    this.graph.updatedAt = node.updatedAt;
    this.persist();
  }

  getNode(id: string): TaskNode | undefined {
    return this.graph?.nodes.get(id);
  }

  getAllNodes(filter?: TaskFilter, sort?: TaskSort): TaskNode[] {
    if (!this.graph) return [];

    let nodes = Array.from(this.graph.nodes.values());

    if (filter) {
      nodes = nodes.filter((n) => {
        if (filter.status?.length && !filter.status.includes(n.status)) return false;
        if (filter.priority?.length && !filter.priority.includes(n.priority)) return false;
        if (filter.type?.length && !filter.type.includes(n.type)) return false;
        if (filter.assignee?.length && n.assignee && !filter.assignee.includes(n.assignee))
          return false;
        if (filter.tags?.length && n.tags && !n.tags.some((t) => filter.tags!.includes(t)))
          return false;
        if (filter.specRequirementId && n.specRequirementId !== filter.specRequirementId)
          return false;
        return true;
      });
    }

    if (sort) {
      nodes.sort((a, b) => {
        const cmp = compareByField(a, b, sort.field);
        return sort.direction === 'asc' ? cmp : -cmp;
      });
    }

    return nodes;
  }

  getChildren(parentId: string): TaskNode[] {
    if (!this.graph) return [];
    return Array.from(this.graph.nodes.values()).filter((n) => n.parentId === parentId);
  }

  getDependents(taskId: string): string[] {
    if (!this.graph) return [];
    return this.graph.edges
      .filter((e) => e.from === taskId && e.type === 'depends_on')
      .map((e) => e.to);
  }

  getBlockers(taskId: string): string[] {
    if (!this.graph) return [];
    return this.graph.edges
      .filter((e) => e.to === taskId && e.type === 'depends_on')
      .map((e) => e.from);
  }

  canStart(taskId: string): boolean {
    const blockers = this.getBlockers(taskId);
    return blockers.every((id) => {
      const node = this.graph?.nodes.get(id);
      return node?.status === 'completed';
    });
  }

  getProgress(): TaskProgress {
    if (!this.graph) {
      return {
        total: 0,
        pending: 0,
        inProgress: 0,
        blocked: 0,
        failed: 0,
        review: 0,
        completed: 0,
        percentComplete: 0,
        estimatedHours: 0,
        actualHours: 0,
      };
    }
    return computeTaskProgress(this.graph);
  }

  getTransitions(taskId?: string): TaskTransition[] {
    if (!taskId) return [...this.transitions];
    // Would need taskId tracking per transition
    return [...this.transitions];
  }

  private unblockDependents(completedId: string): void {
    if (!this.graph) return;
    const dependents = this.getDependents(completedId);
    for (const depId of dependents) {
      const dep = this.graph.nodes.get(depId);
      if (dep?.status === 'blocked') {
        const remainingBlockers = this.getBlockers(depId);
        const allUnblocked = remainingBlockers.every((id) => {
          const blocker = this.graph?.nodes.get(id);
          return blocker?.status === 'completed';
        });
        if (allUnblocked) {
          dep.status = 'pending';
          dep.updatedAt = Date.now();
        }
      }
    }
  }

  private checkAndBlockIfNeeded(taskId: string): void {
    if (!this.graph) return;
    const blockers = this.getBlockers(taskId);
    const someBlocked = blockers.some((id) => {
      const blocker = this.graph?.nodes.get(id);
      return blocker?.status !== 'completed';
    });
    if (someBlocked) {
      const node = this.graph.nodes.get(taskId);
      if (node) {
        node.status = 'blocked';
        node.updatedAt = Date.now();
      }
    }
  }

  /**
   * Fire-and-forget persistence with attached error handler.
   * Synchronous mutators (addNode/addEdge/updateNodeStatus) use this to
   * avoid forcing an async cascade through every caller; if the store
   * rejects, the configured `onPersistError` is invoked so failures are
   * surfaced instead of swallowed by an unhandled promise rejection.
   */
  private persist(): void {
    if (!this.graph) return;
    this.opts.store.saveGraph(this.graph).catch((err) => {
      if (this.opts.onPersistError) this.opts.onPersistError(err);
      else
        console.warn(
          '[task-tracker] saveGraph failed:',
          err instanceof Error ? err.message : String(err),
        );
    });
  }
}

const PRIORITY_RANK: Record<TaskNode['priority'], number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};
const STATUS_RANK: Record<TaskNode['status'], number> = {
  in_progress: 0,
  pending: 1,
  review: 2,
  blocked: 3,
  failed: 4,
  completed: 5,
};

function compareByField(a: TaskNode, b: TaskNode, field: TaskSort['field']): number {
  switch (field) {
    case 'priority':
      return PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
    case 'status':
      return STATUS_RANK[a.status] - STATUS_RANK[b.status];
    case 'createdAt':
      return a.createdAt - b.createdAt;
    case 'updatedAt':
      return a.updatedAt - b.updatedAt;
  }
}
