import { spawn, type ChildProcess } from 'node:child_process';
import { SSETransport, StreamableHTTPTransport, type HttpTransportOptions } from './transport.js';

export type Transport = 'stdio' | 'sse' | 'streamable-http';

export interface MCPClientOptions {
  name: string;
  transport: Transport;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  startupTimeoutMs?: number;
}

export type ConnectionState =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'disconnected'
  | 'reconnecting'
  | 'failed';

export interface MCPTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export interface ToolCallResult {
  content: unknown;
  isError: boolean;
}

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

type ExitListener = (name: string, code: number | null, signal: string | null) => void;
/**
 * Fired when the server sends `notifications/tools/list_changed`. The
 * client refreshes its cached tool list before invoking listeners, so
 * subscribers can call `listTools()` for the fresh set.
 */
type ToolsChangedListener = (name: string, tools: MCPTool[]) => void;

/**
 * Lightweight MCP client supporting three transport types:
 * - stdio: spawns a child process and communicates over pipes
 * - sse: connects to an HTTP SSE endpoint for server events, POST for requests
 * - streamable-http: session-based HTTP transport with NDJSON responses
 */
export class MCPClient {
  private state: ConnectionState = 'idle';
  private child?: ChildProcess;
  private nextId = 1;
  private readonly pending = new Map<number, (res: JsonRpcResponse) => void>();
  private rxBuffer = '';
  private _tools: MCPTool[] = [];
  /** Cached tool list — survives reconnects so the registry can re-register without re-discovering. */
  private _toolsCache?: MCPTool[];
  private _drainPending = false;
  private _lastNotifySkipped = false;
  // HTTP transports
  private sseTransport?: SSETransport;
  private httpTransport?: StreamableHTTPTransport;
  /** Notified when the stdio child process exits so the registry can attempt reconnect. */
  private readonly exitListeners = new Set<ExitListener>();
  /** Notified when the server announces a tools/list_changed notification. */
  private readonly toolsChangedListeners = new Set<ToolsChangedListener>();
  /** Notified when an HTTP transport (SSE or streamable-http) disconnects. */
  private readonly disconnectListeners = new Set<() => void>();

  constructor(public readonly opts: MCPClientOptions) {}

  getState(): ConnectionState {
    return this.state;
  }

  listTools(): MCPTool[] {
    return this._tools.length > 0 ? [...this._tools] : this._toolsCache ? [...this._toolsCache] : [];
  }

  /** Returns true if a prior notify() call was skipped due to backpressure. */
  hadNotifySkipped(): boolean {
    return this._lastNotifySkipped;
  }

  /**
   * Register a listener for child-process exit events.
   * The registry uses this to trigger reconnection.
   */
  addExitListener(listener: ExitListener): void {
    this.exitListeners.add(listener);
  }

  removeExitListener(listener: ExitListener): void {
    this.exitListeners.delete(listener);
  }

  /**
   * Register a listener for transport disconnect events (SSE / streamable-http).
   * Used by the registry to trigger reconnection for HTTP-based servers.
   */
  addDisconnectListener(listener: () => void): void {
    this.disconnectListeners.add(listener);
  }

  removeDisconnectListener(listener: () => void): void {
    this.disconnectListeners.delete(listener);
  }

  async connect(): Promise<void> {
    this.state = 'connecting';

    if (this.opts.transport === 'stdio') {
      await this.connectStdio();
    } else if (this.opts.transport === 'sse') {
      await this.connectSSE();
    } else if (this.opts.transport === 'streamable-http') {
      await this.connectStreamableHTTP();
    } else {
      this.state = 'failed';
      throw new Error(`Unknown transport "${this.opts.transport}"`);
    }
  }

  private async connectStdio(): Promise<void> {
    if (!this.opts.command) {
      this.state = 'failed';
      throw new Error('MCP stdio transport requires "command"');
    }

    const child = spawn(this.opts.command, this.opts.args ?? [], {
      env: { ...process.env, ...this.opts.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;

    child.stdout?.on('data', (chunk: Buffer) => this.onData(chunk.toString()));
    child.stderr?.on('data', () => {
      // intentionally discard stderr noise from server
    });
    child.on('exit', (code, signal) => {
      this.state = 'disconnected';
      for (const listener of this.exitListeners) {
        try { listener(this.opts.name, code, signal); } catch { /* ignore */ }
      }
    });
    child.on('error', () => {
      this.state = 'failed';
    });

    const timeout = this.opts.startupTimeoutMs ?? 10_000;
    const initialize = await Promise.race([
      this.request('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        clientInfo: { name: 'wrongstack', version: '0.1.1' },
      }),
      new Promise<JsonRpcResponse>((_, rej) =>
        setTimeout(() => rej(new Error('MCP initialize timeout')), timeout),
      ),
    ]);
    if (initialize.error) {
      this.state = 'failed';
      throw new Error(`MCP initialize failed: ${initialize.error.message}`);
    }
    try {
      await this.notify('notifications/initialized', {});
    } catch (err) {
      console.warn(
        '[MCP] notify("notifications/initialized") failed for "' + this.opts.name + '": ' + (err instanceof Error ? err.message : String(err)),
      );
    }
    const toolsRes = await this.request('tools/list', {});
    if (toolsRes.error) {
      this._tools = [];
    } else {
      const result = toolsRes.result as { tools?: MCPTool[] } | undefined;
      this._tools = result?.tools ?? [];
    }
    // Cache tools so reconnect can re-register without re-discovering
    this._toolsCache = this._tools;
    this.state = 'connected';
  }

  private async connectSSE(): Promise<void> {
    if (!this.opts.url) {
      this.state = 'failed';
      throw new Error('MCP SSE transport requires "url"');
    }
    const httpOpts: HttpTransportOptions = {
      name: this.opts.name,
      url: this.opts.url,
      headers: this.opts.headers,
      startupTimeoutMs: this.opts.startupTimeoutMs,
    };
    this.sseTransport = new SSETransport(httpOpts);
    this.sseTransport.onDisconnect(() => {
      this.state = 'disconnected';
      for (const cb of this.disconnectListeners) {
        try { cb(); } catch { /* ignore */ }
      }
    });
    this.sseTransport.onToolsChanged((tools) => {
      this._tools = tools;
      for (const cb of this.toolsChangedListeners) {
        try { cb(this.opts.name, tools); } catch { /* ignore */ }
      }
    });
    try {
      await this.sseTransport.connect();
    } catch (err) {
      this.state = 'failed';
      throw err;
    }
    this._tools = this.sseTransport.listTools();
    this._toolsCache = this._tools;
    this.state = 'connected';
  }

  private async connectStreamableHTTP(): Promise<void> {
    if (!this.opts.url) {
      this.state = 'failed';
      throw new Error('MCP streamable-http transport requires "url"');
    }
    const httpOpts: HttpTransportOptions = {
      name: this.opts.name,
      url: this.opts.url,
      headers: this.opts.headers,
      startupTimeoutMs: this.opts.startupTimeoutMs,
    };
    this.httpTransport = new StreamableHTTPTransport(httpOpts);
    this.httpTransport.onDisconnect(() => {
      this.state = 'disconnected';
      for (const cb of this.disconnectListeners) {
        try { cb(); } catch { /* ignore */ }
      }
    });
    this.httpTransport.onToolsChanged((tools) => {
      this._tools = tools;
      for (const cb of this.toolsChangedListeners) {
        try { cb(this.opts.name, tools); } catch { /* ignore */ }
      }
    });
    try {
      await this.httpTransport.connect();
    } catch (err) {
      this.state = 'failed';
      throw err;
    }
    this._tools = this.httpTransport.listTools();
    this._toolsCache = this._tools;
    this.state = 'connected';
  }

  async callTool(name: string, input: unknown): Promise<ToolCallResult> {
    if (this.state !== 'connected') {
      throw new Error(`MCP client "${this.opts.name}" not connected (state=${this.state})`);
    }
    // Delegate to the active transport
    if (this.sseTransport) {
      return this.sseTransport.callTool(name, input);
    }
    if (this.httpTransport) {
      return this.httpTransport.callTool(name, input);
    }
    // stdio
    const res = await this.request('tools/call', { name, arguments: input });
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
    if (this.child) {
      const child = this.child;
      const exitPromise = child.exitCode === null && child.signalCode === null
        ? new Promise<void>((resolve) => child.once('exit', () => resolve()))
        : Promise.resolve();
      try {
        child.kill();
      } catch {
        // ignore
      }
      // Wait for actual exit so exit-listener consumers see the event before
      // close() resolves. Cap the wait so a hung child can't pin us forever.
      await Promise.race([
        exitPromise,
        new Promise<void>((resolve) => setTimeout(resolve, 1000)),
      ]);
    }
    this.sseTransport?.close();
    this.httpTransport?.close();
    this.state = 'disconnected';
  }

  private request(method: string, params: unknown): Promise<JsonRpcResponse> {
    const id = this.nextId++;
    const req: JsonRpcRequest = { jsonrpc: '2.0', id, method, params };
    return new Promise((resolve, reject) => {
      this.pending.set(id, resolve);
      try {
        this.child?.stdin?.write(JSON.stringify(req) + '\n');
      } catch (err) {
        this.pending.delete(id);
        reject(err);
      }
    });
  }

  private async notify(method: string, params: unknown): Promise<void> {
    const req = { jsonrpc: '2.0', method, params };
    const encoded = JSON.stringify(req) + '\n';
    try {
      const ok = this.child?.stdin?.write(encoded);
      if (!ok) {
        // Only the first caller waits for drain; others just warn and return.
        // This avoids a race where two concurrent notify() calls each start
        // their own drain-wait, then both resolve and the buffer is still full.
        if (this._drainPending) {
          this._lastNotifySkipped = true;
          process.emitWarning(
            `[MCP] notify("${method}") skipped: stdin buffer backpressure (already waiting for drain)`,
          );
          return;
        }
        this._drainPending = true;
        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => {
            this._drainPending = false;
            reject(new Error(`MCP notify("${method}") drain timeout`));
          }, 500);
          this.child?.stdin?.once('drain', () => {
            clearTimeout(timeout);
            this._drainPending = false;
            resolve();
          });
          this.child?.stdin?.once('error', (err) => {
            clearTimeout(timeout);
            this._drainPending = false;
            reject(err);
          });
        });
      }
    } catch (err) {
      throw new Error(`[MCP] notify("${method}") failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private onData(s: string): void {
    this.rxBuffer += s;
    let idx = this.rxBuffer.indexOf('\n');
    while (idx !== -1) {
      const line = this.rxBuffer.slice(0, idx).trim();
      this.rxBuffer = this.rxBuffer.slice(idx + 1);
      if (line) this.onLine(line);
      idx = this.rxBuffer.indexOf('\n');
    }
  }

  private onLine(line: string): void {
    let msg: JsonRpcResponse & { method?: string; params?: unknown };
    try {
      msg = JSON.parse(line) as JsonRpcResponse & { method?: string; params?: unknown };
    } catch {
      return;
    }
    if (msg.id !== undefined && this.pending.has(msg.id)) {
      const resolve = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      resolve?.(msg);
      return;
    }
    // Notifications have a `method` but no `id`. The MCP spec defines
    // `notifications/tools/list_changed` for tool-set invalidation —
    // refresh the cache asynchronously and fire listeners so the
    // registry can re-register the wrapped tools.
    if (typeof msg.method === 'string' && msg.method === 'notifications/tools/list_changed') {
      void this.handleToolsListChanged();
    }
  }

  /**
   * L2-C: refresh the cached tool list when the server announces a
   * `tools/list_changed`. Listeners (the registry) re-wrap and
   * re-register. Failures are swallowed — a stale cache is preferable
   * to a hard crash on a transient notification glitch.
   */
  private async handleToolsListChanged(): Promise<void> {
    try {
      const toolsRes = await this.request('tools/list', {});
      const tools = ((toolsRes.result as { tools?: MCPTool[] } | undefined)?.tools ?? []).filter(
        (t): t is MCPTool => !!t && typeof t.name === 'string',
      );
      this._tools = tools;
      this._toolsCache = tools;
      for (const listener of this.toolsChangedListeners) {
        try {
          listener(this.opts.name, [...tools]);
        } catch {
          // listeners must be best-effort
        }
      }
    } catch {
      // ignore — keep the existing cache
    }
  }

  addToolsChangedListener(listener: ToolsChangedListener): void {
    this.toolsChangedListeners.add(listener);
  }

  removeToolsChangedListener(listener: ToolsChangedListener): void {
    this.toolsChangedListeners.delete(listener);
  }
}