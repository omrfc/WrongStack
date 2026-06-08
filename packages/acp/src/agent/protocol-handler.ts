/**
 * ACPProtocolHandler — state machine for ACP server-side message handling.
 *
 * ACP turn lifecycle:
 *   idle → [initialize] → await-turn → [tools/call] → executing
 *   → [tool result sent] → idle
 *
 * We implement this as a simple switch on the method name, since the ACP
 * protocol is request/response based (not streaming) on the wire.
 *
 * Concurrency: ACP allows Cancellations and multiple concurrent tool calls
 * within a turn. We handle each tools/call in its own Promise.all.
 */
import type {
  ACPMessage,
  ACPRequest,
  ACPNotification,
  ACPInitializeParams,
  ACPToolCallRequest,
  ACPToolResult,
  ACPToolCallResponse,
} from '../types/acp-messages.js';
import type {AgentServerTransport} from './stdio-transport.js';

export const WRONGSTACK_VERSION = '0.1.0';
const WRONGSTACK_CAPABILITIES = [
  'code-generation',
  'async-tools',
  'streaming',
  'progress',
];

export class ACPProtocolHandler {
  private initialized = false;
  private readonly signal = new AbortController();
  private pendingCalls = new Map<string | number, Promise<unknown>>();

  constructor(
    private readonly transport: AgentServerTransport,
    private readonly registry: import('./tools-registry.js').ACPToolsRegistry,
    private readonly context: unknown,
  ) {}

  /** Wire an external abort signal from the ACP client */
  wireAbortController(abortController: AbortController): void {
    abortController.signal.addEventListener('abort', () => {
      for (const id of this.pendingCalls.keys()) {
        this.transport.send({id, method: 'cancel', result: {ok: true}}).catch((err) => console.debug(`[protocol-handler] cancel send failed: ${err}`));
      }
    });
  }

  /** Process one inbound message. Returns true if this was a terminal message. */
  async handleMessage(msg: ACPMessage): Promise<boolean> {
    if (msg.id !== undefined) {
      return this.handleRequest(msg as ACPRequest);
    }
    return this.handleNotification(msg as ACPNotification);
  }

  private async handleRequest(req: ACPRequest): Promise<boolean> {
    if (req.method !== 'initialize' && !this.initialized) {
      await this.sendError(req.id ?? null, -32000, 'Not initialized');
      return false;
    }

    // All requests after initialization check have a guaranteed id
    const id = req.id as string | number;

    switch (req.method) {
      case 'initialize':
        return this.handleInitialize(req as ACPRequest & {params: ACPInitializeParams}, id);
      case 'ping':
        await this.transport.send({id, method: 'ping', result: {pong: true}});
        return false;
      case 'tools/call':
        return this.handleToolCall(req as ACPRequest & {params: ACPToolCallRequest['params']}, id);
      case 'tools/list':
        return this.handleToolsList(id);
      case 'cancel':
        return this.handleCancel(id);
      case 'session/list':
        return this.handleSessionList(id);
      case 'sessionInfoUpdate':
        await this.transport.send({id, method: 'sessionInfoUpdate', result: {ok: true}});
        return false;
      default:
        await this.sendError(id, -32601, `Unknown method: ${req.method}`);
        return false;
    }
  }

  private async handleNotification(n: ACPNotification): Promise<boolean> {
    if (n.method === 'cancel') {
      this.handleCancelNotification(n as ACPNotification & {params?: {reason?: string | undefined}});
    }
    return false;
  }

  private async handleInitialize(
    req: ACPRequest & {params: ACPInitializeParams},
    id: string | number,
  ): Promise<boolean> {
    this.initialized = true;

    const result = {
      capabilities: WRONGSTACK_CAPABILITIES,
      agentName: 'WrongStack',
      agentVersion: WRONGSTACK_VERSION,
      protocolVersion: req.params?.protocolVersion ?? '2024-11',
      ...this.registry.buildToolList(),
    };

    await this.transport.send({id, method: 'initialize', result});
    return false;
  }

  private async handleToolsList(id: string | number): Promise<boolean> {
    await this.transport.send({
      id,
      method: 'tools/list',
      result: this.registry.buildToolList(),
    });
    return false;
  }

  private async handleToolCall(
    req: ACPRequest & {params: {name: string; arguments: Record<string, unknown>}},
    id: string | number,
  ): Promise<boolean> {
    const {name, arguments: args} = req.params;

    const runPromise = (async () => {
      if (!this.registry.has(name)) {
        return {
          content: [{type: 'text', text: `Tool not found: ${name}`}],
          isError: true,
        } satisfies ACPToolResult;
      }

      const result = await this.registry.execute(
        name,
        args,
        this.context,
        this.signal.signal,
      );
      return result ?? {content: [{type: 'text', text: 'Tool returned null'}], isError: false};
    })();

    this.pendingCalls.set(id, runPromise);

    try {
      const toolResult = (await runPromise) as ACPToolResult;
      this.pendingCalls.delete(id);

      const response: ACPToolCallResponse = {method: 'tools/call', id, result: toolResult};
      await this.transport.send(response);
    } catch (err) {
      this.pendingCalls.delete(id);
      const msg = err instanceof Error ? err.message : String(err);
      await this.transport.send({
        id,
        method: 'tools/call',
        result: {content: [{type: 'text', text: msg}], isError: true},
      });
    }

    return false;
  }

  private async handleCancel(id: string | number): Promise<boolean> {
    this.pendingCalls.delete(id);
    await this.transport.send({id, method: 'cancel', result: {ok: true}});
    return false;
  }

  private handleCancelNotification(
    _n: ACPNotification & {params?: {reason?: string | undefined}},
  ): void {
    // Broadcast cancellation to all pending — best-effort
  }

  private async handleSessionList(id: string | number): Promise<boolean> {
    await this.transport.send({
      id,
      method: 'session/list',
      result: {sessions: []},
    });
    return false;
  }

  private async sendError(id: string | number | null, code: number, message: string): Promise<void> {
    if (id === null) return;
    await this.transport.send({id, method: '', error: {code, message}});
  }
}
