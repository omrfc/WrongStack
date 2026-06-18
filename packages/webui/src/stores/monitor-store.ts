import { create } from 'zustand';

// ============================================
// Monitor Store
// ============================================
// Tracks connected clients, mail queue activity, and agent counts
// for the real-time monitoring dashboard.

export interface ClientCounts {
  tui: number;
  webui: number;
  repl: number;
}

export interface MailActivity {
  timestamp: number;
  type: 'sent' | 'delivered' | 'read' | 'completed';
  from?: string;
  to?: string;
  subject?: string;
  /** Stable monotonic id assigned by `addMailActivity` — use as the React key
   *  so a prepend doesn't shift index-based keys and force a full remount. */
  seq?: number;
}

/** Real-time session stats from client.status_update events */
export interface CurrentSessionStats {
  clientType?: string;
  clientId?: string;
  agentCount?: number;
  model?: string;
  mode?: string;
  toolCalls?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheTokens?: number;
  costUsd?: number;
  timestamp?: number;
}

export interface MonitorState {
  /** Connected client counts by type */
  clientCounts: ClientCounts;
  /** Recent mail queue activity (last 50 events) */
  mailActivity: MailActivity[];
  /** Total messages in mailbox */
  totalMessages: number;
  /** Open (uncompleted) messages */
  openMessages: number;
  /** Messages waiting for reply (unread) */
  unreadMessages: number;
  /** Total registered agents */
  totalAgents: number;
  /** Currently active agents */
  activeAgents: number;
  /** Current session stats from client.status_update */
  currentSession: CurrentSessionStats;
  /** Last update timestamp */
  lastUpdated: number;

  setClientCounts: (counts: ClientCounts) => void;
  addMailActivity: (activity: MailActivity) => void;
  setMailStats: (total: number, open: number, unread: number) => void;
  setAgentStats: (total: number, active: number) => void;
  setCurrentSession: (stats: CurrentSessionStats) => void;
  clear: () => void;
}

// Monotonic id source for mail-activity React keys (stable across prepends).
let mailActivitySeq = 0;

export const useMonitorStore = create<MonitorState>()((set) => ({
  clientCounts: { tui: 0, webui: 0, repl: 0 },
  mailActivity: [],
  totalMessages: 0,
  openMessages: 0,
  unreadMessages: 0,
  totalAgents: 0,
  activeAgents: 0,
  currentSession: {},
  lastUpdated: Date.now(),

  setClientCounts: (counts) =>
    set({ clientCounts: counts, lastUpdated: Date.now() }),

  addMailActivity: (activity) =>
    set((state) => ({
      mailActivity: [{ ...activity, seq: activity.seq ?? ++mailActivitySeq }, ...state.mailActivity].slice(0, 50),
      lastUpdated: Date.now(),
    })),

  setMailStats: (total, open, unread) =>
    set({ totalMessages: total, openMessages: open, unreadMessages: unread, lastUpdated: Date.now() }),

  setAgentStats: (total, active) =>
    set({ totalAgents: total, activeAgents: active, lastUpdated: Date.now() }),

  setCurrentSession: (stats) =>
    set({ currentSession: { ...useMonitorStore.getState().currentSession, ...stats }, lastUpdated: Date.now() }),

  clear: () =>
    set({
      clientCounts: { tui: 0, webui: 0, repl: 0 },
      mailActivity: [],
      totalMessages: 0,
      openMessages: 0,
      unreadMessages: 0,
      totalAgents: 0,
      activeAgents: 0,
      currentSession: {},
      lastUpdated: Date.now(),
    }),
}));
