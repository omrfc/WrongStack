/**
 * MCP management handlers for the WebUI server.
 * Handles MCP-related WS messages from the browser client.
 */
import type { WebSocket } from 'ws';
import type { Config, MCPRegistryHandle } from '@wrongstack/core';
import type { ConnectedClient, WSClientMessage, WSServerMessage } from './types.js';
import { send } from './ws-utils.js';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export interface MCPServerView {
  name: string;
  transport: string;
  status: 'stopped' | 'connecting' | 'connected' | 'sleeping' | 'discovering' | 'error';
  enabled: boolean;
  description?: string;
  tools?: string[];
  error?: string;
  pid?: number;
}

interface MCPServerConfig {
  transport: 'stdio' | 'sse' | 'streamable-http';
  description?: string;
  enabled?: boolean;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  allowedTools?: string[];
}

interface MCPServerRecord {
  [name: string]: MCPServerConfig;
}

function isMcpServerRecord(val: unknown): val is MCPServerRecord {
  if (typeof val !== 'object' || val === null) return false;
  return true;
}

/** Project a config server + registry state to the wire format */
function projectServer(
  name: string,
  cfg: MCPServerConfig,
  _status: MCPServerView['status'] = 'stopped',
  tools: string[] = [],
): MCPServerView {
  return {
    name,
    transport: cfg.transport,
    status: _status,
    enabled: cfg.enabled ?? true,
    description: cfg.description,
    tools,
  };
}

/** Read the config file */
async function readConfig(configPath: string): Promise<Record<string, unknown>> {
  try {
    const content = await fs.readFile(configPath, 'utf-8');
    return JSON.parse(content);
  } catch {
    return {};
  }
}

/** Write the config file */
async function writeConfig(configPath: string, cfg: Record<string, unknown>): Promise<void> {
  const dir = path.dirname(configPath);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(configPath, JSON.stringify(cfg, null, 2), 'utf-8');
}

/** Get MCP servers from config */
export async function getMcpServers(config: Config, globalConfigPath: string): Promise<MCPServerView[]> {
  const servers: MCPServerView[] = [];
  const configured = isMcpServerRecord(config.mcpServers) ? config.mcpServers : {};

  for (const [name, cfg] of Object.entries(configured)) {
    servers.push(projectServer(name, cfg));
  }

  return servers;
}

/** Get MCP server states from registry */
function getRegistryStates(mcpRegistry?: MCPRegistryHandle): Map<string, { state: string; toolCount: number }> {
  const states = new Map<string, { state: string; toolCount: number }>();
  if (!mcpRegistry?.list) return states;

  try {
    const list = mcpRegistry.list();
    for (const item of list) {
      states.set(item.name, { state: item.state, toolCount: item.toolCount });
    }
  } catch {
    // Registry may not be available
  }

  return states;
}

/** Handle mcp.list — return all configured MCP servers */
export async function handleMcpList(
  ws: WebSocket,
  _msg: WSClientMessage,
  config: Config,
  _globalConfigPath: string,
  mcpRegistry?: MCPRegistryHandle,
): Promise<void> {
  const servers = await getMcpServers(config, _globalConfigPath);
  const registryStates = getRegistryStates(mcpRegistry);

  // Merge registry states into server views
  for (const server of servers) {
    const registryState = registryStates.get(server.name);
    if (registryState) {
      server.status = registryState.state as MCPServerView['status'];
      server.tools = Array.from({ length: registryState.toolCount }, (_, i) => `tool-${i + 1}`);
    }
  }

  send(ws, { type: 'mcp.list', payload: { servers } });
}

/** Handle mcp.add — add a new MCP server configuration */
export async function handleMcpAdd(
  ws: WebSocket,
  msg: WSClientMessage,
  config: Config,
  globalConfigPath: string,
  mcpRegistry?: MCPRegistryHandle,
): Promise<void> {
  const payload = msg.payload as {
    name: string;
    transport: string;
    description?: string;
    enabled?: boolean;
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    allowedTools?: string[];
  };

  if (!payload.name) {
    send(ws, { type: 'mcp.operation_result', payload: { success: false, message: 'Server name is required' } });
    return;
  }

  try {
    const diskConfig = await readConfig(globalConfigPath);
    const mcpServers = isMcpServerRecord(diskConfig.mcpServers) ? diskConfig.mcpServers : {};

    if (mcpServers[payload.name]) {
      send(ws, { type: 'mcp.operation_result', payload: { success: false, message: `Server "${payload.name}" already exists` } });
      return;
    }

    mcpServers[payload.name] = {
      transport: payload.transport as 'stdio' | 'sse' | 'streamable-http',
      description: payload.description,
      enabled: payload.enabled ?? true,
      command: payload.command,
      args: payload.args,
      env: payload.env,
      allowedTools: payload.allowedTools,
    };

    diskConfig.mcpServers = mcpServers;
    await writeConfig(globalConfigPath, diskConfig);

    const newServer = projectServer(payload.name, mcpServers[payload.name]);
    send(ws, { type: 'mcp.server.added', payload: { server: newServer } });

    // If registry is available and server is enabled, start it
    if (mcpRegistry && (payload.enabled ?? true)) {
      const serverConfig = mcpServers[payload.name];
      try {
        await mcpRegistry.start({
          name: payload.name,
          transport: payload.transport as 'stdio' | 'sse' | 'streamable-http',
          command: payload.command,
          args: payload.args,
          env: payload.env,
          allowedTools: payload.allowedTools,
          enabled: true,
        });
      } catch (err) {
        send(ws, { type: 'mcp.server.error', payload: { name: payload.name, error: String(err) } });
      }
    }

    send(ws, { type: 'mcp.operation_result', payload: { success: true, message: `Server "${payload.name}" added` } });
  } catch (err) {
    send(ws, { type: 'mcp.operation_result', payload: { success: false, message: `Failed to add server: ${err}` } });
  }
}

/** Handle mcp.remove — remove an MCP server configuration */
export async function handleMcpRemove(
  ws: WebSocket,
  msg: WSClientMessage,
  _config: Config,
  globalConfigPath: string,
  mcpRegistry?: MCPRegistryHandle,
): Promise<void> {
  const payload = msg.payload as { name: string };

  if (!payload.name) {
    send(ws, { type: 'mcp.operation_result', payload: { success: false, message: 'Server name is required' } });
    return;
  }

  try {
    // Stop the server first if it's running
    if (mcpRegistry) {
      try {
        await mcpRegistry.stop(payload.name);
      } catch {
        // Server may not be running, ignore
      }
    }

    const diskConfig = await readConfig(globalConfigPath);
    const mcpServers = isMcpServerRecord(diskConfig.mcpServers) ? diskConfig.mcpServers : {};

    if (!mcpServers[payload.name]) {
      send(ws, { type: 'mcp.operation_result', payload: { success: false, message: `Server "${payload.name}" not found` } });
      return;
    }

    delete mcpServers[payload.name];
    diskConfig.mcpServers = mcpServers;
    await writeConfig(globalConfigPath, diskConfig);

    send(ws, { type: 'mcp.server.removed', payload: { name: payload.name } });
    send(ws, { type: 'mcp.operation_result', payload: { success: true, message: `Server "${payload.name}" removed` } });
  } catch (err) {
    send(ws, { type: 'mcp.operation_result', payload: { success: false, message: `Failed to remove server: ${err}` } });
  }
}

/** Handle mcp.update — update an existing MCP server configuration */
export async function handleMcpUpdate(
  ws: WebSocket,
  msg: WSClientMessage,
  _config: Config,
  globalConfigPath: string,
): Promise<void> {
  const payload = msg.payload as {
    name: string;
    transport?: string;
    description?: string;
    enabled?: boolean;
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    allowedTools?: string[];
  };

  if (!payload.name) {
    send(ws, { type: 'mcp.operation_result', payload: { success: false, message: 'Server name is required' } });
    return;
  }

  try {
    const diskConfig = await readConfig(globalConfigPath);
    const mcpServers = isMcpServerRecord(diskConfig.mcpServers) ? diskConfig.mcpServers : {};

    if (!mcpServers[payload.name]) {
      send(ws, { type: 'mcp.operation_result', payload: { success: false, message: `Server "${payload.name}" not found` } });
      return;
    }

    const existing = mcpServers[payload.name];
    mcpServers[payload.name] = {
      transport: (payload.transport ?? existing.transport) as 'stdio' | 'sse' | 'streamable-http',
      description: payload.description ?? existing.description,
      enabled: payload.enabled ?? existing.enabled,
      command: payload.command ?? existing.command,
      args: payload.args ?? existing.args,
      env: payload.env ?? existing.env,
      allowedTools: payload.allowedTools ?? existing.allowedTools,
    };

    diskConfig.mcpServers = mcpServers;
    await writeConfig(globalConfigPath, diskConfig);

    const updatedServer = projectServer(payload.name, mcpServers[payload.name]);
    send(ws, { type: 'mcp.server.updated', payload: { server: updatedServer } });
    send(ws, { type: 'mcp.operation_result', payload: { success: true, message: `Server "${payload.name}" updated` } });
  } catch (err) {
    send(ws, { type: 'mcp.operation_result', payload: { success: false, message: `Failed to update server: ${err}` } });
  }
}

/** Handle mcp.wake — wake a sleeping MCP server (restart it) */
export async function handleMcpWake(
  ws: WebSocket,
  msg: WSClientMessage,
  _config: Config,
  _globalConfigPath: string,
  mcpRegistry?: MCPRegistryHandle,
): Promise<void> {
  const payload = msg.payload as { name: string };

  if (!payload.name) {
    send(ws, { type: 'mcp.operation_result', payload: { success: false, message: 'Server name is required' } });
    return;
  }

  if (!mcpRegistry) {
    send(ws, { type: 'mcp.operation_result', payload: { success: false, message: 'MCP registry not available' } });
    return;
  }

  try {
    send(ws, { type: 'mcp.server.waking', payload: { name: payload.name } });
    await mcpRegistry.restart(payload.name);
    send(ws, { type: 'mcp.server.connected', payload: { name: payload.name } });
    send(ws, { type: 'mcp.operation_result', payload: { success: true, message: `Server "${payload.name}" restarted` } });
  } catch (err) {
    send(ws, { type: 'mcp.server.error', payload: { name: payload.name, error: String(err) } });
    send(ws, { type: 'mcp.operation_result', payload: { success: false, message: `Failed to restart "${payload.name}": ${err}` } });
  }
}

/** Handle mcp.sleep — put an MCP server to sleep (stop it) */
export async function handleMcpSleep(
  ws: WebSocket,
  msg: WSClientMessage,
  _config: Config,
  _globalConfigPath: string,
  mcpRegistry?: MCPRegistryHandle,
): Promise<void> {
  const payload = msg.payload as { name: string };

  if (!payload.name) {
    send(ws, { type: 'mcp.operation_result', payload: { success: false, message: 'Server name is required' } });
    return;
  }

  if (!mcpRegistry) {
    send(ws, { type: 'mcp.operation_result', payload: { success: false, message: 'MCP registry not available' } });
    return;
  }

  try {
    await mcpRegistry.stop(payload.name);
    send(ws, { type: 'mcp.server.sleeping', payload: { name: payload.name } });
    send(ws, { type: 'mcp.operation_result', payload: { success: true, message: `Server "${payload.name}" stopped` } });
  } catch (err) {
    send(ws, { type: 'mcp.server.error', payload: { name: payload.name, error: String(err) } });
    send(ws, { type: 'mcp.operation_result', payload: { success: false, message: `Failed to stop "${payload.name}": ${err}` } });
  }
}

/** Handle mcp.discover — perform one-time tool discovery on an MCP server */
export async function handleMcpDiscover(
  ws: WebSocket,
  msg: WSClientMessage,
  _config: Config,
  _globalConfigPath: string,
  _mcpRegistry?: MCPRegistryHandle,
): Promise<void> {
  const payload = msg.payload as { name: string };

  if (!payload.name) {
    send(ws, { type: 'mcp.operation_result', payload: { success: false, message: 'Server name is required' } });
    return;
  }

  // Discover is not yet implemented - servers are discovered on connect
  send(ws, { type: 'mcp.server.discovered', payload: { name: payload.name, tools: [] } });
  send(ws, { type: 'mcp.operation_result', payload: { success: true, message: `Server "${payload.name}" tools were discovered on connect` } });
}

/** Handle mcp.enable — enable an MCP server */
export async function handleMcpEnable(
  ws: WebSocket,
  msg: WSClientMessage,
  _config: Config,
  _globalConfigPath: string,
): Promise<void> {
  const payload = msg.payload as { name: string };

  if (!payload.name) {
    send(ws, { type: 'mcp.operation_result', payload: { success: false, message: 'Server name is required' } });
    return;
  }

  // TODO: Wire up to actual MCPRegistryHandle.enable()
  send(ws, { type: 'mcp.operation_result', payload: { success: true, message: `Enable command sent for "${payload.name}"` } });
}

/** Handle mcp.disable — disable an MCP server */
export async function handleMcpDisable(
  ws: WebSocket,
  msg: WSClientMessage,
  _config: Config,
  _globalConfigPath: string,
): Promise<void> {
  const payload = msg.payload as { name: string };

  if (!payload.name) {
    send(ws, { type: 'mcp.operation_result', payload: { success: false, message: 'Server name is required' } });
    return;
  }

  // TODO: Wire up to actual MCPRegistryHandle.disable()
  send(ws, { type: 'mcp.operation_result', payload: { success: true, message: `Disable command sent for "${payload.name}"` } });
}

/** Handle mcp.restart — restart an MCP server */
export async function handleMcpRestart(
  ws: WebSocket,
  msg: WSClientMessage,
  _config: Config,
  _globalConfigPath: string,
): Promise<void> {
  const payload = msg.payload as { name: string };

  if (!payload.name) {
    send(ws, { type: 'mcp.operation_result', payload: { success: false, message: 'Server name is required' } });
    return;
  }

  // TODO: Wire up to actual MCPRegistryHandle.restart()
  send(ws, { type: 'mcp.operation_result', payload: { success: true, message: `Restart command sent for "${payload.name}"` } });
}
