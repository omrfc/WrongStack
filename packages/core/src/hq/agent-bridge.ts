/**
 * AgentMonitorEventBridge — forwards local agent timeline and status events
 * to the HQ publisher as structured HQ event envelopes, so the HQ browser
 * dashboard sees real-time agent conversation streams.
 */
import type { EventBus } from '../kernel/events.js';
import { createHqEventEnvelope, type HqAgentMessagePayload, type HqAgentStatusPayload, type HqEventEnvelope } from './protocol.js';

export type HqAgentEventPublisher = (envelope: HqEventEnvelope) => void;

export interface AgentMonitorEventBridgeOptions {
  /** Local EventBus emitting agent.timeline.* and agent.status_changed events. */
  events: EventBus;
  /** Client/project identifiers for HQ envelope authorship. */
  clientId: string;
  projectId: string;
  /**
   * Publish callback — called with each HQ event envelope. Wire this to
   * your HQ publisher's `send()` or queue method when connected.
   * When null (no HQ connection), events are silently dropped.
   */
  publish?: HqAgentEventPublisher | undefined;
}

/**
 * Start forwarding agent monitoring events to HQ. Returns a disposer that
 * unsubscribes all listeners — call on shutdown.
 */
export function startAgentMonitorEventBridge(opts: AgentMonitorEventBridgeOptions): () => void {
  const { events, clientId, projectId, publish } = opts;
  const seq = { current: 0 };

  function nextSeq(): number {
    seq.current += 1;
    return seq.current;
  }

  function buildEnvelope<T>(type: string, payload: T): HqEventEnvelope<T> {
    return createHqEventEnvelope({
      id: `${Date.now().toString(36)}-${nextSeq()}`,
      type: type as never,
      timestamp: new Date().toISOString(),
      clientId,
      projectId,
      seq: nextSeq(),
      payload,
    }) as HqEventEnvelope<T>;
  }

  const offMessage = events.on('agent.timeline.message', (payload) => {
    if (!publish) return;
    const msgPayload: HqAgentMessagePayload = {
      subagentId: payload.subagentId,
      agentName: payload.agentName,
      content: payload.content,
      kind: payload.kind,
      iteration: payload.iteration,
      ts: payload.ts,
    };
    if (payload.toolName !== undefined) msgPayload.toolName = payload.toolName;
    if (payload.costUsd !== undefined) msgPayload.costUsd = payload.costUsd;
    publish(buildEnvelope('agent.message', msgPayload));
  });

  const offStatus = events.on('agent.status_changed', (payload) => {
    if (!publish) return;
    const statusPayload: HqAgentStatusPayload = {
      subagentId: payload.subagentId,
      agentName: payload.agentName,
      status: payload.status,
      ts: payload.ts,
    };
    if (payload.summary !== undefined) statusPayload.summary = payload.summary;
    if (payload.task !== undefined) statusPayload.task = payload.task;
    publish(buildEnvelope('agent.status', statusPayload));
  });

  return () => {
    offMessage();
    offStatus();
  };
}
