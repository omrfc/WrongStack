/**
 * ACP v1 server-side protocol handler.
 *
 * Receives JSON-RPC requests from an external ACP client (Zed, JetBrains
 * Junie, VS Code ACP extension, etc.) over stdio and answers them per the
 * v1 spec. See https://agentclientprotocol.com/protocol/v1/overview.
 *
 * Supported methods
 * ─────────────────
 *  - initialize                — handshake
 *  - authenticate              — optional, no-op when auth isn't required
 *  - session/new               — create a session
 *  - session/load              — restore a session by id
 *  - session/prompt            — run one turn, stream session/update
 *                               notifications, return stopReason
 *  - session/cancel            — notification (no response); cancels the
 *                               in-flight turn on the target session
 *  - session/set_mode          — change the active mode for a session
 *  - session/set_config_option — change a config option value
 *  - session/list              — list known sessions
 *
 * Method execution
 * ────────────────
 *  The handler is transport-agnostic; it sends responses via the
 *  `AgentServerTransport` injected at construction. The actual
 *  agent-loop work for a `session/prompt` turn is delegated to the
 *  caller-provided `runTurn` callback, which receives the prompt
 *  blocks and the per-turn AbortSignal and resolves with the final
 *  stopReason. Updates are streamed via the `emit` callback passed
 *  to `runTurn`; the handler wraps each as a `session/update`
 *  notification.
 *
 *  This separation keeps the handler unit-testable: tests can supply
 *  a fake `runTurn` that yields a canned sequence of updates, and
 *  assert on the JSON-RPC traffic the handler produces. A real
 *  production caller wires `runTurn` to a core `Agent` instance.
 *
 * Concurrency
 * ───────────
 *  Each session is single-threaded (one active turn at a time). The
 *  handler keeps a per-session AbortController so a `session/cancel`
 *  notification can stop the running turn mid-stream without tearing
 *  down the session. Multiple sessions can be active concurrently.
 */
import {
  ACP_PROTOCOL_VERSION,
  type StopReason,
  type ContentBlock,
  type PermissionOption,
  type PlanEntry,
  type RequestPermissionOutcome,
  type ToolKind,
  type UsageCost,
} from '../types/acp-v1.js';
import type { AgentServerTransport } from './stdio-transport.js';
import type { ACPMessage } from '../types/acp-messages.js';

// Transport's `send` is typed `ACPMessage` which predates v1 and
// doesn't carry a `jsonrpc` field. The runtime is fine — the
// transport just `JSON.stringify`s the message — so cast at the
// boundary.
type WireMessage = { jsonrpc?: '2.0'; id?: string | number; method?: string; params?: unknown; result?: unknown; error?: unknown };
function toWire(msg: WireMessage): ACPMessage {
  return msg as never as ACPMessage;
}

export const WRONGSTACK_VERSION = '0.274.1';
const WRONGSTACK_AUTH_METHODS = [
  {
    id: 'wrongstack-auth',
    name: 'Run wstack auth',
    description: 'Configure a WrongStack model provider in an interactive terminal.',
    type: 'terminal',
    args: ['auth'],
  },
];

/** What kinds of content the agent accepts in a prompt. */
export interface PromptCapabilities {
  image: boolean;
  audio: boolean;
  embeddedContext: boolean;
}

export interface AgentCapabilities {
  loadSession: boolean;
  promptCapabilities: PromptCapabilities;
}

export interface RunTurnInput {
  sessionId: string;
  /** Content blocks the client sent. */
  prompt: readonly ContentBlock[];
  /** Cancelled when the client sends `session/cancel` for this session. */
  signal: AbortSignal;
}

export interface RunTurnResult {
  stopReason: StopReason;
  /** Optional summary text the agent produced. */
  text?: string;
  plan?: PlanEntry[];
  usage?: { used: number; size: number; cost?: UsageCost | undefined };
}

/**
 * A tool-call permission request the agent surfaces to the client.
 */
export interface RunTurnPermissionRequest {
  toolCall: { toolCallId: string; title: string; kind?: ToolKind | undefined };
  options: PermissionOption[];
}

/** Client filesystem/terminal capabilities advertised at initialize. */
export interface ClientCapabilities {
  fs?: { readTextFile?: boolean | undefined; writeTextFile?: boolean | undefined } | undefined;
  terminal?: boolean | undefined;
}

/**
 * Client-callback API handed to `runTurn`. Lets the agent's tools call back
 * into the connected ACP client — ask for permission, and (when the client
 * advertises the capability) use the client's filesystem and terminal so the
 * editor's view (including unsaved buffers) is the source of truth.
 */
export interface RunTurnApi {
  /**
   * Ask the connected ACP client to approve/reject a tool call via the
   * `session/request_permission` method. Resolves with the client's
   * outcome. Rejects if no client channel is available or the request
   * times out — the caller decides the fallback.
   */
  requestPermission(req: RunTurnPermissionRequest): Promise<RequestPermissionOutcome>;
  /** Capabilities the client advertised at initialize — gate tool wiring on these. */
  clientCapabilities: ClientCapabilities;
  /** Read a text file from the client's filesystem (`fs/read_text_file`). */
  readTextFile(params: { path: string; line?: number; limit?: number }): Promise<string>;
  /** Write a text file in the client's filesystem (`fs/write_text_file`). */
  writeTextFile(params: { path: string; content: string }): Promise<void>;
  /**
   * Run a command in the client's terminal (`terminal/create` →
   * `wait_for_exit` → `output` → `release`) and resolve with the combined
   * output and exit code.
   */
  runTerminal(params: {
    command: string;
    args?: string[] | undefined;
    cwd?: string | undefined;
  }): Promise<{ output: string; exitCode: number | null }>;
}

/**
 * The agent's per-turn work. Streams `SessionUpdate` notifications to
 * `emit` and resolves with the final stopReason. Errors thrown from
 * this iterable are converted to a `prompt_failed` JSON-RPC error.
 *
 * `api` is an optional client-callback surface (permission requests).
 * Older runTurn implementations that ignore it keep working unchanged.
 */
export type RunTurn = (
  input: RunTurnInput,
  emit: (update: unknown) => void,
  api?: RunTurnApi,
) => Promise<RunTurnResult>;

export interface SessionState {
  id: string;
  cwd: string;
  /** Per-turn abort signal — aborted when the session is cancelled or closed. */
  abort: AbortController;
  /** Active mode, advertised to the client in current_mode_update. */
  modeId: string;
  /** Created at, for session/list ordering. */
  createdAt: string;
  /** Last activity timestamp, for session/info_update. */
  updatedAt: string;
  /** Optional human title. */
  title?: string;
}

/** MCP-style session mode advertised in current_mode_update. */
export interface SessionMode {
  id: string;
  name: string;
  description?: string | undefined;
}

export interface SessionConfigOption {
  id: string;
  name: string;
  type: 'select' | string;
  currentValue: string;
  options: { value: string; name: string; description?: string | undefined }[];
}

export interface ProtocolHandlerOptions {
  transport: AgentServerTransport;
  /** Where the server is running; used for new sessions' default cwd. */
  defaultCwd: string;
  /** Agent's per-turn implementation. */
  runTurn: RunTurn;
  /**
   * Optional callbacks for the lifecycle events the server should
   * surface to the client. All default to no-ops.
   */
  onSessionNew?: ((state: SessionState) => void) | undefined;
  /** Static list of available modes (advertised to clients). */
  modes?: readonly SessionMode[] | undefined;
  /** Static list of config options. */
  configOptions?: readonly SessionConfigOption[] | undefined;
  /** Agent name advertised in initialize. */
  agentName?: string | undefined;
  /**
   * Optional source of replayable conversation history for `session/load`.
   * Returns the `session/update` payloads (user/agent message chunks) to
   * stream back to the client before the load response. Wired from
   * `makeACPServerAgentTurn(...).replay`.
   */
  replayFor?: ((sessionId: string) => Array<{ sessionUpdate: string; content: unknown }>) | undefined;
  /**
   * Optional hook to prime the turn engine's session history on cold
   * `session/load` (server restart). Wired from `makeACPServerAgentTurn(...).seed`
   * — it re-feeds the persisted conversation into the next-created Agent so
   * the model resumes, not just the client UI.
   */
  seedFor?: ((sessionId: string, history: Array<{ sessionUpdate: string; content: unknown }>) => void) | undefined;
  /**
   * Optional durable session store. When set, sessions + their recorded
   * history are persisted on create/prompt and restored on `session/load`,
   * so a reconnecting client can resume after a server restart.
   * (Structural type — `ACPSessionStore` satisfies it without a value import.)
   */
  store?: SessionPersistence | undefined;
}

/** Minimal durable-store contract the handler uses (ACPSessionStore satisfies it). */
export interface SessionPersistence {
  save(
    state: SessionState,
    history?: Array<{ sessionUpdate: string; content: unknown }>,
  ): Promise<unknown>;
  load(
    sessionId: string,
  ): Promise<
    | (Partial<SessionState> & { history?: Array<{ sessionUpdate: string; content: unknown }> | undefined })
    | null
  >;
}

/** Single global mode id, sufficient for v1. */
const DEFAULT_MODE_ID = 'code';

const DEFAULT_MODES: readonly SessionMode[] = [
  {
    id: DEFAULT_MODE_ID,
    name: 'Code',
    description: 'Default agent mode for code-generation tasks.',
  },
];

export class ACPProtocolHandler {
  private readonly transport: AgentServerTransport;
  private readonly defaultCwd: string;
  private readonly runTurn: RunTurn;
  private readonly onSessionNew: (state: SessionState) => void;
  private readonly modes: readonly SessionMode[];
  private readonly configOptions: readonly SessionConfigOption[];
  private readonly agentName: string;
  private readonly replayFor:
    | ((sessionId: string) => Array<{ sessionUpdate: string; content: unknown }>)
    | undefined;
  private readonly seedFor:
    | ((sessionId: string, history: Array<{ sessionUpdate: string; content: unknown }>) => void)
    | undefined;
  private readonly store: SessionPersistence | undefined;

  private initialized = false;
  private clientCapabilities: ClientCapabilities = {};
  private readonly sessions = new Map<string, SessionState>();
  private nextId = 1;

  // Outbound request correlation (server → client requests, e.g.
  // session/request_permission). Keyed by our own `srv_N` ids.
  private readonly pendingOut = new Map<
    string,
    { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }
  >();
  private nextOutId = 1;

  constructor(opts: ProtocolHandlerOptions) {
    this.transport = opts.transport;
    this.defaultCwd = opts.defaultCwd;
    this.runTurn = opts.runTurn;
    this.onSessionNew = opts.onSessionNew ?? (() => {});
    this.modes = opts.modes ?? DEFAULT_MODES;
    this.configOptions = opts.configOptions ?? [];
    this.agentName = opts.agentName ?? 'wrongstack';
    this.replayFor = opts.replayFor;
    this.seedFor = opts.seedFor;
    this.store = opts.store;
    // Route inbound JSON-RPC responses (to our outbound requests)
    // independently of the server's read loop. StdioTransport fires
    // onMessage on the stdin 'data' event, so a pending request resolves
    // even while a session/prompt handler is parked awaiting it.
    // Guarded: minimal transports (and some test fakes) may omit onMessage;
    // without it, server→client requests simply aren't supported.
    if (typeof this.transport.onMessage === 'function') {
      this.transport.onMessage((m) => this.maybeResolvePending(m));
    }
  }

  /**
   * Send a request to the client and await its response. Used for
   * server-initiated calls like `session/request_permission`. Rejects on
   * timeout or transport error so the caller can pick a safe fallback.
   */
  private request(method: string, params: unknown, timeoutMs = 60_000): Promise<unknown> {
    const id = `srv_${this.nextOutId++}`;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingOut.delete(id);
        reject(new Error(`${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pendingOut.set(id, { resolve, reject, timer });
      this.transport
        .send(toWire({ jsonrpc: '2.0', id, method, params }))
        .catch((e: unknown) => {
          clearTimeout(timer);
          this.pendingOut.delete(id);
          reject(e instanceof Error ? e : new Error(String(e)));
        });
    });
  }

  private maybeResolvePending(m: ACPMessage): void {
    const id = (m as { id?: unknown }).id;
    if (typeof id !== 'string') return;
    const pending = this.pendingOut.get(id);
    if (!pending) return;
    this.pendingOut.delete(id);
    clearTimeout(pending.timer);
    const err = (m as { error?: { message?: string } }).error;
    if (err) pending.reject(new Error(err.message ?? 'client request failed'));
    else pending.resolve((m as { result?: unknown }).result);
  }

  /**
   * Process one inbound message. Returns true if this was a terminal
   * message (rare; reserved for future use by the server's own
   * shutdown signal).
   */
  async handleMessage(msg: unknown): Promise<boolean> {
    if (typeof msg !== 'object' || msg === null) return false;
    const m = msg as { id?: unknown; method?: unknown; params?: unknown; result?: unknown; error?: unknown };

    // Response (we never initiate requests, but be defensive).
    if (m.id !== undefined && (m.result !== undefined || m.error !== undefined)) {
      return false;
    }

    // Request (has id, has method, no result/error)
    if (m.id !== undefined && typeof m.method === 'string') {
      return this.handleRequest(m.id as string | number, m.method, m.params);
    }

    // Notification (no id, has method)
    if (typeof m.method === 'string') {
      return this.handleNotification(m.method, m.params);
    }

    return false;
  }

  /** Abort all active turns and drop session state. */
  close(): void {
    for (const [, session] of this.sessions) {
      session.abort.abort();
    }
    this.sessions.clear();
    for (const [, p] of this.pendingOut) {
      clearTimeout(p.timer);
      p.reject(new Error('protocol handler closed'));
    }
    this.pendingOut.clear();
  }

  // ────────────────────────────────────────────────────────────────────
  // Requests
  // ────────────────────────────────────────────────────────────────────

  private async handleRequest(
    id: string | number,
    method: string,
    params: unknown,
  ): Promise<boolean> {
    // The only method allowed before initialize is `initialize` itself.
    if (method !== 'initialize' && !this.initialized) {
      await this.sendError(id, -32000, 'Not initialized');
      return false;
    }

    try {
      switch (method) {
        case 'initialize':
          return await this.handleInitialize(id, params);
        case 'authenticate':
          return await this.handleAuthenticate(id, params);
        case 'logout':
          return await this.handleLogout(id, params);
        case 'session/new':
          return await this.handleSessionNew(id, params);
        case 'session/load':
          return await this.handleSessionLoad(id, params);
        case 'session/resume':
          return await this.handleSessionResume(id, params);
        case 'session/close':
          return await this.handleSessionClose(id, params);
        case 'session/delete':
          return await this.handleSessionDelete(id, params);
        case 'session/prompt':
          return await this.handleSessionPrompt(id, params);
        case 'session/set_mode':
          return await this.handleSetMode(id, params);
        case 'session/set_config_option':
          return await this.handleSetConfigOption(id, params);
        case 'session/list':
          return await this.handleSessionList(id);
        case 'session/fork':
          return await this.handleSessionFork(id, params);
        case 'providers/list':
          return await this.handleProvidersList(id, params);
        case 'providers/set':
          return await this.handleProvidersSet(id, params);
        case 'providers/disable':
          return await this.handleProvidersDisable(id, params);
        case 'mcp/message':
          return await this.handleMcpMessage(id, params);
        default:
          if (method.startsWith('document/') || method.startsWith('nes/') || method.startsWith('elicitation/')) {
            // Spec: notifications don't require a response.
            // These are IDE-specific features we don't yet implement.
            return false;
          }
          await this.sendError(id, -32601, `Unknown method: ${method}`);
          return false;
      }
    } catch (err) {
      const { code, message, data } = errorToJsonRpc(err);
      await this.sendError(id, code, message, data);
      return false;
    }
  }

  private async handleInitialize(id: string | number, params: unknown): Promise<boolean> {
    const p = (params ?? {}) as { protocolVersion?: unknown; clientCapabilities?: ClientCapabilities };
    if (p.clientCapabilities && typeof p.clientCapabilities === 'object') {
      this.clientCapabilities = p.clientCapabilities;
    }
    const requested = typeof p.protocolVersion === 'number' ? p.protocolVersion : 1;
    if (requested !== ACP_PROTOCOL_VERSION) {
      await this.sendError(
        id,
        -32000,
        `server speaks protocolVersion=${ACP_PROTOCOL_VERSION}, client requested ${requested}`,
      );
      return false;
    }
    this.initialized = true;
    await this.transport.send(toWire({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: ACP_PROTOCOL_VERSION,
        agentCapabilities: {
          loadSession: true,
          promptCapabilities: {
            // We route ACP image blocks into the core agent's multimodal
            // input (server-agent-turn.promptToAgentInput); whether the
            // model can see them is the configured provider's concern.
            image: true,
            audio: false,
            embeddedContext: true,
          },
          mcpCapabilities: {
            http: false,
            sse: false,
          },
          sessionCapabilities: {
            close: {},
            list: {},
            delete: {},
            resume: {},
          },
          auth: {
            logout: {},
          },
        },
        agentInfo: {
          name: this.agentName,
          title: 'WrongStack',
          version: WRONGSTACK_VERSION,
        },
        authMethods: WRONGSTACK_AUTH_METHODS,
        modes: this.modes,
        configOptions: this.configOptions,
      },
    }));
    return false;
  }

  private async handleAuthenticate(id: string | number, _params: unknown): Promise<boolean> {
    // WrongStack doesn't currently require auth.
    await this.transport.send(toWire({
      jsonrpc: '2.0',
      id,
      result: { outcome: 'unauthenticated' },
    }));
    return false;
  }

  private async handleLogout(id: string | number, _params: unknown): Promise<boolean> {
    // WrongStack doesn't have persistent auth state, so logout is a no-op.
    await this.transport.send(toWire({
      jsonrpc: '2.0',
      id,
      result: {},
    }));
    return false;
  }

  private async handleSessionNew(id: string | number, params: unknown): Promise<boolean> {
    const p = (params ?? {}) as { cwd?: unknown; mcpServers?: unknown };
    const cwd = typeof p.cwd === 'string' ? p.cwd : this.defaultCwd;
    const sessionId = `sess_${this.allocId()}`;
    const now = new Date().toISOString();
    const state: SessionState = {
      id: sessionId,
      cwd,
      abort: new AbortController(),
      modeId: DEFAULT_MODE_ID,
      createdAt: now,
      updatedAt: now,
    };
    this.sessions.set(sessionId, state);
    this.onSessionNew(state);
    await this.persist(state);

    // Per spec, the server MAY emit current_mode_update /
    // config_option_update / available_commands_update notifications
    // immediately after session/new to populate the client UI. We do.
    await this.sendNotification({
      sessionId,
      update: {
        sessionUpdate: 'current_mode_update',
        modeId: this.modes[0]?.id ?? DEFAULT_MODE_ID,
      },
    });
    if (this.configOptions.length > 0) {
      await this.sendNotification({
        sessionId,
        update: {
          sessionUpdate: 'config_option_update',
          configOptions: [...this.configOptions],
        },
      });
    }

    await this.transport.send(toWire({
      jsonrpc: '2.0',
      id,
      result: {
        sessionId,
        modes: this.modes,
        configOptions: this.configOptions,
      },
    }));
    return false;
  }

  private async handleSessionLoad(id: string | number, params: unknown): Promise<boolean> {
    const p = (params ?? {}) as { sessionId?: unknown; cwd?: unknown; mcpServers?: unknown };
    const sessionId = typeof p.sessionId === 'string' ? p.sessionId : null;
    const loadCwd = typeof p.cwd === 'string' ? p.cwd : undefined;
    let existing = sessionId ? this.sessions.get(sessionId) : undefined;

    // Cold path: not in memory but persisted (server restarted). Restore the
    // session state + replay its stored history. The agent's own model
    // context starts fresh — the client UI is made whole via replay.
    if (!existing && sessionId && this.store) {
      const persisted = await this.store.load(sessionId);
      if (persisted) {
        const restored: SessionState = {
          id: sessionId,
          cwd: persisted.cwd ?? loadCwd ?? this.defaultCwd,
          abort: new AbortController(),
          modeId: persisted.modeId ?? DEFAULT_MODE_ID,
          createdAt: persisted.createdAt ?? new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          ...(persisted.title !== undefined ? { title: persisted.title } : {}),
        };
        this.sessions.set(sessionId, restored);
        // Prime the turn engine so the next prompt's Agent resumes the
        // model's context, not just the client UI.
        this.seedFor?.(sessionId, persisted.history ?? []);
        for (const update of persisted.history ?? []) {
          await this.sendNotification({ sessionId, update });
        }
        await this.sendNotification({
          sessionId,
          update: { sessionUpdate: 'current_mode_update', modeId: restored.modeId },
        });
        await this.transport.send(toWire({
          jsonrpc: '2.0',
          id,
          result: {
            initialMode: { currentModeId: restored.modeId, availableModes: this.modes },
          },
        }));
        return false;
      }
    }

    if (existing) {
      // Session exists in memory — restore it.
      existing.updatedAt = new Date().toISOString();
      // Replay the recorded conversation history (user/agent message
      // chunks) so the reconnecting client sees the prior turns.
      const replay = sessionId ? this.replayFor?.(sessionId) : undefined;
      if (replay) {
        for (const update of replay) {
          await this.sendNotification({ sessionId, update });
        }
      }
      await this.sendNotification({
        sessionId,
        update: {
          sessionUpdate: 'session_info_update',
          updatedAt: existing.updatedAt,
        },
      });
      await this.sendNotification({
        sessionId,
        update: {
          sessionUpdate: 'current_mode_update',
          modeId: existing.modeId,
        },
      });
      await this.transport.send(toWire({
        jsonrpc: '2.0',
        id,
        result: {
          initialMode: {
            currentModeId: existing.modeId,
            availableModes: this.modes,
          },
        },
      }));
      return false;
    }

    // Session not found — spec says to return an error.
    await this.sendError(id, -32000, `session not found: ${sessionId}`);
    return false;
  }

  private async handleSessionResume(id: string | number, params: unknown): Promise<boolean> {
    const p = (params ?? {}) as { sessionId?: unknown; cwd?: unknown; mcpServers?: unknown };
    const sessionId = typeof p.sessionId === 'string' ? p.sessionId : null;
    const existing = sessionId ? this.sessions.get(sessionId) : undefined;

    if (existing) {
      existing.updatedAt = new Date().toISOString();
      await this.transport.send(toWire({
        jsonrpc: '2.0',
        id,
        result: {
          initialMode: {
            currentModeId: existing.modeId,
            availableModes: this.modes,
          },
        },
      }));
      return false;
    }

    await this.sendError(id, -32000, `session not found: ${sessionId}`);
    return false;
  }

  private async handleSessionClose(id: string | number, params: unknown): Promise<boolean> {
    const p = (params ?? {}) as { sessionId?: unknown };
    const sessionId = typeof p.sessionId === 'string' ? p.sessionId : null;
    const session = sessionId ? this.sessions.get(sessionId) : undefined;

    if (!session) {
      await this.sendError(id, -32000, `session not found: ${sessionId}`);
      return false;
    }

    // Abort any in-flight turn and remove the session.
    session.abort.abort();
    if (sessionId) this.sessions.delete(sessionId);

    await this.transport.send(toWire({
      jsonrpc: '2.0',
      id,
      result: {},
    }));
    return false;
  }

  private async handleSessionDelete(id: string | number, params: unknown): Promise<boolean> {
    const p = (params ?? {}) as { sessionId?: unknown };
    const sessionId = typeof p.sessionId === 'string' ? p.sessionId : null;

    if (!sessionId) {
      await this.sendError(id, -32000, `session not found: ${sessionId}`);
      return false;
    }

    if (!this.sessions.has(sessionId)) {
      await this.transport.send(toWire({ jsonrpc: '2.0', id, result: { configOptions: [...this.configOptions] } }));
      return false;
    }
    const session = this.sessions.get(sessionId)!;
    session.abort.abort();
    this.sessions.delete(sessionId);

    await this.transport.send(toWire({
      jsonrpc: '2.0',
      id,
      result: {},
    }));
    return false;
  }

  private async handleSessionFork(id: string | number, params: unknown): Promise<boolean> {
    // Fork creates a new session from an existing one.
    const p = (params ?? {}) as { sessionId?: unknown; cwd?: unknown; mcpServers?: unknown };
    const sourceId = typeof p.sessionId === 'string' ? p.sessionId : null;
    if (!sourceId || !this.sessions.has(sourceId)) {
      await this.sendError(id, -32000, `session not found: ${sourceId}`);
      return false;
    }
    // Create a new session based on the source
    const forkParams: Record<string, unknown> = params as Record<string, unknown>;
    return this.handleSessionNew(id, { ...forkParams, cwd: p.cwd ?? this.defaultCwd });
  }

  private async handleProvidersList(id: string | number, _params: unknown): Promise<boolean> {
    // Return the current provider configuration.
    await this.transport.send(toWire({
      jsonrpc: '2.0',
      id,
      result: {
        providers: [],
        currentProviderId: null,
      },
    }));
    return false;
  }

  private async handleProvidersSet(id: string | number, _params: unknown): Promise<boolean> {
    await this.sendError(id, -32000, 'provider configuration not available through ACP; use wstack auth');
    return false;
  }

  private async handleProvidersDisable(id: string | number, _params: unknown): Promise<boolean> {
    await this.transport.send(toWire({
      jsonrpc: '2.0',
      id,
      result: {},
    }));
    return false;
  }

  private async handleMcpMessage(id: string | number, _params: unknown): Promise<boolean> {
    await this.sendError(id, -32000, 'MCP message routing not available through ACP');
    return false;
  }

  private async handleSessionPrompt(id: string | number, params: unknown): Promise<boolean> {
    const p = (params ?? {}) as { sessionId?: unknown; prompt?: unknown };
    const sessionId = typeof p.sessionId === 'string' ? p.sessionId : null;
    if (!sessionId || !this.sessions.has(sessionId)) {
      await this.sendError(id, -32000, 'unknown or missing sessionId');
      return false;
    }
    if (!Array.isArray(p.prompt)) {
      await this.sendError(id, -32602, 'prompt must be an array of content blocks');
      return false;
    }
    const session = this.sessions.get(sessionId)!;

    // If the previous turn was cancelled, recreate the AbortController
    // so a stale signal doesn't cancel the new turn.
    if (session.abort.signal.aborted) {
      session.abort = new AbortController();
    }

    const turnSignal = new AbortController();
    // Forward session/cancel notifications to the turn's signal.
    const onCancel = (): void => turnSignal.abort();
    session.abort.signal.addEventListener('abort', onCancel, { once: true });

    // Client-callback surface for this turn: lets the agent's tools ask
    // the connected client for permission, and use the client's filesystem
    // and terminal (when advertised) instead of the local ones.
    const api: RunTurnApi = {
      clientCapabilities: this.clientCapabilities,
      requestPermission: async (req) => {
        const res = await this.request('session/request_permission', {
          sessionId,
          toolCall: req.toolCall,
          options: req.options,
        });
        const outcome = (res as { outcome?: RequestPermissionOutcome } | undefined)?.outcome;
        return outcome ?? { outcome: 'cancelled' };
      },
      readTextFile: async (params) => {
        const res = await this.request('fs/read_text_file', { sessionId, ...params });
        return String((res as { content?: unknown })?.content ?? '');
      },
      writeTextFile: async (params) => {
        await this.request('fs/write_text_file', { sessionId, ...params });
      },
      runTerminal: async ({ command, args, cwd }) => {
        const created = (await this.request('terminal/create', {
          sessionId,
          command,
          ...(args ? { args } : {}),
          ...(cwd ? { cwd } : {}),
        })) as { terminalId?: string };
        const terminalId = created?.terminalId;
        if (!terminalId) return { output: '', exitCode: null };
        try {
          const exit = (await this.request('terminal/wait_for_exit', { sessionId, terminalId })) as {
            exitCode?: number | null;
          };
          const out = (await this.request('terminal/output', { sessionId, terminalId })) as {
            output?: unknown;
          };
          return {
            output: String(out?.output ?? ''),
            exitCode: typeof exit?.exitCode === 'number' ? exit.exitCode : null,
          };
        } finally {
          try {
            await this.request('terminal/release', { sessionId, terminalId });
          } catch {
            // best-effort release
          }
        }
      },
    };

    let result: RunTurnResult;
    try {
      result = await this.runTurn(
        { sessionId, prompt: p.prompt as ContentBlock[], signal: turnSignal.signal },
        (update) => this.sendNotification({ sessionId, update }),
        api,
      );
    } catch (err) {
      session.abort.signal.removeEventListener('abort', onCancel);
      const { code, message, data } = errorToJsonRpc(err);
      await this.sendError(id, code, message, data);
      return false;
    }
    session.abort.signal.removeEventListener('abort', onCancel);
    session.updatedAt = new Date().toISOString();
    await this.persist(session);

    await this.transport.send(toWire({
      jsonrpc: '2.0',
      id,
      result: { stopReason: result.stopReason },
    }));
    return false;
  }

  private async handleSetMode(id: string | number, params: unknown): Promise<boolean> {
    const p = (params ?? {}) as { sessionId?: unknown; modeId?: unknown };
    const sessionId = typeof p.sessionId === 'string' ? p.sessionId : null;
    const modeId = typeof p.modeId === 'string' ? p.modeId : null;
    const session = sessionId ? this.sessions.get(sessionId) : undefined;
    if (!session || !modeId || !this.modes.some((m) => m.id === modeId)) {
      await this.sendError(id, -32602, 'invalid sessionId or modeId');
      return false;
    }
    session.modeId = modeId;
    session.updatedAt = new Date().toISOString();
    await this.sendNotification({
      sessionId,
      update: { sessionUpdate: 'current_mode_update', modeId },
    });
    await this.transport.send(toWire({ jsonrpc: '2.0', id, result: {} }));
    return false;
  }

  private async handleSetConfigOption(id: string | number, params: unknown): Promise<boolean> {
    const p = (params ?? {}) as { sessionId?: unknown; configId?: unknown; value?: unknown };
    const sessionId = typeof p.sessionId === 'string' ? p.sessionId : null;
    const optionId = typeof p.configId === 'string' ? p.configId : null;
    const value = typeof p.value === 'string' ? p.value : null;
    const session = sessionId ? this.sessions.get(sessionId) : undefined;
    const option = optionId ? this.configOptions.find((o) => o.id === optionId) : undefined;
    if (!session || !option || value === null || !option.options.some((o) => o.value === value)) {
      await this.sendError(id, -32602, 'invalid sessionId, configId, or value');
      return false;
    }
    option.currentValue = value;
    session.updatedAt = new Date().toISOString();
    await this.sendNotification({
      sessionId,
      update: {
        sessionUpdate: 'config_option_update',
        configOptions: [...this.configOptions],
      },
    });
    await this.transport.send(toWire({ jsonrpc: '2.0', id, result: { configOptions: [...this.configOptions] } }));
    return false;
  }

  private async handleSessionList(id: string | number): Promise<boolean> {
    const sessions = Array.from(this.sessions.values()).map((s) => {
      const out: { sessionId: string; cwd: string; updatedAt: string; title?: string } = {
        sessionId: s.id,
        cwd: s.cwd,
        updatedAt: s.updatedAt,
      };
      if (s.title !== undefined) out.title = s.title;
      return out;
    });
    await this.transport.send(toWire({
      jsonrpc: '2.0',
      id,
      result: { sessions },
    }));
    return false;
  }

  // ────────────────────────────────────────────────────────────────────
  // Notifications
  // ────────────────────────────────────────────────────────────────────

  private async handleNotification(method: string, params: unknown): Promise<boolean> {
    switch (method) {
      case 'session/cancel': {
        const p = (params ?? {}) as { sessionId?: unknown };
        const sessionId = typeof p.sessionId === 'string' ? p.sessionId : null;
        const session = sessionId ? this.sessions.get(sessionId) : undefined;
        if (session) {
          session.abort.abort();
        }
        return false;
      }
      case '$/cancel_request': {
        // Protocol-level request cancellation — no-op for now.
        return false;
      }
      case 'exit':
        // Client is shutting down. Best-effort: abort all sessions.
        this.close();
        return true;
      default:
        // Unknown notification — log and ignore.
        return false;
    }
  }

  // ────────────────────────────────────────────────────────────────────
  // Wire helpers
  // ────────────────────────────────────────────────────────────────────

  private async sendNotification(params: unknown): Promise<void> {
    await this.transport.send(toWire({ jsonrpc: '2.0', method: 'session/update', params }));
  }

  /** Best-effort durable persistence of a session + its recorded history. */
  private async persist(state: SessionState): Promise<void> {
    if (!this.store) return;
    try {
      await this.store.save(state, this.replayFor?.(state.id));
    } catch {
      // persistence is best-effort — never fail a request because the disk hiccuped
    }
  }

  private async sendError(
    id: string | number,
    code: number,
    message: string,
    data?: unknown,
  ): Promise<void> {
    const error: { code: number; message: string; data?: unknown } = { code, message };
    if (data !== undefined) error.data = data;
    await this.transport.send(toWire({ jsonrpc: '2.0', id, error }));
  }

  private allocId(): number {
    return this.nextId++;
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Error mapping
// ─────────────────────────────────────────────────────────────────────────

function errorToJsonRpc(err: unknown): { code: number; message: string; data?: unknown } {
  if (err && typeof err === 'object') {
    const e = err as { code?: unknown; message?: unknown; data?: unknown };
    if (typeof e.code === 'number' && typeof e.message === 'string') {
      const result: { code: number; message: string; data?: unknown } = {
        code: e.code,
        message: e.message,
      };
      if (e.data !== undefined) result.data = e.data;
      return result;
    }
  }
  const message = err instanceof Error ? err.message : String(err);
  return { code: -32603, message };
}
