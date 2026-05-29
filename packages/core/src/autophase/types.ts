/**
 * AutoPhase — Otonom faz tabanlı iş akışı tipleri.
 *
 * Bir proje fazlara (phase) bölünür; her fazın alt görevleri (tasks) vardır.
 * Fazlar dependency-aware çalışır: bir fazın tüm görevleri tamamlanmadan
 * sonraki faz başlayamaz (opsiyonel olarak parallel fazlar da mümkün).
 */

import type { TaskGraph, TaskNode, TaskStatus } from '../types/task-graph.js';

// ─── Phase Status ───────────────────────────────────────────────────────────

export type PhaseStatus =
  | 'pending'      // Henüz başlamadı, önceki faz bekleniyor
  | 'ready'        // Başlamaya hazır (önceki faz tamamlandı)
  | 'running'      // Aktif çalışıyor
  | 'paused'       // Kullanıcı duraklattı
  | 'completed'    // Tüm görevleri bitti
  | 'failed'       // En az bir görev başarısız ve retry hakkı bitti
  | 'skipped';     // Atlandı

// ─── Phase Node ─────────────────────────────────────────────────────────────

export interface PhaseNode {
  id: string;
  /** Faz adı, örn: "Discovery", "Design", "Implementation", "Testing" */
  name: string;
  description: string;
  status: PhaseStatus;
  /** Bu fazın görev grafiği */
  taskGraph: TaskGraph;
  /** Önceki faz ID'leri — bunlar tamamlanmadan bu faz başlayamaz */
  dependsOn: string[];
  /** Sonraki faz ID'leri */
  nextPhases: string[];
  /** Bu faz parallel çalışabilir mi? (önceki faz bitmeden başlayabilir) */
  parallelizable: boolean;
  /** Faz önceliği */
  priority: 'critical' | 'high' | 'medium' | 'low';
  /** Tahmini süre (saat) */
  estimateHours: number;
  /** Gerçekleşen süre (ms) */
  actualDurationMs?: number;
  /** Başlangıç zamanı */
  startedAt?: number;
  /** Bitiş zamanı */
  completedAt?: number;
  /** Bu fazda atanmış agent'lar */
  assignedAgents: string[];
  /** Faz metadata */
  metadata?: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

// ─── Phase Graph ────────────────────────────────────────────────────────────

export interface PhaseGraph {
  id: string;
  /** Proje başlığı */
  title: string;
  description: string;
  phases: Map<string, PhaseNode>;
  /** Başlangıç faz ID'leri */
  rootPhaseIds: string[];
  /** Aktif faz ID'leri (running durumunda olanlar) */
  activePhaseIds: string[];
  /** Tamamlanan faz ID'leri */
  completedPhaseIds: string[];
  /** Başarısız faz ID'leri */
  failedPhaseIds: string[];
  /** Otonom mod aktif mi? */
  autonomous: boolean;
  /** Tüm fazlar tamamlandığında dur */
  stopOnComplete: boolean;
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  completedAt?: number;
}

// ─── Phase Progress ─────────────────────────────────────────────────────────

export interface PhaseProgress {
  totalPhases: number;
  pending: number;
  ready: number;
  running: number;
  paused: number;
  completed: number;
  failed: number;
  skipped: number;
  percentComplete: number;
  totalTasks: number;
  completedTasks: number;
  failedTasks: number;
  estimatedHours: number;
  actualHours: number;
}

// ─── Phase Event Map ────────────────────────────────────────────────────────

export interface PhaseEventMap {
  'phase.statusChange': { phaseId: string; from: PhaseStatus; to: PhaseStatus };
  'phase.started': { phaseId: string; name: string };
  'phase.completed': { phaseId: string; name: string; durationMs: number };
  'phase.failed': { phaseId: string; name: string; error?: string };
  'phase.taskCompleted': { phaseId: string; taskId: string; taskTitle: string };
  'phase.taskFailed': { phaseId: string; taskId: string; taskTitle: string; error: string };
  'phase.taskRetrying': { phaseId: string; taskId: string; taskTitle: string; attempt: number; maxRetries: number };
  'phase.allTasksDone': { phaseId: string; completed: number; failed: number };
  'graph.completed': { graphId: string; durationMs: number };
  'graph.failed': { graphId: string; failedPhaseId: string; error: string };
  'autonomous.tick': { activePhases: string[]; queuedPhases: string[] };
  'agent.assigned': { phaseId: string; agentId: string };
  'agent.released': { phaseId: string; agentId: string };
}

export type PhaseEventName = keyof PhaseEventMap;

// ─── Phase Execution Context ────────────────────────────────────────────────

export interface PhaseExecutionContext {
  /**
   * Bir görevi çalıştır — AI agent tarafından yapılır. `env`, fazın git
   * worktree'sine (varsa) işaret eder; agent'ı izole çalışma dizininde koştur.
   */
  executeTask: (
    task: TaskNode,
    phaseId: string,
    env?: { cwd?: string; branch?: string },
  ) => Promise<unknown>;
  /** Bir faz tamamlandığında çağrılır */
  onPhaseComplete?: (phase: PhaseNode) => void;
  /** Bir faz başarısız olduğunda çağrılır */
  onPhaseFail?: (phase: PhaseNode, error: Error) => void;
  /** Her tick'te çağrılır (otonom modda) */
  onTick?: (ctx: { activePhases: PhaseNode[]; readyPhases: PhaseNode[] }) => void;
}

// ─── AutoPhase Options ──────────────────────────────────────────────────────

export interface AutoPhaseOptions {
  /** Maksimum parallel faz sayısı */
  maxConcurrentPhases?: number;
  /** Maksimum parallel görev sayısı (faz içinde) */
  maxConcurrentTasks?: number;
  /** Başarısız görev retry sayısı */
  maxRetries?: number;
  /** Otonom mod: faz tamamlandıkça otomatik sonrakine geç */
  autonomous?: boolean;
  /** Fazlar arası bekleme süresi (ms) */
  phaseDelayMs?: number;
  /** Bir faz failed olursa dur */
  stopOnFailure?: boolean;
  /** Event bus */
  events?: import('../kernel/events.js').EventBus;
  /**
   * Opsiyonel git-worktree yöneticisi. Verilirse her faz kendi
   * worktree+branch'inde izole çalışır ve tamamlanınca ana branch'e sıralı
   * squash-merge edilir. Yoksa davranış değişmez (paylaşılan working tree).
   */
  worktrees?: import('../worktree/worktree-manager.js').WorktreeManager;
}

// ─── Phase Filter / Sort ────────────────────────────────────────────────────

export interface PhaseFilter {
  status?: PhaseStatus[];
  priority?: PhaseNode['priority'][];
}

export interface PhaseSort {
  field: 'priority' | 'createdAt' | 'startedAt' | 'completedAt';
  direction: 'asc' | 'desc';
}

// ─── Phase Template ─────────────────────────────────────────────────────────

export interface PhaseTemplate {
  name: string;
  description: string;
  priority: PhaseNode['priority'];
  estimateHours: number;
  parallelizable: boolean;
  /** Otomatik oluşturulacak task şablonları */
  taskTemplates?: Array<{
    title: string;
    description: string;
    type: import('../types/task-graph.js').TaskType;
    priority: import('../types/task-graph.js').TaskPriority;
    estimateHours: number;
    tags?: string[];
  }>;
}
