import { create } from 'zustand';
import type { WorktreeHandleView, WorktreeOrphanView } from '../types.js';

// ── Worktree store (live backend state; not persisted) ──────────────────────

interface WorktreeActivity {
  handleId: string;
  kind: string;
  text: string;
  at: number;
}

interface WorktreeCleanResult {
  ok: boolean;
  removed: number;
  reason?: string;
  at: number;
}

interface WorktreeState {
  worktrees: WorktreeHandleView[];
  baseBranch: string;
  activity: WorktreeActivity[];
  /** Disk-scanned orphans left by previous/crashed runs. */
  orphans: WorktreeOrphanView[];
  /** Whether cleaning is currently allowed (no live run). */
  canClean: boolean;
  /** Why cleaning is blocked, when canClean is false. */
  cleanBlockedReason?: string;
  /** Outcome of the last cleanup. */
  cleanResult: WorktreeCleanResult | null;
  setSnapshot: (worktrees: WorktreeHandleView[], baseBranch: string) => void;
  pushEvent: (e: WorktreeActivity) => void;
  setOrphans: (orphans: WorktreeOrphanView[], canClean: boolean, reason?: string) => void;
  setCleanResult: (r: WorktreeCleanResult | null) => void;
}

export const useWorktreeStore = create<WorktreeState>()((set) => ({
  worktrees: [],
  baseBranch: '',
  activity: [],
  orphans: [],
  canClean: false,
  cleanResult: null,
  setSnapshot: (worktrees, baseBranch) => set({ worktrees, baseBranch }),
  pushEvent: (e) => set((s) => ({ activity: [...s.activity, e].slice(-40) })),
  setOrphans: (orphans, canClean, cleanBlockedReason) =>
    set({ orphans, canClean, cleanBlockedReason }),
  setCleanResult: (cleanResult) => set({ cleanResult }),
}));
