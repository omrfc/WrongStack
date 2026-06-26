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

/** One agent inside a live cross-process session (from sessions.status_update). */
export interface LiveAgent {
  id: string;
  name: string;
  status: string;
  currentTool?: string;
  iterations?: number;
  toolCalls?: number;
  costUsd?: number;
  tokensIn?: number;
  tokensOut?: number;
  ctxPct?: number;
  model?: string;
  partialText?: string;
  lastActivityAt?: string;
}

/** Project-wide totals summed across every live session's agents. */
export interface FleetAggregate {
  toolCalls: number;
  costUsd: number;
  tokensIn: number;
  tokensOut: number;
}

/** One live session across any surface, as broadcast by the server's
 *  SessionRegistry poll (`sessions.status_update`). This is the cross-process
 *  source of truth the Fleet HQ office map renders from. */
export interface LiveSession {
  sessionId: string;
  pid?: number;
  /** Surface that owns the session: 'tui' | 'webui' | 'cli'. */
  clientType?: string;
  projectName?: string;
  projectSlug?: string;
  gitBranch?: string;
  status?: string;
  /** UTC ISO when the session was registered — used for uptime. */
  startedAt?: string;
  /** Absolute working directory of the session. */
  workingDir?: string;
  agentCount?: number;
  agents: LiveAgent[];
}

/** Map a registry surface to one of the office-map client buckets. CLI/REPL
 *  sessions land in the `repl` bucket; anything unknown defaults to `webui`. */
export function clientBucket(clientType: string | undefined): keyof ClientCounts {
  switch (clientType) {
    case 'tui':
      return 'tui';
    case 'cli':
    case 'repl':
      return 'repl';
    case 'webui':
      return 'webui';
    default:
      return 'webui';
  }
}

/** Derive client counts, agent totals, and project-wide cost/token/tool
 *  aggregates from a live-session snapshot. */
export function deriveMonitorStats(sessions: LiveSession[]): {
  clientCounts: ClientCounts;
  totalAgents: number;
  activeAgents: number;
  aggregate: FleetAggregate;
} {
  const clientCounts: ClientCounts = { tui: 0, webui: 0, repl: 0 };
  let totalAgents = 0;
  let activeAgents = 0;
  const aggregate: FleetAggregate = { toolCalls: 0, costUsd: 0, tokensIn: 0, tokensOut: 0 };
  for (const s of sessions) {
    clientCounts[clientBucket(s.clientType)] += 1;
    for (const a of s.agents) {
      totalAgents += 1;
      if (a.status === 'running' || a.status === 'streaming') activeAgents += 1;
      aggregate.toolCalls += a.toolCalls ?? 0;
      aggregate.costUsd += a.costUsd ?? 0;
      aggregate.tokensIn += a.tokensIn ?? 0;
      aggregate.tokensOut += a.tokensOut ?? 0;
    }
  }
  return { clientCounts, totalAgents, activeAgents, aggregate };
}

function clampCtxPct(pct: number | undefined): number | undefined {
  if (pct === undefined) return undefined;
  if (!Number.isFinite(pct)) return 0;
  return Math.max(0, Math.min(100, Math.round(pct)));
}

function normalizeLiveSessions(sessions: LiveSession[]): LiveSession[] {
  return sessions.map((session) => ({
    ...session,
    agents: session.agents.map((agent) => ({
      ...agent,
      ctxPct: clampCtxPct(agent.ctxPct),
    })),
  }));
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
  /** Live cross-process sessions (the Fleet HQ map's structural source). */
  liveSessions: LiveSession[];
  /** Project-wide tool/cost/token totals across all live agents. */
  aggregate: FleetAggregate;
  /** Last update timestamp */
  lastUpdated: number;

  setClientCounts: (counts: ClientCounts) => void;
  /** Replace the live-session snapshot and re-derive client/agent counts. */
  setLiveSessions: (sessions: LiveSession[]) => void;
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
  liveSessions: [],
  aggregate: { toolCalls: 0, costUsd: 0, tokensIn: 0, tokensOut: 0 },
  lastUpdated: Date.now(),

  setClientCounts: (counts) =>
    set({ clientCounts: counts, lastUpdated: Date.now() }),

  setLiveSessions: (sessions) => {
    const normalized = normalizeLiveSessions(sessions);
    set({
      liveSessions: normalized,
      ...deriveMonitorStats(normalized),
      lastUpdated: Date.now(),
    });
  },

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
      liveSessions: [],
      aggregate: { toolCalls: 0, costUsd: 0, tokensIn: 0, tokensOut: 0 },
      lastUpdated: Date.now(),
    }),
}));
