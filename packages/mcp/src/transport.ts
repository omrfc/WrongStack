import type { Dispatcher } from 'undici';
import { randomBytes } from 'node:crypto';
import * as https from 'node:https';
import * as net from 'node:net';
import type { ConnectionState, JsonRpcResponse, MCPTool, ToolCallResult } from './client.js';
import { MCP_CONSTANTS } from './constants.js';
import { normalizeMCPTools } from './tool-schema.js';

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
  requestTimeoutMs?: number;
  /**
   * Per-request TLS configuration. When set, an https.Agent is created
   * and passed to fetch via the `dispatch` option. This avoids globally
   * disabling certificate validation (NODE_TLS_REJECT_UNAUTHORIZED) which
   * would affect all provider API calls in the same process.
   * ⚠️ Setting `rejectUnauthorized: false` disables TLS verification for this
   * transport only — an active network attacker between the client and the
   * MCP server can read and modify tool calls and responses. Only use this
   * for local development with self-signed certificates; production MCP
   * servers must present a valid certificate.
   */
  tls?: { ca?: string; rejectUnauthorized?: boolean };
}

/**
 * Validate that an MCP transport URL is not targeting private/internal
 * addresses. This is a defense-in-depth SSRF check — MCP servers are
 * typically local or LAN, but config manipulation could point to metadata
 * endpoints (169.254.169.254) or internal services.
 *
 * The check is intentionally lighter than fetch.ts's assertNotPrivate:
 * MCP URLs are admin-configured, not LLM-supplied, so we only block
 * the most obvious attack vectors.
 */
function validateTransportUrl(rawUrl: string): void {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`MCP transport: invalid URL "${rawUrl}"`);
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(
      `MCP transport: unsupported protocol "${url.protocol}" — only http/https allowed`,
    );
  }

  const hostname = url.hostname;

  // Block cloud metadata endpoints (IMDS) — these are never valid MCP servers
  const ipVersion = net.isIP(hostname);
  if (ipVersion === 4) {
    const parts = hostname.split('.').map(Number);
    // 169.254.x.x (link-local / IMDS)
    if (parts[0] === 169 && parts[1] === 254) {
      throw new Error(
        `MCP transport: blocked link-local/IMDS address "${hostname}" — likely not a valid MCP server`,
      );
    }
  }

  // Plaintext http: is only permitted for loopback addresses where the
  // attacker would already need machine-level access. Remote HTTP MCP servers
  // must use TLS so an active network attacker cannot read or modify tool
  // calls and responses.
  if (url.protocol === 'http:') {
    const isLoopback =
      hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      hostname === '::1' ||
      hostname === '[::1]';
    if (!isLoopback) {
      throw new Error(
        `MCP transport: http:// is only allowed for loopback addresses; use https:// for "${hostname}"`,
      );
    }
  }
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
/** Max data lines buffered per event before flush. Prevents a malicious
 *  server from accumulating unbounded data: lines without a blank-line
 *  delimiter would grow this array indefinitely. */
const SSE_READER_MAX_DATA_LINES = 1024;

export class SSEReader {
  private buffer = '';
  private dataLines: string[] = [];
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
    // Guard against a single chunk that exceeds the buffer cap.
    if (chunk.length > SSE_READER_MAX_BUFFER) {
      throw new Error(
        `SSE: chunk size ${chunk.length} exceeds max buffer ${SSE_READER_MAX_BUFFER} — refusing to accumulate`,
      );
    }
    this.buffer += chunk;
    if (this.buffer.length > SSE_READER_MAX_BUFFER) {
      throw new Error(
        `SSE: pending line exceeds ${SSE_READER_MAX_BUFFER} bytes — upstream is not framing events`,
      );
    }
    let idx = this.buffer.indexOf('\n');
    while (idx !== -1) {
      const line = this.buffer.slice(0, idx).replace(/\r$/, '');
      this.buffer = this.buffer.slice(idx + 1);
      idx = this.buffer.indexOf('\n');

      this.processLine(line);
    }
  }

  private processLine(line: string): void {
    if (line === '') {
      this.flush();
      return;
    }
    if (line.startsWith(':')) return;

    const colonIdx = line.indexOf(':');
    const field = colonIdx === -1 ? line : line.slice(0, colonIdx);
    let value = colonIdx === -1 ? '' : line.slice(colonIdx + 1);
    if (value.startsWith(' ')) value = value.slice(1);

    if (field === 'event') {
      // The current transport only cares about JSON-RPC payloads in data
      // fields. Event names are accepted for spec compatibility.
    } else if (field === 'data') {
      if (this.dataLines.length >= SSE_READER_MAX_DATA_LINES) {
        throw new Error(
          `SSE: exceeded ${SSE_READER_MAX_DATA_LINES} data lines per event — upstream is not sending blank-line delimiters`,
        );
      }
      this.dataLines.push(value);
    }
  }

  private flush(): void {
    if (this.dataLines.length === 0) {
      return;
    }
    const data = this.dataLines.join('\n').trim();
    this.dataLines = [];
    if (!data) return;
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
    this.dataLines = [];
    this.listeners = [];
  }
}

function isJsonRpcResult(v: unknown): v is JsonRpcResult {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as JsonRpcResult;
  if (r.jsonrpc !== '2.0') return false;
  if (r.error !== undefined) {
    return (
      typeof r.error === 'object' &&
      r.error !== null &&
      typeof r.error.code === 'number' &&
      typeof r.error.message === 'string'
    );
  }
  return 'result' in r || r.id === undefined;
}

function assertMatchingJsonRpcResult(
  data: unknown,
  expectedId: number,
  method: string,
): JsonRpcResult {
  if (!isJsonRpcResult(data)) {
    throw new Error('Invalid JSON-RPC response: not a JSON-RPC 2.0 envelope');
  }
  if (data.id !== undefined && data.id !== expectedId) {
    throw new Error(
      `Invalid JSON-RPC response: id mismatch for ${method} (expected ${expectedId}, got ${data.id})`,
    );
  }
  if (data.id === undefined && !method.startsWith('notifications/')) {
    throw new Error(`Invalid JSON-RPC response: missing id for ${method}`);
  }
  return data;
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
  private requestTimeout: number;
  /** Per-request TLS agent — created once from HttpTransportOptions.tls */
  private tlsAgent?: https.Agent;
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
    validateTransportUrl(opts.url);
    this.url = opts.url;
    this.headers = { ...opts.headers };
    this.timeout = opts.startupTimeoutMs ?? 10_000;
    this.requestTimeout = opts.requestTimeoutMs ?? 60_000;
    if (opts.tls) {
      this.tlsAgent = new https.Agent({
        ca: opts.tls.ca,
        rejectUnauthorized: opts.tls.rejectUnauthorized,
      });
    }
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
        this.tools = normalizeMCPTools((res.result as { tools?: unknown } | undefined)?.tools);
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
      const fetchOpts: RequestInit = {
        headers: this.headers,
        signal,
      };
      if (this.tlsAgent) fetchOpts.dispatcher = this.tlsAgent as unknown as Dispatcher;
      const response = await fetch(sseUrl, fetchOpts);

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
        protocolVersion: MCP_CONSTANTS.PROTOCOL_VERSION,
        capabilities: { tools: {} },
        clientInfo: MCP_CONSTANTS.CLIENT_INFO,
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
        const result = toolsRes.result as { tools?: unknown } | undefined;
        this.tools = normalizeMCPTools(result?.tools);
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
      // Cryptographically random session ID instead of timestamp —
      // prevents an attacker on the same LAN from guessing the session
      // param and reconnecting to the SSE stream.
      url.searchParams.set('session', randomBytes(16).toString('hex'));
      return url.toString();
    } catch {
      return this.url;
    }
  }

  private async httpPost(method: string, params: unknown): Promise<JsonRpcResult> {
    const id = this.nextId++;
    const body = JSON.stringify({ jsonrpc: '2.0', id, method, params });

    const timeoutSignal = createTimeoutSignal(this.abortController?.signal, this.requestTimeout);
    const fetchOpts: RequestInit = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...this.headers,
      },
      body,
      signal: timeoutSignal.signal,
    };
    if (this.tlsAgent) fetchOpts.dispatcher = this.tlsAgent as unknown as Dispatcher;
    const res = await fetch(this.url, fetchOpts);

    try {
      if (!res.ok) {
        // Cap the body — a misbehaving server could return megabytes of
        // HTML and that's not useful in an error message anyway.
        const body = await res.text();
        const cap = MCP_CONSTANTS.REQUEST_LOG_CAP;
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
      return assertMatchingJsonRpcResult(data, id, method);
    } finally {
      timeoutSignal.dispose();
    }
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

  /** Generic JSON-RPC request — used by MCPClient.request() for SSE transports. */
  async request(method: string, params: unknown, timeoutMs?: number): Promise<JsonRpcResponse> {
    const id = this.nextId++;
    const body = JSON.stringify({ jsonrpc: '2.0', id, method, params });

    const timeoutSignal = createTimeoutSignal(this.abortController?.signal, timeoutMs ?? this.requestTimeout);
    const fetchOpts: RequestInit = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...this.headers,
      },
      body,
      signal: timeoutSignal.signal,
    };
    if (this.tlsAgent) fetchOpts.dispatcher = this.tlsAgent as unknown as Dispatcher;
    const res = await fetch(this.url, fetchOpts);

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${res.statusText}`);
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
    const result = assertMatchingJsonRpcResult(data, id, method);
    timeoutSignal.dispose();
    return { jsonrpc: '2.0', id, result: result.result, error: result.error };
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
  private requestTimeout: number;
  /** Per-request TLS agent — created once from HttpTransportOptions.tls */
  private tlsAgent?: https.Agent;
  private nextId = 1;
  private tools: MCPTool[] = [];
  private abortController?: AbortController;
  private sessionId?: string;
  private disconnectHandlers: Array<() => void> = [];
  private readonly toolsChangedListeners = new Set<(tools: MCPTool[]) => void>();

  constructor(opts: HttpTransportOptions) {
    validateTransportUrl(opts.url);
    this.url = opts.url;
    this.headers = { ...opts.headers };
    this.timeout = opts.startupTimeoutMs ?? 10_000;
    this.requestTimeout = opts.requestTimeoutMs ?? 60_000;
    if (opts.tls) {
      this.tlsAgent = new https.Agent({
        ca: opts.tls.ca,
        rejectUnauthorized: opts.tls.rejectUnauthorized,
      });
    }
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
        this.tools = normalizeMCPTools((res.result as { tools?: unknown } | undefined)?.tools);
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
      const initFetchOpts: RequestInit = {
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
            protocolVersion: MCP_CONSTANTS.PROTOCOL_VERSION,
            capabilities: { tools: {} },
            clientInfo: MCP_CONSTANTS.CLIENT_INFO,
          },
        }),
        signal,
      };
      if (this.tlsAgent) initFetchOpts.dispatcher = this.tlsAgent as unknown as Dispatcher;
      const initRes = await fetch(this.url, initFetchOpts);

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
      data = assertMatchingJsonRpcResult(data, this.nextId - 1, 'initialize');

      if (data.error) {
        throw new Error(`initialize failed: ${data.error.message}`);
      }

      this.sessionId = (initRes.headers.get('x-mcp-session') ?? undefined) as string | undefined;
      await this.postRaw('notifications/initialized', {});

      const toolsRes = await this.postRaw('tools/list', {});
      if (toolsRes.error) {
        this.tools = [];
      } else {
        const result = toolsRes.result as { tools?: unknown } | undefined;
        this.tools = normalizeMCPTools(result?.tools);
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

    const timeoutSignal = createTimeoutSignal(this.abortController?.signal, this.requestTimeout);
    const fetchOpts: RequestInit = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        ...(this.sessionId ? { 'x-mcp-session': this.sessionId } : {}),
        ...this.headers,
      },
      body,
      signal: timeoutSignal.signal,
    };
    if (this.tlsAgent) fetchOpts.dispatcher = this.tlsAgent as unknown as Dispatcher;
    const res = await fetch(url, fetchOpts);

    try {
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      }

      const text = await res.text();
      const lines = text.split('\n').filter((l) => l.trim());
      for (const line of lines) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {}
        if (isJsonRpcResult(parsed)) {
          return assertMatchingJsonRpcResult(parsed, id, method);
        }
      }
      throw new Error('Could not parse response as JSON-RPC');
    } finally {
      timeoutSignal.dispose();
    }
  }

  /** Generic JSON-RPC request — used by MCPClient.request() for SSE/streamable-http transports. */
  async request(method: string, params: unknown, timeoutMs?: number): Promise<JsonRpcResponse> {
    const id = this.nextId++;
    const body = JSON.stringify({ jsonrpc: '2.0', id, method, params });

    const url = this.sessionId
      ? `${this.url}${this.url.includes('?') ? '&' : '?'}session=${this.sessionId}`
      : this.url;

    const timeoutSignal = createTimeoutSignal(this.abortController?.signal, timeoutMs ?? this.requestTimeout);
    const fetchOpts: RequestInit = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        ...(this.sessionId ? { 'x-mcp-session': this.sessionId } : {}),
        ...this.headers,
      },
      body,
      signal: timeoutSignal.signal,
    };
    if (this.tlsAgent) fetchOpts.dispatcher = this.tlsAgent as unknown as Dispatcher;
    const res = await fetch(url, fetchOpts);

    try {
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      }

      const text = await res.text();
      const lines = text.split('\n').filter((l) => l.trim());
      for (const line of lines) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {}
        if (isJsonRpcResult(parsed)) {
          // Convert JsonRpcResult to JsonRpcResponse
          return {
            jsonrpc: '2.0',
            id,
            result: parsed.result,
            error: parsed.error,
          };
        }
      }
      throw new Error('Could not parse response as JSON-RPC');
    } finally {
      timeoutSignal.dispose();
    }
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

function createTimeoutSignal(
  parent: AbortSignal | undefined,
  timeoutMs: number,
): { signal: AbortSignal; dispose: () => void } {
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort(parent?.reason);
  if (parent?.aborted) {
    ctrl.abort(parent.reason);
  } else {
    parent?.addEventListener('abort', onAbort, { once: true });
  }
  const timer = setTimeout(
    () => ctrl.abort(new Error(`MCP HTTP request timed out after ${timeoutMs}ms`)),
    timeoutMs,
  );
  return {
    signal: ctrl.signal,
    dispose: () => {
      clearTimeout(timer);
      parent?.removeEventListener('abort', onAbort);
    },
  };
}
