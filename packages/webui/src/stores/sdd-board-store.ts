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
  /** Base branch the run's squash commits land on (for the Rollback control). */
  baseBranch?: string;
  /** Squash commits the run landed on the base branch (drives Rollback availability). */
  mergedCommits?: Array<{ taskId: string; sha: string; title: string }>;
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

/** Outcome of a cleanup/rollback/destroy, surfaced as a result banner. */
export interface SddLifecycleResultUI {
  op: 'cleanup_worktrees' | 'rollback' | 'destroy';
  ok: boolean;
  removed?: number;
  reverted?: number;
  deleted?: string[];
  reason?: string;
  /** Client-stamped arrival time (server payload carries no clock). */
  at: number;
}

interface SddBoardState {
  snapshot: SddBoardSnapshotUI | null;
  boards: SddBoardSummary[];
  lifecycleResult: SddLifecycleResultUI | null;
  /** True from the moment Destroy is confirmed until the result lands. */
  destroying: boolean;
  setSnapshot: (s: SddBoardSnapshotUI | null) => void;
  setBoards: (b: SddBoardSummary[]) => void;
  setLifecycleResult: (r: SddLifecycleResultUI | null) => void;
  setDestroying: (v: boolean) => void;
}

export const useSddBoardStore = create<SddBoardState>()((set) => ({
  snapshot: null,
  boards: [],
  lifecycleResult: null,
  destroying: false,
  setSnapshot: (snapshot) => set({ snapshot }),
  setBoards: (boards) => set({ boards }),
  setLifecycleResult: (lifecycleResult) => set({ lifecycleResult }),
  setDestroying: (destroying) => set({ destroying }),
}));
