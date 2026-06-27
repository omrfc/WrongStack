/**
 * WsBridgeTransport — an `AgentServerTransport` backed by a single
 * bidirectional message channel (one WebSocket connection).
 *
 * Unlike stdio (a process-wide pipe driven by a read loop) or HTTP (one
 * request/response per POST, notifications buffered), a WebSocket is a live
 * full-duplex channel: the agent can stream `session/update` notifications
 * and make `session/request_permission` callbacks WHILE a turn runs. This
 * transport is the seam that lets `ACPProtocolHandler` drive one such
 * connection.
 *
 * It is dependency-free and structural: the caller (the CLI, which already
 * depends on `ws`) constructs it with a `send` sink and feeds inbound
 * messages via `receive(msg)`. One handler + one transport per connection.
 */
import type { ACPMessage } from '../types/acp-messages.js';
import type { AgentServerTransport } from './stdio-transport.js';

export class WsBridgeTransport implements AgentServerTransport {
  private readonly handlers = new Set<(msg: ACPMessage) => void>();
  private closed = false;

  /** @param sink Called with each outbound message to write to the socket. */
  constructor(private readonly sink: (msg: ACPMessage) => void) {}

  send(msg: ACPMessage): Promise<void> {
    if (this.closed) return Promise.resolve();
    try {
      this.sink(msg);
    } catch {
      // socket write failures tear the connection down elsewhere
    }
    return Promise.resolve();
  }

  sendRaw(): void {
    // Raw byte writes have no meaning over a JSON-message WebSocket.
  }

  read(): Promise<ACPMessage | null> {
    // The WS server drives the handler via handleMessage(receive); the
    // read-loop model isn't used for this transport.
    return Promise.resolve(null);
  }

  onMessage(handler: (msg: ACPMessage) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  close(): void {
    this.closed = true;
    this.handlers.clear();
  }

  /**
   * Feed one inbound message from the socket. Fires the registered
   * `onMessage` handlers (which route JSON-RPC responses to pending
   * outbound requests inside the handler). Inbound *requests* are processed
   * by the caller via `handler.handleMessage(msg)` — call both per message.
   */
  receive(msg: ACPMessage): void {
    if (this.closed) return;
    for (const handler of [...this.handlers]) {
      try {
        handler(msg);
      } catch {
        // a faulty consumer must not break the socket pump
      }
    }
  }
}
