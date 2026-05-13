import type { BridgeMessage, BridgeTransport } from '../../types/agent-bridge.js';

/**
 * In-memory pub/sub transport for agent-to-agent messaging.
 * Subscribers register by agentId and receive messages via callback.
 */
export class InMemoryBridgeTransport implements BridgeTransport {
  private readonly subs = new Map<string, Set<(msg: BridgeMessage) => void>>();

  send(msg: BridgeMessage, to: string): Promise<void> {
    const handlers = this.subs.get(to);
    if (handlers) {
      for (const h of handlers) {
        try { h(msg); } catch { /* ignore */ }
      }
    }
    return Promise.resolve();
  }

  subscribe(agentId: string, handler: (msg: BridgeMessage) => void): () => void {
    if (!this.subs.has(agentId)) this.subs.set(agentId, new Set());
    this.subs.get(agentId)!.add(handler);
    return () => this.subs.get(agentId)?.delete(handler);
  }

  close(agentId: string): Promise<void> {
    this.subs.delete(agentId);
    return Promise.resolve();
  }
}