import type { EventBus, Logger, MCPServerConfig, Tool, ToolRegistry } from '@wrongstack/core';
import { expectDefined } from '@wrongstack/core';
import { type ConnectionState, MCPClient, type MCPTool } from './client.js';
import { MCP_CONSTANTS } from './constants.js';
import { manifestConfigHash, readManifest, writeManifest } from './manifest-cache.js';
import { wrapMCPTool } from './wrap-tool.js';

interface ServerSlot {
  cfg: MCPServerConfig;
  client?: MCPClient | undefined;
  state: ConnectionState;
  /** Tools currently registered in toolRegistry (empty in lazy mode). */
  toolNames: string[];
  /** Cached tools when lazyMode is active (not registered in toolRegistry). */
  lazyTools: Tool[];
  attempts: number;
  /** Set when a reconnect cycle is already running for this slot. */
  reconnectPending: boolean;
  /**
   * Handle to the pending backoff timer scheduled by `scheduleReconnect`.
   * Stored so `stop` / `stopAll` / `sleepIdle` / exhaustion paths can cancel
   * it — a stale timer that fires after the slot has been torn down would
   * resurrect the server via `attemptReconnect` (which doesn't gate on
   * `slot.state`).
   */
  reconnectTimer?: NodeJS.Timeout | undefined;
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
  /**
   * Lazy-connect: the server process is not spawned at boot. Tools are
   * registered from a cached manifest and the process only spawns on the first
   * tool call (via {@link MCPRegistry.ensureConnected}), then auto-sleeps.
   */
  lazy: boolean;
  /** Epoch ms of the last tool call — drives idle auto-sleep. */
  lastUsed: number;
  /** Single-flight guard so concurrent first-calls trigger only one connect. */
  connecting?: Promise<MCPClient> | undefined;
  /** Whether this lazy server's resolver wrappers are registered (register once). */
  registeredLazy: boolean;
}

export interface MCPRegistryOptions {
  toolRegistry: ToolRegistry;
  events: EventBus;
  log: Logger;
  /**
   * Directory for the on-disk tool-manifest cache (lazy-connect). Without it,
   * `lazy` servers cannot register tools cold and fall back to eager connect.
   * Typically `wpaths.cacheDir` (`~/.wrongstack/cache`).
   */
  cacheDir?: string | undefined;
  /**
   * Idle window (ms) after which a connected lazy server is auto-stopped and
   * re-woken on the next tool call. 0 disables idle auto-sleep.
   * Default: {@link MCP_CONSTANTS.IDLE.DEFAULT_TIMEOUT_MS}.
   */
  idleTimeoutMs?: number | undefined;
  /**
   * Lazy mode: when true, MCP server tools are NOT registered into the
   * tool registry on connect. They are cached internally and can be
   * activated on demand via `activateServer(name)`. This is used in
   * token-saving mode to avoid bloating the system prompt with 50-100+
   * MCP tool descriptions. The model uses `mcp_control({ action: "activate", server: "..." })`
   * to temporarily enable tools when needed.
   * Default: false.
   */
  lazyMode?: boolean | undefined;
}

export class MCPRegistry {
  private readonly servers = new Map<string, ServerSlot>();
  private readonly toolRegistry: ToolRegistry;
  private readonly events: EventBus;
  private readonly log: Logger;
  private readonly lazyMode: boolean;
  private readonly cacheDir?: string | undefined;
  private readonly idleTimeoutMs: number;
  /** Single shared idle sweep timer (started lazily; unref'd; cleared on stopAll). */
  private idleTimer?: ReturnType<typeof setInterval> | undefined;

  constructor(opts: MCPRegistryOptions) {
    this.toolRegistry = opts.toolRegistry;
    this.events = opts.events;
    this.log = opts.log;
    this.lazyMode = opts.lazyMode ?? false;
    this.cacheDir = opts.cacheDir;
    this.idleTimeoutMs = opts.idleTimeoutMs ?? MCP_CONSTANTS.IDLE.DEFAULT_TIMEOUT_MS;
  }

  async start(cfg: MCPServerConfig): Promise<void> {
    if (cfg.enabled === false) return;
    // Reject duplicate registrations explicitly. Without this, calling
    // start() twice with the same name would overwrite the slot in
    // `this.servers` and orphan the previous slot's client (still
    // connected, with listeners wired into a slot that's no longer
    // reachable from the registry). Callers that want a clean re-start
    // should use `restart(name)`.
    if (this.servers.has(cfg.name)) {
      throw new Error(
        `MCP server "${cfg.name}" is already registered — use restart() to re-cycle a running server`,
      );
    }
    // Lazy-connect requires a manifest cache dir to register tools cold.
    const lazy = !!cfg.lazy && !!this.cacheDir;
    const slot: ServerSlot = {
      cfg,
      state: 'idle',
      toolNames: [],
      lazyTools: [],
      attempts: 0,
      reconnectPending: false,
      reconnectCycles: 0,
      lazy,
      lastUsed: Date.now(),
      registeredLazy: false,
    };
    this.servers.set(cfg.name, slot);
    if (lazy) {
      await this.startLazy(slot);
    } else {
      await this.attemptConnect(slot);
    }
  }

  /**
   * Boot a lazy server WITHOUT spawning it. If a tool manifest is cached (from a
   * prior connect with matching config), register resolver-backed wrappers and
   * go `dormant` — the process spawns on the first tool call. If there is no
   * cache yet, do a one-time cold discovery connect to learn + cache the tools.
   */
  private async startLazy(slot: ServerSlot): Promise<void> {
    const cacheDir = this.cacheDir;
    if (!cacheDir) {
      await this.attemptConnect(slot);
      return;
    }
    const hash = manifestConfigHash(slot.cfg);
    const cached = await readManifest(cacheDir, slot.cfg.name, hash);
    if (cached && cached.length > 0) {
      this.applyTools(slot, cached);
      slot.state = 'dormant';
      this.ensureIdleSweep();
      this.log.info(
        `MCP server "${slot.cfg.name}" registered lazily from cache (${cached.length} tools, dormant)`,
      );
      return;
    }
    // No cache — must connect once to discover the tool list, then it stays
    // connected and becomes eligible for idle auto-sleep.
    await this.attemptConnect(slot);
  }

  /**
   * Ensure a lazy server is connected, spawning it on demand. Single-flight:
   * concurrent first-calls share one connect. Resolver wrappers call this.
   */
  async ensureConnected(name: string): Promise<MCPClient> {
    const slot = this.servers.get(name);
    if (!slot) throw new Error(`MCP server "${name}" not registered`);
    slot.lastUsed = Date.now();
    if (slot.client && slot.state === 'connected') return slot.client;
    if (slot.connecting) return slot.connecting;
    slot.connecting = (async () => {
      try {
        // start fresh budget — a deliberate wake is not a crash-reconnect.
        slot.attempts = 0;
        slot.reconnectCycles = 0;
        await this.attemptConnect(slot);
        if (!slot.client) {
          throw new Error(`MCP server "${name}" failed to connect on demand`);
        }
        slot.lastUsed = Date.now();
        this.ensureIdleSweep();
        return slot.client;
      } finally {
        slot.connecting = undefined;
      }
    })();
    return slot.connecting;
  }

  /**
   * Register all cached tools for a given server into the tool registry.
   * No-op if tools are already registered or the server is not connected.
   * The server connection stays alive — this only toggles tool visibility.
   */
  activateServer(name: string): void {
    const slot = this.servers.get(name);
    if (!slot) return;
    // A dormant lazy server has no client yet — its resolver wrappers connect on
    // demand, so it can still be activated (registered) without a live process.
    if (!slot.client && !slot.lazy) return;
    if (slot.toolNames.length > 0) return; // already active
    const cached = slot.lazyTools;
    if (cached.length === 0) return;
    for (const tool of cached) {
      try {
        this.toolRegistry.register(tool, `mcp:${name}`);
        slot.toolNames.push(tool.name);
      } catch (err) {
        this.log.warn(`MCP tool "${tool.name}" activate failed`, err);
      }
    }
    this.log.info(`MCP server "${name}" activated (${slot.toolNames.length} tools)`);
    this.events.emit('mcp.server.connected', { name, toolCount: slot.toolNames.length });
  }

  /**
   * Unregister all tools for a given server from the tool registry.
   * The server connection stays alive — this only toggles tool visibility.
   * Returns the number of tools that were deactivated.
   */
  deactivateServer(name: string): number {
    const slot = this.servers.get(name);
    if (!slot) return 0;
    const count = slot.toolNames.length;
    if (count === 0) return 0;
    for (const t of slot.toolNames) {
      try {
        this.toolRegistry.unregister(t);
      } catch {
        /* ignore */
      }
    }
    slot.toolNames = [];
    this.log.info(`MCP server "${name}" deactivated (${count} tools removed)`);
    this.events.emit('mcp.server.disconnected', { name, reason: 'deactivate' });
    return count;
  }

  /**
   * Check whether a server's tools are currently registered.
   */
  isActivated(name: string): boolean {
    const slot = this.servers.get(name);
    return slot ? slot.toolNames.length > 0 : false;
  }

  async stop(name: string): Promise<void> {
    const slot = this.servers.get(name);
    if (!slot) return;
    slot.reconnectPending = false;
    // Cancel the pending backoff timer. Without this, a disconnect scheduled
    // for reconnection would fire its `attemptReconnect` callback after the
    // slot has been torn down and respawn the server we just told to stop.
    if (slot.reconnectTimer) {
      clearTimeout(slot.reconnectTimer);
      slot.reconnectTimer = undefined;
    }
    if (slot.client) {
      slot.client.removeExitListener(this.onChildExit);
      if (slot.onDisconnect) slot.client.removeDisconnectListener(slot.onDisconnect);
      slot.client.removeToolsChangedListener(this.onToolsChanged);
      await slot.client.close();
      slot.client = undefined;
    }
    slot.onDisconnect = undefined;
    slot.connecting = undefined;
    for (const t of slot.toolNames) this.toolRegistry.unregister(t);
    slot.toolNames = [];
    slot.lazyTools = [];
    // Full teardown — a future start()/restart() re-registers lazy wrappers.
    slot.registeredLazy = false;
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

  list(): { name: string; state: ConnectionState; toolCount: number; tools: string[] }[] {
    return Array.from(this.servers.values()).map((s) => {
      const tools = this.toolNamesForSlot(s);
      return {
        name: s.cfg.name,
        state: s.state,
        toolCount: tools.length,
        tools,
      };
    });
  }

  /**
   * Resolve the live tool names for a slot — the registered names in normal
   * mode, or the cached lazy-tool names when running in lazy mode (where
   * tools are connected but intentionally not registered).
   */
  private toolNamesForSlot(s: ServerSlot): string[] {
    return s.toolNames.length > 0 ? s.toolNames.slice() : (s.lazyTools ?? []).map((t) => t.name);
  }

  /**
   * Wrap + register (or cache) a server's tools. Lazy servers get resolver-backed
   * wrappers that spawn the process on first use; eager servers bind the live
   * client directly. Honours token-saving `lazyMode` (cache, don't register) and
   * a register-once guard for lazy resolver wrappers (so a wake/reconnect reuses
   * the existing registrations rather than churning the tool list).
   */
  private applyTools(slot: ServerSlot, tools: MCPTool[], client?: MCPClient | undefined): void {
    // Resolver wrappers survive sleep/wake — only register them once.
    if (slot.lazy && slot.registeredLazy && !this.lazyMode) return;
    const allowed = slot.cfg.allowedTools;
    const filtered = tools.filter((t) => !allowed || allowed.includes(t.name));
    const clientArg = slot.lazy ? () => this.ensureConnected(slot.cfg.name) : expectDefined(client);
    const wrapped = filtered.map((t) =>
      wrapMCPTool(slot.cfg.name, t, clientArg, slot.cfg.permission ?? 'confirm'),
    );
    if (this.lazyMode) {
      // Token-saving mode: cache without registering (mcp_use activates on demand).
      slot.lazyTools = wrapped;
      return;
    }
    for (const tool of wrapped) {
      try {
        this.toolRegistry.register(tool, `mcp:${slot.cfg.name}`);
        slot.toolNames.push(tool.name);
      } catch (err) {
        this.log.warn(`MCP tool "${tool.name}" not registered`, err);
      }
    }
    if (slot.lazy) slot.registeredLazy = true;
  }

  /** Start the shared idle sweep timer once (unref'd so it never holds the process). */
  private ensureIdleSweep(): void {
    if (this.idleTimer || this.idleTimeoutMs <= 0) return;
    this.idleTimer = setInterval(() => {
      void this.sweepIdle();
    }, MCP_CONSTANTS.IDLE.SWEEP_INTERVAL_MS);
    // Node-only: don't keep the event loop alive just for the sweep.
    this.idleTimer.unref?.();
  }

  /** Auto-sleep connected lazy servers that have been idle past the timeout. */
  private async sweepIdle(): Promise<void> {
    if (this.idleTimeoutMs <= 0) return;
    const now = Date.now();
    for (const slot of this.servers.values()) {
      if (
        slot.lazy &&
        slot.state === 'connected' &&
        slot.client &&
        now - slot.lastUsed > this.idleTimeoutMs
      ) {
        await this.sleepIdle(slot);
      }
    }
  }

  /**
   * Soft stop: close the server process but KEEP its resolver wrappers and
   * cached manifest registered, so the next tool call transparently re-wakes it.
   * Distinct from {@link stop} (full teardown for disable/remove).
   */
  private async sleepIdle(slot: ServerSlot): Promise<void> {
    slot.reconnectPending = false;
    // Defense-in-depth: a connect-failure retry timer from an earlier
    // failed cycle shouldn't outlive a fresh sleep.
    if (slot.reconnectTimer) {
      clearTimeout(slot.reconnectTimer);
      slot.reconnectTimer = undefined;
    }
    if (slot.client) {
      // Remove the exit listener BEFORE close so the teardown isn't seen as a crash.
      slot.client.removeExitListener(this.onChildExit);
      if (slot.onDisconnect) slot.client.removeDisconnectListener(slot.onDisconnect);
      slot.client.removeToolsChangedListener(this.onToolsChanged);
      await slot.client.close();
      slot.client = undefined;
    }
    slot.onDisconnect = undefined;
    slot.state = 'dormant';
    this.log.info(`MCP server "${slot.cfg.name}" idle — sleeping (tools stay registered)`);
    this.events.emit('mcp.server.disconnected', { name: slot.cfg.name, reason: 'idle-sleep' });
  }

  /**
   * Catalog of every server ever registered with this registry — includes
   * servers that are stopped, failed, or not yet started.
   * Useful for the `mcp_control` tool to show all known servers without
   * triggering connections.
   */
  describe(): {
    name: string;
    state: ConnectionState;
    toolCount: number;
    enabled: boolean;
    tools: string[];
  }[] {
    return Array.from(this.servers.values()).map((s) => {
      const tools = this.toolNamesForSlot(s);
      return {
        name: s.cfg.name,
        state: s.state,
        toolCount: tools.length,
        enabled: s.cfg.enabled !== false,
        tools,
      };
    });
  }

  async stopAll(): Promise<void> {
    if (this.idleTimer) {
      clearInterval(this.idleTimer);
      this.idleTimer = undefined;
    }
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
   * In lazy mode, only update the internal cache without registering.
   */
  private readonly onToolsChanged = (name: string, _tools: { name: string }[]): void => {
    const slot = this.servers.get(name);
    if (!slot?.client) return;
    // Unregister any previously registered tools, then re-apply the fresh set.
    for (const t of slot.toolNames) {
      try {
        this.toolRegistry.unregister(t);
      } catch {
        /* ignore */
      }
    }
    slot.toolNames = [];
    slot.registeredLazy = false;
    const discovered = slot.client.listTools();
    // Refresh the lazy manifest so a future cold boot sees the new tool set.
    if (slot.lazy && this.cacheDir) {
      void writeManifest(this.cacheDir, slot.cfg.name, manifestConfigHash(slot.cfg), discovered);
    }
    this.applyTools(slot, discovered, slot.client);
    this.events.emit('mcp.server.connected', {
      name: slot.cfg.name,
      toolCount: slot.toolNames.length,
    });
    this.log.info(
      `MCP server "${slot.cfg.name}" tools refreshed (${this.toolNamesForSlot(slot).length} active)`,
    );
  };

  private readonly onChildExit = (
    name: string,
    code: number | null,
    _signal: string | null,
  ): void => {
    const slot = this.servers.get(name);
    if (!slot) return;
    if (slot.lazy) {
      // Lazy server died — go dormant (keep resolver wrappers); the next tool
      // call re-spawns it. No reconnect storm for an on-demand server.
      slot.client = undefined;
      slot.state = 'dormant';
      this.events.emit('mcp.server.disconnected', {
        name,
        reason: `exit:${code ?? 'unknown'} (dormant)`,
      });
      return;
    }
    for (const t of slot.toolNames) {
      try {
        this.toolRegistry.unregister(t);
      } catch {
        /* ignore */
      }
    }
    slot.toolNames = [];
    slot.lazyTools = [];
    slot.state = 'disconnected';
    this.events.emit('mcp.server.disconnected', { name, reason: `exit:${code ?? 'unknown'}` });
    this.scheduleReconnect(slot);
  };

  /** Handles SSE / streamable-http disconnect — same recovery as stdio child exit. */
  private readonly onTransportDisconnect = (name: string): void => {
    const slot = this.servers.get(name);
    if (!slot) return;
    if (slot.lazy) {
      slot.client = undefined;
      slot.state = 'dormant';
      this.events.emit('mcp.server.disconnected', { name, reason: 'http-disconnect (dormant)' });
      return;
    }
    for (const t of slot.toolNames) {
      try {
        this.toolRegistry.unregister(t);
      } catch {
        /* ignore */
      }
    }
    slot.toolNames = [];
    slot.lazyTools = [];
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
    // Cancel any previously-scheduled timer for this slot. Defensive — the
    // `reconnectPending` early-return above normally prevents re-scheduling
    // while one is outstanding, but if the slot was torn down mid-flight
    // and re-started (`restart()`), a stale handle from the prior cycle
    // could otherwise fire and resurrect the wrong client.
    if (slot.reconnectTimer) {
      clearTimeout(slot.reconnectTimer);
      slot.reconnectTimer = undefined;
    }
    // Exponential backoff with light jitter: 1s, 2s, 4s, 8s, 16s, capped
    // at 30s. The ±20% jitter avoids reconnect stampedes when many
    // servers crash together.
    const base = Math.min(
      MCPRegistry.BASE_RECONNECT_DELAY_MS * 2 ** slot.reconnectCycles,
      MCPRegistry.MAX_RECONNECT_DELAY_MS,
    );
    const jitter = base * MCP_CONSTANTS.RECONNECT.JITTER_FACTOR * (Math.random() * 2 - 1);
    const delay = Math.max(100, Math.round(base + jitter));
    slot.reconnectTimer = setTimeout(() => {
      slot.reconnectTimer = undefined;
      void this.attemptReconnect(slot);
    }, delay);
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
        const mc = client as MCPClient;
        const discovered = mc.listTools();
        // Lazy servers persist their manifest so later boots can register cold.
        if (slot.lazy && this.cacheDir) {
          await writeManifest(
            this.cacheDir,
            slot.cfg.name,
            manifestConfigHash(slot.cfg),
            discovered,
          );
        }
        this.applyTools(slot, discovered, mc);
        slot.lastUsed = Date.now();
        if (slot.lazy) this.ensureIdleSweep();
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
          // The connect() loop itself doesn't schedule a backoff timer (it
          // only awaits inline setTimeouts within the `while`), but a
          // prior `scheduleReconnect` cycle may have left one outstanding.
          // Drop it so the user can `restart()` without waiting on a stale
          // fire that would race the fresh `attemptConnect`.
          if (slot.reconnectTimer) {
            clearTimeout(slot.reconnectTimer);
            slot.reconnectTimer = undefined;
          }
          slot.reconnectPending = false;
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
