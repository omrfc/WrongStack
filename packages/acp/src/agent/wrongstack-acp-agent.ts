/**
 * WrongStackACPServer — ACP server-side entry point.
 *
 * Exposes WrongStack as an ACP-compatible agent. ACP clients (Zed, JetBrains,
 * VS Code ACP extension) spawn this as a subprocess, send JSON-RPC messages
 * over stdio, and receive tool responses.
 *
 * Usage:
 *   node dist/agent/wrongstack-acp-agent.js
 *
 * Or via the CLI:
 *   wstack acp-server
 *
 * Startup: sends `[wstack-acp]\n` to stdout so the client knows which process
 * is the ACP server before protocol messages begin.
 */
import { fileURLToPath } from 'node:url';
import type { Tool } from '@wrongstack/core';
import { ACPProtocolHandler } from './protocol-handler.js';
import { StdioTransport } from './stdio-transport.js';
import { ACPToolsRegistry } from './tools-registry.js';

export interface WrongStackACPServerOptions {
  /**
   * Initial tool set. Typically loaded from the WrongStack tool registry
   * via `api.tools.list()` so the ACP server exposes exactly the tools the
   * CLI has configured.
   */
  tools: Tool[];
  /**
   * Owner label for tool metadata. Passed to ACPToolsRegistry.
   * @default 'wrongstack'
   */
  owner?: string;
}

export class WrongStackACPServer {
  private readonly transport: StdioTransport;
  private readonly registry: ACPToolsRegistry;
  private readonly handler: ACPProtocolHandler;
  private running = false;

  constructor(opts: WrongStackACPServerOptions) {
    this.transport = new StdioTransport();
    this.registry = new ACPToolsRegistry(opts.owner);
    this.registry.register(opts.tools);
    this.handler = new ACPProtocolHandler(
      this.transport,
      this.registry,
      /* TODO: load WrongStack Context */ {},
    );
  }

  /**
   * Start the server. Blocks until the client disconnects.
   *
   * 1. Send the startup marker `[wstack-acp]` so the client
   *    knows which stdout line is the protocol boundary.
   * 2. Loop: read messages, dispatch to handler, until EOF or error.
   *
   * Single dispatch path: every inbound message is read exactly once
   * from the transport and passed to the protocol handler exactly once.
   * An earlier version combined a `transport.onMessage` callback with
   * this read loop, which caused every message to be processed twice
   * (once by the callback, once by the loop) — duplicate tool calls
   * and duplicate responses to the client. See the ACP double-dispatch
   * fix in the security audit (P1-001).
   */
  async start(): Promise<void> {
    this.transport.sendStartupMarker();
    this.running = true;

    while (this.running) {
      const msg = await this.transport.read();
      if (!msg) break; // EOF
      const terminal = await this.handler.handleMessage(msg);
      if (terminal) break;
    }

    this.transport.close();
  }

  /** Stop the server. */
  stop(): void {
    this.running = false;
    this.transport.close();
  }
}

/**
 * Bootstrap function for `node dist/agent/wrongstack-acp-agent.js`.
 * Instantiates the server with the default tool set.
 *
 * Tool loading: the ACP agent is a subprocess without the full CLI context,
 * so it needs to receive its tools from the parent via environment or a
 * pre-main bootstrap. For now, it uses an empty tool set unless tools are
 * explicitly passed via constructor options.
 *
 * In practice the CLI will instantiate and run WrongStackACPServer directly,
 * passing `api.tools.list()` as the tool set.
 */
async function main(): Promise<void> {
  const server = new WrongStackACPServer({ tools: [] });
  await server.start();
}

// Only auto-start when this file is the process entrypoint (e.g.
// `node dist/agent/wrongstack-acp-agent.js`). Importing the module — which the
// CLI does to reuse `WrongStackACPServer` — must stay side-effect-free, or
// every launch would start an ACP server and hijack stdin.
const isEntrypoint =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
if (isEntrypoint) {
  main().catch((err) => {
    process.stderr.write(`[wstack-acp fatal] ${err}\n`);
    process.exit(1);
  });
}
