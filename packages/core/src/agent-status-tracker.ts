/**
 * AgentStatusTracker — subscribes to EventBus events and keeps the
 * SessionRegistry updated with live agent status.
 *
 * Created once per process during boot. Listens for:
 * - agent.run.started / agent.run.completed → agent status changes
 * - tool.started / tool.executed → current tool tracking
 * - brain.ask_human → waiting_user status
 * - fleet events (subagent spawn/start/done) → agent entries
 *
 * @module agent-status-tracker
 */
import type { EventBus } from './kernel/events.js';
import {
  type AgentEntry,
  type AgentLiveStatus,
  SessionRegistry,
} from './session-registry.js';

export interface AgentStatusTrackerOptions {
  events: EventBus;
  registry: SessionRegistry;
  /** Leader agent name shown in the registry. Default: "leader". */
  leaderName?: string | undefined;
}

export class AgentStatusTracker {
  private readonly events: EventBus;
  private readonly registry: SessionRegistry;
  private readonly leaderName: string;

  // Live agent map: agentId → AgentEntry
  private agents = new Map<string, AgentEntry>();

  // Leader tracking
  private leaderStatus: AgentLiveStatus = 'idle';
  private leaderCurrentTool: string | undefined;
  private leaderIterations = 0;
  private leaderToolCalls = 0;

  private unsubscribers: Array<() => void> = [];

  constructor(opts: AgentStatusTrackerOptions) {
    this.events = opts.events;
    this.registry = opts.registry;
    this.leaderName = opts.leaderName ?? 'leader';
  }

  start(): void {
    // Leader events
    this.unsubscribers.push(
      this.events.onPattern('agent.run.started', () => {
        this.leaderStatus = 'running';
        this.leaderIterations++;
        this.flush();
      }),
    );

    this.unsubscribers.push(
      this.events.onPattern('agent.run.completed', () => {
        this.leaderStatus = 'idle';
        this.leaderCurrentTool = undefined;
        this.flush();
      }),
    );

    this.unsubscribers.push(
      this.events.onPattern('agent.run.error', () => {
        this.leaderStatus = 'error';
        this.leaderCurrentTool = undefined;
        this.flush();
      }),
    );

    // Tool events — track current tool
    this.unsubscribers.push(
      this.events.onPattern('tool.started', (_event, payload) => {
        const p = payload as { name?: string } | undefined;
        if (p?.name) {
          this.leaderCurrentTool = p.name;
          this.leaderToolCalls++;
        }
        this.leaderStatus = 'running';
        this.flush();
      }),
    );

    this.unsubscribers.push(
      this.events.onPattern('tool.executed', () => {
        this.leaderCurrentTool = undefined;
        this.flush();
      }),
    );

    // Brain ask_human → waiting for user input
    this.unsubscribers.push(
      this.events.onPattern('brain.ask_human', () => {
        this.leaderStatus = 'waiting_user';
        this.flush();
      }),
    );

    // Streaming events
    this.unsubscribers.push(
      this.events.onPattern('llm.stream_started', () => {
        this.leaderStatus = 'streaming';
        this.flush();
      }),
    );

    // Fleet events — subagent tracking
    this.unsubscribers.push(
      this.events.onPattern('fleet.subagent.spawned', (_event, payload) => {
        const p = payload as { subagentId?: string; name?: string } | undefined;
        if (p?.subagentId) {
          this.agents.set(p.subagentId, {
            id: p.subagentId,
            name: p.name ?? p.subagentId,
            status: 'idle',
            iterations: 0,
            toolCalls: 0,
            lastActivityAt: new Date().toISOString(),
          });
          this.flush();
        }
      }),
    );

    this.unsubscribers.push(
      this.events.onPattern('fleet.subagent.task_started', (_event, payload) => {
        const p = payload as { subagentId?: string } | undefined;
        if (p?.subagentId) {
          const entry = this.agents.get(p.subagentId);
          if (entry) {
            entry.status = 'running';
            entry.iterations++;
            entry.lastActivityAt = new Date().toISOString();
            this.flush();
          }
        }
      }),
    );

    this.unsubscribers.push(
      this.events.onPattern('fleet.subagent.task_completed', (_event, payload) => {
        const p = payload as { subagentId?: string } | undefined;
        if (p?.subagentId) {
          const entry = this.agents.get(p.subagentId);
          if (entry) {
            entry.status = 'idle';
            entry.lastActivityAt = new Date().toISOString();
            this.flush();
          }
        }
      }),
    );

    this.unsubscribers.push(
      this.events.onPattern('fleet.subagent.error', (_event, payload) => {
        const p = payload as { subagentId?: string } | undefined;
        if (p?.subagentId) {
          const entry = this.agents.get(p.subagentId);
          if (entry) {
            entry.status = 'error';
            entry.lastActivityAt = new Date().toISOString();
            this.flush();
          }
        }
      }),
    );

    this.unsubscribers.push(
      this.events.onPattern('fleet.subagent.stopped', (_event, payload) => {
        const p = payload as { subagentId?: string } | undefined;
        if (p?.subagentId) {
          this.agents.delete(p.subagentId);
          this.flush();
        }
      }),
    );
  }

  stop(): void {
    for (const unsub of this.unsubscribers) {
      try { unsub(); } catch { /* ignore */ }
    }
    this.unsubscribers = [];
  }

  private flush(): void {
    const leaderEntry: AgentEntry = {
      id: 'leader',
      name: this.leaderName,
      status: this.leaderStatus,
      currentTool: this.leaderCurrentTool,
      iterations: this.leaderIterations,
      toolCalls: this.leaderToolCalls,
      lastActivityAt: new Date().toISOString(),
    };

    const allAgents = [leaderEntry, ...this.agents.values()];
    this.registry.updateAgents(allAgents).catch(() => undefined);
  }
}
