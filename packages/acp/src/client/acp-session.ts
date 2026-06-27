/**
 * ACPSession — v1-correct ACP client.
 *
 * Owns one child process running an ACP-supporting agent (Claude Code,
 * Gemini CLI, Codex CLI, etc.) and translates the wire protocol into
 * a `SubagentRunner`-shaped surface for the rest of WrongStack.
 *
 * Spec: https://agentclientprotocol.com/protocol/v1/overview
 * Design: see ./acp-session.design.md in this directory.
 */
import { ClientTransport, type ACPClientTransport } from '../agent/stdio-transport.js';
import type { ACPMessage } from '../types/acp-messages.js';
import {
  WebSocketClientTransport,
  type WebSocketClientTransportOptions,
} from './websocket-transport.js';
import {
  ACP_PROTOCOL_VERSION,
  type AgentCapabilities,
  type AnySessionUpdate,
  type AuthMethod,
  type ContentBlock,
  type McpServer,
  type PlanEntry,
  type SessionId,
  type SessionInfo,
  type StopReason,
  type ToolCallContent,
  type ToolCallStatus,
  type ToolCallUpdateNotification,
  type ToolKind,
  type UsageCost,
} from '../types/acp-v1.js';
import { FileServer, FsError } from './file-server.js';
import {
  defaultPermissionPolicy,
  type PermissionPolicy,
} from './permission.js';
import { TerminalServer } from './terminal-server.js';

export interface ACPSessionOptions {
  command: string;
  args?: readonly string[] | undefined;
  env?: Record<string, string> | undefined;
  cwd?: string | undefined;
  role?: string | undefined;
  /** Sandbox root for fs/* and terminal/* methods. */
  projectRoot: string;
  /** Hard timeout for one prompt turn. Default 5 minutes. */
  timeoutMs?: number | undefined;
  /** Override the permission policy. */
  permissionPolicy?: PermissionPolicy | undefined;
  /** Per-fs-call timeout, default 30s. */
  fsTimeoutMs?: number | undefined;
  /** Per-terminal command timeout, default 5 minutes. */
  terminalTimeoutMs?: number | undefined;
  /** Per-terminal output byte cap, default 1 MiB. */
  terminalOutputByteLimit?: number | undefined;
  /**
   * MCP server configs to include in session/new, session/load, and
   * session/resume. The agent will connect to these servers to provide
   * additional tools.
   *
   * Stdio servers are always sent. HTTP/SSE servers are only sent if
   * the agent advertises the corresponding mcpCapabilities.
   */
  mcpServers?: McpServer[] | undefined;
}

/**
 * A captured file diff emitted by the agent during a turn (via a tool
 * call's `diff` content). `oldText: null` means the file was created.
 */
export interface ACPCapturedDiff {
  path: string;
  oldText: string | null;
  newText: string;
}

/**
 * A captured tool call the agent ran during a turn. We collapse the
 * `tool_call` + subsequent `tool_call_update` notifications for the same
 * `toolCallId` into one record carrying its latest status.
 */
export interface ACPCapturedToolCall {
  toolCallId: string;
  title: string;
  kind?: ToolKind | undefined;
  status: ToolCallStatus;
  /** Terminal/command output or text content surfaced by the tool, if any. */
  rawOutput?: Record<string, unknown> | undefined;
  rawInput?: Record<string, unknown> | undefined;
}

export interface ACPSessionRunResult {
  text: string;
  stopReason: StopReason;
  hasText: boolean;
  usage?: { used: number; size: number; cost?: UsageCost | undefined } | undefined;
  plan?: PlanEntry[] | undefined;
  /** Tool calls the agent ran this turn (deduped by toolCallId). */
  toolCalls: ACPCapturedToolCall[];
  /** File diffs the agent produced this turn. */
  diffs: ACPCapturedDiff[];
  /** Agent "thinking" text emitted via thought_chunk, concatenated. */
  thoughts: string;
}

/**
 * Live progress callback. Invoked for every `session/update` notification
 * the agent streams during a `prompt()` turn, in arrival order, BEFORE the
 * turn resolves. Lets the host render tool activity / text deltas / diffs
 * as they happen instead of waiting for the buffered final result.
 *
 * The raw `update` (the discriminated `session/update` payload) is passed
 * through verbatim so callers can switch on `update.sessionUpdate`.
 */
export type ACPProgressHandler = (event: ACPProgressEvent) => void;

export type ACPProgressEvent =
  | { type: 'message'; text: string }
  | { type: 'thought'; text: string }
  | { type: 'tool_call'; toolCall: ACPCapturedToolCall }
  | { type: 'tool_call_update'; toolCall: ACPCapturedToolCall }
  | { type: 'diff'; diff: ACPCapturedDiff }
  | { type: 'plan'; entries: PlanEntry[] }
  | { type: 'usage'; usage: { used: number; size: number; cost?: UsageCost | undefined } }
  | { type: 'raw'; update: AnySessionUpdate };

export type ACPSessionErrorKind =
  | 'spawn_failed'
  | 'init_failed'
  | 'protocol_error'
  | 'session_create_failed'
  | 'prompt_failed'
  | 'auth_failed'
  | 'logout_failed'
  | 'aborted'
  | 'closed'
  | 'agent_died'
  | 'unsupported_capability';

export class ACPSessionError extends Error {
  readonly kind: ACPSessionErrorKind;
  override readonly cause: unknown;
  constructor(kind: ACPSessionErrorKind, message: string, cause?: unknown) {
    super(message);
    this.name = 'ACPSessionError';
    this.kind = kind;
    this.cause = cause;
  }
}

interface PendingRequest {
  method: string;
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timeoutMs: number;
  timeoutHandle: ReturnType<typeof setTimeout>;
}

type State = 'init' | 'ready' | 'authenticated' | 'sessioning' | 'prompting' | 'done' | 'closed';

interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

function isJsonRpcError(v: unknown): v is JsonRpcError {
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof (v as { code?: unknown }).code === 'number' &&
    typeof (v as { message?: unknown }).message === 'string'
  );
}

export class ACPSession {
  private readonly transport: ACPClientTransport;
  private readonly fileServer: FileServer;
  private readonly terminalServer: TerminalServer;
  private readonly permissionPolicy: PermissionPolicy;
  private readonly timeoutMs: number;
  private readonly opts: ACPSessionOptions;

  private state: State = 'init';
  private sessionId: SessionId | null = null;
  /** Pending outbound requests (initialize, session/new, session/prompt, etc). */
  private readonly pending = new Map<string | number, PendingRequest>();
  private nextId = 1;
  /** True after close() has been called. */
  private closed = false;

  // Agent-provided info from the initialize handshake
  private agentCapabilities: AgentCapabilities = {};
  private agentInfo: { name: string; title?: string | undefined; version: string } | null = null;
  private authMethods: AuthMethod[] = [];
  /** Protocol version negotiated with the agent during initialize. */
  private negotiatedVersion: number = ACP_PROTOCOL_VERSION;

  private constructor(opts: ACPSessionOptions, transport: ACPClientTransport) {
    this.opts = opts;
    this.transport = transport;
    this.timeoutMs = opts.timeoutMs ?? 5 * 60_000;
    const fsOpts: ConstructorParameters<typeof FileServer>[0] = {
      projectRoot: opts.projectRoot,
    };
    if (opts.fsTimeoutMs !== undefined) fsOpts.timeoutMs = opts.fsTimeoutMs;
    this.fileServer = new FileServer(fsOpts);
    const termOpts: ConstructorParameters<typeof TerminalServer>[0] = {
      projectRoot: opts.projectRoot,
    };
    if (opts.terminalTimeoutMs !== undefined) {
      termOpts.commandTimeoutMs = opts.terminalTimeoutMs;
    }
    if (opts.terminalOutputByteLimit !== undefined) {
      termOpts.outputByteLimit = opts.terminalOutputByteLimit;
    }
    this.terminalServer = new TerminalServer(termOpts);
    this.permissionPolicy = opts.permissionPolicy ?? defaultPermissionPolicy;
  }

  // ──────────────────────────────────────────────────────────────────────
  // Public accessors
  // ──────────────────────────────────────────────────────────────────────

  /** Agent capabilities advertised during initialize. */
  getCapabilities(): AgentCapabilities {
    return { ...this.agentCapabilities };
  }

  /** Authentication methods advertised by the agent. */
  getAuthMethods(): AuthMethod[] {
    return [...this.authMethods];
  }

  /** Agent info (name, title, version) from initialize. */
  getAgentInfo(): { name: string; title?: string | undefined; version: string } | null {
    return this.agentInfo;
  }

  /** Whether the agent requires authentication (has auth methods). */
  requiresAuth(): boolean {
    return this.authMethods.length > 0;
  }

  /** Current session id, if one exists. */
  getSessionId(): SessionId | null {
    return this.sessionId;
  }

  /** Protocol version negotiated during initialize. */
  getNegotiatedVersion(): number {
    return this.negotiatedVersion;
  }

  // ──────────────────────────────────────────────────────────────────────
  // Lifecycle — start
  // ──────────────────────────────────────────────────────────────────────

  /**
   * Spawn the child, run the initialize handshake, install the
   * message dispatch, and return a ready session.
   */
  static async start(opts: ACPSessionOptions): Promise<ACPSession> {
    const transportOpts: ConstructorParameters<typeof ClientTransport>[0] = {
      command: opts.command,
      args: opts.args ? [...opts.args] : [],
      handshakeTimeoutMs: 30_000,
      skipHandshakeMarker: true,
    };
    if (opts.env !== undefined) transportOpts.env = opts.env;
    if (opts.cwd !== undefined) transportOpts.cwd = opts.cwd;
    const transport = new ClientTransport(transportOpts);
    return ACPSession.attach(opts, transport, `failed to spawn ${opts.command}`);
  }

  /**
   * Connect to a REMOTE ACP agent over a WebSocket instead of spawning a
   * local subprocess. `opts.command` is ignored for the wire (a label is
   * still useful for `role`); everything else (projectRoot sandbox for
   * fs/terminal, timeouts, permission policy, MCP servers) applies the same.
   */
  static async connectWebSocket(
    wsOpts: WebSocketClientTransportOptions,
    opts: ACPSessionOptions,
  ): Promise<ACPSession> {
    const transport = new WebSocketClientTransport(wsOpts);
    return ACPSession.attach(opts, transport, `failed to connect to ${wsOpts.url}`);
  }

  /**
   * Connect using a caller-supplied transport. Lets advanced callers plug
   * in their own wire (SDK streams, in-process pipes, test doubles).
   */
  static async connect(
    transport: ACPClientTransport,
    opts: ACPSessionOptions,
  ): Promise<ACPSession> {
    return ACPSession.attach(opts, transport, 'failed to connect transport');
  }

  /** Shared connect path: start the transport, install dispatch, handshake. */
  private static async attach(
    opts: ACPSessionOptions,
    transport: ACPClientTransport,
    spawnErrLabel: string,
  ): Promise<ACPSession> {
    try {
      await transport.start();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new ACPSessionError('spawn_failed', `${spawnErrLabel}: ${msg}`, err);
    }

    const session = new ACPSession(opts, transport);
    transport.onMessage((msg) => session.handleMessage(msg));

    try {
      await session.initialize();
    } catch (err) {
      try {
        transport.stop();
      } catch {
        // best effort
      }
      throw err;
    }
    return session;
  }

  // ──────────────────────────────────────────────────────────────────────
  // Initialization
  // ──────────────────────────────────────────────────────────────────────

  private async initialize(): Promise<void> {
    const id = this.allocId();
    const result = await this.sendRequest(id, 'initialize', {
      protocolVersion: ACP_PROTOCOL_VERSION,
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
        terminal: true,
      },
      clientInfo: { name: 'wrongstack', title: 'WrongStack', version: '0.263.0' },
    });
    if (isJsonRpcError(result)) {
      throw new ACPSessionError('init_failed', `initialize failed: ${result.message}`, result);
    }
    if (
      typeof result !== 'object' ||
      result === null ||
      typeof (result as { protocolVersion?: unknown }).protocolVersion !== 'number'
    ) {
      throw new ACPSessionError('protocol_error', 'initialize returned no protocolVersion');
    }
    const r = result as {
      protocolVersion: number;
      agentCapabilities?: AgentCapabilities;
      agentInfo?: { name: string; title?: string | undefined; version: string };
      authMethods?: AuthMethod[];
    };
    // Negotiation per spec: the client advertises its latest supported
    // version; the agent replies with the version both will use — the
    // client's if the agent supports it, otherwise the agent's own latest.
    // We therefore accept any version <= ours (we can speak it) and only
    // reject a version HIGHER than we support (the agent demands a protocol
    // we don't implement). Equal is the common path.
    if (r.protocolVersion > ACP_PROTOCOL_VERSION) {
      throw new ACPSessionError(
        'unsupported_capability',
        `agent requires protocolVersion=${r.protocolVersion}, client supports up to ${ACP_PROTOCOL_VERSION}`,
      );
    }
    this.negotiatedVersion = r.protocolVersion;
    // Store agent metadata
    this.agentCapabilities = r.agentCapabilities ?? {};
    this.agentInfo = r.agentInfo ?? null;
    this.authMethods = r.authMethods ?? [];
    this.state = 'ready';
  }

  // ──────────────────────────────────────────────────────────────────────
  // Authentication
  // ──────────────────────────────────────────────────────────────────────

  /**
   * Authenticate with the agent using one of the advertised auth methods.
   * Call this AFTER start() and BEFORE any session/new call.
   *
   * Throws ACPSessionError('auth_failed') if the agent rejects the
   * authentication or if the methodId is not in the advertised list.
   */
  async authenticate(methodId: string): Promise<void> {
    if (this.state === 'closed') {
      throw new ACPSessionError('closed', 'session is closed');
    }
    if (this.state !== 'ready') {
      throw new ACPSessionError(
        'protocol_error',
        `authenticate called in state=${this.state} (expected 'ready')`,
      );
    }
    if (!this.authMethods.some((m) => m.id === methodId)) {
      throw new ACPSessionError(
        'auth_failed',
        `auth method "${methodId}" not in advertised methods: ${this.authMethods.map((m) => m.id).join(', ')}`,
      );
    }

    const id = this.allocId();
    const result = await this.sendRequest(id, 'authenticate', { methodId });
    if (isJsonRpcError(result)) {
      throw new ACPSessionError('auth_failed', `authenticate failed: ${result.message}`, result);
    }
    this.state = 'authenticated';
  }

  /**
   * Log out from the current authenticated session.
   * Only callable if the agent advertises `auth.logout` capability.
   */
  async logout(): Promise<void> {
    if (this.state === 'closed') {
      throw new ACPSessionError('closed', 'session is closed');
    }
    if (!this.agentCapabilities.auth?.logout) {
      throw new ACPSessionError(
        'unsupported_capability',
        'agent does not support logout (auth.logout capability not advertised)',
      );
    }

    const id = this.allocId();
    const result = await this.sendRequest(id, 'logout', {});
    if (isJsonRpcError(result)) {
      throw new ACPSessionError('logout_failed', `logout failed: ${result.message}`, result);
    }
    this.state = 'ready';
  }

  // ──────────────────────────────────────────────────────────────────────
  // Session management
  // ──────────────────────────────────────────────────────────────────────

  /**
   * Load an existing session. The agent replays the conversation history
   * via session/update notifications before responding.
   *
   * Only works if the agent advertises `loadSession` capability.
   *
   * @param sessionId - The session to load
   * @param mcpServers - Optional MCP servers (defaults to options.mcpServers)
   * @param cwd - Optional working directory (defaults to options.cwd or projectRoot)
   */
  async loadSession(
    sessionId: SessionId,
    mcpServers?: McpServer[],
    cwd?: string,
  ): Promise<void> {
    if (this.closed) {
      throw new ACPSessionError('closed', 'session is closed');
    }
    if (!this.agentCapabilities.loadSession) {
      throw new ACPSessionError(
        'unsupported_capability',
        'agent does not support session/load (loadSession capability not advertised)',
      );
    }
    if (this.sessionId) {
      // Close current session first
      await this.closeSession();
    }

    this.resetScratch();
    const servers = this.filterMcpServers(mcpServers ?? this.opts.mcpServers);
    const id = this.allocId();
    const result = await this.sendRequest(id, 'session/load', {
      sessionId,
      cwd: cwd ?? this.opts.cwd ?? this.opts.projectRoot,
      mcpServers: servers,
    });
    if (isJsonRpcError(result)) {
      throw new ACPSessionError('prompt_failed', `session/load failed: ${result.message}`, result);
    }
    this.sessionId = sessionId;
  }

  /**
   * Resume an existing session without replaying history.
   *
   * Only works if the agent advertises `sessionCapabilities.resume`.
   *
   * @param sessionId - The session to resume
   * @param mcpServers - Optional MCP servers (defaults to options.mcpServers)
   * @param cwd - Optional working directory (defaults to options.cwd or projectRoot)
   */
  async resumeSession(
    sessionId: SessionId,
    mcpServers?: McpServer[],
    cwd?: string,
  ): Promise<void> {
    if (this.closed) {
      throw new ACPSessionError('closed', 'session is closed');
    }
    if (!this.agentCapabilities.sessionCapabilities?.resume) {
      throw new ACPSessionError(
        'unsupported_capability',
        'agent does not support session/resume (sessionCapabilities.resume not advertised)',
      );
    }
    if (this.sessionId) {
      await this.closeSession();
    }

    const servers = this.filterMcpServers(mcpServers ?? this.opts.mcpServers);
    const id = this.allocId();
    const result = await this.sendRequest(id, 'session/resume', {
      sessionId,
      cwd: cwd ?? this.opts.cwd ?? this.opts.projectRoot,
      mcpServers: servers,
    });
    if (isJsonRpcError(result)) {
      throw new ACPSessionError('prompt_failed', `session/resume failed: ${result.message}`, result);
    }
    this.sessionId = sessionId;
  }

  /**
   * List existing sessions known to the agent.
   *
   * Only works if the agent advertises `sessionCapabilities.list`.
   */
  async listSessions(cursor?: string, cwd?: string): Promise<{ sessions: SessionInfo[]; nextCursor?: string | undefined }> {
    if (this.closed) {
      throw new ACPSessionError('closed', 'session is closed');
    }
    if (!this.agentCapabilities.sessionCapabilities?.list) {
      throw new ACPSessionError(
        'unsupported_capability',
        'agent does not support session/list (sessionCapabilities.list not advertised)',
      );
    }

    const id = this.allocId();
    const params: Record<string, unknown> = {};
    if (cursor !== undefined) params.cursor = cursor;
    if (cwd !== undefined) params.cwd = cwd;
    const result = await this.sendRequest(id, 'session/list', params);
    if (isJsonRpcError(result)) {
      throw new ACPSessionError('prompt_failed', `session/list failed: ${result.message}`, result);
    }
    const r = result as { sessions?: SessionInfo[]; nextCursor?: string };
    return {
      sessions: r.sessions ?? [],
      nextCursor: r.nextCursor,
    };
  }

  /**
   * Delete a session from the agent's session list.
   *
   * Only works if the agent advertises `sessionCapabilities.delete`.
   */
  async deleteSession(sessionId: SessionId): Promise<void> {
    if (this.closed) {
      throw new ACPSessionError('closed', 'session is closed');
    }
    if (!this.agentCapabilities.sessionCapabilities?.delete) {
      throw new ACPSessionError(
        'unsupported_capability',
        'agent does not support session/delete (sessionCapabilities.delete not advertised)',
      );
    }

    const id = this.allocId();
    const result = await this.sendRequest(id, 'session/delete', { sessionId });
    if (isJsonRpcError(result)) {
      throw new ACPSessionError('prompt_failed', `session/delete failed: ${result.message}`, result);
    }

    if (this.sessionId === sessionId) {
      this.sessionId = null;
    }
  }

  /**
   * Fork a session — create a new session from an existing one.
   */
  async forkSession(
    sourceSessionId: SessionId,
    cwd?: string,
    mcpServers?: McpServer[],
  ): Promise<SessionId> {
    if (this.closed) throw new ACPSessionError('closed', 'session is closed');

    const servers = this.filterMcpServers(mcpServers ?? this.opts.mcpServers);
    const id = this.allocId();
    const result = await this.sendRequest(id, 'session/fork', {
      sessionId: sourceSessionId,
      cwd: cwd ?? this.opts.cwd ?? this.opts.projectRoot,
      ...(servers.length > 0 ? { mcpServers: servers } : {}),
    });
    if (isJsonRpcError(result)) {
      throw new ACPSessionError('prompt_failed', `session/fork failed: ${result.message}`, result);
    }
    const newId = (result as { sessionId?: unknown }).sessionId;
    if (typeof newId !== 'string' || !newId) {
      throw new ACPSessionError('protocol_error', 'session/fork returned no sessionId', result);
    }
    return newId as SessionId;
  }

  /**
   * Set the active mode for a session.
   */
  async setMode(sessionId: SessionId, modeId: string): Promise<void> {
    if (this.closed) throw new ACPSessionError('closed', 'session is closed');
    const id = this.allocId();
    const result = await this.sendRequest(id, 'session/set_mode', { sessionId, modeId });
    if (isJsonRpcError(result)) {
      throw new ACPSessionError('prompt_failed', `session/set_mode failed: ${result.message}`, result);
    }
  }

  /**
   * Set a configuration option for a session.
   */
  async setConfigOption(sessionId: SessionId, configId: string, value: string): Promise<void> {
    if (this.closed) throw new ACPSessionError('closed', 'session is closed');
    const id = this.allocId();
    const result = await this.sendRequest(id, 'session/set_config_option', {
      sessionId, configId, value,
    });
    if (isJsonRpcError(result)) {
      throw new ACPSessionError('prompt_failed', `session/set_config_option failed: ${result.message}`, result);
    }
  }

  /**
   * List available providers and the current provider.
   */
  async listProviders(): Promise<{ providers: unknown[]; currentProviderId: string | null }> {
    if (this.closed) throw new ACPSessionError('closed', 'session is closed');
    const id = this.allocId();
    const result = await this.sendRequest(id, 'providers/list', {});
    if (isJsonRpcError(result)) {
      throw new ACPSessionError('prompt_failed', `providers/list failed: ${result.message}`, result);
    }
    const r = result as { providers?: unknown[]; currentProviderId?: string | null };
    return { providers: r.providers ?? [], currentProviderId: r.currentProviderId ?? null };
  }

  /**
   * Send an MCP message to the agent for routing.
   */
  async mcpMessage(connectionId: string, message: Record<string, unknown>): Promise<unknown> {
    if (this.closed) throw new ACPSessionError('closed', 'session is closed');
    const id = this.allocId();
    const result = await this.sendRequest(id, 'mcp/message', { connectionId, message });
    if (isJsonRpcError(result)) {
      throw new ACPSessionError('prompt_failed', `mcp/message failed: ${result.message}`, result);
    }
    return result;
  }

  /**
   * Set the active provider for the agent.
   */
  async setProvider(providerId: string, config?: Record<string, unknown>): Promise<void> {
    if (this.closed) throw new ACPSessionError('closed', 'session is closed');
    const id = this.allocId();
    const result = await this.sendRequest(id, 'providers/set', { providerId, ...(config ?? {}) });
    if (isJsonRpcError(result)) {
      throw new ACPSessionError('prompt_failed', `providers/set failed: ${result.message}`, result);
    }
  }

  /**
   * Disable the current provider.
   */
  async disableProvider(): Promise<void> {
    if (this.closed) throw new ACPSessionError('closed', 'session is closed');
    const id = this.allocId();
    const result = await this.sendRequest(id, 'providers/disable', {});
    if (isJsonRpcError(result)) {
      throw new ACPSessionError('prompt_failed', `providers/disable failed: ${result.message}`, result);
    }
  }

  // ──────────────────────────────────────────────────────────────────────
  // Prompt
  // ──────────────────────────────────────────────────────────────────────

  /**
   * Run one prompt turn. Creates a session if needed, sends the
   * prompt, streams session/update notifications, and resolves with
   * the agent's response.
   *
   * @param blocks - Content blocks to send. Use `textContent()` for plain
   *   text, or include ImageContent/AudioContent if the agent's
   *   `promptCapabilities` allow it.
   * @param signal - AbortSignal for cancellation.
   *
   * Cancellation: if `signal` aborts mid-prompt, we send
   * `session/cancel` (a notification per spec) and keep accepting
   * updates until the agent returns with `stopReason: 'cancelled'`.
   * The result is the same shape as a normal turn, with
   * `stopReason === 'cancelled'`.
   */
  async prompt(
    blocks: ContentBlock[],
    signal: AbortSignal,
    onProgress?: ACPProgressHandler,
  ): Promise<ACPSessionRunResult> {
    if (this.closed) {
      throw new ACPSessionError('closed', 'session is closed');
    }
    if (this.state !== 'ready' && this.state !== 'authenticated' && this.state !== 'done') {
      throw new ACPSessionError('protocol_error', `prompt called in state=${this.state}`);
    }

    // Pre-aborted signals short-circuit BEFORE we create a session
    // and before any wire activity.
    if (signal.aborted) {
      return emptyRunResult('cancelled');
    }

    if (!this.sessionId) {
      await this.createSession();
    }

    this.resetScratch();
    this.progressHandler = onProgress ?? null;

    const promptId = this.allocId();
    const turnPromise = this.sendRequest(
      promptId,
      'session/prompt',
      {
        sessionId: this.sessionId,
        prompt: blocks,
      },
      this.timeoutMs,
    );

    let cancelled = false;
    const onAbort = (): void => {
      cancelled = true;
      this.transport
        .send({ method: 'session/cancel', params: { sessionId: this.sessionId } })
        .catch(() => {
          // transport may already be torn down — ignore
        });
    };
    signal.addEventListener('abort', onAbort, { once: true });

    this.state = 'prompting';
    let response: unknown;
    try {
      response = await turnPromise;
    } catch (err) {
      this.state = 'done';
      signal.removeEventListener('abort', onAbort);
      if (cancelled || signal.aborted) {
        throw new ACPSessionError('aborted', 'prompt was aborted by the parent');
      }
      const msg = err instanceof Error ? err.message : String(err);
      throw new ACPSessionError('prompt_failed', `session/prompt failed: ${msg}`, err);
    } finally {
      signal.removeEventListener('abort', onAbort);
      this.progressHandler = null;
    }

    this.state = 'done';
    if (isJsonRpcError(response)) {
      throw new ACPSessionError('prompt_failed', `agent error: ${response.message}`, response);
    }
    const stopReason = (response as { stopReason?: StopReason }).stopReason ?? 'end_turn';
    const finalText = this.scratch.text;
    return {
      text: finalText,
      stopReason,
      hasText: finalText.length > 0,
      usage: this.scratch.usage,
      plan: this.scratch.plan,
      toolCalls: [...this.scratch.toolCalls.values()],
      diffs: this.scratch.diffs,
      thoughts: this.scratch.thoughts,
    };
  }

  private async createSession(): Promise<void> {
    const servers = this.filterMcpServers(this.opts.mcpServers);
    const id = this.allocId();
    const result = await this.sendRequest(id, 'session/new', {
      cwd: this.opts.cwd ?? this.opts.projectRoot,
      mcpServers: servers,
    });
    if (isJsonRpcError(result)) {
      throw new ACPSessionError(
        'session_create_failed',
        `session/new failed: ${result.message}`,
        result,
      );
    }
    const sessionId = (result as { sessionId?: unknown }).sessionId;
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      throw new ACPSessionError(
        'protocol_error',
        'session/new returned no sessionId',
        result,
      );
    }
    this.sessionId = sessionId as SessionId;
  }

  /**
   * Close the current session gracefully (if the agent supports it).
   *
   * Sends `session/close` JSON-RPC request, then clears the local
   * session id. Best-effort — errors are swallowed so the caller can
   * always proceed to transport teardown.
   */
  private async closeSession(): Promise<void> {
    if (!this.sessionId) return;
    const sid = this.sessionId;
    this.sessionId = null;

    if (this.agentCapabilities.sessionCapabilities?.close) {
      const id = this.allocId();
      try {
        await this.sendRequest(id, 'session/close', { sessionId: sid }, 10_000);
      } catch {
        // Best-effort: if close fails, we still proceed with transport stop.
      }
    }
  }

  // ──────────────────────────────────────────────────────────────────────
  // Lifecycle — close
  // ──────────────────────────────────────────────────────────────────────

  /** Tear down the session and kill the child process. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.state = 'closed';
    this.terminalServer.releaseAll();

    // Graceful session close (if session is active and agent supports it)
    if (this.sessionId && this.agentCapabilities.sessionCapabilities?.close) {
      try {
        await this.closeSession();
      } catch {
        // best-effort
      }
    }

    // Reject any pending outbound requests so their awaits return.
    for (const [, p] of this.pending) {
      clearTimeout(p.timeoutHandle);
      p.reject(new ACPSessionError('closed', 'session was closed'));
    }
    this.pending.clear();
    try {
      this.transport.stop();
    } catch {
      // best effort
    }
  }

  // ──────────────────────────────────────────────────────────────────────
  // Helpers
  // ──────────────────────────────────────────────────────────────────────

  /**
   * Filter MCP servers according to agent capabilities.
   * - Stdio servers are always included.
   * - HTTP servers are only included if agent supports mcpCapabilities.http.
   * - SSE servers are only included if agent supports mcpCapabilities.sse.
   */
  private filterMcpServers(servers?: McpServer[]): McpServer[] {
    if (!servers || servers.length === 0) return [];
    const mcpCaps = this.agentCapabilities.mcpCapabilities ?? {};
    return servers.filter((s) => {
      if ('type' in s && s.type === 'http') return mcpCaps.http === true;
      if ('type' in s && s.type === 'sse') return mcpCaps.sse === true;
      return true; // stdio — always supported per spec
    });
  }

  // ────────────────────────────────────────────────────────────────────
  // Wire layer
  // ────────────────────────────────────────────────────────────────────

  private allocId(): number {
    return this.nextId++;
  }

  private async sendRequest(
    id: number,
    method: string,
    params: unknown,
    timeoutMs?: number,
  ): Promise<unknown> {
    return new Promise<unknown>((resolve, reject) => {
      const effectiveTimeout = timeoutMs ?? this.timeoutMs;
      const handle = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new ACPSessionError(
            'protocol_error',
            `${method} timed out after ${effectiveTimeout}ms`,
          ),
        );
      }, effectiveTimeout);
      this.pending.set(id, {
        method,
        resolve: resolve as (v: unknown) => void,
        reject,
        timeoutMs: effectiveTimeout,
        timeoutHandle: handle,
      });
      this.transport
        .send({ jsonrpc: '2.0', id, method, params } as never as ACPMessage)
        .catch((err) => {
          clearTimeout(handle);
          this.pending.delete(id);
          const msg = err instanceof Error ? err.message : String(err);
          reject(new ACPSessionError('protocol_error', `send ${method} failed: ${msg}`, err));
        });
    });
  }

  private handleMessage(msg: ACPMessage): void {
    // Response to an outbound request (has id and either result or error)
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const pending = this.pending.get(msg.id);
      if (!pending) return;
      clearTimeout(pending.timeoutHandle);
      this.pending.delete(msg.id);
      if (msg.error !== undefined) {
        pending.reject(new Error(msg.error.message ?? 'unknown JSON-RPC error'));
      } else {
        pending.resolve(msg.result);
      }
      return;
    }

    // session/update notification (no id)
    if (msg.method === 'session/update') {
      this.handleUpdate(msg);
      return;
    }

    // session/request_permission (has id, expected response: outcome)
    if (msg.method === 'session/request_permission') {
      void this.handlePermissionRequest(msg);
      return;
    }

    // fs/* requests
    if (msg.method === 'fs/read_text_file' || msg.method === 'fs/write_text_file') {
      void this.handleFsRequest(msg);
      return;
    }

    // terminal/* requests
    if (msg.method?.startsWith('terminal/')) {
      void this.handleTerminalRequest(msg);
      return;
    }

    // mcp/* requests from the agent
    if (msg.method === 'mcp/connect' || msg.method === 'mcp/message' || msg.method === 'mcp/disconnect') {
      // MCP channel management — best-effort acknowledge.
      if (msg.id !== undefined) {
        this.transport.send({ id: msg.id, method: msg.method, result: {} } as never as ACPMessage).catch(() => {});
      }
      return;
    }

    // elicitation/* requests from the agent
    if (msg.method === 'elicitation/create' || msg.method === 'elicitation/complete') {
      // Elicitation is a UI feedback mechanism — acknowledge and ignore.
      if (msg.id !== undefined) {
        this.transport.send({ id: msg.id, method: msg.method, result: {} } as never as ACPMessage).catch(() => {});
      }
      return;
    }

    // $/cancel_request protocol notification — no response expected.
    if (msg.method === '$/cancel_request') {
      return;
    }

    // Anything else: log to stderr and ignore. Don't crash.
    if (msg.method) {
      // eslint-disable-next-line no-console
      console.warn(`[acp-session] unhandled method: ${msg.method}`);
    }
  }

  private handleUpdate(msg: ACPMessage): void {
    const update = (msg as { params?: { update?: unknown } }).params?.update;
    if (typeof update !== 'object' || update === null) return;
    const u = update as { sessionUpdate?: string; [k: string]: unknown };
    // Always surface the raw update so callers that want full fidelity
    // (forwarding to an event bus, etc.) never lose a notification.
    this.emitProgress({ type: 'raw', update: u as AnySessionUpdate });
    switch (u.sessionUpdate) {
      case 'agent_message_chunk': {
        const text = extractText(u.content);
        if (text) {
          this.scratch.text += text;
          this.emitProgress({ type: 'message', text });
        }
        return;
      }
      case 'thought_chunk': {
        const text = extractText(u.content);
        if (text) {
          this.scratch.thoughts += text;
          this.emitProgress({ type: 'thought', text });
        }
        return;
      }
      case 'tool_call':
      case 'tool_call_update': {
        this.captureToolCall(u, u.sessionUpdate === 'tool_call');
        return;
      }
      case 'plan':
        if (Array.isArray(u.entries)) {
          this.scratch.plan = u.entries as PlanEntry[];
          this.emitProgress({ type: 'plan', entries: u.entries as PlanEntry[] });
        }
        return;
      case 'usage_update':
        if (typeof u.used === 'number' && typeof u.size === 'number') {
          const usage = {
            used: u.used,
            size: u.size,
            ...(typeof u.cost === 'object' && u.cost !== null
              ? { cost: u.cost as UsageCost }
              : {}),
          };
          this.scratch.usage = usage;
          this.emitProgress({ type: 'usage', usage });
        }
        return;
      case 'available_commands_update':
      case 'current_mode_update':
      case 'config_option_update':
      case 'session_info_update':
      case 'user_message_chunk':
      case 'next_edit_suggestions':
      case 'elicitation':
        return;
      default:
        return;
    }
  }

  /**
   * Fold a `tool_call` / `tool_call_update` notification into the scratch
   * tool-call map (deduped by toolCallId), extract any `diff` content into
   * the diffs list, and emit live progress.
   */
  private captureToolCall(
    u: { [k: string]: unknown },
    isNew: boolean,
  ): void {
    const toolCallId = typeof u.toolCallId === 'string' ? u.toolCallId : '';
    if (!toolCallId) return;
    const prev = this.scratch.toolCalls.get(toolCallId);
    const record: ACPCapturedToolCall = {
      toolCallId,
      title:
        typeof u.title === 'string'
          ? u.title
          : (prev?.title ?? toolCallId),
      kind: (typeof u.kind === 'string' ? (u.kind as ToolKind) : prev?.kind),
      status:
        typeof u.status === 'string'
          ? (u.status as ToolCallStatus)
          : (prev?.status ?? (isNew ? 'pending' : 'in_progress')),
      rawInput:
        isRecord(u.rawInput) ? u.rawInput : prev?.rawInput,
      rawOutput:
        isRecord(u.rawOutput) ? u.rawOutput : prev?.rawOutput,
    };
    this.scratch.toolCalls.set(toolCallId, record);

    // Pull any diff content out of the tool call so the host can show
    // what changed. The agent sends diffs as ToolCallContent of type 'diff'.
    if (Array.isArray(u.content)) {
      for (const c of u.content as ToolCallContent[]) {
        if (c && typeof c === 'object' && c.type === 'diff') {
          const diff: ACPCapturedDiff = {
            path: c.path,
            oldText: c.oldText,
            newText: c.newText,
          };
          this.scratch.diffs.push(diff);
          this.emitProgress({ type: 'diff', diff });
        }
      }
    }

    this.emitProgress({
      type: isNew ? 'tool_call' : 'tool_call_update',
      toolCall: record,
    });
  }

  private emitProgress(event: ACPProgressEvent): void {
    if (!this.progressHandler) return;
    try {
      this.progressHandler(event);
    } catch {
      // A faulty host handler must never break the wire pump.
    }
  }

  /** Live progress handler installed for the duration of a `prompt()` turn. */
  private progressHandler: ACPProgressHandler | null = null;

  // Per-prompt scratch state
  private scratch: {
    text: string;
    thoughts: string;
    plan?: PlanEntry[];
    usage?: { used: number; size: number; cost?: UsageCost | undefined };
    toolCalls: Map<string, ACPCapturedToolCall>;
    diffs: ACPCapturedDiff[];
  } = { text: '', thoughts: '', toolCalls: new Map(), diffs: [] };

  private resetScratch(): void {
    this.scratch = { text: '', thoughts: '', toolCalls: new Map(), diffs: [] };
  }

  private async handlePermissionRequest(msg: ACPMessage): Promise<void> {
    const id = msg.id;
    if (id === undefined) return;
    const params = (msg as { params?: { toolCall?: unknown; options?: unknown } }).params;
    const toolCall = params?.toolCall as ToolCallUpdateNotification | undefined;
    const options = Array.isArray(params?.options)
      ? (params.options as never as Parameters<PermissionPolicy>[0]['options'])
      : [];
    if (!toolCall) {
      await this.transport.send({
        id,
        method: 'session/request_permission',
        error: { code: -32602, message: 'toolCall is required' },
      });
      return;
    }
    const policyAbort = new AbortController();
    const outcome = await this.permissionPolicy({
      toolCall,
      options,
      signal: policyAbort.signal,
    });
    await this.transport.send({
      id,
      method: 'session/request_permission',
      result: { outcome },
    });
  }

  private async handleFsRequest(msg: ACPMessage): Promise<void> {
    const id = msg.id;
    if (id === undefined) return;
    const params = (msg as { params?: { sessionId?: string; path?: string; content?: string } }).params;
    if (!params?.path) {
      await this.transport.send({
        id,
        method: msg.method,
        error: { code: -32602, message: 'path is required' },
      });
      return;
    }
    try {
      if (msg.method === 'fs/read_text_file') {
        const result = await this.fileServer.readTextFile({
          sessionId: params.sessionId ?? '',
          path: params.path,
        });
        await this.transport.send({ id, method: msg.method, result });
      } else {
        await this.fileServer.writeTextFile({
          sessionId: params.sessionId ?? '',
          path: params.path,
          content: params.content ?? '',
        });
        await this.transport.send({ id, method: msg.method, result: {} });
      }
    } catch (err) {
      const code = err instanceof FsError ? -32602 : -32603;
      const message = err instanceof Error ? err.message : String(err);
      await this.transport.send({ id, method: msg.method, error: { code, message } });
    }
  }

  private async handleTerminalRequest(msg: ACPMessage): Promise<void> {
    const id = msg.id;
    if (id === undefined) return;
    const params = (msg as { params?: Record<string, unknown> }).params ?? {};
    try {
      switch (msg.method) {
        case 'terminal/create': {
          const createOpts: Parameters<TerminalServer['create']>[0] = {
            sessionId: String(params.sessionId ?? ''),
            command: String(params.command ?? ''),
            args: Array.isArray(params.args) ? (params.args as string[]) : [],
          };
          if (Array.isArray(params.env)) {
            createOpts.env = params.env as { name: string; value: string }[];
          }
          if (typeof params.cwd === 'string') {
            createOpts.cwd = params.cwd;
          }
          if (typeof params.outputByteLimit === 'number') {
            createOpts.outputByteLimit = params.outputByteLimit;
          }
          const result = this.terminalServer.create(createOpts);
          await this.transport.send({ id, method: msg.method, result });
          return;
        }
        case 'terminal/output': {
          const terminalId = String(params.terminalId ?? '');
          const out = this.terminalServer.output(terminalId);
          await this.transport.send({ id, method: msg.method, result: out });
          return;
        }
        case 'terminal/wait_for_exit': {
          const terminalId = String(params.terminalId ?? '');
          const exit = await this.terminalServer.waitForExit(terminalId);
          await this.transport.send({ id, method: msg.method, result: exit });
          return;
        }
        case 'terminal/kill': {
          const terminalId = String(params.terminalId ?? '');
          this.terminalServer.kill(terminalId);
          await this.transport.send({ id, method: msg.method, result: {} });
          return;
        }
        case 'terminal/release': {
          const terminalId = String(params.terminalId ?? '');
          this.terminalServer.release(terminalId);
          await this.transport.send({ id, method: msg.method, result: {} });
          return;
        }
        default:
          await this.transport.send({
            id,
            method: msg.method,
            error: { code: -32601, message: `unknown method: ${msg.method}` },
          });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.transport.send({
        id,
        method: msg.method,
        error: { code: -32603, message },
      });
    }
  }
}

/**
 * Create a text ContentBlock. Convenience helper for callers of
 * `session.prompt()`.
 */
export function textContent(text: string): ContentBlock {
  return { type: 'text', text };
}

/**
 * Create an image ContentBlock. Only send this if the agent's
 * `promptCapabilities.image` is `true` (check via
 * `session.getCapabilities().promptCapabilities?.image`).
 */
export function imageContent(mimeType: string, data: string): ContentBlock {
  return { type: 'image', mimeType, data };
}

/**
 * Create an audio ContentBlock. Only send this if the agent's
 * `promptCapabilities.audio` is `true` (check via
 * `session.getCapabilities().promptCapabilities?.audio`).
 */
export function audioContent(mimeType: string, data: string): ContentBlock {
  return { type: 'audio', mimeType, data };
}

function extractText(block: unknown): string {
  if (typeof block !== 'object' || block === null) return '';
  const b = block as {
    type?: string;
    text?: unknown;
    resource?: { text?: unknown };
  };
  if (b.type === 'text' && typeof b.text === 'string') return b.text;
  // Embedded text resources carry their content under `resource.text`.
  if (
    b.type === 'resource' &&
    b.resource &&
    typeof b.resource === 'object' &&
    typeof b.resource.text === 'string'
  ) {
    return b.resource.text;
  }
  return '';
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** A fully-populated empty run result (used for pre-aborted short-circuits). */
function emptyRunResult(stopReason: StopReason): ACPSessionRunResult {
  return {
    text: '',
    stopReason,
    hasText: false,
    toolCalls: [],
    diffs: [],
    thoughts: '',
  };
}
