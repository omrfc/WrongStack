import { create } from 'zustand';

export interface SideEffectEntry {
  toolUseId: string;
  toolName: string;
  ts: string;
  input: Record<string, unknown>;
  outcome?: string | undefined;
  risk: string;
}

interface SideEffectState {
  sideEffects: SideEffectEntry[];
  loading: boolean;
  setSideEffects: (effects: SideEffectEntry[]) => void;
  setLoading: (loading: boolean) => void;
  clear: () => void;
}

export const useSideEffectStore = create<SideEffectState>((set) => ({
  sideEffects: [],
  loading: false,
  setSideEffects: (effects) => set({ sideEffects: effects, loading: false }),
  setLoading: (loading) => set({ loading }),
  clear: () => set({ sideEffects: [], loading: false }),
}));
