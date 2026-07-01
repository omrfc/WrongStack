import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { expectDefined } from '@wrongstack/core';
import { toErrorMessage } from '@wrongstack/core/utils';
import { MCP_CONSTANTS } from './constants.js';
/**
 * Server-side MCP. The mirror image of `MCPClient`: instead of consuming a
 * remote MCP server, this lets WrongStack *be* an MCP server — exposing its
 * tools to any MCP client (Claude Desktop, another agent, an IDE) over a
 * JSON-RPC 2.0 stream.
 *
 * The protocol core (`MCPServer`) is transport-agnostic: feed it a raw JSON
 * line via `handleMessage`, get back a response string (or `null` for
 * notifications). `serveStdio` wires it to stdin/stdout for the canonical
 * stdio transport.
 */

/** A tool descriptor advertised over `tools/list`. */
export interface MCPServerTool {
  name: string;
  description?: string | undefined;
  inputSchema: Record<string, unknown>;
}

/** The result of a `tools/call`, as the host produces it. */
export interface MCPServerCallResult {
  /** Text or pre-built MCP content blocks. Strings are wrapped as a text block. */
  content: unknown;
  isError: boolean;
}

/**
 * Bridges the MCP server to a tool backend (in the CLI, the `ToolRegistry`).
 * Kept narrow so the protocol core has no dependency on `@wrongstack/core`.
 */
export interface MCPServerToolHost {
  listTools(): MCPServerTool[] | Promise<MCPServerTool[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<MCPServerCallResult>;
}

export interface MCPServerLogger {
  warn?(msg: string): void;
  info?(msg: string): void;
}

export interface MCPServerOptions {
  host: MCPServerToolHost;
  /** Advertised in the `initialize` handshake. Defaults to the wrongstack identity. */
  serverInfo?: { name: string; version: string };
  logger?: MCPServerLogger | undefined;
}

interface JsonRpcRequest {
  jsonrpc?: string | undefined;
  id?: number | string | null | undefined;
  method?: string | undefined;
  params?: unknown | undefined;
}

// JSON-RPC 2.0 reserved error codes.
const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INTERNAL_ERROR = -32603;

export class MCPServer {
  private readonly host: MCPServerToolHost;
  private readonly serverInfo: { name: string; version: string };
  private readonly logger?: MCPServerLogger | undefined;

  constructor(opts: MCPServerOptions) {
    this.host = opts.host;
    this.serverInfo = opts.serverInfo ?? {
      name: MCP_CONSTANTS.CLIENT_INFO.name,
      version: MCP_CONSTANTS.CLIENT_INFO.version,
    };
    this.logger = opts.logger;
  }

  /**
   * Handle one raw JSON-RPC line. Returns the response JSON string for
   * requests, or `null` for notifications (no `id`) and for blank input —
   * the caller should write the string to its output stream when non-null.
   */
  async handleMessage(raw: string): Promise<string | null> {
    const line = raw.trim();
    if (!line) return null;

    let msg: JsonRpcRequest;
    try {
      msg = JSON.parse(line) as JsonRpcRequest;
    } catch {
      return this.encodeError(null, PARSE_ERROR, 'Parse error');
    }

    if (typeof msg !== 'object' || msg === null || typeof msg.method !== 'string') {
      const id = msg && typeof msg === 'object' ? (msg.id ?? null) : null;
      return this.encodeError(id ?? null, INVALID_REQUEST, 'Invalid Request');
    }

    const isNotification = msg.id === undefined || msg.id === null;

    // Notifications never get a response. We still dispatch known ones for
    // side effects, but `notifications/initialized` is purely a handshake ack.
    if (isNotification) {
      return null;
    }

    try {
      const result = await this.dispatch(msg.method, msg.params);
      if (result === METHOD_NOT_FOUND_SENTINEL) {
        return this.encodeError(
          expectDefined(msg.id),
          METHOD_NOT_FOUND,
          `Method not found: ${msg.method}`,
        );
      }
      return JSON.stringify({ jsonrpc: '2.0', id: msg.id, result });
    } catch (err) {
      const message = toErrorMessage(err);
      this.logger?.warn?.(`MCP server: method "${msg.method}" threw: ${message}`);
      return this.encodeError(expectDefined(msg.id), INTERNAL_ERROR, message);
    }
  }

  private async dispatch(method: string, params: unknown): Promise<unknown> {
    switch (method) {
      case 'initialize':
        return {
          protocolVersion: MCP_CONSTANTS.PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: this.serverInfo,
        };
      case 'ping':
        return {};
      case 'tools/list': {
        const tools = await this.host.listTools();
        return { tools };
      }
      case 'tools/call': {
        const p = (params ?? {}) as { name?: unknown | undefined; arguments?: unknown | undefined };
        if (typeof p.name !== 'string') {
          throw new Error('tools/call requires a string "name"');
        }
        const args =
          p.arguments && typeof p.arguments === 'object' && !Array.isArray(p.arguments)
            ? (p.arguments as Record<string, unknown>)
            : {};
        const res = await this.host.callTool(p.name, args);
        return { content: toContentBlocks(res.content), isError: res.isError };
      }
      default:
        return METHOD_NOT_FOUND_SENTINEL;
    }
  }

  private encodeError(id: number | string | null, code: number, message: string): string {
    return JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } });
  }
}

const METHOD_NOT_FOUND_SENTINEL = Symbol('method-not-found');

/** Normalize a host result's content into MCP content blocks. */
export function toContentBlocks(content: unknown): Array<{ type: 'text'; text: string }> {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  if (Array.isArray(content)) {
    // Already-shaped content blocks pass through; otherwise stringify each item.
    const allBlocks = content.every(
      (c) => c && typeof c === 'object' && (c as { type?: unknown | undefined }).type === 'text',
    );
    if (allBlocks) return content as Array<{ type: 'text'; text: string }>;
    return [{ type: 'text', text: content.map((c) => stringifyItem(c)).join('\n') }];
  }
  if (content === undefined || content === null) return [{ type: 'text', text: '' }];
  return [{ type: 'text', text: stringifyItem(content) }];
}

function stringifyItem(c: unknown): string {
  if (typeof c === 'string') return c;
  try {
    return JSON.stringify(c);
  } catch {
    return String(c);
  }
}

export interface ServeStdioHandle {
  /** Stop reading and detach listeners. Does not exit the process. */
  close(): void;
  /** Resolves when the input stream ends (EOF). */
  done: Promise<void>;
}

export interface ServeStdioOptions {
  stdin?: NodeJS.ReadableStream | undefined;
  stdout?: NodeJS.WritableStream | undefined;
}

/**
 * Run an `MCPServer` over stdio: newline-delimited JSON-RPC in on stdin,
 * responses out on stdout. CRITICAL: nothing else may write to stdout while
 * this runs — it is the JSON-RPC channel. Route all logging to stderr.
 */
export function serveStdio(server: MCPServer, opts: ServeStdioOptions = {}): ServeStdioHandle {
  const stdin: NodeJS.ReadableStream = opts.stdin ?? process.stdin;
  const stdout = opts.stdout ?? process.stdout;
  let buffer = '';
  let closed = false;
  let bufferTooLarge = false;
  // Serialize writes so concurrent async handlers don't interleave lines.
  let writeChain: Promise<void> = Promise.resolve();

  const writeLine = (s: string) => {
    writeChain = writeChain
      .then(
        () =>
          new Promise<void>((resolve) => {
            stdout.write(`${s}\n`, () => resolve());
          }),
      )
      .catch((err) => {
        const msg = toErrorMessage(err);
        console.error(
          JSON.stringify({
            level: 'error',
            event: 'mcp_server.stdout_write_failed',
            message: msg,
            timestamp: new Date().toISOString(),
          }),
        );
      });
  };

  const onData = (chunk: Buffer | string) => {
    // A misbehaving peer that streams bytes forever without `\n` would
    // otherwise balloon `buffer` indefinitely. Mirror the HTTP body cap
    // (`HTTP_BODY_CAP` below) — once exceeded, abandon the line, drop the
    // unread tail, and shut down so the caller can react.
    if (bufferTooLarge) return;
    buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    if (buffer.length > HTTP_BODY_CAP) {
      bufferTooLarge = true;
      buffer = '';
      console.error(
        JSON.stringify({
          level: 'error',
          event: 'mcp_server.line_buffer_overflow',
          message: `stdio line exceeded ${HTTP_BODY_CAP} bytes without newline — aborting stream`,
          timestamp: new Date().toISOString(),
        }),
      );
      // Pause and tear down further reads so the caller sees a clean end.
      // `destroy()` is called WITHOUT an error so the stream's 'error' event
      // isn't emitted (PassThrough/mocked streams would otherwise emit
      // unhandled 'error' that callers must drain).
      try {
        (stdin as { pause?: () => void }).pause?.();
        (stdin as { destroy?: () => void }).destroy?.();
      } catch {
        /* ignore */
      }
      onEnd();
      return;
    }
    let idx = buffer.indexOf('\n');
    while (idx !== -1) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      idx = buffer.indexOf('\n');
      if (!line.trim()) continue;
      void server
        .handleMessage(line)
        .then((res) => {
          // Always flush responses for in-flight requests, even after
          // the stream ended: `done` waits on writeChain, so dropping a
          // late response here would mean `done` resolves without that
          // line ever landing on stdout. Stopping new reads is `onEnd`'s
          // job — not gating writes.
          if (res !== null) writeLine(res);
        })
        .catch((err) => {
          // Malformed JSON from a peer — log and continue so one bad line
          // doesn't kill the entire session.
          console.error(
            JSON.stringify({
              level: 'error',
              event: 'mcp_server.handle_message_failed',
              message: toErrorMessage(err),
              timestamp: new Date().toISOString(),
            }),
          );
        });
    }
  };

  let resolveDone!: () => void;
  // `done` resolves once the stream has closed AND any in-flight writes have
  // drained. Without the writeChain tail-call, a caller that awaits
  // `handle.done` after stdin ends could see `done` resolve before the last
  // response line lands on stdout — useful, e.g., for closing a wrapper
  // process and being sure the stdout pipe is fully flushed.
  const done = new Promise<void>((resolve) => {
    resolveDone = () => {
      // Chain onto writeChain so `done` only resolves once writes drain.
      void writeChain.then(() => resolve());
    };
  });

  const onEnd = () => {
    if (closed) return;
    closed = true;
    stdin.off('data', onData);
    resolveDone();
  };

  stdin.on('data', onData);
  stdin.once('end', onEnd);
  stdin.once('close', onEnd);
  if (typeof (stdin as { resume?: () => void }).resume === 'function') {
    (stdin as { resume: () => void }).resume();
  }

  return {
    close: () => {
      onEnd();
    },
    done,
  };
}

// ── HTTP transport ──────────────────────────────────────────────────────────

const HTTP_BODY_CAP = 4 * 1024 * 1024; // 4 MiB

export interface ServeHttpOptions {
  /** TCP port. 0 picks an ephemeral port (resolved in the handle). Default 0. */
  port?: number | undefined;
  /** Bind address. Default '127.0.0.1' (loopback only). */
  host?: string | undefined;
  /**
   * Bearer token required on every request (`Authorization: Bearer <token>`).
   * REQUIRED when binding to a non-loopback host — `serveHttp` refuses to
   * expose tools to the network without one.
   */
  token?: string | undefined;
  logger?: MCPServerLogger | undefined;
}

export interface ServeHttpHandle {
  port: number;
  host: string;
  url: string;
  close(): Promise<void>;
}

function isLoopbackHost(host: string): boolean {
  return host === '127.0.0.1' || host === '::1' || host === 'localhost';
}

/**
 * Run an `MCPServer` over HTTP: POST a single JSON-RPC request, get the JSON
 * response (notifications → 202 with no body). Reuses `handleMessage`, so the
 * protocol is identical to the stdio transport.
 *
 * Security: binds to loopback by default. Binding to any other host (e.g.
 * `0.0.0.0`) REQUIRES a `token` — otherwise this rejects, because it would
 * otherwise expose tool execution to the whole network unauthenticated.
 */
export function serveHttp(
  server: MCPServer,
  opts: ServeHttpOptions = {},
): Promise<ServeHttpHandle> {
  const host = opts.host ?? '127.0.0.1';
  const port = opts.port ?? 0;
  const token = opts.token;
  const log = opts.logger;

  if (!isLoopbackHost(host) && !token) {
    return Promise.reject(
      new Error(
        `serveHttp: refusing to bind to non-loopback host "${host}" without a token — ` +
          'pass a token to expose tools to the network, or bind to 127.0.0.1.',
      ),
    );
  }

  const httpServer = createServer((req: IncomingMessage, res: ServerResponse) => {
    void handleHttpRequest(server, req, res, token, log);
  });

  return new Promise<ServeHttpHandle>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(port, host, () => {
      httpServer.removeListener('error', reject);
      const addr = httpServer.address();
      const boundPort = typeof addr === 'object' && addr ? addr.port : port;
      const displayHost = host === '::1' ? '[::1]' : host;
      resolve({
        port: boundPort,
        host,
        url: `http://${displayHost}:${boundPort}/`,
        close: () =>
          new Promise<void>((res2) => {
            httpServer.close(() => res2());
          }),
      });
    });
  });
}

async function handleHttpRequest(
  server: MCPServer,
  req: IncomingMessage,
  res: ServerResponse,
  token: string | undefined,
  log: MCPServerLogger | undefined,
): Promise<void> {
  const send = (status: number, body: string, type = 'application/json') => {
    res.writeHead(status, { 'content-type': type });
    res.end(body);
  };

  // Health probe.
  if (req.method === 'GET') {
    return send(200, JSON.stringify({ status: 'ok', server: 'wrongstack-mcp' }));
  }
  if (req.method !== 'POST') {
    return send(405, JSON.stringify({ error: 'method not allowed' }));
  }
  if (token) {
    const auth = req.headers.authorization ?? '';
    const expected = `Bearer ${token}`;
    if (auth !== expected) {
      return send(401, JSON.stringify({ error: 'unauthorized' }));
    }
  }

  let body = '';
  let tooLarge = false;
  req.on('data', (chunk: Buffer) => {
    if (tooLarge) return;
    body += chunk.toString('utf8');
    if (body.length > HTTP_BODY_CAP) {
      tooLarge = true;
      send(413, JSON.stringify({ error: 'payload too large' }));
      req.destroy();
    }
  });
  req.on('end', () => {
    if (tooLarge) return;
    void server
      .handleMessage(body)
      .then((out) => {
        // Notifications produce no response body.
        if (out === null) return send(202, '');
        return send(200, out);
      })
      .catch((err) => {
        log?.warn?.(`MCP http handler error: ${toErrorMessage(err)}`);
        send(500, JSON.stringify({ error: 'internal error' }));
      });
  });
}
