/**
 * VizStore — Real-time cinematic event stream for the AgentFlow visualization.
 *
 * Holds a ring buffer of structured events from the entire agent ecosystem:
 * provider calls, agent spawns, tool executions, mailbox messages, etc.
 * Every event is typed with a `vizKind` for the renderer to pattern-match on.
 */

import { create } from 'zustand';

// ── Event types ───────────────────────────────────────────────────────

/** Categories the cinematic renderer understands. */
export type VizEventKind =
  | 'provider:call'        // LLM provider call started
  | 'provider:delta'       // Streaming text delta
  | 'provider:response'    // Provider response received
  | 'agent:spawned'        // Agent (leader or subagent) spawned
  | 'agent:tool'           // Agent executed a tool
  | 'agent:status'         // Agent status change (running → completed/failed)
  | 'agent:ctx'            // Agent context pressure update
  | 'agent:text'           // Agent streaming/partial text
  | 'tool:started'         // Tool execution started
  | 'tool:executed'        // Tool execution completed
  | 'tool:progress'        // Tool progress update
  | 'mailbox:send'         // Mailbox message sent
  | 'mailbox:deliver'      // Mailbox message delivered/read
  | 'session:start'        // Session started/resumed
  | 'session:end'          // Session ended
  | 'iteration:start'      // Iteration started
  | 'iteration:end'        // Iteration completed
  | 'error'                // Error occurred
  | 'context:compacted'    // Context compaction
  | 'context:repaired'     // Context repair
  | 'budget:extended'      // Agent budget extended
  | 'cost:update'          // Cost/token update
  | 'fleet:snapshot'       // Cross-process fleet snapshot (sessions + agents)
  ;

export interface VizEvent {
  id: string;
  kind: VizEventKind;
  timestamp: number;
  /** Source node id (e.g. provider id, agent id, tool name) */
  source: string;
  /** Target node id (optional — e.g. provider for tool calls) */
  target?: string | undefined;
  /** Display label */
  label: string;
  /** Numeric magnitude (tokens, cost, duration) for size/color mapping */
  magnitude?: number | undefined;
  /** Extra structured payload for the renderer */
  data?: Record<string, unknown> | undefined;
  /** The raw WS payload for drill-down in detail panels */
  raw?: unknown;
  /** Grouping key for the flow (e.g. 'iteration:3', 'agent:leader') */
  flowGroup?: string | undefined;
  /** Color hint for the renderer */
  color?: string | undefined;
}

/** Active connection between two nodes in the flow graph. */
export interface VizEdge {
  id: string;
  source: string;
  target: string;
  kind: VizEventKind;
  label: string;
  /** Flow intensity 0–1 for animation speed/opacity */
  intensity: number;
  /** Color for the edge */
  color: string;
  /** When this edge was last active */
  lastActiveAt: number;
  /** Cumulative magnitude (tokens, calls, etc.) */
  totalMagnitude: number;
}

/** Node in the flow graph — represents a live entity. */
export interface VizNode {
  id: string;
  kind: 'provider' | 'agent' | 'tool' | 'mailbox' | 'session' | 'system' | 'error' | 'coordinator';
  label: string;
  sublabel?: string | undefined;
  status: 'idle' | 'active' | 'streaming' | 'completed' | 'error';
  /** 0–1 activity level for glow/pulse */
  activity: number;
  /** Color theme */
  color: string;
  /** Provider/model info */
  provider?: string | undefined;
  model?: string | undefined;
  /** For agents: stats */
  iterations?: number | undefined;
  toolCalls?: number | undefined;
  costUsd?: number | undefined;
  ctxPct?: number | undefined;
  ctxTokens?: number | undefined;
  maxContext?: number | undefined;
  /** For agents: current tool name */
  currentTool?: string | undefined;
  /** For agents: session id */
  sessionId?: string | undefined;
  /** Magnitude for sizing */
  magnitude?: number | undefined;
  /** When this node was last updated */
  lastSeenAt: number;
  /** Position hints for the layout engine */
  positionHint?: { zone: 'left' | 'center' | 'right' | 'top' | 'bottom'; order: number } | undefined;
}

// ── Store state ───────────────────────────────────────────────────────

interface VizState {
  /** Ring buffer of recent events — newest first. */
  events: VizEvent[];
  /** Live nodes in the flow graph. */
  nodes: Map<string, VizNode>;
  /** Active edges between nodes. */
  edges: Map<string, VizEdge>;
  /** Whether the visualization is actively running. */
  isActive: boolean;
  /** Max events to keep in the ring buffer. */
  maxEvents: number;
  /** Counters for the HUD */
  counters: {
    totalTokens: number;
    totalCost: number;
    totalToolCalls: number;
    activeAgents: number;
    completedTasks: number;
    errors: number;
    mailboxMessages: number;
  };

  // Actions
  pushEvent: (event: VizEvent) => void;
  upsertNode: (node: Partial<VizNode> & { id: string; kind: VizNode['kind']; label: string }) => void;
  removeNode: (id: string) => void;
  upsertEdge: (edge: Partial<VizEdge> & { id: string; source: string; target: string; kind: VizEdge['kind']; label: string }) => void;
  removeEdge: (id: string) => void;
  clear: () => void;
  setActive: (active: boolean) => void;
  decayActivity: () => void;
  prunesStale: (olderThan: number) => void;
}

// ── Kind/status inference helpers ─────────────────────────────────────

/** Map an event's source/kind to a VizNode kind. */
function inferKind(event: VizEvent, isTarget = false): VizNode['kind'] {
  if (isTarget && event.target) {
    // Tools appear as targets of agent:tool
    if (event.kind === 'agent:tool') return 'tool';
    if (event.kind === 'tool:executed' || event.kind === 'tool:started') return 'tool';
    // The leader is the coordinator
    if (event.source === 'leader' || event.source === 'coordinator') return 'coordinator';
    if (event.kind.startsWith('provider:')) return 'provider';
    if (event.kind.startsWith('mailbox:')) return 'mailbox';
  }
  switch (event.kind) {
    case 'provider:call':
    case 'provider:delta':
    case 'provider:response':
      return 'provider';
    case 'agent:spawned':
    case 'agent:tool':
    case 'agent:status':
    case 'agent:text':
    case 'agent:ctx':
    case 'budget:extended':
      return 'agent';
    case 'tool:started':
    case 'tool:executed':
    case 'tool:progress':
      return 'tool';
    case 'mailbox:send':
    case 'mailbox:deliver':
      return 'mailbox';
    case 'session:start':
    case 'session:end':
    case 'iteration:start':
    case 'iteration:end':
    case 'fleet:snapshot':
      return 'session';
    case 'context:compacted':
    case 'context:repaired':
    case 'cost:update':
      return 'system';
    case 'error':
      return 'error';
    default:
      return 'system';
  }
}

/** Map an event kind to a node status. */
function inferStatus(kind: VizEventKind): VizNode['status'] {
  switch (kind) {
    case 'provider:call':
    case 'provider:delta':
    case 'agent:tool':
    case 'tool:started':
    case 'tool:progress':
    case 'iteration:start':
    case 'agent:text':
      return 'streaming';
    case 'agent:status':
    case 'iteration:end':
      return 'completed';
    case 'error':
      return 'error';
    case 'tool:executed':
      return 'completed';
    case 'session:end':
      return 'idle';
    default:
      return 'active';
  }
}

// ── Helpers ───────────────────────────────────────────────────────────

let _eventSeq = 0;
function nextId(): string {
  return `viz_${Date.now()}_${++_eventSeq}`;
}

const NODE_COLORS: Record<string, string> = {
  provider: 'hsl(180, 80%, 55%)',    // cyan
  agent: 'hsl(280, 80%, 65%)',       // purple
  tool: 'hsl(40, 90%, 55%)',         // amber
  mailbox: 'hsl(140, 70%, 55%)',     // green
  session: 'hsl(220, 80%, 60%)',     // blue
  system: 'hsl(0, 0%, 60%)',         // gray
  error: 'hsl(0, 80%, 55%)',         // red
};

const EDGE_COLORS: Record<string, string> = {
  'provider:call': 'hsl(180, 80%, 55%)',
  'provider:delta': 'hsl(180, 60%, 70%)',
  'agent:tool': 'hsl(40, 90%, 55%)',
  'mailbox:send': 'hsl(140, 70%, 55%)',
  'default': 'hsl(0, 0%, 40%)',
};

// ── Store ─────────────────────────────────────────────────────────────

export const useVizStore = create<VizState>()((set, get) => ({
  events: [],
  nodes: new Map(),
  edges: new Map(),
  isActive: false,
  maxEvents: 2000,
  counters: {
    totalTokens: 0,
    totalCost: 0,
    totalToolCalls: 0,
    activeAgents: 0,
    completedTasks: 0,
    errors: 0,
    mailboxMessages: 0,
  },

  pushEvent: (event) => set((state) => {
    const events = [{ ...event, id: event.id ?? nextId(), timestamp: event.timestamp || Date.now() }, ...state.events];
    if (events.length > state.maxEvents) events.length = state.maxEvents;

    // ── Apply event to nodes/edges maps ───────────────────────────
    const nodes = new Map(state.nodes);
    const edges = new Map(state.edges);
    const now = Date.now();

    // Upsert source node
    const sourceNode: VizNode = {
      id: event.source,
      kind: inferKind(event),
      label: event.label,
      status: inferStatus(event.kind),
      activity: 1.0,
      color: event.color ?? NODE_COLORS[inferKind(event)],
      lastSeenAt: now,
    };
    const existingSource = nodes.get(event.source);
    nodes.set(event.source, { ...existingSource, ...sourceNode });

    // Upsert target node if present
    if (event.target) {
      const targetNode: VizNode = {
        id: event.target,
        kind: inferKind(event, true),
        label: event.target,
        status: inferStatus(event.kind),
        activity: 0.8,
        color: event.color ?? NODE_COLORS[inferKind(event, true)],
        lastSeenAt: now,
      };
      const existingTarget = nodes.get(event.target);
      nodes.set(event.target, { ...existingTarget, ...targetNode });

      // Upsert edge
      const edgeId = `${event.source}->${event.target}`;
      const existingEdge = edges.get(edgeId);
      edges.set(edgeId, {
        id: edgeId,
        source: event.source,
        target: event.target,
        kind: event.kind as VizEdge['kind'],
        label: event.label,
        intensity: existingEdge ? Math.min(1, existingEdge.intensity + 0.3) : 0.7,
        color: event.color ?? NODE_COLORS[inferKind(event)] ?? '#6366f1',
        lastActiveAt: now,
        totalMagnitude: (existingEdge?.totalMagnitude ?? 0) + (event.magnitude ?? 0),
      });
    }

    return { events, nodes, edges };
  }),

  upsertNode: (partial) => set((state) => {
    const nodes = new Map(state.nodes);
    const existing = nodes.get(partial.id);
    nodes.set(partial.id, {
      ...existing,
      ...partial,
      lastSeenAt: partial.lastSeenAt !== undefined ? partial.lastSeenAt : Date.now(),
    } as VizNode);
    return { nodes };
  }),

  removeNode: (id) => set((state) => {
    const nodes = new Map(state.nodes);
    nodes.delete(id);
    const edges = new Map(state.edges);
    for (const [eid, edge] of edges) {
      if (edge.source === id || edge.target === id) edges.delete(eid);
    }
    return { nodes, edges };
  }),

  upsertEdge: (partial) => set((state) => {
    const edges = new Map(state.edges);
    const existing = edges.get(partial.id);
    edges.set(partial.id, {
      ...existing,
      ...partial,
      lastActiveAt: partial.lastActiveAt !== undefined ? partial.lastActiveAt : Date.now(),
      intensity: partial.intensity ?? existing?.intensity ?? 0.5,
      color: partial.color ?? EDGE_COLORS[partial.kind] ?? EDGE_COLORS.default,
      totalMagnitude: (existing?.totalMagnitude ?? 0) + (partial.totalMagnitude ?? 0),
    } as VizEdge & { totalMagnitude: number });
    return { edges };
  }),

  removeEdge: (id) => set((state) => {
    const edges = new Map(state.edges);
    edges.delete(id);
    return { edges };
  }),

  clear: () => set({
    events: [],
    nodes: new Map(),
    edges: new Map(),
    counters: {
      totalTokens: 0, totalCost: 0, totalToolCalls: 0,
      activeAgents: 0, completedTasks: 0, errors: 0, mailboxMessages: 0,
    },
  }),

  setActive: (active) => set({ isActive: active }),

  decayActivity: () => set((state) => {
    const nodes = new Map(state.nodes);
    for (const [id, node] of nodes) {
      if (node.activity >= 0.01) {
        const decayed = node.activity * 0.92;
        nodes.set(id, { ...node, activity: decayed < 0.01 ? 0 : decayed });
      }
    }
    const edges = new Map(state.edges);
    for (const [id, edge] of edges) {
      if (edge.intensity >= 0.01) {
        const decayed = edge.intensity * 0.90;
        edges.set(id, { ...edge, intensity: decayed < 0.01 ? 0 : decayed });
      }
    }
    return { nodes, edges };
  }),

  prunesStale: (olderThan) => set((state) => {
    const cutoff = Date.now() - olderThan;
    const nodes = new Map(state.nodes);
    for (const [id, node] of nodes) {
      if (node.lastSeenAt < cutoff && node.status !== undefined && node.status !== 'active') nodes.delete(id);
    }
    const edges = new Map(state.edges);
    for (const [id, edge] of edges) {
      if (edge.lastActiveAt < cutoff) edges.delete(id);
    }
    const events = state.events.filter((e) => e.timestamp > cutoff);
    return { nodes, edges, events };
  }),
}));

// ── Event pipeline helper ─────────────────────────────────────────────
// Called from ws-handlers.ts to convert raw WS messages to VizEvents.

export function wsToVizEvent(
  wsType: string,
  payload: Record<string, unknown>,
): VizEvent | null {
  switch (wsType) {
    case 'provider.text_delta': {
      const text = (payload.text as string) ?? '';
      return {
        id: nextId(), kind: 'provider:delta', timestamp: Date.now(),
        source: 'provider', target: 'leader',
        label: text.slice(0, 60), magnitude: text.length,
        data: { text },
        color: NODE_COLORS.provider,
        flowGroup: 'provider',
      };
    }
    case 'provider.response': {
      const usage = payload.usage as { input?: number; output?: number; cacheRead?: number; cacheWrite?: number } | undefined;
      const total = (usage?.input ?? 0) + (usage?.output ?? 0);
      return {
        id: nextId(), kind: 'provider:response', timestamp: Date.now(),
        source: 'provider', target: 'leader',
        label: `${(usage?.input ?? 0).toLocaleString('en-US')} in / ${(usage?.output ?? 0).toLocaleString('en-US')} out`,
        magnitude: total,
        data: payload as Record<string, unknown>,
        color: NODE_COLORS.provider,
        flowGroup: 'provider',
      };
    }
    case 'tool.started': {
      const name = payload.name as string ?? 'tool';
      return {
        id: nextId(), kind: 'tool:started', timestamp: Date.now(),
        source: name, target: 'filesystem',
        label: name, magnitude: 1,
        data: payload as Record<string, unknown>,
        color: NODE_COLORS.tool,
        flowGroup: `tool:${name}`,
      };
    }
    case 'tool.executed': {
      const name = payload.name as string ?? 'tool';
      const ok = payload.ok as boolean ?? true;
      return {
        id: nextId(), kind: 'tool:executed', timestamp: Date.now(),
        source: name, target: 'leader',
        label: `${name} ${ok ? '✓' : '✗'} (${payload.durationMs as number ?? 0}ms)`,
        magnitude: payload.durationMs as number ?? 0,
        data: payload as Record<string, unknown>,
        color: ok ? NODE_COLORS.tool : NODE_COLORS.error,
        flowGroup: `tool:${name}`,
      };
    }
    case 'tool.progress': {
      const name = payload.name as string ?? 'tool';
      const text = (payload.event as { type?: string; text?: string } | undefined)?.text ?? '';
      return {
        id: nextId(), kind: 'tool:progress', timestamp: Date.now(),
        source: name, target: 'leader',
        label: text.slice(0, 60) || name,
        magnitude: text.length,
        data: payload as Record<string, unknown>,
        color: NODE_COLORS.tool,
        flowGroup: `tool:${name}`,
      };
    }
    case 'subagent.event': {
      const kind = payload.kind as string;
      const agentId = payload.subagentId as string ?? 'unknown';
      const agentName = payload.name as string ?? agentId;
      switch (kind) {
        case 'spawned':
          return {
            id: nextId(), kind: 'agent:spawned', timestamp: Date.now(),
            source: agentId, target: 'session',
            label: `${agentName} spawned`,
            magnitude: 1,
            data: payload as Record<string, unknown>,
            color: NODE_COLORS.agent,
            flowGroup: `agent:${agentId}`,
          };
        case 'tool_executed': {
          const toolName = payload.toolName as string ?? 'tool';
          const toolOk = payload.ok as boolean ?? true;
          return {
            id: nextId(), kind: 'agent:tool', timestamp: Date.now(),
            source: agentId, target: toolName,
            label: toolName,
            magnitude: payload.durationMs as number ?? 0,
            data: payload as Record<string, unknown>,
            color: toolOk ? NODE_COLORS.tool : NODE_COLORS.error,
            flowGroup: `agent:${agentId}`,
          };
        }
        case 'task_completed': {
          const status = payload.status as string ?? 'completed';
          return {
            id: nextId(), kind: 'agent:status', timestamp: Date.now(),
            source: agentId, target: 'session',
            label: `${agentName} ${status}`,
            magnitude: 1,
            data: payload as Record<string, unknown>,
            color: status === 'success' ? 'hsl(140, 70%, 55%)' : NODE_COLORS.error,
            flowGroup: `agent:${agentId}`,
          };
        }
        case 'ctx_pct':
          return {
            id: nextId(), kind: 'agent:ctx', timestamp: Date.now(),
            source: agentId, target: 'session',
            label: `ctx ${Math.round((payload.load as number ?? 0) * 100)}%`,
            magnitude: payload.tokens as number ?? 0,
            data: payload as Record<string, unknown>,
            color: NODE_COLORS.agent,
            flowGroup: `agent:${agentId}`,
          };
        case 'iteration_summary':
          return {
            id: nextId(), kind: 'agent:text', timestamp: Date.now(),
            source: agentId, target: 'session',
            label: (payload.partialText as string ?? '').slice(0, 80) || `iter ${payload.iteration as number ?? 0}`,
            magnitude: payload.costUsd as number ?? 0,
            data: payload as Record<string, unknown>,
            color: NODE_COLORS.agent,
            flowGroup: `agent:${agentId}`,
          };
        case 'budget_extended':
          return {
            id: nextId(), kind: 'budget:extended', timestamp: Date.now(),
            source: agentId, target: 'session',
            label: `${agentName} extended budget`,
            magnitude: payload.totalExtensions as number ?? 1,
            data: payload as Record<string, unknown>,
            color: 'hsl(40, 90%, 55%)',
            flowGroup: `agent:${agentId}`,
          };
      }
      return null;
    }
    case 'mailbox.event': {
      const eventName = payload.event as string;
      const from = payload.from as string ?? '?';
      const to = payload.to as string ?? '?';
      const subject = payload.subject as string ?? '';
      const isSend = eventName === 'mailbox.sent';
      return {
        id: nextId(), kind: isSend ? 'mailbox:send' : 'mailbox:deliver', timestamp: Date.now(),
        source: from, target: to,
        label: subject || (isSend ? `→ ${to}` : `← ${from}`),
        magnitude: 1,
        data: payload as Record<string, unknown>,
        color: NODE_COLORS.mailbox,
        flowGroup: 'mailbox',
      };
    }
    case 'iteration.started': {
      const idx = payload.index as number ?? 0;
      return {
        id: nextId(), kind: 'iteration:start', timestamp: Date.now(),
        source: 'leader', target: 'session',
        label: `Iteration ${idx}`,
        magnitude: idx,
        data: payload as Record<string, unknown>,
        color: NODE_COLORS.agent,
        flowGroup: 'iteration',
      };
    }
    case 'error': {
      const msg = payload.message as string ?? 'Error';
      return {
        id: nextId(), kind: 'error', timestamp: Date.now(),
        source: payload.phase as string ?? 'system', target: 'session',
        label: msg,
        magnitude: 1,
        data: payload as Record<string, unknown>,
        color: NODE_COLORS.error,
        flowGroup: 'error',
      };
    }
    case 'context.compacted':
      return {
        id: nextId(), kind: 'context:compacted', timestamp: Date.now(),
        source: 'system', target: 'session',
        label: `Compacted: ${(payload.saved as number ?? 0).toLocaleString('en-US')} tokens`,
        magnitude: payload.saved as number ?? 0,
        data: payload as Record<string, unknown>,
        color: 'hsl(220, 60%, 50%)',
        flowGroup: 'context',
      };
    case 'context.repaired':
      return {
        id: nextId(), kind: 'context:repaired', timestamp: Date.now(),
        source: 'system', target: 'session',
        label: `Repaired: ${payload.removedMessages as number ?? 0} msgs`,
        magnitude: payload.removedMessages as number ?? 0,
        data: payload as Record<string, unknown>,
        color: 'hsl(220, 60%, 50%)',
        flowGroup: 'context',
      };
    case 'session.start': {
      const sid = payload.sessionId as string ?? '?';
      const proj = payload.projectName as string ?? '';
      return {
        id: nextId(), kind: 'session:start', timestamp: Date.now(),
        source: 'session', target: 'leader',
        label: proj || sid.slice(0, 12),
        magnitude: 1,
        data: payload as Record<string, unknown>,
        color: NODE_COLORS.session,
        flowGroup: 'session',
      };
    }
    case 'sessions.status_update': {
      // Convert the cross-process fleet snapshot into VizEvents that the
      // AgentFlowViz can render as session + agent nodes with live status.
      // We emit one fleet:snapshot event per tick; the renderer diffes it.
      const sessions = payload.sessions as Array<Record<string, unknown>> ?? [];
      return {
        id: nextId(), kind: 'fleet:snapshot', timestamp: Date.now(),
        source: 'system', target: 'session',
        label: `${sessions.length} session(s)`,
        magnitude: sessions.length,
        data: payload as Record<string, unknown>,
        color: NODE_COLORS.system,
        flowGroup: 'fleet',
      };
    }
    default:
      return null;
  }
}
