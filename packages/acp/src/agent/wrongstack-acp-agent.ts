/**
 * WrongStackACPServer — ACP v1 server-side entry point.
 *
 * Exposes WrongStack as an ACP-compatible agent. ACP clients (Zed, JetBrains
 * Junie, VS Code ACP extension) spawn this as a subprocess, send JSON-RPC
 * messages over stdio, and receive v1-protocol responses.
 *
 * Usage:
 *   node dist/agent/wrongstack-acp-agent.js
 *
 * Or via the CLI:
 *   wstack acp-server
 *
 * Wiring a real agent: this class is the surface; the bootstrap
 * binary uses a no-op echo by default so the binary is a useful
 * connectivity smoke test. For a real server, instantiate
 * `WrongStackACPServer` programmatically and pass a `runTurn`
 * produced by `makeACPServerAgentTurn({ agentFor: ... })` from
 * `./server-agent-turn.js`. The factory is responsible for building
 * a real core `Agent` (with the right provider, model, system prompt,
 * etc.) per session.
 *
 * Startup: stdout is JSON-RPC only by default. The legacy `[wstack-acp]\n`
 * marker can be enabled for older internal harnesses with
 * `legacyStartupMarker`, but ACP clients should rely on v1 initialize.
 */
import { fileURLToPath } from 'node:url';
import { createServer, type Server } from 'node:http';
import { writeErr } from '@wrongstack/core';
import type { ACPMessage } from '../types/acp-messages.js';
import {
  ACPProtocolHandler,
  type RunTurn,
  type RunTurnResult,
  type SessionPersistence,
} from './protocol-handler.js';
import { StdioTransport } from './stdio-transport.js';

export interface WrongStackACPServerOptions {
  runTurn?: RunTurn | undefined;
  defaultCwd?: string | undefined;
  agentName?: string | undefined;
  /**
   * Transport mode. 'stdio' (default) communicates over stdin/stdout.
   * When a number is provided, the server listens as an HTTP server on
   * that port, accepting Streamable HTTP (JSON-RPC over HTTP POST).
   */
  transport?: 'stdio' | number | undefined;
  /** Host for HTTP transport. Defaults to '127.0.0.1'. */
  host?: string | undefined;
  /** Emit the pre-v1 startup marker on stdio. Defaults to false. */
  legacyStartupMarker?: boolean | undefined;
  /**
   * Conversation-history source for `session/load` replay. Pass
   * `makeACPServerAgentTurn(...).replay` here so a reconnecting client
   * gets prior turns streamed back.
   */
  replayFor?: ((sessionId: string) => Array<{ sessionUpdate: string; content: unknown }>) | undefined;
  /**
   * Cold-load seed hook. Pass `makeACPServerAgentTurn(...).seed` so a
   * restored session's Agent resumes the model context, not just the UI.
   */
  seedFor?: ((sessionId: string, history: Array<{ sessionUpdate: string; content: unknown }>) => void) | undefined;
  /**
   * Durable session store. When set, sessions + history are persisted and
   * restored across restarts for `session/load`. Pass an `ACPSessionStore`.
   */
  store?: SessionPersistence | undefined;
}

export class WrongStackACPServer {
  private readonly transport: StdioTransport;
  private readonly handler: ACPProtocolHandler;
  private readonly options: WrongStackACPServerOptions;
  /** HTTP server when transport mode is HTTP. */
  private httpServer: Server | null = null;
  private running = false;

  constructor(opts: WrongStackACPServerOptions = {}) {
    this.options = opts;
    this.transport = new StdioTransport();
    const runTurn: RunTurn = opts.runTurn ?? defaultEchoRunTurn;
    this.handler = new ACPProtocolHandler({
      transport: this.transport,
      defaultCwd: opts.defaultCwd ?? process.cwd(),
      runTurn,
      agentName: opts.agentName,
      ...(opts.replayFor ? { replayFor: opts.replayFor } : {}),
      ...(opts.seedFor ? { seedFor: opts.seedFor } : {}),
      ...(opts.store ? { store: opts.store } : {}),
    });
  }

  /**
   * Start the server. Mode depends on `options.transport`:
   * - 'stdio' (default): reads JSON-RPC from stdin, writes to stdout.
   * - number: listens as HTTP on the given port.
   */
  async start(): Promise<void> {
    const transportMode = this.options.transport;
    if (typeof transportMode === 'number') {
      await this.startHttp(transportMode);
    } else {
      await this.startStdio();
    }
  }

  private async startStdio(): Promise<void> {
    if (this.options.legacyStartupMarker) {
      this.transport.sendStartupMarker();
    }
    this.running = true;
    while (this.running) {
      const msg = await this.transport.read();
      if (!msg) break;
      const terminal = await this.handler.handleMessage(msg);
      if (terminal) break;
    }
    this.transport.close();
  }

  private async startHttp(port: number): Promise<void> {
    const host = this.options.host ?? '127.0.0.1';
    const handler = this.handler;

    this.httpServer = createServer(async (req, res) => {
      // Origin guard. Real ACP/MCP clients (Zed, JetBrains, curl, the MCP SDK)
      // are non-browser and send no `Origin` header, so they are unaffected. A
      // browser making a cross-origin request DOES send `Origin`; reject it so a
      // malicious web page the user visits cannot reach this loopback agent and
      // drive it (a real `runTurn` executes tools/commands — i.e. RCE). This
      // replaces the previous `Access-Control-Allow-Origin: *`, which let any
      // site read responses from, and POST to, this server.
      const selfOrigin = `http://${host}:${port}`;
      const reqOrigin = Array.isArray(req.headers.origin)
        ? req.headers.origin[0]
        : req.headers.origin;
      if (reqOrigin && reqOrigin !== selfOrigin) {
        res.writeHead(403);
        res.end(JSON.stringify({ error: 'cross-origin request forbidden' }));
        return;
      }
      // Never reflect a wildcard — only echo our own origin back (for same-origin
      // browser tooling). `Authorization` is intentionally omitted from the
      // allow-list: it is not enforced here, so advertising it would mislead.
      if (reqOrigin) res.setHeader('Access-Control-Allow-Origin', reqOrigin);
      res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Mcp-Session-Id');

      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }

      if (req.method !== 'POST') {
        res.writeHead(405);
        res.end(JSON.stringify({ error: 'method not allowed' }));
        return;
      }

      // Parse JSON body
      let body = '';
      for await (const chunk of req) {
        body += chunk;
      }

      let msg: unknown;
      try {
        msg = JSON.parse(body);
      } catch {
        res.writeHead(400);
        res.end(JSON.stringify({ error: { code: -32700, message: 'Parse error' } }));
        return;
      }

      // Process the message and return the response. For HTTP transport we
      // must NOT let the handler write to stdout — instead we intercept
      // `transport.send` and capture the JSON-RPC response + any buffered
      // notifications, then return them inline (Streamable HTTP pattern).
      const notifications: unknown[] = [];
      let response: ACPMessage | null = null;
      const originalSend = this.transport.send.bind(this.transport);
      this.transport.send = async (m: ACPMessage) => {
        if (m.id !== undefined && (m.result !== undefined || m.error !== undefined)) {
          // The JSON-RPC response to this request — capture, don't write
          // to stdout (which is meaningless over HTTP).
          response = m;
        } else if (m.method === 'session/update') {
          notifications.push(m.params);
        } else {
          // Any other server-initiated notification — buffer it too.
          notifications.push(m);
        }
      };

      try {
        await handler.handleMessage(msg);
      } finally {
        this.transport.send = originalSend;
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      const responseBody =
        response !== null
          ? { ...(response as ACPMessage), notifications }
          : { notifications };
      res.end(JSON.stringify(responseBody));
    });

    return new Promise<void>((resolve) => {
      this.httpServer!.listen(port, host, () => {
        writeErr(`[wstack-acp] HTTP server listening on http://${host}:${port}\n`);
        this.running = true;
        resolve();
      });
    });
  }

  /** Stop the server. */
  stop(): void {
    this.running = false;
    this.transport.close();
    if (this.httpServer) {
      this.httpServer.close();
      this.httpServer = null;
    }
  }
}

/**
 * Default per-turn implementation: a no-op that echoes nothing useful
 * and returns `end_turn`. Lets the server boot end-to-end without
 * needing the core Agent factory (which would couple this entrypoint
 * to a long-lived model provider). The real implementation is
 * `ACPServerAgentTurn` (follow-up PR) that wires a core `Agent`.
 */
const defaultEchoRunTurn: RunTurn = async (_input, _emit): Promise<RunTurnResult> => {
  return { stopReason: 'end_turn' };
};

/**
 * Bootstrap function for `node dist/agent/wrongstack-acp-agent.js`.
 * Instantiates the server with the default (no-op) runTurn so the
 * binary is useful as a connectivity smoke test.
 *
 * In practice the CLI will instantiate and run `WrongStackACPServer`
 * directly, passing a real `runTurn` wired to a core `Agent`.
 */
/* v8 ignore start -- process entrypoint: bootstrap + auto-start only run when launched as `node wrongstack-acp-agent.js`, never on import (which the CLI does to reuse the class). */
async function main(): Promise<void> {
  const server = new WrongStackACPServer();
  await server.start();
}

const isEntrypoint =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
if (isEntrypoint) {
  main().catch((err) => {
    writeErr(`[wstack-acp fatal] ${err}\n`);
    process.exit(1);
  });
}
/* v8 ignore stop */
