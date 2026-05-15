import type { ConnectionState, MCPTool, ToolCallResult } from './client.js';

export type JsonRpcResult = {
  jsonrpc: string;
  id?: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
};

export interface HttpTransportOptions {
  name: string;
  url: string;
  headers?: Record<string, string>;
  startupTimeoutMs?: number;
}

/**
 * SSE-based MCP transport using native fetch.
 *
 * Communication pattern:
 * - Client connects to SSE endpoint to receive server messages (JSON-RPC events)
 * - Client sends JSON-RPC requests via HTTP POST to the same or separate endpoint
 * - Server sends results/errors via the SSE stream
 *
 * The SSE reader parses the SSE protocol (event:, data:, blank line to dispatch).
 */
/**
 * Cap on the pending-line buffer. The upstream SSE parser
 * (packages/providers/src/sse.ts) already enforces 256 KB; this
 * reader is used only inside MCP HTTP transports, but defense-in-depth
 * says we should never let a malicious stream pin memory.
 */
const SSE_READER_MAX_BUFFER = 256 * 1024;

export class SSEReader {
  private buffer = '';
  private listeners: Array<
    (event: { jsonrpc?: string; method?: string; params?: unknown; id?: number }) => void
  > = [];

  onMessage(
    cb: (data: { jsonrpc?: string; method?: string; params?: unknown; id?: number }) => void,
  ): () => void {
    this.listeners.push(cb);
    return () => {
      const idx = this.listeners.indexOf(cb);
      if (idx >= 0) this.listeners.splice(idx, 1);
    };
  }

  feed(chunk: string): void {
    this.buffer += chunk;
    if (this.buffer.length > SSE_READER_MAX_BUFFER) {
      throw new Error(
        `SSE: pending line exceeds ${SSE_READER_MAX_BUFFER} bytes — upstream is not framing events`,
      );
    }
    let idx = this.buffer.indexOf('\n');
    while (idx !== -1) {
      const line = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 1);
      idx = this.buffer.indexOf('\n');

      if (line.startsWith('event:')) {
        // track event type, ignore for now
      } else if (line.startsWith('data:')) {
        const data = line.slice(5).trim();
        if (data) {
          try {
            const parsed = JSON.parse(data) as {
              jsonrpc?: string;
              method?: string;
              params?: unknown;
              id?: number;
            };
            this.dispatch(parsed);
          } catch {
            // ignore parse errors
          }
        }
      }
    }
  }

  private dispatch(msg: {
    jsonrpc?: string;
    method?: string;
    params?: unknown;
    id?: number;
  }): void {
    for (const cb of this.listeners) {
      try {
        cb(msg);
      } catch {
        /* ignore */
      }
    }
  }

  reset(): void {
    this.buffer = '';
    this.listeners = [];
  }
}

function isJsonRpcResult(v: unknown): v is JsonRpcResult {
  return typeof v === 'object' && v !== null && 'jsonrpc' in v;
}

/**
 * SSE transport for MCP over HTTP.
 *
 * Uses native fetch API with ReadableStream to consume SSE events.
 * HTTP POST is used to send JSON-RPC requests.
 */
export class SSETransport {
  private state: ConnectionState = 'idle';
  private url: string;
  private headers: Record<string, string>;
  private timeout: number;
  private nextId = 1;
  // NOTE: id-correlation via this map was scaffolded but never populated by
  // `httpPost` — JSON-RPC responses come back synchronously over HTTP, not
  // via the SSE stream. Keep the field reserved for future bidirectional-
  // streaming support; do not wire callsites to it without first deciding
  // who is responsible for clearing it on transport teardown.
  private readonly _reservedPending = new Map<number, (res: JsonRpcResult) => void>();
  private tools: MCPTool[] = [];
  private abortController?: AbortController;
  private reader?: globalThis.ReadableStreamDefaultReader<string>;
  private readerDone = false;
  private disconnectHandlers: Array<() => void> = [];
  private readLoopAbort?: AbortController;
  private readonly toolsChangedListeners = new Set<(tools: MCPTool[]) => void>();

  constructor(opts: HttpTransportOptions) {
    this.url = opts.url;
    this.headers = { ...opts.headers };
    this.timeout = opts.startupTimeoutMs ?? 10_000;
  }

  getState(): ConnectionState {
    return this.state;
  }

  listTools(): MCPTool[] {
    return [...this.tools];
  }

  onDisconnect(cb: () => void): () => void {
    this.disconnectHandlers.push(cb);
    return () => {
      const idx = this.disconnectHandlers.indexOf(cb);
      if (idx >= 0) this.disconnectHandlers.splice(idx, 1);
    };
  }

  onToolsChanged(cb: (tools: MCPTool[]) => void): () => void {
    this.toolsChangedListeners.add(cb);
    return () => {
      this.toolsChangedListeners.delete(cb);
    };
  }

  /** Refresh tool list when server sends notifications/tools/list_changed. */
  private async handleToolsListChanged(): Promise<void> {
    try {
      const res = await this.httpPost('tools/list', {});
      if (!res.error) {
        this.tools = (res.result as { tools?: MCPTool[] } | undefined)?.tools ?? [];
        for (const cb of this.toolsChangedListeners) {
          try {
            cb([...this.tools]);
          } catch {
            /* ignore */
          }
        }
      }
    } catch {
      /* ignore transient failures */
    }
  }

  async connect(): Promise<void> {
    this.state = 'connecting';
    this.abortController = new AbortController();
    const signal = this.abortController.signal;
    const startupTimer = setTimeout(() => this.abortController?.abort(), this.timeout);

    try {
      const sseUrl = this.buildSSEUrl();
      const response = await fetch(sseUrl, {
        headers: this.headers,
        signal,
      });

      if (!response.ok) {
        throw new Error(`SSE connect HTTP ${response.status}: ${response.statusText}`);
      }

      if (!response.body) {
        throw new Error('SSE response has no body');
      }

      const textDecoder = new TextDecoder();
      const sseReader = new SSEReader();
      this.readLoopAbort = new AbortController();

      sseReader.onMessage((msg) => {
        // Future: if the spec evolves to send JSON-RPC responses over SSE
        // (rather than as HTTP POST replies), wire id-correlation here via
        // `_reservedPending`. Today httpPost owns response routing.
        // Server-initiated notifications (no id). Handle list_changed for L2-C.
        if (msg.method && !msg.id) {
          if (msg.method === 'notifications/tools/list_changed') {
            void this.handleToolsListChanged();
          }
        }
      });

      const reader = response.body.getReader();
      this.reader = {
        cancel: () => reader.cancel(),
        releaseLock: () => reader.releaseLock(),
      } as globalThis.ReadableStreamDefaultReader<string>;

      this.readSSEBody(reader, textDecoder, sseReader);

      const initRes = await this.httpPost('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        clientInfo: { name: 'wrongstack', version: '0.1.10' },
      });

      if (initRes.error) {
        throw new Error(`initialize failed: ${initRes.error.message}`);
      }

      try {
        await this.httpPost('notifications/initialized', {});
      } catch {
        // servers may not require it
      }

      const toolsRes = await this.httpPost('tools/list', {});
      if (toolsRes.error) {
        this.tools = [];
      } else {
        const result = toolsRes.result as { tools?: MCPTool[] } | undefined;
        this.tools = result?.tools ?? [];
      }

      this.state = 'connected';
      clearTimeout(startupTimer);
    } catch (err) {
      clearTimeout(startupTimer);
      this.state = 'failed';
      this.abortController.abort();
      throw err;
    }
  }

  private async readSSEBody(
    reader: globalThis.ReadableStreamDefaultReader<Uint8Array>,
    decoder: InstanceType<typeof TextDecoder>,
    sseReader: SSEReader,
  ): Promise<void> {
    try {
      while (!this.readerDone) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        sseReader.feed(chunk);
      }
    } catch {
      // SSE read error — connection lost. Transition to disconnected so
      // callTool and health checks see the correct state, then notify
      // disconnect handlers so the registry can schedule a reconnect.
      if (this.state !== 'disconnected' && this.state !== 'failed') {
        this.state = 'disconnected';
        for (const cb of this.disconnectHandlers) {
          try {
            cb();
          } catch {
            /* ignore */
          }
        }
      }
    }
  }

  private buildSSEUrl(): string {
    try {
      const url = new URL(this.url);
      url.searchParams.set('session', String(Date.now()));
      return url.toString();
    } catch {
      return this.url;
    }
  }

  private async httpPost(method: string, params: unknown): Promise<JsonRpcResult> {
    const id = this.nextId++;
    const body = JSON.stringify({ jsonrpc: '2.0', id, method, params });

    const res = await fetch(this.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...this.headers,
      },
      body,
      signal: this.abortController?.signal,
    });

    if (!res.ok) {
      // Cap the body — a misbehaving server could return megabytes of
      // HTML and that's not useful in an error message anyway.
      const body = await res.text();
      const cap = 1024;
      const snippet =
        body.length > cap ? `${body.slice(0, cap)}… [${body.length} bytes total]` : body;
      throw new Error(`HTTP ${res.status}: ${snippet}`);
    }

    let data: unknown;
    try {
      data = await res.json();
    } catch (err) {
      throw new Error(
        `Invalid JSON-RPC response: ${err instanceof Error ? err.message : 'parse failed'}`,
        { cause: err },
      );
    }
    if (!isJsonRpcResult(data)) {
      throw new Error('Invalid JSON-RPC response: not a JSON-RPC envelope');
    }
    return data;
  }

  async callTool(name: string, input: unknown): Promise<ToolCallResult> {
    if (this.state !== 'connected') {
      throw new Error(`SSE transport not connected (state=${this.state})`);
    }
    const res = await this.httpPost('tools/call', { name, arguments: input });
    if (res.error) {
      return { content: res.error.message, isError: true };
    }
    const result = res.result as { content?: unknown; isError?: boolean } | undefined;
    return {
      content: result?.content ?? '',
      isError: Boolean(result?.isError),
    };
  }

  async close(): Promise<void> {
    // Idempotent — safe to call multiple times.
    if (this.state === 'disconnected') return;
    this.readerDone = true;
    this.readLoopAbort?.abort();
    try {
      this.reader?.cancel();
    } catch {
      /* ignore */
    }
    try {
      this.reader?.releaseLock();
    } catch {
      /* ignore */
    }
    this.abortController?.abort();
    this.disconnectHandlers = [];
    this.state = 'disconnected';
  }
}

/**
 * Streamable HTTP transport for MCP.
 *
 * Uses session-based HTTP with NDJSON responses.
 */
export class StreamableHTTPTransport {
  private state: ConnectionState = 'idle';
  private url: string;
  private headers: Record<string, string>;
  private timeout: number;
  private nextId = 1;
  private tools: MCPTool[] = [];
  private abortController?: AbortController;
  private sessionId?: string;
  private disconnectHandlers: Array<() => void> = [];
  private readonly toolsChangedListeners = new Set<(tools: MCPTool[]) => void>();

  constructor(opts: HttpTransportOptions) {
    this.url = opts.url;
    this.headers = { ...opts.headers };
    this.timeout = opts.startupTimeoutMs ?? 10_000;
  }

  getState(): ConnectionState {
    return this.state;
  }

  listTools(): MCPTool[] {
    return [...this.tools];
  }

  onDisconnect(cb: () => void): () => void {
    this.disconnectHandlers.push(cb);
    return () => {
      const idx = this.disconnectHandlers.indexOf(cb);
      if (idx >= 0) this.disconnectHandlers.splice(idx, 1);
    };
  }

  onToolsChanged(cb: (tools: MCPTool[]) => void): () => void {
    this.toolsChangedListeners.add(cb);
    return () => {
      this.toolsChangedListeners.delete(cb);
    };
  }

  private async handleToolsListChanged(): Promise<void> {
    try {
      const res = await this.postRaw('tools/list', {});
      if (!res.error) {
        this.tools = (res.result as { tools?: MCPTool[] } | undefined)?.tools ?? [];
        for (const cb of this.toolsChangedListeners) {
          try {
            cb([...this.tools]);
          } catch {
            /* ignore */
          }
        }
      }
    } catch {
      /* ignore transient failures */
    }
  }

  async connect(): Promise<void> {
    this.state = 'connecting';
    this.abortController = new AbortController();
    const signal = this.abortController.signal;
    const startupTimer = setTimeout(() => this.abortController?.abort(), this.timeout);

    try {
      const initRes = await fetch(this.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          ...this.headers,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: this.nextId++,
          method: 'initialize',
          params: {
            protocolVersion: '2024-11-05',
            capabilities: { tools: {} },
            clientInfo: { name: 'wrongstack', version: '0.1.10' },
          },
        }),
        signal,
      });

      if (!initRes.ok) {
        throw new Error(`initialize HTTP ${initRes.status}: ${initRes.statusText}`);
      }

      const contentType = initRes.headers.get('content-type') ?? '';
      let data: JsonRpcResult | undefined;

      if (contentType.includes('application/json')) {
        const parsed = await initRes.json();
        if (isJsonRpcResult(parsed)) data = parsed;
      } else {
        const text = await initRes.text();
        const lines = text.split('\n').filter((l) => l.trim());
        for (const line of lines) {
          try {
            const parsed = JSON.parse(line);
            if (isJsonRpcResult(parsed)) {
              data = parsed;
              break;
            }
          } catch {}
        }
      }

      if (!data) {
        throw new Error('Could not parse initialize response');
      }

      if (data.error) {
        throw new Error(`initialize failed: ${data.error.message}`);
      }

      this.sessionId = (initRes.headers.get('x-mcp-session') ?? undefined) as string | undefined;
      await this.postRaw('notifications/initialized', {});

      const toolsRes = await this.postRaw('tools/list', {});
      if (toolsRes.error) {
        this.tools = [];
      } else {
        const result = toolsRes.result as { tools?: MCPTool[] } | undefined;
        this.tools = result?.tools ?? [];
      }

      this.state = 'connected';
      clearTimeout(startupTimer);
    } catch (err) {
      clearTimeout(startupTimer);
      this.state = 'failed';
      this.abortController.abort();
      throw err;
    }
  }

  private async postRaw(method: string, params: unknown): Promise<JsonRpcResult> {
    const id = this.nextId++;
    const body = JSON.stringify({ jsonrpc: '2.0', id, method, params });

    const url = this.sessionId
      ? `${this.url}${this.url.includes('?') ? '&' : '?'}session=${this.sessionId}`
      : this.url;

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        ...(this.sessionId ? { 'x-mcp-session': this.sessionId } : {}),
        ...this.headers,
      },
      body,
      signal: this.abortController?.signal,
    });

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    }

    const text = await res.text();
    const lines = text.split('\n').filter((l) => l.trim());
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line);
        if (isJsonRpcResult(parsed)) return parsed;
      } catch {}
    }
    throw new Error('Could not parse response as JSON-RPC');
  }

  async callTool(name: string, input: unknown): Promise<ToolCallResult> {
    if (this.state !== 'connected') {
      throw new Error(`streamable-http transport not connected (state=${this.state})`);
    }
    const res = await this.postRaw('tools/call', { name, arguments: input });
    if (res.error) {
      return { content: res.error.message, isError: true };
    }
    const result = res.result as { content?: unknown; isError?: boolean } | undefined;
    return {
      content: result?.content ?? '',
      isError: Boolean(result?.isError),
    };
  }

  async close(): Promise<void> {
    if (this.state === 'disconnected') return;
    this.state = 'disconnected';
    this.abortController?.abort();
    // Intentionally do NOT fire disconnect handlers — those trigger
    // reconnection in the registry, which would fight an explicit close().
    this.disconnectHandlers = [];
  }
}
