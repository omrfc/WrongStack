import { randomUUID } from 'node:crypto';
import type {
  AgentBridge,
  AgentBridgeConfig,
  BridgeMessage,
  BridgeTransport,
} from '../types/agent-bridge.js';
import { InMemoryBridgeTransport } from './transport/in-memory-transport.js';

// Re-export for backwards compatibility
export { InMemoryBridgeTransport };

export class InMemoryAgentBridge implements AgentBridge {
  readonly agentId: string;
  readonly coordinatorId: string;
  private readonly transport: BridgeTransport;
  private readonly subscriptions: Set<(msg: BridgeMessage) => void> = new Set();
  private pendingRequests = new Map<string, {
    resolve: (msg: BridgeMessage) => void;
    reject: (e: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  private stopped = false;
  private timeoutMs: number;

  constructor(config: AgentBridgeConfig, transport: BridgeTransport) {
    this.agentId = config.agentId;
    this.coordinatorId = config.coordinatorId;
    this.transport = transport;
    this.timeoutMs = config.timeoutMs ?? 30_000;

    this.transport.subscribe(this.agentId, (msg) => {
      if (msg.type === 'heartbeat') return;

      const pending = this.pendingRequests.get(msg.id);
      if (pending) {
        clearTimeout(pending.timer);
        this.pendingRequests.delete(msg.id);
        pending.resolve(msg);
        return;
      }

      for (const h of this.subscriptions) {
        try { h(msg); } catch { /* ignore */ }
      }
    });
  }

  async send(msg: BridgeMessage): Promise<void> {
    msg.timestamp = Date.now();
    await this.transport.send(msg, msg.to ?? this.coordinatorId);
  }

  async broadcast(msg: BridgeMessage): Promise<void> {
    msg.timestamp = Date.now();
    msg.to = '*';
    await this.transport.send(msg, '*');
  }

  subscribe(handler: (msg: BridgeMessage) => void | Promise<void>): () => void {
    this.subscriptions.add(handler as (msg: BridgeMessage) => void);
    return () => this.subscriptions.delete(handler as (msg: BridgeMessage) => void);
  }

  async request<T>(msg: BridgeMessage, timeoutMs?: number): Promise<BridgeMessage<T>> {
    if (this.stopped) throw new Error('Bridge is stopped');
    const timeout = timeoutMs ?? this.timeoutMs;
    const correlationId = msg.id;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(correlationId);
        reject(new Error(`Request ${correlationId} timed out after ${timeout}ms`));
      }, timeout);

      this.pendingRequests.set(correlationId, { resolve: resolve as (msg: BridgeMessage) => void, reject, timer });

      msg.timestamp = Date.now();
      this.transport.send(msg, msg.to ?? this.coordinatorId).catch((e) => {
        clearTimeout(timer);
        this.pendingRequests.delete(correlationId);
        reject(e);
      });
    });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const [, p] of this.pendingRequests) {
      clearTimeout(p.timer);
    }
    this.pendingRequests.clear();
    this.subscriptions.clear();
    await this.transport.close(this.agentId);
  }
}

export function createMessage<T = unknown>(
  type: BridgeMessage['type'],
  from: string,
  payload: T,
  to?: string,
): BridgeMessage<T> {
  return {
    id: randomUUID(),
    type,
    from,
    to,
    payload,
    timestamp: Date.now(),
    priority: 'normal',
  };
}