/**
 * MCP management handlers for the WebUI server (both the standalone
 * `wstackui` server and the CLI's embedded `--webui` server).
 *
 * These are thin WebSocket translators over the shared, surface-agnostic
 * management core in `@wrongstack/mcp` (`manage.ts`) — the SAME core the REPL
 * `/mcp` command writes against (same config.json, same MCPRegistry). All the
 * config IO, url/header persistence, and live registry start/stop logic lives
 * there; here we only map structured results to WS events the browser expects.
 */

import { allServers } from '@wrongstack/core';
import {
  addMcp,
  disableMcp,
  discoverMcp,
  enableMcp,
  listMcp,
  type MCPRegistry,
  type McpManageDeps,
  type McpServerInfo,
  type McpServerInput,
  removeMcp,
  restartMcp,
  updateMcp,
} from '@wrongstack/mcp';
import type { WebSocket } from 'ws';
import type { WSClientMessage } from './types.js';
import { send } from './ws-utils.js';

/** Wire view of a server as the browser MCP panel consumes it. */
export interface MCPServerView {
  name: string;
  transport: string;
  status: 'stopped' | 'connecting' | 'connected' | 'sleeping' | 'discovering' | 'error';
  enabled: boolean;
  description?: string;
  tools?: string[];
  error?: string;
  pid?: number;
  lazy?: boolean;
}

/** Map a raw registry state to the UI status union. */
function mapStatus(raw: string): MCPServerView['status'] {
  switch (raw) {
    case 'connected':
      return 'connected';
    case 'connecting':
    case 'reconnecting':
      return 'connecting';
    case 'failed':
      return 'error';
    case 'dormant':
      // Lazy server registered from cache, process not spawned — show as sleeping.
      return 'sleeping';
    default:
      // idle / disconnected / stopped
      return 'stopped';
  }
}

/** Project the shared {@link McpServerInfo} into the browser wire shape. */
function toView(info: McpServerInfo): MCPServerView {
  const view: MCPServerView = {
    name: info.name,
    transport: info.transport,
    // A dormant lazy server is "asleep", not stopped — preserve that even when
    // it's enabled in config.
    status: info.status === 'dormant' ? 'sleeping' : info.enabled === false ? 'stopped' : mapStatus(info.status),
    enabled: info.enabled,
    tools: info.tools,
  };
  if (info.description !== undefined) view.description = info.description;
  if (info.lazy !== undefined) view.lazy = info.lazy;
  return view;
}

/**
 * Build the shared management deps. Returns null (and sends a failure result)
 * when the live registry isn't wired — both WebUI servers now pass one, so this
 * is a defensive guard rather than the normal path.
 */
function deps(
  ws: WebSocket,
  globalConfigPath: string | undefined,
  registry: MCPRegistry | undefined,
): McpManageDeps | null {
  if (!registry || !globalConfigPath) {
    send(ws, {
      type: 'mcp.operation_result',
      payload: { success: false, message: 'MCP registry is not available in this session.' },
    });
    return null;
  }
  return { configPath: globalConfigPath, registry, presets: allServers() };
}

function name(msg: WSClientMessage): string {
  return (msg.payload as { name?: string } | undefined)?.name ?? '';
}

/** mcp.list — configured servers merged with live registry status + tools. */
export async function handleMcpList(
  ws: WebSocket,
  _msg: WSClientMessage,
  globalConfigPath: string,
  mcpRegistry?: MCPRegistry,
): Promise<void> {
  if (!mcpRegistry || !globalConfigPath) {
    send(ws, { type: 'mcp.list', payload: { servers: [] } });
    return;
  }
  const servers = await listMcp({
    configPath: globalConfigPath,
    registry: mcpRegistry,
    presets: allServers(),
  });
  send(ws, { type: 'mcp.list', payload: { servers: servers.map(toView) } });
}

/** mcp.add — persist a new server (incl. url/headers) and start it if enabled. */
export async function handleMcpAdd(
  ws: WebSocket,
  msg: WSClientMessage,
  globalConfigPath: string,
  mcpRegistry?: MCPRegistry,
): Promise<void> {
  const d = deps(ws, globalConfigPath, mcpRegistry);
  if (!d) return;
  const result = await addMcp(msg.payload as McpServerInput, d);
  if (result.ok && result.server) {
    send(ws, { type: 'mcp.server.added', payload: { server: toView(result.server) } });
    if (result.registryError) {
      send(ws, {
        type: 'mcp.server.error',
        payload: { name: result.server.name, error: result.registryError },
      });
    } else if (result.server.enabled) {
      send(ws, { type: 'mcp.server.connected', payload: { name: result.server.name } });
    }
  }
  send(ws, {
    type: 'mcp.operation_result',
    payload: { success: result.ok, message: result.message },
  });
}

/** mcp.update — re-persist config (incl. url/headers) and re-apply to registry. */
export async function handleMcpUpdate(
  ws: WebSocket,
  msg: WSClientMessage,
  globalConfigPath: string,
  mcpRegistry?: MCPRegistry,
): Promise<void> {
  const d = deps(ws, globalConfigPath, mcpRegistry);
  if (!d) return;
  const result = await updateMcp(msg.payload as McpServerInput, d);
  if (result.ok && result.server) {
    send(ws, { type: 'mcp.server.updated', payload: { server: toView(result.server) } });
  }
  send(ws, {
    type: 'mcp.operation_result',
    payload: { success: result.ok, message: result.message },
  });
}

/** mcp.remove — stop the server and delete it from config. */
export async function handleMcpRemove(
  ws: WebSocket,
  msg: WSClientMessage,
  globalConfigPath: string,
  mcpRegistry?: MCPRegistry,
): Promise<void> {
  const d = deps(ws, globalConfigPath, mcpRegistry);
  if (!d) return;
  const result = await removeMcp(name(msg), d);
  if (result.ok) {
    send(ws, { type: 'mcp.server.removed', payload: { name: name(msg) } });
  }
  send(ws, {
    type: 'mcp.operation_result',
    payload: { success: result.ok, message: result.message },
  });
}

/** mcp.enable — flip enabled:true in config and start the server. */
export async function handleMcpEnable(
  ws: WebSocket,
  msg: WSClientMessage,
  globalConfigPath: string,
  mcpRegistry?: MCPRegistry,
): Promise<void> {
  const d = deps(ws, globalConfigPath, mcpRegistry);
  if (!d) return;
  const result = await enableMcp(name(msg), d);
  if (result.ok && result.server) {
    send(ws, { type: 'mcp.server.updated', payload: { server: toView(result.server) } });
    if (result.registryError) {
      send(ws, {
        type: 'mcp.server.error',
        payload: { name: name(msg), error: result.registryError },
      });
    } else {
      send(ws, { type: 'mcp.server.connected', payload: { name: name(msg) } });
    }
  }
  send(ws, {
    type: 'mcp.operation_result',
    payload: { success: result.ok, message: result.message },
  });
}

/** mcp.disable — stop the server and flip enabled:false in config. */
export async function handleMcpDisable(
  ws: WebSocket,
  msg: WSClientMessage,
  globalConfigPath: string,
  mcpRegistry?: MCPRegistry,
): Promise<void> {
  const d = deps(ws, globalConfigPath, mcpRegistry);
  if (!d) return;
  const result = await disableMcp(name(msg), d);
  if (result.ok) {
    send(ws, { type: 'mcp.server.sleeping', payload: { name: name(msg) } });
    if (result.server) {
      send(ws, { type: 'mcp.server.updated', payload: { server: toView(result.server) } });
    }
  }
  send(ws, {
    type: 'mcp.operation_result',
    payload: { success: result.ok, message: result.message },
  });
}

/** mcp.sleep — stop a running server (config stays enabled). */
export async function handleMcpSleep(
  ws: WebSocket,
  msg: WSClientMessage,
  globalConfigPath: string,
  mcpRegistry?: MCPRegistry,
): Promise<void> {
  const d = deps(ws, globalConfigPath, mcpRegistry);
  if (!d) return;
  // Sleep == disable the live process but keep config enabled — use the
  // registry directly so the persisted `enabled` flag is untouched.
  try {
    await d.registry.stop(name(msg));
    send(ws, { type: 'mcp.server.sleeping', payload: { name: name(msg) } });
    send(ws, {
      type: 'mcp.operation_result',
      payload: { success: true, message: `Server "${name(msg)}" stopped` },
    });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    send(ws, { type: 'mcp.server.error', payload: { name: name(msg), error } });
    send(ws, {
      type: 'mcp.operation_result',
      payload: { success: false, message: `Failed to stop "${name(msg)}": ${error}` },
    });
  }
}

/** mcp.wake — restart a sleeping/stopped server from config. */
export async function handleMcpWake(
  ws: WebSocket,
  msg: WSClientMessage,
  globalConfigPath: string,
  mcpRegistry?: MCPRegistry,
): Promise<void> {
  const d = deps(ws, globalConfigPath, mcpRegistry);
  if (!d) return;
  send(ws, { type: 'mcp.server.waking', payload: { name: name(msg) } });
  const result = await restartMcp(name(msg), d);
  if (result.ok && !result.registryError) {
    send(ws, { type: 'mcp.server.connected', payload: { name: name(msg) } });
  } else if (result.registryError) {
    send(ws, {
      type: 'mcp.server.error',
      payload: { name: name(msg), error: result.registryError },
    });
  }
  send(ws, {
    type: 'mcp.operation_result',
    payload: { success: result.ok, message: result.message },
  });
}

/** mcp.restart — stop + start a server. */
export async function handleMcpRestart(
  ws: WebSocket,
  msg: WSClientMessage,
  globalConfigPath: string,
  mcpRegistry?: MCPRegistry,
): Promise<void> {
  const d = deps(ws, globalConfigPath, mcpRegistry);
  if (!d) return;
  const result = await restartMcp(name(msg), d);
  if (result.ok && !result.registryError) {
    send(ws, { type: 'mcp.server.connected', payload: { name: name(msg) } });
  } else if (result.registryError) {
    send(ws, {
      type: 'mcp.server.error',
      payload: { name: name(msg), error: result.registryError },
    });
  }
  send(ws, {
    type: 'mcp.operation_result',
    payload: { success: result.ok, message: result.message },
  });
}

/** mcp.discover — ensure the server is running and report its live tools. */
export async function handleMcpDiscover(
  ws: WebSocket,
  msg: WSClientMessage,
  globalConfigPath: string,
  mcpRegistry?: MCPRegistry,
): Promise<void> {
  const d = deps(ws, globalConfigPath, mcpRegistry);
  if (!d) return;
  const result = await discoverMcp(name(msg), d);
  if (result.ok) {
    send(ws, {
      type: 'mcp.server.discovered',
      payload: { name: name(msg), tools: result.tools ?? [] },
    });
  }
  send(ws, {
    type: 'mcp.operation_result',
    payload: { success: result.ok, message: result.message },
  });
}
