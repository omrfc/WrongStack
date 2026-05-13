import { spawn, type ChildProcess } from 'node:child_process';

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

/**
 * Lightweight stdio MCP client. Supports JSON-RPC 2.0 over newline-delimited JSON.
 * SSE / streamable-http are stubbed and throw on connect — to be filled by a real impl.
 */
export class MCPClient {
  private state: ConnectionState = 'idle';
  private child?: ChildProcess;
  private nextId = 1;
  private readonly pending = new Map<number, (res: JsonRpcResponse) => void>();
  private rxBuffer = '';
  private tools: MCPTool[] = [];

  constructor(public readonly opts: MCPClientOptions) {}

  getState(): ConnectionState {
    return this.state;
  }

  listTools(): MCPTool[] {
    return [...this.tools];
  }

  async connect(): Promise<void> {
    this.state = 'connecting';
    if (this.opts.transport !== 'stdio') {
      this.state = 'failed';
      throw new Error(`MCP transport "${this.opts.transport}" not supported in this build`);
    }
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
    child.on('exit', () => {
      this.state = 'disconnected';
    });
    child.on('error', () => {
      this.state = 'failed';
    });

    const timeout = this.opts.startupTimeoutMs ?? 10_000;
    const initialize = await Promise.race([
      this.request('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        clientInfo: { name: 'wrongstack', version: '0.0.1' },
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
    } catch {
      // some servers don't require this
    }
    const toolsRes = await this.request('tools/list', {});
    if (toolsRes.error) {
      this.tools = [];
    } else {
      const result = toolsRes.result as { tools?: MCPTool[] } | undefined;
      this.tools = result?.tools ?? [];
    }
    this.state = 'connected';
  }

  async callTool(name: string, input: unknown): Promise<ToolCallResult> {
    if (this.state !== 'connected') {
      throw new Error(`MCP client "${this.opts.name}" not connected (state=${this.state})`);
    }
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
      try {
        this.child.kill();
      } catch {
        // ignore
      }
    }
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
        // Internal buffer full — wait for drain before returning
        await new Promise<void>((resolve) => {
          const timeout = setTimeout(() => resolve(), 100);
          this.child?.stdin?.once('drain', () => {
            clearTimeout(timeout);
            resolve();
          });
        });
      }
    } catch (err) {
      process.emitWarning(
        `[MCP] notify("${method}") failed: ${err instanceof Error ? err.message : String(err)}`,
      );
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
    let msg: JsonRpcResponse;
    try {
      msg = JSON.parse(line) as JsonRpcResponse;
    } catch {
      return;
    }
    if (msg.id !== undefined && this.pending.has(msg.id)) {
      const resolve = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      resolve?.(msg);
    }
  }
}
