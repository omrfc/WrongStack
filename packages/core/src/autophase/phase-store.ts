import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import type { PhaseGraph, PhaseNode } from './types.js';
import type { TaskGraph, TaskNode, TaskEdge } from '../types/task-graph.js';

export interface PhaseStoreOptions {
  baseDir: string;
}

interface SerializedPhaseGraph {
  id: string;
  title: string;
  description: string;
  phases: SerializedPhaseNode[];
  rootPhaseIds: string[];
  activePhaseIds: string[];
  completedPhaseIds: string[];
  failedPhaseIds: string[];
  autonomous: boolean;
  stopOnComplete: boolean;
  createdAt: number;
  updatedAt: number;
  startedAt?: number | undefined;
  completedAt?: number | undefined;
}

interface SerializedPhaseNode {
  id: string;
  name: string;
  description: string;
  status: PhaseNode['status'];
  taskGraph: SerializedTaskGraph;
  dependsOn: string[];
  nextPhases: string[];
  parallelizable: boolean;
  priority: PhaseNode['priority'];
  estimateHours: number;
  actualDurationMs?: number | undefined;
  startedAt?: number | undefined;
  completedAt?: number | undefined;
  assignedAgents: string[];
  metadata?: Record<string, unknown> | undefined;
  createdAt: number;
  updatedAt: number;
}

interface SerializedTaskGraph {
  id: string;
  specId: string;
  title: string;
  nodes: SerializedTaskNode[];
  edges: TaskEdge[];
  rootNodes: string[];
  createdAt: number;
  updatedAt: number;
}

interface SerializedTaskNode {
  id: string;
  title: string;
  description: string;
  type: TaskNode['type'];
  priority: TaskNode['priority'];
  status: TaskNode['status'];
  assignee?: string | undefined;
  estimateHours?: number | undefined;
  actualHours?: number | undefined;
  tags?: string[] | undefined;
  specRequirementId?: string | undefined;
  parentId?: string | undefined;
  children?: string[] | undefined;
  createdAt: number;
  updatedAt: number;
  startedAt?: number | undefined;
  completedAt?: number | undefined;
  metadata?: Record<string, unknown> | undefined;
}

/**
 * PhaseStore - persistence layer for saving and loading PhaseGraph objects on disk.
 */
export class PhaseStore {
  readonly baseDir: string;

  constructor(opts: PhaseStoreOptions) {
    this.baseDir = opts.baseDir;
  }

  async save(graph: PhaseGraph): Promise<void> {
    const filePath = this.getFilePath(graph.id);
    await fsp.mkdir(path.dirname(filePath), { recursive: true });

    const serialized = this.serializeGraph(graph);
    await fsp.writeFile(filePath, JSON.stringify(serialized, null, 2), 'utf8');
  }

  async load(graphId: string): Promise<PhaseGraph | null> {
    const filePath = this.getFilePath(graphId);
    try {
      const raw = await fsp.readFile(filePath, 'utf8');
      const serialized = JSON.parse(raw) as SerializedPhaseGraph;
      return this.deserializeGraph(serialized);
    } catch {
      return null;
    }
  }

  async delete(graphId: string): Promise<void> {
    const filePath = this.getFilePath(graphId);
    try {
      await fsp.unlink(filePath);
    } catch {
      // File might not exist
    }
  }

  async list(): Promise<Array<{ id: string; title: string; updatedAt: number; status: string }>> {
    try {
      const entries = await fsp.readdir(this.baseDir, { withFileTypes: true });
      const graphs: Array<{ id: string; title: string; updatedAt: number; status: string }> = [];

      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
        try {
          const raw = await fsp.readFile(path.join(this.baseDir, entry.name), 'utf8');
          const serialized = JSON.parse(raw) as SerializedPhaseGraph;
          const done = serialized.completedPhaseIds.length;
          const total = serialized.phases.length;
          graphs.push({
            id: serialized.id,
            title: serialized.title,
            updatedAt: serialized.updatedAt,
            status: done === total ? 'completed' : done > 0 ? 'in_progress' : 'pending',
          });
        } catch {
          // Skip invalid files
        }
      }

      return graphs.sort((a, b) => b.updatedAt - a.updatedAt);
    } catch {
      return [];
    }
  }

  private getFilePath(graphId: string): string {
    return path.join(this.baseDir, `${graphId}.json`);
  }

  private serializeGraph(graph: PhaseGraph): SerializedPhaseGraph {
    return {
      id: graph.id,
      title: graph.title,
      description: graph.description,
      phases: Array.from(graph.phases.values()).map((p) => this.serializePhase(p)),
      rootPhaseIds: graph.rootPhaseIds,
      activePhaseIds: graph.activePhaseIds,
      completedPhaseIds: graph.completedPhaseIds,
      failedPhaseIds: graph.failedPhaseIds,
      autonomous: graph.autonomous,
      stopOnComplete: graph.stopOnComplete,
      createdAt: graph.createdAt,
      updatedAt: graph.updatedAt,
      startedAt: graph.startedAt,
      completedAt: graph.completedAt,
    };
  }

  private serializePhase(phase: PhaseNode): SerializedPhaseNode {
    return {
      id: phase.id,
      name: phase.name,
      description: phase.description,
      status: phase.status,
      taskGraph: this.serializeTaskGraph(phase.taskGraph),
      dependsOn: phase.dependsOn,
      nextPhases: phase.nextPhases,
      parallelizable: phase.parallelizable,
      priority: phase.priority,
      estimateHours: phase.estimateHours,
      actualDurationMs: phase.actualDurationMs,
      startedAt: phase.startedAt,
      completedAt: phase.completedAt,
      assignedAgents: phase.assignedAgents,
      metadata: phase.metadata,
      createdAt: phase.createdAt,
      updatedAt: phase.updatedAt,
    };
  }

  private serializeTaskGraph(graph: TaskGraph): SerializedTaskGraph {
    return {
      id: graph.id,
      specId: graph.specId,
      title: graph.title,
      nodes: Array.from(graph.nodes.values()).map((n) => this.serializeTaskNode(n)),
      edges: graph.edges,
      rootNodes: graph.rootNodes,
      createdAt: graph.createdAt,
      updatedAt: graph.updatedAt,
    };
  }

  private serializeTaskNode(node: TaskNode): SerializedTaskNode {
    return { ...node };
  }

  private deserializeGraph(serialized: SerializedPhaseGraph): PhaseGraph {
    const phases = new Map<string, PhaseNode>();
    for (const sp of serialized.phases) {
      phases.set(sp.id, this.deserializePhase(sp));
    }

    return {
      id: serialized.id,
      title: serialized.title,
      description: serialized.description,
      phases,
      rootPhaseIds: serialized.rootPhaseIds,
      activePhaseIds: serialized.activePhaseIds,
      completedPhaseIds: serialized.completedPhaseIds,
      failedPhaseIds: serialized.failedPhaseIds,
      autonomous: serialized.autonomous,
      stopOnComplete: serialized.stopOnComplete,
      createdAt: serialized.createdAt,
      updatedAt: serialized.updatedAt,
      startedAt: serialized.startedAt,
      completedAt: serialized.completedAt,
    };
  }

  private deserializePhase(serialized: SerializedPhaseNode): PhaseNode {
    return {
      id: serialized.id,
      name: serialized.name,
      description: serialized.description,
      status: serialized.status,
      taskGraph: this.deserializeTaskGraph(serialized.taskGraph),
      dependsOn: serialized.dependsOn,
      nextPhases: serialized.nextPhases,
      parallelizable: serialized.parallelizable,
      priority: serialized.priority,
      estimateHours: serialized.estimateHours,
      actualDurationMs: serialized.actualDurationMs,
      startedAt: serialized.startedAt,
      completedAt: serialized.completedAt,
      assignedAgents: serialized.assignedAgents,
      metadata: serialized.metadata,
      createdAt: serialized.createdAt,
      updatedAt: serialized.updatedAt,
    };
  }

  private deserializeTaskGraph(serialized: SerializedTaskGraph): TaskGraph {
    const nodes = new Map<string, TaskNode>();
    for (const sn of serialized.nodes) {
      nodes.set(sn.id, sn as TaskNode);
    }

    return {
      id: serialized.id,
      specId: serialized.specId,
      title: serialized.title,
      nodes,
      edges: serialized.edges ?? [],
      rootNodes: serialized.rootNodes ?? [],
      createdAt: serialized.createdAt,
      updatedAt: serialized.updatedAt,
    };
  }
}
