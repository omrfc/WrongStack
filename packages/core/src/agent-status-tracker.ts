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
import type {
  AgentEntry,
  AgentLiveStatus,
  SessionRegistry,
} from './session-registry.js';

export interface AgentStatusTrackerOptions {
  events: EventBus;
  registry: SessionRegistry;
  /** Leader agent name shown in the registry. Default: "leader". */
  leaderName?: string | undefined;
  /**
   * Best-effort callback fired after each registry write settles. Used to nudge
   * local WebUI servers (FleetNotifier) so cross-process status reaches the map
   * without waiting on their file-watch/poll. Never block or throw.
   */
  onUpdate?: (() => void) | undefined;
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
  private leaderCostUsd = 0;
  private leaderTokensIn = 0;
  private leaderTokensOut = 0;
  private leaderCtxPct: number | undefined;
  private leaderModel: string | undefined;

  private unsubscribers: Array<() => void> = [];
  private readonly onUpdate: (() => void) | undefined;

  constructor(opts: AgentStatusTrackerOptions) {
    this.events = opts.events;
    this.registry = opts.registry;
    this.leaderName = opts.leaderName ?? 'leader';
    this.onUpdate = opts.onUpdate;
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

    // Capture the leader's model + context fill from each iteration's context.
    this.unsubscribers.push(
      this.events.onPattern('iteration.started', (_e, payload) => {
        const ctx = (payload as { ctx?: { model?: string; tokenCount?: number; maxContext?: number } } | undefined)?.ctx;
        if (!ctx) return;
        if (ctx.model) this.leaderModel = ctx.model;
        if (typeof ctx.tokenCount === 'number' && typeof ctx.maxContext === 'number' && ctx.maxContext > 0) {
          this.leaderCtxPct = Math.round((ctx.tokenCount / ctx.maxContext) * 100);
        }
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

    // Leader token + cost accounting (per provider call — accumulate).
    this.unsubscribers.push(
      this.events.onPattern('token.accounted', (_e, payload) => {
        const p = payload as
          | { usage?: { input?: number; output?: number }; cost?: { total?: number } }
          | undefined;
        if (!p) return;
        this.leaderTokensIn += p.usage?.input ?? 0;
        this.leaderTokensOut += p.usage?.output ?? 0;
        this.leaderCostUsd += p.cost?.total ?? 0;
        this.flush();
      }),
    );

    // ── Subagent tracking ──────────────────────────────────────────────
    // These are the real fleet lifecycle events (emitted by MultiAgentHost /
    // the subagent runner / director). The previous code listened to a
    // `fleet.subagent.*` namespace that nothing emits, so subagents never
    // reached the registry — only the leader showed up.
    const touch = (id: string): AgentEntry => {
      let entry = this.agents.get(id);
      if (!entry) {
        entry = { id, name: id, status: 'idle', iterations: 0, toolCalls: 0, lastActivityAt: new Date().toISOString() };
        this.agents.set(id, entry);
      }
      entry.lastActivityAt = new Date().toISOString();
      return entry;
    };

    this.unsubscribers.push(
      this.events.onPattern('subagent.spawned', (_e, payload) => {
        const p = payload as { subagentId?: string; name?: string; model?: string } | undefined;
        if (!p?.subagentId) return;
        const entry = touch(p.subagentId);
        entry.name = p.name?.trim() || entry.name;
        if (p.model) entry.model = p.model;
        entry.status = 'running';
        this.flush();
      }),
    );

    this.unsubscribers.push(
      this.events.onPattern('subagent.ctx_pct', (_e, payload) => {
        const p = payload as { subagentId?: string; load?: number } | undefined;
        if (!p?.subagentId) return;
        const entry = touch(p.subagentId);
        if (typeof p.load === 'number') entry.ctxPct = Math.round(p.load * 100);
        this.flush();
      }),
    );

    this.unsubscribers.push(
      this.events.onPattern('subagent.task_started', (_e, payload) => {
        const p = payload as { subagentId?: string } | undefined;
        if (!p?.subagentId) return;
        const entry = touch(p.subagentId);
        entry.status = 'running';
        entry.iterations++;
        this.flush();
      }),
    );

    this.unsubscribers.push(
      this.events.onPattern('subagent.tool_executed', (_e, payload) => {
        const p = payload as { subagentId?: string; name?: string } | undefined;
        if (!p?.subagentId) return;
        const entry = touch(p.subagentId);
        entry.status = 'running';
        entry.currentTool = p.name;
        entry.toolCalls++;
        this.flush();
      }),
    );

    this.unsubscribers.push(
      this.events.onPattern('subagent.iteration_summary', (_e, payload) => {
        const p = payload as
          | { subagentId?: string; iteration?: number; toolCalls?: number; currentTool?: string; costUsd?: number }
          | undefined;
        if (!p?.subagentId) return;
        const entry = touch(p.subagentId);
        entry.status = 'running';
        if (typeof p.iteration === 'number') entry.iterations = p.iteration;
        if (typeof p.toolCalls === 'number') entry.toolCalls = p.toolCalls;
        if (typeof p.costUsd === 'number') entry.costUsd = p.costUsd;
        if (p.currentTool) entry.currentTool = p.currentTool;
        this.flush();
      }),
    );

    this.unsubscribers.push(
      this.events.onPattern('subagent.task_completed', (_e, payload) => {
        const p = payload as
          | { subagentId?: string; status?: string; iterations?: number; toolCalls?: number }
          | undefined;
        if (!p?.subagentId) return;
        // Only update an agent we already know — a completion for an unseen
        // agent isn't worth materialising.
        const entry = this.agents.get(p.subagentId);
        if (!entry) return;
        entry.status = p.status === 'failed' || p.status === 'timeout' ? 'error' : 'idle';
        entry.currentTool = undefined;
        if (typeof p.iterations === 'number') entry.iterations = p.iterations;
        if (typeof p.toolCalls === 'number') entry.toolCalls = p.toolCalls;
        entry.lastActivityAt = new Date().toISOString();
        this.flush();
      }),
    );

    this.unsubscribers.push(
      this.events.onPattern('subagent.stopped', (_e, payload) => {
        const p = payload as { subagentId?: string } | undefined;
        if (!p?.subagentId) return;
        if (this.agents.delete(p.subagentId)) this.flush();
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
      costUsd: this.leaderCostUsd,
      tokensIn: this.leaderTokensIn,
      tokensOut: this.leaderTokensOut,
      ctxPct: this.leaderCtxPct,
      model: this.leaderModel,
      lastActivityAt: new Date().toISOString(),
    };

    const allAgents = [leaderEntry, ...this.agents.values()];
    // Nudge local WebUIs only AFTER the write settles, so they re-read fresh
    // data. Best-effort — never let a notifier failure surface here.
    this.registry
      .updateAgents(allAgents)
      .then(() => {
        try {
          this.onUpdate?.();
        } catch {
          /* best-effort */
        }
      })
      .catch(() => undefined);
  }
}
