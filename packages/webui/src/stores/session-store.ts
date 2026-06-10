import type { Usage } from '@wrongstack/core';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { SessionInfo } from './types.js';

// ============================================
// Session Store
// ============================================

interface SessionState {
  session: SessionInfo | null;
  totalTokens: Usage;
  /** Input tokens of the LAST provider response — used as the "live context
   *  size" indicator in the topbar (matches what TUI's ContextChip shows). */
  lastInputTokens: number;
  cost: number;
  startTime: number | null;
  /** Model max context window, from models.dev catalog. 0 = unknown. */
  maxContext: number;
  /** USD per 1M tokens — used to compute cost deltas on every provider.response. */
  inputCost: number;
  outputCost: number;
  cacheReadCost: number;
  /** basename(projectRoot) for the topbar. */
  projectName: string;
  /** Full project root path — used for richer tooltips / hover context. */
  projectRoot: string;
  /** Full working directory path — can differ from projectRoot. */
  cwd: string;
  /** Active mode id (default | code | …). */
  mode: string;
  /** All modes the backend knows about, populated by modes.list. The
   *  topbar mode chip uses this to render a picker; empty until the
   *  backend responds. */
  modes: Array<{ id: string; name: string; description: string }>;
  /** Active context-window policy id (balanced | frugal | deep | archival). */
  contextMode: string;
  /** Context-window policy presets from the backend. */
  contextModes: Array<{
    id: string;
    name: string;
    description: string;
    thresholds?: { warn: number | undefined; soft: number; hard: number };
    preserveK?: number | undefined;
    eliseThreshold?: number | undefined;
    custom?: boolean | undefined;
  }>;
  /** Iteration progress while the agent is running. Resets on run.result. */
  iteration: { index: number; max: number } | null;
  /** Live snapshot of context.todos — backend broadcasts on every
   *  tool.executed, and the sidebar/overlay reads from here. */
  todos: Array<{
    id: string;
    content: string;
    status: 'pending' | 'in_progress' | 'completed';
    activeForm?: string | undefined;
  }>;

  setSession: (session: SessionInfo | null) => void;
  updateUsage: (usage: Usage) => void;
  addCost: (cost: number) => void;
  startSession: (session: SessionInfo) => void;
  endSession: () => void;
  setEnv: (env: {
    maxContext?: number | undefined;
    projectRoot?: string | undefined;
    projectName?: string | undefined;
    cwd?: string | undefined;
    mode?: string | undefined;
    contextMode?: string | undefined;
    inputCost?: number | undefined;
    outputCost?: number | undefined;
    cacheReadCost?: number | undefined;
  }) => void;
  setIteration: (it: { index: number; max: number } | null) => void;
  setModes: (modes: Array<{ id: string; name: string; description: string }>) => void;
  setContextModes: (modes: SessionState['contextModes']) => void;
  setTodos: (todos: SessionState['todos']) => void;
}

export const useSessionStore = create<SessionState>()(
  persist(
    (set) => ({
      session: null,
      totalTokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      lastInputTokens: 0,
      cost: 0,
      startTime: null,
      maxContext: 0,
      inputCost: 0,
      outputCost: 0,
      cacheReadCost: 0,
      projectName: '',
      projectRoot: '',
      cwd: '',
      mode: 'default',
      modes: [],
      contextMode: 'balanced',
      contextModes: [],
      iteration: null,
      todos: [],

      setSession: (session) => set({ session }),

      updateUsage: (usage) =>
        set((state) => {
          const inputDelta = usage.input + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
          const cacheReadDelta = usage.cacheRead ?? 0;
          const cacheWriteDelta = usage.cacheWrite ?? 0;
          return {
            totalTokens: {
              input: state.totalTokens.input + usage.input,
              output: state.totalTokens.output + usage.output,
              cacheRead: (state.totalTokens.cacheRead ?? 0) + cacheReadDelta,
              cacheWrite: (state.totalTokens.cacheWrite ?? 0) + cacheWriteDelta,
            },
            lastInputTokens: inputDelta || state.lastInputTokens,
          };
        }),

      addCost: (cost) => set((state) => ({ cost: state.cost + cost })),

      startSession: (session) =>
        set({
          session,
          startTime: Date.now(),
          iteration: null,
          lastInputTokens: 0,
          totalTokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          cost: 0,
        }),

      endSession: () =>
        set({
          session: null,
          startTime: null,
          iteration: null,
        }),

      setEnv: (env) =>
        set((state) => ({
          maxContext: env.maxContext ?? state.maxContext,
          projectRoot: env.projectRoot ?? state.projectRoot,
          projectName: env.projectName ?? state.projectName,
          cwd: env.cwd ?? state.cwd,
          mode: env.mode ?? state.mode,
          contextMode: env.contextMode ?? state.contextMode,
          inputCost: env.inputCost ?? state.inputCost,
          outputCost: env.outputCost ?? state.outputCost,
          cacheReadCost: env.cacheReadCost ?? state.cacheReadCost,
        })),

      setIteration: (iteration) => set({ iteration }),
      setModes: (modes) => set({ modes }),
      setContextModes: (contextModes) => set({ contextModes }),
      setTodos: (todos) => set({ todos }),
    }),
    {
      name: 'wrongstack-session',
      partialize: () => ({}),
    },
  ),
);
