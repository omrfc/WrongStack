import { create } from 'zustand';
import { getWSClient } from '@/lib/ws-client';
import { type GoalState, parseGoalState } from '@/lib/goal';

// ── Goal Store ─────────────────────────────────────────────────────────────

interface GoalStoreState {
  goal: GoalState | null;
  setGoal: (raw: Record<string, unknown> | null) => void;
  clear: () => void;
  /** Request the latest goal state from the server. Safe to call any time. */
  refresh: () => void;
}

export const useGoalStore = create<GoalStoreState>()((set) => ({
  goal: null,
  setGoal: (raw) => set({ goal: parseGoalState(raw) }),
  clear: () => set({ goal: null }),
  refresh: () => {
    try {
      getWSClient()?.send?.({ type: 'goal.get' });
    } catch {
      // WS not connected — harmless
    }
  },
}));
