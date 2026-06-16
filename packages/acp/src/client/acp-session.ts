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
import { ClientTransport } from '../agent/stdio-transport.js';
import type { ACPMessage } from '../types/acp-messages.js';
import {
  ACP_PROTOCOL_VERSION,
  type ContentBlock,
  type PlanEntry,
  type StopReason,
  type ToolCallUpdateNotification,
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
}

export interface ACPSessionRunResult {
  text: string;
  stopReason: StopReason;
  hasText: boolean;
  usage?: { used: number; size: number; cost?: UsageCost | undefined } | undefined;
  plan?: PlanEntry[] | undefined;
}

export type ACPSessionErrorKind =
  | 'spawn_failed'
  | 'init_failed'
  | 'protocol_error'
  | 'session_create_failed'
  | 'prompt_failed'
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
  /** Wall-clock cap for this specific request. */
  timeoutMs: number;
  timeoutHandle: ReturnType<typeof setTimeout>;
}

type State = 'init' | 'ready' | 'sessioning' | 'prompting' | 'done' | 'closed';

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
  private readonly transport: ClientTransport;
  private readonly fileServer: FileServer;
  private readonly terminalServer: TerminalServer;
  private readonly permissionPolicy: PermissionPolicy;
  private readonly timeoutMs: number;
  private readonly opts: ACPSessionOptions;

  private state: State = 'init';
  private sessionId: string | null = null;
  /** Pending outbound requests (initialize, session/new, session/prompt, etc). */
  private readonly pending = new Map<string | number, PendingRequest>();
  private nextId = 1;
  /** True after close() has been called. */
  private closed = false;

  private constructor(opts: ACPSessionOptions, transport: ClientTransport) {
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

  /**
   * Spawn the child, run the initialize handshake, install the
   * message dispatch, and return a ready session.
   */
  static async start(opts: ACPSessionOptions): Promise<ACPSession> {
    const transportOpts: ConstructorParameters<typeof ClientTransport>[0] = {
      command: opts.command,
      args: opts.args ? [...opts.args] : [],
      handshakeTimeoutMs: 30_000,
      // ACPSession is the v1 CLIENT side: it speaks to external agents
      // (Claude Code, Gemini CLI, …) that do NOT emit a `[wstack-acp]\n`
      // startup marker. The transport should treat the child as ready
      // as soon as the process is spawned and stdout is flowing.
      skipHandshakeMarker: true,
    };
    if (opts.env !== undefined) transportOpts.env = opts.env;
    if (opts.cwd !== undefined) transportOpts.cwd = opts.cwd;
    const transport = new ClientTransport(transportOpts);
    try {
      await transport.start();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new ACPSessionError('spawn_failed', `failed to spawn ${opts.command}: ${msg}`, err);
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

  private async initialize(): Promise<void> {
    const id = this.allocId();
    const result = await this.sendRequest(id, 'initialize', {
      protocolVersion: ACP_PROTOCOL_VERSION,
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
        terminal: true,
        promptCapabilities: { image: false, audio: false, embeddedContext: true },
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
    const r = result as { protocolVersion: number };
    if (r.protocolVersion !== ACP_PROTOCOL_VERSION) {
      throw new ACPSessionError(
        'unsupported_capability',
        `agent speaks protocolVersion=${r.protocolVersion}, client speaks ${ACP_PROTOCOL_VERSION}`,
      );
    }
    this.state = 'ready';
  }

  /**
   * Run one prompt turn. Creates a session if needed, sends the
   * prompt, streams session/update notifications, and resolves with
   * the agent's response.
   *
   * Cancellation: if `signal` aborts mid-prompt, we send
   * `session/cancel` (a notification per spec) and keep accepting
   * updates until the agent returns with `stopReason: 'cancelled'`.
   * The result is the same shape as a normal turn, with
   * `stopReason === 'cancelled'`.
   */
  async prompt(text: string, signal: AbortSignal): Promise<ACPSessionRunResult> {
    if (this.closed) {
      throw new ACPSessionError('closed', 'session is closed');
    }
    if (this.state !== 'ready' && this.state !== 'done') {
      throw new ACPSessionError('protocol_error', `prompt called in state=${this.state}`);
    }

    // Pre-aborted signals short-circuit BEFORE we create a session
    // and before any wire activity. Per spec, a cancelled prompt is
    // a normal outcome and the spec's "cancel via session/cancel
    // notification" path only applies to in-flight prompts. A
    // never-started prompt just returns the cancelled stopReason
    // with no text.
    if (signal.aborted) {
      return { text: '', stopReason: 'cancelled', hasText: false };
    }

    if (!this.sessionId) {
      await this.createSession();
    }

    this.resetScratch();

    const promptId = this.allocId();
    const turnPromise = this.sendRequest(
      promptId,
      'session/prompt',
      {
        sessionId: this.sessionId,
        prompt: [textContent(text)] satisfies ContentBlock[],
      },
      this.timeoutMs,
    );

    let cancelled = false;
    const onAbort = (): void => {
      cancelled = true;
      // Best-effort cancel: send a notification (no id). Per spec the
      // agent MUST eventually respond to our session/prompt request
      // with `stopReason: 'cancelled'`.
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
    };
  }

  private async createSession(): Promise<void> {
    const id = this.allocId();
    const result = await this.sendRequest(id, 'session/new', {
      cwd: this.opts.cwd ?? this.opts.projectRoot,
      mcpServers: [],
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
    this.sessionId = sessionId;
  }

  /** Tear down the session and kill the child process. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.state = 'closed';
    this.terminalServer.releaseAll();
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
        .send({ jsonrpc: '2.0', id, method, params } as unknown as ACPMessage)
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
    if (msg.method && msg.method.startsWith('terminal/')) {
      void this.handleTerminalRequest(msg);
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
    switch (u.sessionUpdate) {
      case 'agent_message_chunk': {
        const text = extractText(u.content);
        if (text) this.accumulatedText(text);
        return;
      }
      case 'thought_chunk':
        // Log only; v1 doesn't surface thoughts to the TUI yet.
        return;
      case 'tool_call':
      case 'tool_call_update':
        // Tool calls run inside the external agent; we observe but
        // don't proxy execution. The TUI can read these from the
        // session JSONL if it needs to display them.
        return;
      case 'plan':
        if (Array.isArray(u.entries)) {
          this.accumulatedPlan(u.entries as PlanEntry[]);
        }
        return;
      case 'usage_update':
        if (typeof u.used === 'number' && typeof u.size === 'number') {
          this.accumulatedUsage({
            used: u.used,
            size: u.size,
            ...(typeof u.cost === 'object' && u.cost !== null
              ? {
                  cost: u.cost as UsageCost,
                }
              : {}),
          });
        }
        return;
      case 'available_commands_update':
      case 'current_mode_update':
      case 'config_option_update':
      case 'session_info_update':
      case 'user_message_chunk':
        // Observed but not consumed in v1.
        return;
      default:
        // _unstable_* and unknown — log once per kind.
        // eslint-disable-next-line no-console
        console.warn(`[acp-session] unhandled sessionUpdate: ${u.sessionUpdate}`);
        return;
    }
  }

  // Per-prompt scratch state. Reset at the start of each prompt() and
  // read at the end to assemble the ACPSessionRunResult. The stream
  // pump writes to it via the three `accumulated*` helpers below.
  private scratch: {
    text: string;
    plan?: PlanEntry[];
    usage?: { used: number; size: number; cost?: UsageCost | undefined };
  } = { text: '' };

  private accumulatedText(chunk: string): void {
    this.scratch.text += chunk;
  }
  private accumulatedPlan(entries: PlanEntry[]): void {
    this.scratch.plan = entries;
  }
  private accumulatedUsage(u: { used: number; size: number; cost?: UsageCost | undefined }): void {
    this.scratch.usage = u;
  }

  private resetScratch(): void {
    this.scratch = { text: '' };
  }

  private async handlePermissionRequest(msg: ACPMessage): Promise<void> {
    const id = msg.id;
    if (id === undefined) return;
    const params = (msg as { params?: { toolCall?: unknown; options?: unknown } }).params;
    const toolCall = params?.toolCall as ToolCallUpdateNotification | undefined;
    const options = Array.isArray(params?.options)
      ? (params.options as unknown as Parameters<PermissionPolicy>[0]['options'])
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

function textContent(text: string): ContentBlock {
  return { type: 'text', text };
}

function extractText(block: unknown): string {
  if (typeof block !== 'object' || block === null) return '';
  const b = block as { type?: string; text?: unknown };
  if (b.type === 'text' && typeof b.text === 'string') return b.text;
  return '';
}
