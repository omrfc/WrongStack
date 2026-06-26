import { create } from 'zustand';
import type { PhaseItem } from '@/components/PhasePanel';

// ── AutoPhase Store ────────────────────────────────────────────────────────

export type AutoPhaseStatus = 'idle' | 'running' | 'paused' | 'completed' | 'failed' | 'stopped';

/** A persisted kanban board (one AutoPhase graph JSON per board on disk). */
export interface AutoPhaseBoardSummary {
  id: string;
  title: string;
  updatedAt: number;
  status: string;
}

interface AutoPhaseState {
  phases: PhaseItem[];
  activePhaseId: string | null;
  overallPercent: number;
  autonomous: boolean;
  title: string | null;
  /** Full operator prompt that started the run (title is only a short heading). */
  goal: string | null;
  status: AutoPhaseStatus;
  lastEvent: string | null;
  lastError: string | null;
  /** All persisted boards for this project (from autophase.list). */
  graphs: AutoPhaseBoardSummary[];
  progress: {
    totalPhases: number;
    completed: number;
    failed: number;
    totalTasks: number;
    completedTasks: number;
    failedTasks: number;
  } | null;

  setState: (s: {
    phases?: PhaseItem[] | undefined;
    activePhaseId?: string | null | undefined;
    overallPercent?: number | undefined;
    autonomous?: boolean | undefined;
    title?: string | null | undefined;
    goal?: string | null | undefined;
    status?: AutoPhaseStatus | undefined;
    lastEvent?: string | null | undefined;
    lastError?: string | null | undefined;
    graphs?: AutoPhaseBoardSummary[] | undefined;
    progress?: AutoPhaseState['progress'] | undefined;
  }) => void;
  clear: () => void;
}

export const useAutoPhaseStore = create<AutoPhaseState>()((set) => ({
  phases: [],
  activePhaseId: null,
  overallPercent: 0,
  autonomous: false,
  title: null,
  goal: null,
  status: 'idle',
  lastEvent: null,
  lastError: null,
  graphs: [],
  progress: null,

  setState: (patch) =>
    set((prev) => ({
      phases: patch.phases ?? prev.phases,
      activePhaseId: patch.activePhaseId !== undefined ? patch.activePhaseId : prev.activePhaseId,
      overallPercent: patch.overallPercent ?? prev.overallPercent,
      autonomous: patch.autonomous ?? prev.autonomous,
      title: patch.title !== undefined ? patch.title : prev.title,
      goal: patch.goal !== undefined ? patch.goal : prev.goal,
      status: patch.status ?? prev.status,
      lastEvent: patch.lastEvent !== undefined ? patch.lastEvent : prev.lastEvent,
      lastError: patch.lastError !== undefined ? patch.lastError : prev.lastError,
      graphs: patch.graphs ?? prev.graphs,
      progress: patch.progress !== undefined ? patch.progress : prev.progress,
    })),
  clear: () =>
    set({
      phases: [],
      activePhaseId: null,
      overallPercent: 0,
      autonomous: false,
      title: null,
      goal: null,
      status: 'idle',
      lastEvent: null,
      lastError: null,
      graphs: [],
      progress: null,
    }),
}));
