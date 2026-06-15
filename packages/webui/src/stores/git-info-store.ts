import { create } from 'zustand';

export interface GitInfo {
  branch: string;
  added: number;
  deleted: number;
  untracked: number;
  behind: number;
  ahead: number;
  /** ISO timestamp of last fetch */
  fetchedAt: number;
}

interface GitInfoState {
  info: GitInfo | null;
  setInfo: (info: GitInfo) => void;
  clear: () => void;
}

export const useGitInfoStore = create<GitInfoState>()((set) => ({
  info: null,
  setInfo: (info) => set({ info }),
  clear: () => set({ info: null }),
}));
