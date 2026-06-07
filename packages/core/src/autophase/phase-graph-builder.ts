import type { PhaseGraph, PhaseNode, PhaseTemplate } from './types.js';
import type { TaskGraph } from '../types/task-graph.js';
import type { TaskStore } from '../sdd/task-tracker.js';
import { DefaultTaskStore, TaskTracker } from '../sdd/index.js';

export interface PhaseGraphBuilderOptions {
  title: string;
  description?: string | undefined;
  /** Ordered phase templates. */
  phases: PhaseTemplate[];
  /** Autonomous mode. */
  autonomous?: boolean | undefined;
  /** Stop on failure. */
  stopOnFailure?: boolean | undefined;
  /** Optional external TaskStore. */
  externalTaskStore?: TaskStore | undefined;
}

/**
 * PhaseGraphBuilder - builds project phases and a task graph for each phase.
 *
 * Usage:
 *   const builder = new PhaseGraphBuilder({
 *     title: 'Auth System Refactor',
 *     phases: [
 *       { name: 'Discovery', description: '...', priority: 'high', estimateHours: 2, parallelizable: false },
 *       { name: 'Design', description: '...', priority: 'critical', estimateHours: 4, parallelizable: false },
 *       { name: 'Implementation', description: '...', priority: 'critical', estimateHours: 12, parallelizable: false },
 *       { name: 'Testing', description: '...', priority: 'high', estimateHours: 6, parallelizable: true },
 *       { name: 'Deployment', description: '...', priority: 'medium', estimateHours: 2, parallelizable: false },
 *     ]
 *   });
 *   const graph = await builder.build();
 */
export class PhaseGraphBuilder {
  constructor(private readonly opts: PhaseGraphBuilderOptions) {}

  async build(): Promise<PhaseGraph> {
    const graphId = crypto.randomUUID();
    const phases = new Map<string, PhaseNode>();
    const phaseIds: string[] = [];

    // Create a PhaseNode from each phase template.
    for (let i = 0; i < this.opts.phases.length; i++) {
      const tmpl = this.opts.phases[i] ?? { name: '', description: '', tasks: [], taskTemplates: [], parallelizable: false, priority: 'medium' as const, estimateHours: 0 };
      const phaseId = crypto.randomUUID();
      phaseIds.push(phaseId);

      // Use the external store or create a new DefaultTaskStore.
      const store = this.opts.externalTaskStore ?? new DefaultTaskStore();
      const tracker = new TaskTracker({ store });
      const taskGraph = await tracker.createGraph(phaseId, `${tmpl.name} Tasks`);

      // Add task templates when present.
      if (tmpl.taskTemplates && tmpl.taskTemplates.length > 0) {
        for (const tt of tmpl.taskTemplates) {
          tracker.addNode({
            title: tt.title,
            description: tt.description,
            type: tt.type,
            priority: tt.priority,
            status: 'pending',
            estimateHours: tt.estimateHours,
            tags: tt.tags ?? [],
          });
        }
      }

      const phase: PhaseNode = {
        id: phaseId,
        name: tmpl.name,
        description: tmpl.description,
        status: 'pending',
        taskGraph,
        dependsOn: i > 0 ? [phaseIds[i - 1] ?? ''] : [],
        nextPhases: i < this.opts.phases.length - 1 ? [phaseIds[i + 1] ?? ''] : [],
        parallelizable: tmpl.parallelizable,
        priority: tmpl.priority,
        estimateHours: tmpl.estimateHours,
        assignedAgents: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      phases.set(phaseId, phase);
    }

    // Second pass: fix nextPhases links.
    // The next phase ID was not known while the phase was being created.
    const phaseArray = Array.from(phases.values());
    for (let i = 0; i < phaseArray.length; i++) {
      const phase = phaseArray[i];
      if (!phase) continue;
      phase.nextPhases = i < phaseArray.length - 1 ? [phaseArray[i + 1]?.id ?? ''] : [];
      phase.dependsOn = i > 0 ? [phaseArray[i - 1]?.id ?? ''] : [];
    }

    const graph: PhaseGraph = {
      id: graphId,
      title: this.opts.title,
      description: this.opts.description ?? '',
      phases,
      rootPhaseIds: phaseIds.length > 0 ? [phaseIds[0] ?? ''] : [],
      activePhaseIds: [],
      completedPhaseIds: [],
      failedPhaseIds: [],
      autonomous: this.opts.autonomous ?? true,
      stopOnComplete: true,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    return graph;
  }

  /**
   * Create phases from an existing TaskGraph.
   * Groups tasks into phases by priority and type.
   */
  static fromTaskGraph(
    taskGraph: TaskGraph,
    options: Omit<PhaseGraphBuilderOptions, 'phases'> & {
      /** Number of tasks per phase. Defaults to 5. */
      tasksPerPhase?: number | undefined;
    },
  ): Promise<PhaseGraph> {
    const tasksPerPhase = options.tasksPerPhase ?? 5;
    const nodes = Array.from(taskGraph.nodes.values());

    // Sort tasks: critical first, then dependency order.
    const sorted = [...nodes].sort((a, b) => {
      const prioOrder = { critical: 0, high: 1, medium: 2, low: 3 };
      return (prioOrder[a.priority] ?? 4) - (prioOrder[b.priority] ?? 4);
    });

    // Group tasks.
    const groups: typeof sorted[] = [];
    for (let i = 0; i < sorted.length; i += tasksPerPhase) {
      groups.push(sorted.slice(i, i + tasksPerPhase));
    }

    const phaseTemplates: PhaseTemplate[] = groups.map((group, idx) => {
      const hasCritical = group.some((t) => t.priority === 'critical');
      const totalHours = group.reduce((sum, t) => sum + (t.estimateHours ?? 2), 0);

      return {
        name: `Phase ${idx + 1}: ${group[0]?.title.slice(0, 30) ?? 'Tasks'}`,
        description: group.map((t) => t.title).join(', '),
        priority: hasCritical ? 'critical' : 'high',
        estimateHours: totalHours,
        parallelizable: false,
        taskTemplates: group.map((t) => ({
          title: t.title,
          description: t.description,
          type: t.type,
          priority: t.priority,
          estimateHours: t.estimateHours ?? 2,
          tags: t.tags ?? [],
        })),
      };
    });

    const builder = new PhaseGraphBuilder({
      ...options,
      phases: phaseTemplates,
    });

    return builder.build();
  }
}
