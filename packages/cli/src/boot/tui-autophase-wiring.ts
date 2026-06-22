/**
 * AutoPhase event forwarding — extracted from the TUI branch of execute().
 *
 * Subscribes to PhaseOrchestrator events on the main EventBus and forwards
 * them to a TUI handler so the PhaseMonitor/PhasePanel stay in sync with
 * the running graph. The event list is static; the only runtime input is
 * the EventBus instance.
 *
 * Returns a subscribe function (called by runTui) and a cleanup function
 * (called on TUI teardown).
 */
import type { EventBus } from '@wrongstack/core';

/**
 * The full set of events forwarded from the EventBus to the TUI's
 * AutoPhase/Coordinator/Worktree/Countdown monitors. Order does not
 * matter — each gets its own listener.
 */
const AUTO_PHASE_EVENTS: readonly string[] = [
  'phase.started',
  'phase.completed',
  'phase.failed',
  'phase.statusChange',
  'phase.taskCompleted',
  'phase.taskFailed',
  'phase.taskRetrying',
  'phase.verifying',
  'phase.verifyFailed',
  'phase.repairing',
  'phase.conflictResolving',
  'phase.conflictResolved',
  'autonomous.tick',
  'graph.completed',
  'graph.failed',
  'agent.assigned',
  'agent.released',
  // Git-worktree isolation lifecycle → TUI worktree panel/monitor.
  'worktree.allocated',
  'worktree.committed',
  'worktree.merged',
  'worktree.conflict',
  'worktree.released',
  'worktree.failed',
  // Auto-proceed countdown tick events
  'countdown.tick',
];

export interface AutoPhaseWiring {
  /**
   * Called by the TUI to receive forwarded events. Each call registers
   * one listener per event name; the returned function unregisters all.
   */
  subscribe: (handler: (event: string, payload: unknown) => void) => () => void;
  /** Remove all listeners. Safe to call multiple times. */
  cleanup: () => void;
}

/**
 * Wire AutoPhase event forwarding on the given EventBus.
 *
 * AutoPhase events are emitted on the untyped surface of the bus (the
 * orchestrator casts `emit` to a string-keyed signature), so we subscribe
 * through the same untyped view rather than the typed event-name overloads.
 *
 * Bind to `events` — pulling the method off the bus as a bare reference
 * loses `this`, so `on`/`off` would read `this.listeners` off `undefined`
 * and throw the moment AutoPhase subscribes.
 */
export function wireAutoPhase(events: EventBus): AutoPhaseWiring {
  const handlers = new Map<string, (payload: unknown) => void>();

  const onUntyped = events.on.bind(events) as never as (
    event: string,
    handler: (payload: unknown) => void,
  ) => void;
  const offUntyped = events.off.bind(events) as never as (
    event: string,
    handler: (payload: unknown) => void,
  ) => void;

  const subscribe = (handler: (event: string, payload: unknown) => void): (() => void) => {
    const registrations: Array<() => void> = [];
    for (const ev of AUTO_PHASE_EVENTS) {
      const h = (p: unknown) => handler(ev, p);
      handlers.set(ev, h);
      onUntyped(ev, h);
      registrations.push(() => offUntyped(ev, h));
    }
    return () => {
      for (const unregister of registrations) unregister();
      handlers.clear();
    };
  };

  const cleanup = (): void => {
    for (const [ev, h] of handlers) {
      offUntyped(ev, h);
    }
    handlers.clear();
  };

  return { subscribe, cleanup };
}
