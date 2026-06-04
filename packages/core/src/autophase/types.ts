/**
 * AutoPhase — Otonom faz tabanlı iş akışı tipleri.
 *
 * Bir proje fazlara (phase) bölünür; her fazın alt görevleri (tasks) vardır.
 * Fazlar dependency-aware çalışır: bir fazın tüm görevleri tamamlanmadan
 * sonraki faz başlayamaz (opsiyonel olarak parallel fazlar da mümkün).
 */

import type { BrainArbiter } from '../coordination/brain.js';
import type { TaskGraph, TaskNode } from '../types/task-graph.js';

// ─── Phase Status ───────────────────────────────────────────────────────────

export type PhaseStatus =
  | 'pending' // Henüz başlamadı, önceki faz bekleniyor
  | 'ready' // Başlamaya hazır (önceki faz tamamlandı)
  | 'running' // Aktif çalışıyor
  | 'paused' // Kullanıcı duraklattı
  | 'completed' // Tüm görevleri bitti
  | 'failed' // En az bir görev başarısız ve retry hakkı bitti
  | 'skipped'; // Atlandı

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
  'phase.taskRetrying': {
    phaseId: string;
    taskId: string;
    taskTitle: string;
    attempt: number;
    maxRetries: number;
  };
  'phase.allTasksDone': { phaseId: string; completed: number; failed: number };
  'phase.verifying': { phaseId: string; name: string; attempt: number };
  'phase.verifyFailed': { phaseId: string; name: string; attempt: number; error?: string };
  'phase.repairing': { phaseId: string; name: string; attempt: number };
  'phase.conflictResolving': { phaseId: string; name: string; files: string[] };
  'phase.conflictResolved': { phaseId: string; name: string };
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
  /**
   * Opsiyonel doğrulama kapısı. Bir fazın tüm görevleri bittikten *sonra*,
   * faz "completed" işaretlenmeden ve worktree'si ana branch'e merge edilmeden
   * *önce* çağrılır. `env`, fazın worktree'sine (varsa) işaret eder; doğrulama
   * o izole dizinde koşmalıdır (örn. typecheck/test). `ok:false` dönerse merge
   * bloklanır ve (varsa) `repairPhase` ile onarım denenir.
   *
   * Tanımlanmazsa kapı atlanır (geriye dönük uyumlu — eski davranış).
   */
  verifyPhase?: (
    phase: PhaseNode,
    env?: { cwd?: string; branch?: string },
  ) => Promise<{ ok: boolean; output?: string }>;
  /**
   * Opsiyonel onarım geçişi. `verifyPhase` başarısız olduğunda, yakalanan hata
   * çıktısı ile çağrılır. Worktree'deki kodu düzeltmeye çalışmalıdır (örn. bir
   * onarım subagent'ı). Dönüş beklenmez; orchestrator ardından `verifyPhase`'i
   * yeniden koşar. `verifyPhase` tanımlı değilse hiç çağrılmaz.
   */
  repairPhase?: (
    phase: PhaseNode,
    failure: string,
    attempt: number,
    env?: { cwd?: string; branch?: string },
  ) => Promise<void>;
  /**
   * Opsiyonel birleştirme-çakışması çözücü. Bir fazın worktree'si ana branch'e
   * squash-merge edilirken çakışma çıkarsa çağrılır. `info.cwd` ana çalışma
   * ağacına (çakışma işaretçilerinin bulunduğu yer) işaret eder; çözücü oradaki
   * işaretçileri temizlemeli ve `true` döndürmelidir. Başarılı olursa merge
   * commit'lenir; aksi halde merge iptal edilir ve worktree `needs-review`'da
   * saklanır. Tanımlanmazsa çakışma eski davranışla parked-for-review olur.
   */
  resolveConflict?: (
    phase: PhaseNode,
    info: { conflictFiles: string[]; cwd: string },
  ) => Promise<boolean>;
  /** Opsiyonel global Brain arbiter: policy/karar/escalation katmanı. */
  brain?: BrainArbiter;
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
  /**
   * Doğrulama kapısı başarısız olduğunda yapılacak maksimum onarım denemesi.
   * Toplam doğrulama koşusu = maxVerifyAttempts + 1 (ilk koşu + her onarım
   * sonrası yeniden koşu). Varsayılan 2. `verifyPhase` verilmezse etkisizdir.
   */
  maxVerifyAttempts?: number;
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
