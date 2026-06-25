import { create } from 'zustand';
import type { BoardTaskItem } from './specs-store';

export type SddBoardStatus = 'idle' | 'running' | 'paused' | 'completed' | 'failed' | 'deadlocked';

export interface SddBoardColumn {
  label: string;
  taskIds: string[];
}

export interface SddBoardFeedEntry {
  ts: number;
  kind:
    | 'started'
    | 'completed'
    | 'failed'
    | 'retrying'
    | 'wave'
    | 'deadlock'
    | 'verification_failed'
    | 'conflict'
    | 'split'
    | 'supervisor';
  taskShortId?: string;
  agentName?: string;
  text: string;
}

export interface SddBoardSnapshotUI {
  runId: string;
  specId?: string;
  graphId: string;
  title: string;
  status: SddBoardStatus;
  startedAt: number;
  updatedAt: number;
  progress: {
    total: number;
    completed: number;
    failed: number;
    inProgress: number;
    pending: number;
    blocked: number;
    review: number;
    percentComplete: number;
  };
  wave: number;
  tasks: BoardTaskItem[];
  columns: SddBoardColumn[];
  diagnostics?: { deadlockChains?: Array<{ blocked: string; blockedBy: string[] }> };
  feed?: SddBoardFeedEntry[];
  /** Run-level default worker model / provider / fallback chain (header display). */
  defaultModel?: string;
  defaultProvider?: string;
  fallbackModels?: string[];
}

export interface SddBoardSummary {
  runId: string;
  specId?: string;
  title: string;
  status: string;
  total: number;
  completed: number;
  updatedAt: number;
}

interface SddBoardState {
  snapshot: SddBoardSnapshotUI | null;
  boards: SddBoardSummary[];
  setSnapshot: (s: SddBoardSnapshotUI | null) => void;
  setBoards: (b: SddBoardSummary[]) => void;
}

export const useSddBoardStore = create<SddBoardState>()((set) => ({
  snapshot: null,
  boards: [],
  setSnapshot: (snapshot) => set({ snapshot }),
  setBoards: (boards) => set({ boards }),
}));
