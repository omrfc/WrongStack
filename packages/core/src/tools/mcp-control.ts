import { expectDefined } from '../utils/expect-defined.js';
import { toErrorMessage } from '../utils/error.js';
/**
 * `mcp_control` — LLM-driven MCP server lifecycle management.
 *
 * The model calls this tool to:
 *   list  — see all known servers (running or not) without starting any
 *   search — filter the server catalog by name or description keyword
 *   enable — start a server and register its tools
 *   disable — stop a server and unregister its tools
 *   restart — stop then re-start a running server
 *
 * This is the primary mechanism by which the LLM autonomously extends its
 * own capabilities at runtime — e.g. "I need GitHub access, let me enable it."
 */
import * as fs from 'node:fs/promises';
import { allServers } from '../infrastructure/mcp-servers.js';
import type { Config, JSONSchema, MCPServerConfig, Tool } from '../index.js';
export interface MCPRegistryHandle {
  start(cfg: MCPServerConfig): Promise<void>;
  stop(name: string): Promise<void>;
  restart(name: string): Promise<void>;
  describe(): {
    name: string;
    state: string;
    toolCount: number;
    enabled: boolean;
    tools?: string[];
  }[];
  list(): { name: string; state: string; toolCount: number; tools?: string[] }[];
  /**
   * Register all cached tools for a server without restarting it.
   * No-op if the server is not connected or tools are already active.
   * Used in token-saving mode to temporarily expose MCP tools.
   */
  activateServer?(name: string): void;
  /**
   * Unregister all tools for a server without disconnecting it.
   * Returns the number of tools that were deactivated.
   * Used in token-saving mode to hide MCP tools after use.
   */
  deactivateServer?(name: string): number;
  /**
   * Check whether a server's tools are currently registered.
   */
  isActivated?(name: string): boolean;
}

export interface CreateMcpControlToolOptions {
  /**
   * Read the current config object. The tool never mutates this directly —
   * writes go to the global config file via `configPath`.
   */
  getConfig: () => Config;
  /**
   * Path to ~/.wrongstack/config.json (or equivalent) for atomic config writes.
   */
  configPath: string;
  /**
   * Live MCP registry for runtime start/stop/restart. The tool calls these
   * immediately so the LLM sees the result of its action in the same turn.
   */
  registry: MCPRegistryHandle;
}

export function createMcpControlTool(opts: CreateMcpControlToolOptions): Tool {
  const { getConfig, configPath, registry } = opts;

  const inputSchema: JSONSchema = {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['list', 'search', 'enable', 'disable', 'restart', 'activate', 'deactivate'],
        description: 'The management action to perform. activate/deactivate toggle tool registration ephemerally without disconnecting.',
      },
      /** Filter for `search`. Matches server name or description case-insensitively. */
      query: {
        type: 'string',
        description: 'Search term for `search` action. Matches server name or description.',
      },
      /** Target server name for `enable`, `disable`, `restart`, `activate`, `deactivate`. */
      server: {
        type: 'string',
        description: 'Server name (e.g. "github", "filesystem", "brave-search").',
      },
    },
    required: ['action'],
  };

  return {
    name: 'mcp_control',
    description:
      'Manage MCP server lifecycle: list available servers, search by name or capability, enable or disable servers at runtime, restart running servers. Use activate/deactivate to ephemerally toggle tool registration without disconnecting — ideal for token-saving mode where MCP tools are lazy-loaded on demand.',
    category: 'mcp',
    permission: 'auto',
    mutating: true,
    riskTier: 'standard',
    inputSchema,
    async execute(raw) {
      const input = raw as { action: string; query?: string | undefined; server?: string | undefined };
      return mcpControlDispatch(input, { getConfig, configPath, registry });
    },
  };
}

// ── Dispatch ──────────────────────────────────────────────────────────────────

async function mcpControlDispatch(
  input: { action: string; query?: string | undefined; server?: string | undefined },
  deps: { getConfig: () => Config; configPath: string; registry: MCPRegistryHandle },
): Promise<string> {
  const { action, query, server } = input;

  switch (action) {
    case 'list':  return renderList(deps);
    case 'search': return renderSearch(query ?? '', deps);
    case 'enable': return server ? runEnable(server, deps) : '`server` is required for enable.';
    case 'disable': return server ? runDisable(server, deps) : '`server` is required for disable.';
    case 'restart': return server ? runRestart(server, deps) : '`server` is required for restart.';
    case 'activate': return server ? runActivate(server, deps) : '`server` is required for activate.';
    case 'deactivate': return server ? runDeactivate(server, deps) : '`server` is required for deactivate.';
    default:
      return `Unknown action "${action}". Use one of: list, search, enable, disable, restart, activate, deactivate.`;
  }
}

// ── Actions ───────────────────────────────────────────────────────────────────

function renderList(deps: { getConfig: () => Config; registry: MCPRegistryHandle }): string {
  const configured = deps.getConfig().mcpServers ?? {};
  const live = deps.registry.describe();

  if (Object.keys(configured).length === 0) {
    return [
      'No MCP servers configured.',
      '  Use `mcp_control({ action: "search" })` to see available presets,',
      '  then `mcp_control({ action: "enable", server: "<name>" })` to add one.',
    ].join('\n');
  }

  const lines: string[] = [];
  const liveMap = new Map(live.map((s) => [s.name, s]));

  for (const [name, cfg] of Object.entries(configured)) {
    const liveInfo = liveMap.get(name);
    const toolCount = liveInfo ? ` (${liveInfo.toolCount} tools)` : '';
    const stateStr = liveInfo ? badge(liveInfo.state) : dim('○ not loaded');
    const enabled = cfg.enabled === false
      ? `${dim('disabled')}  `
      : `${green('● enabled')}  `;
    lines.push(`  ${bold(name)}  ${enabled}${stateStr}${toolCount}`);
    if (cfg.description) lines.push(`    ${dim(cfg.description)}`);
  }

  lines.push('');
  lines.push(dim('  Use `mcp_control({ action: "search", query: "<keyword>" })` to find servers.'));
  lines.push(dim('  Use `mcp_control({ action: "enable", server: "<name>" })` to start a server.'));
  return lines.join('\n');
}

function renderSearch(
  query: string,
  deps: { getConfig: () => Config; registry: MCPRegistryHandle },
): string {
  const configured = deps.getConfig().mcpServers ?? {};
  const all = allServers();
  const q = query.toLowerCase();

  const configuredNames = new Set(Object.keys(configured));

  // Match against configured servers first, then remaining presets
  const configuredEntries = Object.entries(configured).filter(
    ([name, cfg]) =>
      name.toLowerCase().includes(q) ||
      (cfg.description ?? '').toLowerCase().includes(q),
  );

  const unconfiguredEntries = Object.entries(all)
    .filter(([name]) => !configuredNames.has(name))
    .filter(
      ([name, cfg]) =>
        name.toLowerCase().includes(q) ||
        (cfg.description ?? '').toLowerCase().includes(q),
    );

  const lines: string[] = [];

  if (configuredEntries.length > 0) {
    lines.push(bold('Configured servers matching "') + query + '":');
    for (const [name, cfg] of configuredEntries) {
      lines.push(`  ${bold(name)}  ${cfg.description ?? cfg.transport}`);
    }
    lines.push('');
  }

  if (unconfiguredEntries.length > 0) {
    lines.push(bold('Available presets matching "') + query + '":');
    for (const [name, cfg] of unconfiguredEntries) {
      const warn = cfg.permission === 'deny' ? red(' ⚠ confirm required') : '';
      lines.push(`  ${bold(name)}  ${cfg.description ?? cfg.transport}${warn}`);
    }
    lines.push('');
  }

  if (configuredEntries.length === 0 && unconfiguredEntries.length === 0) {
    return `No servers match "${query}". Try a shorter keyword or \`mcp_control({ action: "list" })\`.`;
  }

  const total = configuredEntries.length + unconfiguredEntries.length;
  lines.push(dim(`  ${total} server${total !== 1 ? 's' : ''} shown. Run \`enable\` on one to activate it.`));
  return lines.join('\n');
}

async function runEnable(
  name: string | undefined,
  deps: { getConfig: () => Config; configPath: string; registry: MCPRegistryHandle },
): Promise<string> {
  if (!name) return '`server` is required for enable. Example: { action: "enable", server: "github" }';

  const all = allServers();
  const configured = deps.getConfig().mcpServers ?? {};

  // Resolve the target config — it may be a preset not yet in config
  const cfg = configured[name] ?? all[name];
  if (!cfg) {
    const known = Object.keys(all).join(', ');
    return `Unknown server "${name}". Available presets: ${known}`;
  }

  // Write to config (add or update)
  const full = await readConfig(deps.configPath);
  const mcpServers: Record<string, MCPServerConfig> = {
    ...((full.mcpServers as Record<string, MCPServerConfig> | undefined) ?? {}),
  };
  mcpServers[name] = { ...cfg, enabled: true };
  full.mcpServers = mcpServers;
  await writeConfig(deps.configPath, full);

  // Start the server in the registry
  try {
    const live = deps.registry.describe().find((s) => s.name === name);
    if (live && live.state === 'connected') {
      return `${green('●')} Server "${name}" is already running (${live.toolCount} tools registered).`;
    }
    await deps.registry.start({ ...cfg, enabled: true });
    const updated = deps.registry.describe().find((s) => s.name === name);
    return `${green('✓ Enabled and started')} "${name}"${updated ? ` (${updated.toolCount} tools registered).` : '.'}`;
  } catch (err) {
    return `${red('✗ Failed to start')} "${name}": ${toErrorMessage(err)}`;
  }
}

async function runDisable(
  name: string | undefined,
  deps: { getConfig: () => Config; configPath: string; registry: MCPRegistryHandle },
): Promise<string> {
  if (!name) return '`server` is required for disable. Example: { action: "disable", server: "github" }';

  const configured = deps.getConfig().mcpServers ?? {};
  if (!configured[name]) {
    return `Server "${name}" is not in config. Add it with \`mcp_control({ action: "enable", server: "${name}" })\`.`;
  }

  // Write to config
  const full = await readConfig(deps.configPath);
  const mcpServers: Record<string, MCPServerConfig> = {
    ...((full.mcpServers as Record<string, MCPServerConfig> | undefined) ?? {}),
  };
  const existing = expectDefined(mcpServers[name]);
  mcpServers[name] = { ...existing, enabled: false };
  full.mcpServers = mcpServers;
  await writeConfig(deps.configPath, full);

  // Stop the running server
  try {
    await deps.registry.stop(name);
    return `${yellow('○ Disabled')} "${name}". It will not be started on next boot.`;
  } catch {
    return `${yellow('○ Disabled')} "${name}" (it was not running). Config updated.`;
  }
}

async function runRestart(
  name: string | undefined,
  deps: { getConfig: () => Config; configPath: string; registry: MCPRegistryHandle },
): Promise<string> {
  if (!name) return '`server` is required for restart. Example: { action: "restart", server: "github" }';

  const configured = deps.getConfig().mcpServers ?? {};
  if (!configured[name]) {
    return `Server "${name}" is not configured. Use \`mcp_control({ action: "enable", server: "${name}" })\` first.`;
  }

  try {
    await deps.registry.restart(name);
    const updated = deps.registry.describe().find((s) => s.name === name);
    return `${green('✓ Restarted')} "${name}"${updated ? ` (${updated.toolCount} tools registered).` : '.'}`;
  } catch (err) {
    return `${red('✗ Restart failed')} for "${name}": ${toErrorMessage(err)}`;
  }
}

/**
 * Ephemerally activate a server's tools without writing to config or
 * restarting the connection. The server must already be connected (lazy mode).
 * Calls `registry.activateServer()` when available; falls back to a message
 * if the registry doesn't support ephemeral activation.
 */
async function runActivate(
  name: string | undefined,
  deps: { registry: MCPRegistryHandle },
): Promise<string> {
  if (!name) return '`server` is required for activate.';
  if (!deps.registry.activateServer) {
    return `Registry does not support ephemeral activation. Use \`enable\` to start "${name}" instead.`;
  }
  const live = deps.registry.describe().find((s) => s.name === name);
  if (!live) {
    return `Server "${name}" is not registered. Use \`mcp_control({ action: "enable", server: "${name}" })\` first.`;
  }
  if (live.state !== 'connected') {
    return `Server "${name}" is not connected (state: ${live.state}). Use \`enable\` to start it first.`;
  }
  if (deps.registry.isActivated?.(name)) {
    return `${green('●')} Server "${name}" tools are already active. Use \`deactivate\` to hide them.`;
  }
  deps.registry.activateServer(name);
  const updated = deps.registry.describe().find((s) => s.name === name);
  return `${green('✓ Activated')} "${name}" — ${updated?.toolCount ?? 0} tool(s) now registered. Use \`mcp_control({ action: "deactivate", server: "${name}" })\` to hide them when done.`;
}

/**
 * Ephemerally deactivate a server's tools without disconnecting.
 * Calls `registry.deactivateServer()` when available.
 */
async function runDeactivate(
  name: string | undefined,
  deps: { registry: MCPRegistryHandle },
): Promise<string> {
  if (!name) return '`server` is required for deactivate.';
  if (!deps.registry.deactivateServer) {
    return `Registry does not support ephemeral deactivation. Use \`disable\` to stop "${name}" instead.`;
  }
  if (!deps.registry.isActivated?.(name)) {
    return `Server "${name}" tools are not currently active.`;
  }
  const count = deps.registry.deactivateServer(name);
  return `${yellow('○ Deactivated')} "${name}" — ${count} tool(s) unregistered. Server stays connected.`;
}

// ── Config helpers ──────────────────────────────────────────────────────────────

async function readConfig(p: string): Promise<Record<string, unknown>> {
  try {
    return JSON.parse(await fs.readFile(p, 'utf8')) as Record<string, unknown>;
  } catch {
    return {};
  }
}

async function writeConfig(p: string, cfg: Record<string, unknown>): Promise<void> {
  const raw = JSON.stringify(cfg, null, 2);
  const tmp = p + '.tmp';
  await fs.writeFile(tmp, raw, 'utf8');
  await fs.rename(tmp, p);
}

// ── Colour helpers (no dep on core color — inline) ───────────────────────────

function bold(s: string)  { return `\x1b[1m${s}\x1b[0m`; }
function dim(s: string)  { return `\x1b[2m${s}\x1b[0m`; }
function green(s: string) { return `\x1b[32m${s}\x1b[0m`; }
function yellow(s: string){ return `\x1b[33m${s}\x1b[0m`; }
function red(s: string)   { return `\x1b[31m${s}\x1b[0m`; }

function badge(state: string): string {
  switch (state) {
    case 'connected':    return green('● connected');
    case 'connecting':   return `\x1b[36m◐ connecting\x1b[0m`;
    case 'reconnecting': return `\x1b[36m◑ reconnecting\x1b[0m`;
    case 'disconnected': return dim('○ disconnected');
    case 'failed':       return red('✗ failed');
    default:            return dim(state);
  }
}
