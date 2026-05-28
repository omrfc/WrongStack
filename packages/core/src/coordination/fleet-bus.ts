import type { EventBus } from '../kernel/events.js';

/**
 * Single fleet-wide event with subagent attribution. Whatever a child
 * agent emits on its own EventBus gets re-published here, prefixed with
 * `subagentId` so a single subscriber can multiplex across the fleet.
 *
 * The director uses `FleetBus.filter('tool.executed', …)` to see every
 * tool call across the fleet; the TUI uses
 * `FleetBus.subscribe(id, handler)` to render a per-subagent panel.
 */
export interface FleetEvent {
  subagentId: string;
  taskId?: string;
  ts: number;
  type: string;
  payload: unknown;
}

export type FleetHandler = (event: FleetEvent) => void;

/**
 * Fan-in for per-subagent EventBuses. Each subagent's bus is plugged in
 * via `attach()`; the FleetBus re-emits every event with subagent
 * attribution. Detachment is automatic via the returned disposer — call
 * it when a subagent terminates so we don't leak listeners.
 *
 * The bus exposes two subscription modes: by `subagentId` (everything
 * from one child) and by `type` (one event-type across the fleet). They
 * compose — if you need a per-subagent + per-type slice, subscribe by
 * type and filter on `event.subagentId` in your handler.
 */
export class FleetBus {
  private readonly byId = new Map<string, Set<FleetHandler>>();
  private readonly byType = new Map<string, Set<FleetHandler>>();
  private readonly any = new Set<FleetHandler>();

  /**
   * Hook a subagent's EventBus into the fleet. Uses `onAny()` (an alias for
   * `onPattern('*')`) to forward all events with subagent attribution, so
   * new kernel event types are automatically forwarded without any manual
   * registration. `subagent.*` events are excluded because they originate
   * from MultiAgentHost on the parent bus, not the subagent's own bus.
   *
   * Returns a disposer that detaches every subscription; call on
   * subagent teardown so the listeners don't outlive the run.
   */
  attach(subagentId: string, bus: EventBus, taskId?: string): () => void {
    // Subscribe to every event on the subagent's EventBus and re-emit with
    // attribution via the onAny() alias for onPattern('*'). The payload is
    // typed as `unknown` in the FleetEvent — use the type guard in the
    // handler to narrow it.
    //
    // Skip subagent lifecycle events (subagent.*) — those are emitted by
    // MultiAgentHost on the parent EventBus, not on the subagent's own bus.
    // Forwarding them would create duplicate fleet events for the same logical
    // occurrence. Use the parent EventBus path (events.on('subagent.*')) for
    // lifecycle events instead.
    const off = bus.onAny((type, payload) => {
      if (type.startsWith('subagent.')) return;
      this.emit({ subagentId, taskId, ts: Date.now(), type, payload });
    });

    return () => {
      off();
    };
  }

  /** Subscribe to every event from one subagent. */
  subscribe(subagentId: string, handler: FleetHandler): () => void {
    let set = this.byId.get(subagentId);
    if (!set) {
      set = new Set();
      this.byId.set(subagentId, set);
    }
    set.add(handler);
    return () => {
      set!.delete(handler);
    };
  }

  /** Subscribe to one event type across all subagents. */
  filter(type: string, handler: FleetHandler): () => void {
    let set = this.byType.get(type);
    if (!set) {
      set = new Set();
      this.byType.set(type, set);
    }
    set.add(handler);
    return () => {
      set!.delete(handler);
    };
  }

  /** Subscribe to literally everything. The fleet roll-up uses this. */
  onAny(handler: FleetHandler): () => void {
    this.any.add(handler);
    return () => {
      this.any.delete(handler);
    };
  }

  emit(event: FleetEvent): void {
    // Each fan-out is best-effort — a misbehaving handler must not
    // bring down the bus or other handlers. Errors are swallowed
    // (matching the rest of the project's listener-error policy).
    const byId = this.byId.get(event.subagentId);
    if (byId)
      for (const h of byId) {
        try {
          h(event);
        } catch {
          /* ignore */
        }
      }
    const byType = this.byType.get(event.type);
    if (byType)
      for (const h of byType) {
        try {
          h(event);
        } catch {
          /* ignore */
        }
      }
    for (const h of this.any) {
      try {
        h(event);
      } catch {
        /* ignore */
      }
    }
  }
}

/**
 * Roll-up of token usage + cost across an entire director run. The
 * director's `fleet_status` tool returns this so the model can reason
 * about budget in its next turn ("the researcher already burned $0.40,
 * lean on summaries for the next task").
 */
export interface FleetUsage {
  total: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    cost: number;
  };
  perSubagent: Record<string, SubagentUsageSnapshot>;
}

export interface SubagentUsageSnapshot {
  subagentId: string;
  provider?: string;
  model?: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  toolCalls: number;
  iterations: number;
  startedAt: number;
  lastEventAt: number;
}

/**
 * Aggregates provider.response + tool.executed events from the FleetBus
 * into a live `FleetUsage` snapshot. Costs are computed by the caller
 * via a `priceLookup(subagentId)` so we don't bake provider-pricing
 * coupling into core; the CLI/tests supply a function that resolves
 * each subagent's per-token rates from the models registry.
 */
export class FleetUsageAggregator {
  private readonly perSubagent = new Map<string, SubagentUsageSnapshot>();
  private readonly total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };

  constructor(
    private readonly bus: FleetBus,
    private readonly priceLookup?: (
      subagentId: string,
      provider?: string,
      model?: string,
    ) => { input?: number; output?: number; cacheRead?: number; cacheWrite?: number } | undefined,
    private readonly metaLookup?: (
      subagentId: string,
    ) => { provider?: string; model?: string } | undefined,
  ) {
    bus.filter('provider.response', (e) => this.onProviderResponse(e));
    bus.filter('tool.executed', (e) => this.onToolExecuted(e));
    bus.filter('iteration.started', (e) => this.onIterationStarted(e));
  }

  /** Live snapshot — safe to call from a tool's execute() body. */
  snapshot(): FleetUsage {
    return {
      total: { ...this.total },
      perSubagent: Object.fromEntries(
        Array.from(this.perSubagent.entries()).map(([k, v]) => [k, { ...v }]),
      ),
    };
  }

  private ensure(subagentId: string): SubagentUsageSnapshot {
    let snap = this.perSubagent.get(subagentId);
    if (!snap) {
      const meta = this.metaLookup?.(subagentId);
      snap = {
        subagentId,
        provider: meta?.provider,
        model: meta?.model,
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0,
        toolCalls: 0,
        iterations: 0,
        startedAt: Date.now(),
        lastEventAt: Date.now(),
      };
      this.perSubagent.set(subagentId, snap);
    }
    return snap;
  }

  private onProviderResponse(e: FleetEvent): void {
    const snap = this.ensure(e.subagentId);
    const p = e.payload as {
      usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
    };
    const usage = p?.usage;
    if (!usage) return;
    snap.input += usage.input ?? 0;
    snap.output += usage.output ?? 0;
    snap.cacheRead += usage.cacheRead ?? 0;
    snap.cacheWrite += usage.cacheWrite ?? 0;
    this.total.input += usage.input ?? 0;
    this.total.output += usage.output ?? 0;
    this.total.cacheRead += usage.cacheRead ?? 0;
    this.total.cacheWrite += usage.cacheWrite ?? 0;
    const price = this.priceLookup?.(e.subagentId, snap.provider, snap.model);
    if (price) {
      const delta =
        ((usage.input ?? 0) / 1_000_000) * (price.input ?? 0) +
        ((usage.output ?? 0) / 1_000_000) * (price.output ?? 0) +
        ((usage.cacheRead ?? 0) / 1_000_000) * (price.cacheRead ?? 0) +
        ((usage.cacheWrite ?? 0) / 1_000_000) * (price.cacheWrite ?? 0);
      snap.cost += delta;
      this.total.cost += delta;
    }
    snap.lastEventAt = e.ts;
  }

  private onToolExecuted(e: FleetEvent): void {
    const snap = this.ensure(e.subagentId);
    snap.toolCalls += 1;
    snap.lastEventAt = e.ts;
  }

  private onIterationStarted(e: FleetEvent): void {
    const snap = this.ensure(e.subagentId);
    snap.iterations += 1;
    snap.lastEventAt = e.ts;
  }
}
