import { expectDefined } from '@wrongstack/core';
import type { EventBus, Logger, MCPServerConfig, ToolRegistry } from '@wrongstack/core';
import { MCP_CONSTANTS } from './constants.js';
import { type ConnectionState, MCPClient } from './client.js';
import { wrapMCPTool } from './wrap-tool.js';
interface ServerSlot {
  cfg: MCPServerConfig;
  client?: MCPClient | undefined;
  state: ConnectionState;
  toolNames: string[];
  attempts: number;
  /** Set when a reconnect cycle is already running for this slot. */
  reconnectPending: boolean;
  /**
   * L2-B: number of full reconnect *cycles* (where one cycle = one
   * `attemptConnect` invocation, which itself can try multiple times
   * before giving up). After `MAX_RECONNECT_CYCLES`, the slot stays
   * `failed` until a manual `restart()` resets it.
   */
  reconnectCycles: number;
  /**
   * Slot-scoped, bound disconnect callback. Stored so the matching
   * `removeDisconnectListener` call can hand back the *same* reference —
   * a fresh arrow `() => onTransportDisconnect(slot.cfg.name)` would
   * not match the one we added and the set-based listener registry
   * would silently keep the old handler, causing duplicate reconnect
   * cycles after a few transport flaps.
   */
  onDisconnect?: (() => void) | undefined;
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
      reconnectPending: false,
      reconnectCycles: 0,
    };
    this.servers.set(cfg.name, slot);
    await this.attemptConnect(slot);
  }

  async stop(name: string): Promise<void> {
    const slot = this.servers.get(name);
    if (!slot) return;
    slot.reconnectPending = false;
    if (slot.client) {
      slot.client.removeExitListener(this.onChildExit);
      if (slot.onDisconnect) slot.client.removeDisconnectListener(slot.onDisconnect);
      slot.client.removeToolsChangedListener(this.onToolsChanged);
      await slot.client.close();
      slot.client = undefined;
    }
    slot.onDisconnect = undefined;
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
    slot.reconnectCycles = 0; // user intent: start fresh
    await this.attemptConnect(slot);
  }

  list(): { name: string; state: ConnectionState; toolCount: number }[] {
    return Array.from(this.servers.values()).map((s) => ({
      name: s.cfg.name,
      state: s.state,
      toolCount: s.toolNames.length,
    }));
  }

  /**
   * Catalog of every server ever registered with this registry — includes
   * servers that are stopped, failed, or not yet started.
   * Useful for the `mcp_control` tool to show all known servers without
   * triggering connections.
   */
  describe(): { name: string; state: ConnectionState; toolCount: number; enabled: boolean }[] {
    return Array.from(this.servers.values()).map((s) => ({
      name: s.cfg.name,
      state: s.state,
      toolCount: s.toolNames.length,
      enabled: s.cfg.enabled !== false,
    }));
  }

  async stopAll(): Promise<void> {
    for (const name of Array.from(this.servers.keys())) {
      await this.stop(name);
    }
  }

  /**
   * Health check — returns 'ok' for connected servers, the current state otherwise.
   * For HTTP-based transports this could also ping the server.
   */
  health(): { name: string; alive: boolean; latencyMs?: number | undefined }[] {
    return Array.from(this.servers.values()).map((s) => ({
      name: s.cfg.name,
      alive: s.state === 'connected',
    }));
  }

  /**
   * L2-C: handle `notifications/tools/list_changed` from the server.
   * Unregister the previous wrapper set, then re-register the fresh
   * tool list. The client has already refreshed its cache before
   * dispatching — we just need to re-wrap and re-register.
   */
  private readonly onToolsChanged = (name: string, _tools: { name: string }[]): void => {
    const slot = this.servers.get(name);
    if (!slot || !slot.client) return;
    for (const t of slot.toolNames) {
      try {
        this.toolRegistry.unregister(t);
      } catch {
        /* ignore */
      }
    }
    slot.toolNames = [];
    const allowed = slot.cfg.allowedTools;
    const wrapped = slot.client
      .listTools()
      .filter((t) => !allowed || allowed.includes(t.name))
      .map((t) => wrapMCPTool(slot.cfg.name, t, expectDefined(slot.client), slot.cfg.permission ?? 'confirm'));
    for (const tool of wrapped) {
      try {
        this.toolRegistry.register(tool, `mcp:${slot.cfg.name}`);
        slot.toolNames.push(tool.name);
      } catch (err) {
        this.log.warn(`MCP tool "${tool.name}" not re-registered after list_changed`, err);
      }
    }
    this.events.emit('mcp.server.connected', {
      name: slot.cfg.name,
      toolCount: slot.toolNames.length,
    });
    this.log.info(
      `MCP server "${slot.cfg.name}" tools refreshed (${slot.toolNames.length} active)`,
    );
  };

  private readonly onChildExit = (
    name: string,
    code: number | null,
    _signal: string | null,
  ): void => {
    const slot = this.servers.get(name);
    if (!slot) return;
    for (const t of slot.toolNames) {
      try {
        this.toolRegistry.unregister(t);
      } catch {
        /* ignore */
      }
    }
    slot.toolNames = [];
    slot.state = 'disconnected';
    this.events.emit('mcp.server.disconnected', { name, reason: `exit:${code ?? 'unknown'}` });
    this.scheduleReconnect(slot);
  };

  /** Handles SSE / streamable-http disconnect — same recovery as stdio child exit. */
  private readonly onTransportDisconnect = (name: string): void => {
    const slot = this.servers.get(name);
    if (!slot) return;
    for (const t of slot.toolNames) {
      try {
        this.toolRegistry.unregister(t);
      } catch {
        /* ignore */
      }
    }
    slot.toolNames = [];
    slot.state = 'disconnected';
    this.events.emit('mcp.server.disconnected', { name, reason: 'http-disconnect' });
    this.scheduleReconnect(slot);
  };

  /**
   * L2-B: maximum number of reconnect cycles before staying `failed`.
   * One cycle = one full `attemptConnect` (which itself may try up to 3
   * times). Caps total reconnect storm at ~5 cycles, then the slot
   * needs an explicit `restart()` to re-engage.
   */
  private static readonly MAX_RECONNECT_CYCLES = MCP_CONSTANTS.RECONNECT.MAX_CYCLES;
  /** Base delay between cycles, in ms. Real delay adds jitter. */
  private static readonly BASE_RECONNECT_DELAY_MS = MCP_CONSTANTS.RECONNECT.BASE_DELAY_MS;
  /** Hard ceiling on the inter-cycle delay so the user doesn't wait minutes. */
  private static readonly MAX_RECONNECT_DELAY_MS = 30_000;

  private scheduleReconnect(slot: ServerSlot): void {
    if (slot.reconnectPending) return;
    if (slot.reconnectCycles >= MCPRegistry.MAX_RECONNECT_CYCLES) {
      slot.state = 'failed';
      this.log.error(
        `MCP server "${slot.cfg.name}" giving up after ${slot.reconnectCycles} reconnect cycles. Use \`/mcp restart ${slot.cfg.name}\` to retry.`,
      );
      this.events.emit('mcp.server.disconnected', {
        name: slot.cfg.name,
        reason: `reconnect-exhausted:${slot.reconnectCycles}`,
      });
      return;
    }
    slot.reconnectPending = true;
    // Exponential backoff with light jitter: 1s, 2s, 4s, 8s, 16s, capped
    // at 30s. The ±20% jitter avoids reconnect stampedes when many
    // servers crash together.
    const base = Math.min(
      MCPRegistry.BASE_RECONNECT_DELAY_MS * 2 ** slot.reconnectCycles,
      MCPRegistry.MAX_RECONNECT_DELAY_MS,
    );
    const jitter = base * MCP_CONSTANTS.RECONNECT.JITTER_FACTOR * (Math.random() * 2 - 1);
    const delay = Math.max(100, Math.round(base + jitter));
    setTimeout(() => this.attemptReconnect(slot), delay);
  }

  private async attemptReconnect(slot: ServerSlot): Promise<void> {
    slot.reconnectPending = false;
    slot.reconnectCycles++;
    await this.attemptConnect(slot);
  }

  private async attemptConnect(slot: ServerSlot): Promise<void> {
    const MAX_ATTEMPTS = MCP_CONSTANTS.RECONNECT.MAX_ATTEMPTS;
    let attempt = 0;
    while (attempt < MAX_ATTEMPTS) {
      attempt++;
      slot.state = attempt === 1 ? 'connecting' : 'reconnecting';
      slot.attempts = attempt;
      let client: MCPClient | undefined;
      let boundDisconnect: (() => void) | undefined;
      try {
        client = new MCPClient({
          name: slot.cfg.name,
          transport: slot.cfg.transport,
          command: slot.cfg.command,
          args: slot.cfg.args,
          env: slot.cfg.env,
          url: slot.cfg.url,
          headers: slot.cfg.headers,
          startupTimeoutMs: slot.cfg.startupTimeoutMs,
          requestTimeoutMs: slot.cfg.requestTimeoutMs,
        });
        if (slot.cfg.transport === 'stdio') {
          client.addExitListener(this.onChildExit);
        } else {
          // SSE / streamable-http — wire transport disconnect to registry reconnect.
          // Capture the bound function so we can hand the same reference to
          // removeDisconnectListener on cleanup paths.
          boundDisconnect = () => this.onTransportDisconnect(slot.cfg.name);
          client.addDisconnectListener(boundDisconnect);
        }
        // L2-C: react to server-side tool changes by re-registering wrappers.
        client.addToolsChangedListener(this.onToolsChanged);
        await client.connect();
        // Close any prior client before swapping refs so the old transport
        // can release its abort controller, child process, and listeners
        // instead of being held until GC.
        if (slot.client && slot.client !== client) {
          const prior = slot.client;
          const priorDisconnect = slot.onDisconnect;
          slot.client.removeExitListener(this.onChildExit);
          if (priorDisconnect) prior.removeDisconnectListener(priorDisconnect);
          prior.removeToolsChangedListener(this.onToolsChanged);
          prior.close().catch(() => {
            /* best-effort */
          });
        }
        slot.client = client;
        slot.onDisconnect = boundDisconnect;
        const isReconnect = attempt > 1;
        slot.state = 'connected';
        // L2-B: a healthy connect resets the cycle counter so future
        // crashes get the full reconnect budget again.
        slot.reconnectCycles = 0;
        const allowed = slot.cfg.allowedTools;
        // Prefer cached tools to avoid a round-trip to the server on reconnect.
        // The cache is populated by client.listTools() on first connect.
        const mc = client as MCPClient;
        const candidateTools = mc.listTools();
        const toWrap = candidateTools.length > 0 ? candidateTools : mc.listTools(); // fallback — in practice both return the same list
        const wrapped = toWrap
          .filter((t) => !allowed || allowed.includes(t.name))
          .map((t) => wrapMCPTool(slot.cfg.name, t, mc, slot.cfg.permission ?? 'confirm'));
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
        if (client) {
          client.removeExitListener(this.onChildExit);
          if (boundDisconnect) client.removeDisconnectListener(boundDisconnect);
          client.removeToolsChangedListener(this.onToolsChanged);
          await client.close().catch(() => {
            /* ignore */
          });
        }
        if (attempt >= MAX_ATTEMPTS) {
          this.log.error(
            `MCP server "${slot.cfg.name}" connect exhausted after ${MAX_ATTEMPTS} attempts`,
            err,
          );
          slot.state = 'failed';
          slot.client = undefined;
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
