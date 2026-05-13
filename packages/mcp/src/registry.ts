import type { EventBus, MCPServerConfig, ToolRegistry, Logger } from '@wrongstack/core';
import { MCPClient, type ConnectionState } from './client.js';
import { wrapMCPTool } from './wrap-tool.js';

interface ServerSlot {
  cfg: MCPServerConfig;
  client?: MCPClient;
  state: ConnectionState;
  toolNames: string[];
  attempts: number;
}

export interface MCPRegistryOptions {
  toolRegistry: ToolRegistry;
  events: EventBus;
  log: Logger;
}

export class MCPRegistry {
  private readonly servers = new Map<string, ServerSlot>();
  private readonly toolRegistry: ToolRegistry;
  private readonly events: EventBus;
  private readonly log: Logger;

  constructor(opts: MCPRegistryOptions) {
    this.toolRegistry = opts.toolRegistry;
    this.events = opts.events;
    this.log = opts.log;
  }

  async start(cfg: MCPServerConfig): Promise<void> {
    if (cfg.enabled === false) return;
    const slot: ServerSlot = {
      cfg,
      state: 'idle',
      toolNames: [],
      attempts: 0,
    };
    this.servers.set(cfg.name, slot);
    await this.attemptConnect(slot);
  }

  async stop(name: string): Promise<void> {
    const slot = this.servers.get(name);
    if (!slot) return;
    if (slot.client) await slot.client.close();
    for (const t of slot.toolNames) this.toolRegistry.unregister(t);
    slot.toolNames = [];
    slot.state = 'disconnected';
    this.events.emit('mcp.server.disconnected', { name, reason: 'stop' });
  }

  async restart(name: string): Promise<void> {
    const slot = this.servers.get(name);
    if (!slot) throw new Error(`MCP server "${name}" not registered`);
    await this.stop(name);
    slot.attempts = 0;
    await this.attemptConnect(slot);
  }

  list(): { name: string; state: ConnectionState; toolCount: number }[] {
    return Array.from(this.servers.values()).map((s) => ({
      name: s.cfg.name,
      state: s.state,
      toolCount: s.toolNames.length,
    }));
  }

  async stopAll(): Promise<void> {
    for (const name of Array.from(this.servers.keys())) {
      await this.stop(name);
    }
  }

  private async attemptConnect(slot: ServerSlot): Promise<void> {
    const MAX_ATTEMPTS = 3;
    let attempt = 0;
    while (attempt < MAX_ATTEMPTS) {
      attempt++;
      slot.state = attempt === 1 ? 'connecting' : 'reconnecting';
      slot.attempts = attempt;
      try {
        const client = new MCPClient({
          name: slot.cfg.name,
          transport: slot.cfg.transport,
          command: slot.cfg.command,
          args: slot.cfg.args,
          env: slot.cfg.env,
          url: slot.cfg.url,
          headers: slot.cfg.headers,
          startupTimeoutMs: slot.cfg.startupTimeoutMs,
        });
        await client.connect();
        slot.client = client;
        const isReconnect = attempt > 1;
        slot.state = 'connected';
        const allowed = slot.cfg.allowedTools;
        const wrapped = client
          .listTools()
          .filter((t) => !allowed || allowed.includes(t.name))
          .map((t) => wrapMCPTool(slot.cfg.name, t, client, slot.cfg.permission ?? 'confirm'));
        for (const tool of wrapped) {
          try {
            this.toolRegistry.register(tool, `mcp:${slot.cfg.name}`);
            slot.toolNames.push(tool.name);
          } catch (err) {
            this.log.warn(`MCP tool "${tool.name}" not registered`, err);
          }
        }
        this.events.emit(isReconnect ? 'mcp.server.reconnected' : 'mcp.server.connected', {
          name: slot.cfg.name,
          toolCount: slot.toolNames.length,
        });
        return; // success
      } catch (err) {
        this.log.warn(`MCP server "${slot.cfg.name}" connect attempt ${attempt} failed`, err);
        if (attempt >= MAX_ATTEMPTS) {
          this.log.error(`MCP server "${slot.cfg.name}" connect exhausted after ${MAX_ATTEMPTS} attempts`, err);
          slot.state = 'failed';
          this.events.emit('mcp.server.disconnected', {
            name: slot.cfg.name,
            reason: err instanceof Error ? err.message : 'unknown',
          });
          return;
        }
        const delay = 500 * 2 ** attempt;
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
}
