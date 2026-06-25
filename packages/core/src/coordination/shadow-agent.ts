/**
 * Shadow Agent — Fleet Monitoring & Intervention
 *
 * A deterministic background agent that monitors all agents in the fleet via
 * host-assigned one-shot checks. Shadow Agents run silently, observe everything,
 * and intervene only when explicitly commanded or when critical anomalies detected.
 *
 * Features:
 * - FleetBus subscription for live event monitoring
 * - Host-assigned one-shot checks
 * - Mailbox surveillance for commands and anomalies
 * - Spike detection (instant start/stop tasks)
 * - Intervention via "hoop" command
 * - Cross-terminal visibility via shared mailbox
 */
import { randomUUID } from 'node:crypto';

// ── Types ───────────────────────────────────────────────────────────────────

export interface ShadowConfig {
  /** Heartbeat interval in ms (default: 30000) */
  intervalMs?: number;
  /** Model for LLM analysis (default: host-selected model) */
  model?: string;
  /** Auto-intervene on anomalies (default: false) */
  autoIntervene?: boolean;
  /** Ms before agent considered stuck (default: 300000) */
  stuckThresholdMs?: number;
  /** Ms before task considered spike (default: 5000) */
  spikeThresholdMs?: number;
}

export interface AgentSnapshot {
  agentId: string;
  sessionId: string;
  name: string;
  role: string;
  status: 'running' | 'idle' | 'stopped' | 'unknown';
  currentTask?: string;
  lastSeen: string;
  eventCount: number;
  startedAt: string;
  stoppedAt?: string;
}

export interface SpikeEvent {
  id: string;
  agentId: string;
  spawnedAt: string;
  terminatedAt: string;
  durationMs: number;
  task?: string;
  reason: 'completed' | 'error' | 'killed' | 'timeout' | 'unknown';
}

export interface Anomaly {
  id: string;
  type: 'stuck_agent' | 'spike_task' | 'mailbox_loop' | 'budget_exhausted' | 'orphan_assign';
  severity: 'low' | 'medium' | 'high' | 'critical';
  agentId?: string;
  description: string;
  detectedAt: string;
  resolvedAt?: string;
}

export interface ShadowState {
  enabled: boolean;
  intervalMs: number;
  model: string;
  startTime: string;
  lastHeartbeat: string;
  knownAgents: Map<string, AgentSnapshot>;
  spikeHistory: SpikeEvent[];
  anomalyLog: Anomaly[];
  muted: boolean;
}

// ── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_INTERVAL_MS = 30_000;
const DEFAULT_MODEL = 'default';
// Note: stuck/spike thresholds are passed as parameters, not constants

// ── Intervention Commands ────────────────────────────────────────────────────

export type InterventionCommand =
  | { type: 'hoop'; target: string }
  | { type: 'status' }
  | { type: 'mute' }
  | { type: 'resume' }
  | { type: 'set_interval'; ms: number }
  | { type: 'set_model'; model: string }
  | { type: 'custom'; task: string };

/**
 * Parse a mailbox message body into an intervention command.
 * Supports: "hoop <id>", "hoop all", "shadow status", "shadow mute", etc.
 */
export function parseInterventionCommand(body: string): InterventionCommand | null {
  const trimmed = body.trim();

  // "hoop <target>" — terminate agents
  const hoopMatch = trimmed.match(/^hoop\s+(.+)$/i);
  if (hoopMatch?.[1]) {
    return { type: 'hoop', target: hoopMatch[1].trim() };
  }

  // "shadow status" — full report
  if (/^shadow\s+status$/i.test(trimmed)) {
    return { type: 'status' };
  }

  // "shadow mute" — pause monitoring
  if (/^shadow\s+mute$/i.test(trimmed)) {
    return { type: 'mute' };
  }

  // "shadow resume" — resume monitoring
  if (/^shadow\s+resume$/i.test(trimmed)) {
    return { type: 'resume' };
  }

  // "shadow interval <ms>" — update legacy interval setting
  const intervalMatch = trimmed.match(/^shadow\s+interval\s+(\d+)$/i);
  if (intervalMatch?.[1]) {
    return { type: 'set_interval', ms: parseInt(intervalMatch[1], 10) };
  }

  // "shadow model <model-id>" — change analysis model
  const modelMatch = trimmed.match(/^shadow\s+model\s+(.+)$/i);
  if (modelMatch?.[1]) {
    return { type: 'set_model', model: modelMatch![1].trim() };
  }

  // "shadow intervene <task>" — custom intervention
  const interveneMatch = trimmed.match(/^shadow\s+intervene\s+(.+)$/i);
  if (interveneMatch?.[1]) {
    return { type: 'custom', task: interveneMatch[1].trim() };
  }

  return null;
}

// ── Anomaly Detection ───────────────────────────────────────────────────────

export function detectStuckAgents(
  agents: Map<string, AgentSnapshot>,
  thresholdMs: number,
): Anomaly[] {
  const anomalies: Anomaly[] = [];
  const now = Date.now();

  for (const [agentId, agent] of agents) {
    if (agent.status !== 'running') continue;

    const lastSeenMs = now - new Date(agent.lastSeen).getTime();
    if (lastSeenMs > thresholdMs) {
      anomalies.push({
        id: randomUUID(),
        type: 'stuck_agent',
        severity: 'high',
        agentId,
        description: `Agent ${agentId} (${agent.name}) stuck for ${Math.round(lastSeenMs / 1000)}s — no events detected`,
        detectedAt: new Date().toISOString(),
      });
    }
  }

  return anomalies;
}

export function detectSpikeTasks(
  agent: AgentSnapshot,
  thresholdMs: number,
): SpikeEvent | null {
  if (!agent.stoppedAt) return null;

  const durationMs = new Date(agent.stoppedAt).getTime() - new Date(agent.startedAt).getTime();
  if (durationMs < thresholdMs) {
    const event: SpikeEvent = {
      id: randomUUID(),
      agentId: agent.agentId,
      spawnedAt: agent.startedAt,
      terminatedAt: agent.stoppedAt,
      durationMs,
      reason: 'unknown',
    };
    if (agent.currentTask) {
      event.task = agent.currentTask;
    }
    return event;
  }
  return null;
}

export function detectOrphanAssigns(
  pendingAssigns: Array<{ agentId: string; assignedAt: string; task: string }>,
  thresholdMs: number,
): Anomaly[] {
  const anomalies: Anomaly[] = [];
  const now = Date.now();

  for (const assign of pendingAssigns) {
    const ageMs = now - new Date(assign.assignedAt).getTime();
    if (ageMs > thresholdMs) {
      anomalies.push({
        id: randomUUID(),
        type: 'orphan_assign',
        severity: 'medium',
        agentId: assign.agentId,
        description: `Pending assign to ${assign.agentId} without result for ${Math.round(ageMs / 1000)}s: "${assign.task}"`,
        detectedAt: new Date().toISOString(),
      });
    }
  }

  return anomalies;
}

// ── State Management ───────────────────────────────────────────────────────

export function createShadowState(config: ShadowConfig = {}): ShadowState {
  return {
    enabled: true,
    intervalMs: config.intervalMs ?? DEFAULT_INTERVAL_MS,
    model: config.model ?? DEFAULT_MODEL,
    startTime: new Date().toISOString(),
    lastHeartbeat: new Date().toISOString(),
    knownAgents: new Map(),
    spikeHistory: [],
    anomalyLog: [],
    muted: false,
  };
}

export function serializeShadowState(state: ShadowState): string {
  return JSON.stringify({
    enabled: state.enabled,
    intervalMs: state.intervalMs,
    model: state.model,
    startTime: state.startTime,
    lastHeartbeat: state.lastHeartbeat,
    knownAgents: Array.from(state.knownAgents.entries()),
    spikeHistory: state.spikeHistory.slice(-100), // Keep last 100
    anomalyLog: state.anomalyLog.slice(-50), // Keep last 50
    muted: state.muted,
  });
}

export function deserializeShadowState(json: string): ShadowState {
  const parsed = JSON.parse(json);
  return {
    enabled: parsed.enabled ?? true,
    intervalMs: parsed.intervalMs ?? DEFAULT_INTERVAL_MS,
    model: parsed.model ?? DEFAULT_MODEL,
    startTime: parsed.startTime ?? new Date().toISOString(),
    lastHeartbeat: parsed.lastHeartbeat ?? new Date().toISOString(),
    knownAgents: new Map(parsed.knownAgents ?? []),
    spikeHistory: parsed.spikeHistory ?? [],
    anomalyLog: parsed.anomalyLog ?? [],
    muted: parsed.muted ?? false,
  };
}

// ── Report Generation ───────────────────────────────────────────────────────

export interface FleetStatusInput {
  subagents: Array<{
    id: string;
    name?: string;
    role?: string;
    status?: string;
    taskDescription?: string;
  }>;
  coordinatorStats?: {
    total: number;
    running: number;
    idle: number;
    stopped: number;
  };
  pending?: Array<{ id: string; description: string }>;
}

export function generateStatusReport(state: ShadowState, _fleetStatus: FleetStatusInput): string {
  const now = new Date().toISOString();
  const agentArray = Array.from(state.knownAgents.values());
  const running = agentArray.filter(a => a.status === 'running').length;
  const idle = agentArray.filter(a => a.status === 'idle').length;
  const stopped = agentArray.filter(a => a.status === 'stopped').length;
  const total = state.knownAgents.size;

  const recentAnomalies = state.anomalyLog
    .filter(a => !a.resolvedAt)
    .slice(-5)
    .map(a => `[${a.severity.toUpperCase()}] ${a.description}`)
    .join('\n') || 'None';

  const activeAgents = Array.from(state.knownAgents.values())
    .map(a => `| ${a.name} | ${a.sessionId.slice(0, 8)} | ${a.role} | ${a.status} | ${a.currentTask ?? '-'} | ${a.lastSeen} |`)
    .join('\n') || '| - | - | - | - | - | - |';

  return `## Shadow Agent Status — ${now}

**Fleet**: ${total} agents tracked | ${running} running | ${idle} idle | ${stopped} stopped
**Heartbeat**: every ${state.intervalMs}ms | Last: ${state.lastHeartbeat}
**Model**: ${state.model}
**Uptime**: ${Math.round((Date.now() - new Date(state.startTime).getTime()) / 1000)}s

### Active Agents
| Agent | Session | Role | Status | Task | Last Seen |
|-------|---------|------|--------|------|-----------|
${activeAgents}

### Recent Anomalies (unresolved)
${recentAnomalies}

### Spike History (last ${state.spikeHistory.length})
${state.spikeHistory.slice(-5).map(s =>
  `- ${s.agentId}: ${s.durationMs}ms (${s.reason}) — ${s.task ?? 'no task'}`
).join('\n') || 'None detected'}

### Configuration
- stuck_threshold: ${state.muted ? 'PAUSED' : '300000ms'}
- spike_threshold: 5000ms
- auto_intervene: false (always reports, never auto-acts)`;
}

// ── LLM Analysis Prompt ─────────────────────────────────────────────────────

export function buildAnalysisPrompt(
  state: ShadowState,
  fleetStatus: FleetStatusInput,
  recentEvents: Array<{ type: string; subagentId: string; ts: number }>,
): string {
  return `You are the Shadow Agent analyzer. Given the current fleet state and recent events,
determine if there are any anomalies that need attention.

## Current State
${generateStatusReport(state, fleetStatus)}

## Recent FleetBus Events (last 20)
${recentEvents.slice(-20).map(e =>
  `[${new Date(e.ts).toISOString()}] ${e.type} on ${e.subagentId}`
).join('\n') || 'None'}

## Analysis Request
Identify:
1. Agents that appear stuck or unresponsive
2. Unusual task patterns (spikes, rapid spawning)
3. Mailbox anomalies (orphan assigns, loops)
4. Any critical issues requiring intervention

Respond with:
- JSON array of detected anomalies (or empty array)
- One-line summary of fleet health

Example response:
{"anomalies": [], "summary": "Fleet healthy — 3 agents running normally"}`;
}

// ── Intervention Execution ──────────────────────────────────────────────────

export interface InterventionTarget {
  type: 'single' | 'all' | 'pattern';
  agentIds: string[];
}

export function resolveInterventionTarget(
  target: string,
  knownAgents: Map<string, AgentSnapshot>,
): InterventionTarget {
  const targetLower = target.toLowerCase().trim();

  if (targetLower === 'all') {
    return {
      type: 'all',
      agentIds: Array.from(knownAgents.values())
        .filter(a => a.status === 'running')
        .map(a => a.agentId),
    };
  }

  // Exact match
  if (knownAgents.has(target)) {
    return { type: 'single', agentIds: [target] };
  }

  // Pattern match (contains)
  const matches = Array.from(knownAgents.keys()).filter(id =>
    id.toLowerCase().includes(targetLower)
  );

  if (matches.length > 0) {
    return { type: 'pattern', agentIds: matches };
  }

  return { type: 'single', agentIds: [] }; // Not found
}

// ── Legacy Cron Job Name Constants ──────────────────────────────────────────

/** @deprecated Shadow checks are host-assigned one-shots; kept for compatibility. */
export const SHADOW_HEARTBEAT_CRON = 'shadow_heartbeat';
/** @deprecated Shadow mailbox checks are part of each host-assigned pass. */
export const SHADOW_MAILBOX_CRON = 'shadow_mailbox_check';

// ── Event Types for FleetBus ────────────────────────────────────────────────

export const SHADOW_EVENTS = {
  AGENT_STARTED: 'subagent.started',
  AGENT_STOPPED: 'subagent.stopped',
  AGENT_ERROR: 'subagent.error',
  TOOL_EXECUTED: 'tool.executed',
  TASK_ASSIGNED: 'task.assigned',
  TASK_COMPLETED: 'task.completed',
  BUDGET_EXHAUSTED: 'budget.exhausted',
} as const;

// ── Export all types for external use ─────────────────────────────────────

export type { ShadowAgentEvent } from './shadow-agent-events.js';
