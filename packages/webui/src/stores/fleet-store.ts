import { create } from 'zustand';
import type { SubagentView, SubagentEvent } from './types.js';

// ── Fleet store (live subagent roster; not persisted) ───────────────────────

interface FleetState {
  agents: Map<string, SubagentView>;
  applyEvent: (e: SubagentEvent) => void;
  clear: () => void;
  /** Return all agents belonging to a session. Used for project-scoped filtering. */
  getAgentsBySession: (sessionId: string) => SubagentView[];
}

function blankAgent(id: string, name?: string, sessionId?: string): SubagentView {
  return {
    id,
    name: name?.trim() || id,
    sessionId,
    status: 'running',
    iteration: 0,
    toolCalls: 0,
    costUsd: 0,
    ctxPct: 0,
    ctxTokens: 0,
    maxContext: 0,
    extensions: 0,
    startedAt: Date.now(),
    toolLog: [],
  };
}

export const useFleetStore = create<FleetState>()((set, get) => ({
  agents: new Map(),
  clear: () => set({ agents: new Map() }),
  getAgentsBySession: (sessionId) => {
    const result: SubagentView[] = [];
    for (const a of get().agents.values()) {
      if (a.sessionId === sessionId) result.push(a);
    }
    return result;
  },
  applyEvent: (e) =>
    set((state) => {
      const agents = new Map(state.agents);

      // session_stopped carries a sessionId instead of subagentId —
      // remove ALL agents belonging to that session.
      if (e.kind === 'session_stopped' && e.sessionId) {
        for (const [id, agent] of agents) {
          if (agent.sessionId === e.sessionId) agents.delete(id);
        }
        return { agents };
      }

      const prev = agents.get(e.subagentId) ?? blankAgent(e.subagentId, e.name, e.sessionId);
      const next: SubagentView = { ...prev };
      switch (e.kind) {
        case 'spawned':
          next.name = e.name?.trim() || next.name;
          next.provider = e.provider ?? next.provider;
          next.model = e.model ?? next.model;
          next.description = e.description ?? next.description;
          next.taskId = e.taskId ?? next.taskId;
          next.sessionId = e.sessionId ?? next.sessionId;
          next.status = 'running';
          break;
        case 'task_started':
          next.description = e.description ?? next.description;
          next.taskId = e.taskId ?? next.taskId;
          next.status = 'running';
          break;
        case 'tool_executed':
          next.lastTool = e.toolName ?? next.lastTool;
          next.toolCalls = next.toolCalls + 1;
          // Prepend to tool log, cap at 50
          next.toolLog = [
            { name: e.toolName ?? 'unknown', ok: typeof e.ok === 'boolean' ? e.ok : true, durationMs: typeof e.durationMs === 'number' ? e.durationMs : 0, at: Date.now() },
            ...next.toolLog,
          ].slice(0, 50);
          break;
        case 'iteration_summary':
          next.iteration = e.iteration ?? next.iteration;
          if (typeof e.toolCalls === 'number') next.toolCalls = e.toolCalls;
          if (typeof e.costUsd === 'number') next.costUsd = e.costUsd;
          next.currentTool = e.currentTool ?? next.currentTool;
          if (typeof e.partialText === 'string' && e.partialText) {
            next.partialText = e.partialText;
          }
          break;
        case 'budget_extended':
          next.extensions = e.totalExtensions ?? next.extensions + 1;
          break;
        case 'ctx_pct':
          next.ctxPct = Math.round(Math.min(1, Math.max(0, e.load ?? 0)) * 100);
          next.ctxTokens = e.tokens ?? next.ctxTokens;
          next.maxContext = e.maxContext ?? next.maxContext;
          if (typeof e.costUsd === 'number') next.costUsd = e.costUsd;
          break;
        case 'task_completed':
          next.status = e.status === 'success' ? 'completed' : (e.status ?? 'completed');
          if (typeof e.iterations === 'number') next.iteration = e.iterations;
          if (typeof e.toolCalls === 'number') next.toolCalls = e.toolCalls;
          next.error = e.error;
          next.currentTool = undefined;
          next.completedAt = Date.now();
          if (typeof e.finalText === 'string' && e.finalText) {
            next.finalText = e.finalText;
          }
          break;
      }
      agents.set(e.subagentId, next);
      return { agents };
    }),
}));
