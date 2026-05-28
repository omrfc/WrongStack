import type { PhaseGraph, PhaseNode, PhaseTemplate } from './types.js';
import type { TaskGraph } from '../types/task-graph.js';
import type { TaskStore } from '../sdd/task-tracker.js';
import { DefaultTaskStore, TaskTracker } from '../sdd/index.js';

export interface PhaseGraphBuilderOptions {
  title: string;
  description?: string;
  /** Faz şablonları (sıralı) */
  phases: PhaseTemplate[];
  /** Otonom mod */
  autonomous?: boolean;
  /** Başarısızlıkta dur */
  stopOnFailure?: boolean;
  /** Harici TaskStore (opsiyonel) */
  externalTaskStore?: TaskStore;
}

/**
 * PhaseGraphBuilder — Projeyi fazlara bölen ve her faz için task graph oluşturan builder.
 *
 * Kullanım:
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

    // Her faz şablonundan PhaseNode oluştur
    for (let i = 0; i < this.opts.phases.length; i++) {
      const tmpl = this.opts.phases[i]!;
      const phaseId = crypto.randomUUID();
      phaseIds.push(phaseId);

      // Harici store veya yeni DefaultTaskStore kullan
      const store = this.opts.externalTaskStore ?? new DefaultTaskStore();
      const tracker = new TaskTracker({ store });
      const taskGraph = await tracker.createGraph(phaseId, `${tmpl.name} Tasks`);

      // Task şablonları varsa ekle
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
        dependsOn: i > 0 ? [phaseIds[i - 1]!] : [],
        nextPhases: i < this.opts.phases.length - 1 ? [phaseIds[i + 1]!] : [],
        parallelizable: tmpl.parallelizable,
        priority: tmpl.priority,
        estimateHours: tmpl.estimateHours,
        assignedAgents: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      phases.set(phaseId, phase);
    }

    // İkinci geçiş: nextPhases bağlantılarını düzelt
    // (phase oluşturulurken sonraki fazın ID'si henüz bilinmiyordu)
    const phaseArray = Array.from(phases.values());
    for (let i = 0; i < phaseArray.length; i++) {
      const phase = phaseArray[i]!;
      phase.nextPhases = i < phaseArray.length - 1 ? [phaseArray[i + 1]!.id] : [];
      phase.dependsOn = i > 0 ? [phaseArray[i - 1]!.id] : [];
    }

    const graph: PhaseGraph = {
      id: graphId,
      title: this.opts.title,
      description: this.opts.description ?? '',
      phases,
      rootPhaseIds: phaseIds.length > 0 ? [phaseIds[0]!] : [],
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
   * Var olan bir TaskGraph'tan fazlar oluştur.
   * Task'ları priority/type göre gruplayarak fazlara ayırır.
   */
  static fromTaskGraph(
    taskGraph: TaskGraph,
    options: Omit<PhaseGraphBuilderOptions, 'phases'> & {
      /** Faz başına düşen task sayısı (default: 5) */
      tasksPerPhase?: number;
    },
  ): Promise<PhaseGraph> {
    const tasksPerPhase = options.tasksPerPhase ?? 5;
    const nodes = Array.from(taskGraph.nodes.values());

    // Task'ları sırala: önce critical, sonra dependency order
    const sorted = [...nodes].sort((a, b) => {
      const prioOrder = { critical: 0, high: 1, medium: 2, low: 3 };
      return (prioOrder[a.priority] ?? 4) - (prioOrder[b.priority] ?? 4);
    });

    // Task'ları grupla
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
