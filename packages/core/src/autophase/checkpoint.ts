import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import type { PhaseGraph, PhaseNode } from './types.js';
import { PhaseStore } from './phase-store.js';

export interface Checkpoint {
  id: string;
  graphId: string;
  phaseId: string;
  phaseStatus: PhaseNode['status'];
  taskStatuses: Array<{ taskId: string; status: string; title: string }>;
  timestamp: number;
  label?: string;
}

export interface CheckpointManagerOptions {
  store: PhaseStore;
  maxCheckpoints?: number;
  baseDir?: string;
}

interface SerializedCheckpoint {
  id: string;
  graphId: string;
  phaseId: string;
  phaseStatus: PhaseNode['status'];
  taskStatuses: Array<{ taskId: string; status: string; title: string }>;
  timestamp: number;
  label?: string;
}

/**
 * CheckpointManager — Phase graph'ın anlık görüntülerini alır ve geri yükler.
 *
 * Kullanım:
 *   const cm = new CheckpointManager({ store });
 *   await cm.saveCheckpoint(graph, 'Before risky refactor');
 *   // ... işler ters giderse ...
 *   const restored = await cm.restoreCheckpoint(checkpointId);
 */
export class CheckpointManager {
  private store: PhaseStore;
  private maxCheckpoints: number;
  private checkpoints = new Map<string, Checkpoint>();
  private baseDir: string;

  constructor(opts: CheckpointManagerOptions) {
    this.store = opts.store;
    this.maxCheckpoints = opts.maxCheckpoints ?? 10;
    this.baseDir = opts.baseDir ?? path.join(opts.store.baseDir, '.checkpoints');
    // Directory creation is lazy — happens on first save
  }

  async initialize(): Promise<void> {
    await fsp.mkdir(this.baseDir, { recursive: true });
    await this.loadFromDisk();
  }

  async saveCheckpoint(graph: PhaseGraph, label?: string): Promise<Checkpoint> {
    // Önce graph'ı kaydet
    await this.store.save(graph);

    // Aktif fazdan checkpoint bilgisi çıkar
    const activePhase = Array.from(graph.phases.values()).find(
      (p) => p.status === 'running' || p.status === 'paused',
    );

    const checkpoint: Checkpoint = {
      id: crypto.randomUUID(),
      graphId: graph.id,
      phaseId: activePhase?.id ?? graph.rootPhaseIds[0] ?? '',
      phaseStatus: activePhase?.status ?? 'pending',
      taskStatuses: activePhase
        ? Array.from(activePhase.taskGraph.nodes.values()).map((t) => ({
            taskId: t.id,
            status: t.status,
            title: t.title,
          }))
        : [],
      timestamp: Date.now(),
      label,
    };

    this.checkpoints.set(checkpoint.id, checkpoint);

    // Diske kaydet
    await this.saveToDisk(checkpoint);

    // Eski checkpoint'leri temizle
    await this.pruneCheckpoints();

    return checkpoint;
  }

  async restoreCheckpoint(checkpointId: string): Promise<PhaseGraph | null> {
    let checkpoint = this.checkpoints.get(checkpointId);

    // Diskten yükle (checkpoint bellekte değilse)
    if (!checkpoint) {
      await this.loadFromDisk();
      checkpoint = this.checkpoints.get(checkpointId);
    }

    if (!checkpoint) return null;

    const graph = await this.store.load(checkpoint.graphId);
    if (!graph) return null;

    // Checkpoint'teki faz status'unu geri yükle
    const phase = graph.phases.get(checkpoint.phaseId);
    if (phase) {
      phase.status = checkpoint.phaseStatus;
      phase.updatedAt = Date.now();

      // Task status'larını geri yükle
      for (const ts of checkpoint.taskStatuses) {
        const task = phase.taskGraph.nodes.get(ts.taskId);
        if (task) {
          task.status = ts.status as import('../types/task-graph.js').TaskStatus;
          task.updatedAt = Date.now();
        }
      }
    }

    graph.updatedAt = Date.now();
    return graph;
  }

  listCheckpoints(graphId?: string): Checkpoint[] {
    const all = Array.from(this.checkpoints.values());
    const filtered = graphId ? all.filter((c) => c.graphId === graphId) : all;
    return filtered.sort((a, b) => b.timestamp - a.timestamp);
  }

  deleteCheckpoint(checkpointId: string): boolean {
    const checkpoint = this.checkpoints.get(checkpointId);
    if (!checkpoint) return false;

    this.checkpoints.delete(checkpointId);
    void this.deleteFromDisk(checkpointId);
    return true;
  }

  private async saveToDisk(checkpoint: Checkpoint): Promise<void> {
    await fsp.mkdir(this.baseDir, { recursive: true });
    const filePath = path.join(this.baseDir, `${checkpoint.graphId}.json`);
    const serialized: SerializedCheckpoint = {
      ...checkpoint,
    };

    let existing: SerializedCheckpoint[] = [];
    try {
      const raw = await fsp.readFile(filePath, 'utf8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        existing = parsed as SerializedCheckpoint[];
      }
    } catch {
      // File doesn't exist or is invalid — start fresh
    }

    existing.push(serialized);
    await fsp.writeFile(filePath, JSON.stringify(existing, null, 2), 'utf8');
  }

  private async deleteFromDisk(checkpointId: string): Promise<void> {
    let entries: string[];
    try {
      entries = await fsp.readdir(this.baseDir);
    } catch {
      return; // Directory doesn't exist — nothing to delete
    }

    for (const filename of entries) {
      if (!filename.endsWith('.json')) continue;

      const filePath = path.join(this.baseDir, filename);
      try {
        const raw = await fsp.readFile(filePath, 'utf8');
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) continue;
        const existing = parsed as SerializedCheckpoint[];
        const filtered = existing.filter((c) => c.id !== checkpointId);

        if (filtered.length !== existing.length) {
          if (filtered.length === 0) {
            await fsp.unlink(filePath);
          } else {
            await fsp.writeFile(filePath, JSON.stringify(filtered, null, 2), 'utf8');
          }
        }
      } catch {
        // Skip invalid files
      }
    }
  }

  private async loadFromDisk(): Promise<void> {
    let entries: string[];
    try {
      entries = await fsp.readdir(this.baseDir);
    } catch {
      // Directory doesn't exist yet — nothing to load
      return;
    }

    for (const filename of entries) {
      if (!filename.endsWith('.json')) continue;

      const filePath = path.join(this.baseDir, filename);
      try {
        const raw = await fsp.readFile(filePath, 'utf8');
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) continue;
        const checkpoints = parsed as SerializedCheckpoint[];

        for (const sc of checkpoints) {
          const checkpoint: Checkpoint = {
            id: sc.id,
            graphId: sc.graphId,
            phaseId: sc.phaseId,
            phaseStatus: sc.phaseStatus,
            taskStatuses: sc.taskStatuses,
            timestamp: sc.timestamp,
            label: sc.label,
          };
          this.checkpoints.set(checkpoint.id, checkpoint);
        }
      } catch {
        // Skip invalid files
      }
    }
  }

  private async pruneCheckpoints(): Promise<void> {
    const all = Array.from(this.checkpoints.values()).sort(
      (a, b) => a.timestamp - b.timestamp,
    );

    while (all.length > this.maxCheckpoints) {
      const oldest = all.shift();
      if (oldest) {
        this.checkpoints.delete(oldest.id);
        await this.deleteFromDisk(oldest.id);
      }
    }
  }
}
