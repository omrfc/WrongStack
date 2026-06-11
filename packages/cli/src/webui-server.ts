import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import {
  createHttpServer,
  findFreePort,
  openBrowser,
  registerInstance,
  unregisterInstance,
  handleFilesTree,
  handleFilesRead,
  handleFilesWrite,
  handleFilesList,
  handleMemoryList,
  handleMemoryRemember,
  handleMemoryForget,
  AutoPhaseWebSocketHandler,
} from '@wrongstack/webui/server';
import type { Agent, Context, EventBus, Logger, MemoryStore, ModeStore, ModelsRegistry, SessionStore, SessionWriter, SkillLoader } from '@wrongstack/core';
import {
  DefaultSecretScrubber,
  enhanceUserPrompt,
  recentTextTurns,
  type ProviderConfig,
  type TodoItem,
  mutateTasks,
  mutatePlan,
  setPlanItemStatus,
} from '@wrongstack/core';
import { DefaultSessionStore } from '@wrongstack/core/storage';
import { DefaultSecretVault } from '@wrongstack/core/security';
import { TOKENS, repairToolUseAdjacency, listContextWindowModes, resolveContextWindowPolicy, DEFAULT_CONTEXT_WINDOW_MODE_ID, GlobalMailbox } from '@wrongstack/core';
import { WebSocket, WebSocketServer } from 'ws';
import { expectDefined, loadConfigProviders, maskedKey, mutateConfigProviders, normalizeKeys, nowIso, writeKeysBack } from './provider-config-utils.js';

// ── Console logger adapter for AutoPhaseWebSocketHandler ──────────────────────
// AutoPhaseWebSocketHandler requires a Logger. The CLI uses console.log/error
// directly, so we adapt that to the Logger interface expected by the handler.
const structuredLine = (level: string, message: string): string =>
  JSON.stringify({ level, event: 'webui.autophase', message, timestamp: new Date().toISOString() });
const consoleLogger: Logger = {
  level: 'debug',
  error(msg: string, _ctx?: unknown) { console.error(structuredLine('error', msg)); },
  warn(msg: string, _ctx?: unknown) { console.warn(structuredLine('warn', msg)); },
  info(msg: string, _ctx?: unknown) { console.log(structuredLine('info', msg)); },
  debug(msg: string, _ctx?: unknown) { console.debug(structuredLine('debug', msg)); },
  trace(msg: string, _ctx?: unknown) { console.debug(structuredLine('trace', msg)); },
  child(_bindings: Record<string, unknown>): Logger { return this; },
};

// ── Token estimator helpers (inlined from @wrongstack/webui/server/token-estimator.ts) ──

function estimateTokens(s: string): number {
  return Math.ceil(s.length / 4);
}

function stringifyContent(c: unknown): string {
  if (typeof c === 'string') return c;
  try { return JSON.stringify(c); } catch { return String(c); }
}

function messageTokens(content: unknown): number {
  if (typeof content === 'string') return estimateTokens(content);
  if (!Array.isArray(content)) return 0;
  let tk = 0;
  for (const b of content as Array<{ type?: string; text?: string; input?: unknown; content?: unknown; name?: string }>) {
    if (b.type === 'text') tk += estimateTokens(b.text ?? '');
    else if (b.type === 'tool_use') tk += estimateTokens(stringifyContent(b.input));
    else if (b.type === 'tool_result') tk += estimateTokens(stringifyContent(b.content));
    else tk += estimateTokens(stringifyContent(b));
  }
  return tk;
}

function messagePreview(content: unknown): string {
  if (typeof content === 'string') return content.slice(0, 60);
  if (!Array.isArray(content)) return '';
  return (content as Array<{ type?: string; text?: string; name?: string }>)
    .map((b) =>
      b.type === 'text' ? (b.text ?? '').slice(0, 40) :
      b.type === 'tool_use' ? `[tool_use: ${b.name}]` :
      b.type === 'tool_result' ? '[tool_result]' : `[${b.type}]`)
    .join(' ').slice(0, 60);
}

interface PromptBlock { text?: string | undefined; }
interface ToolLike { name: string; inputSchema?: unknown; description?: string; }
interface MessageLike { role: string; content: unknown; }

function estimateContextBreakdown(input: {
  systemPrompt: ReadonlyArray<PromptBlock>;
  tools: ReadonlyArray<ToolLike>;
  messages: ReadonlyArray<MessageLike>;
}) {
  const sysTokens = input.systemPrompt.reduce((acc, b) => acc + estimateTokens(b.text ?? ''), 0);
  const toolBreakdown = input.tools.map((t) => {
    const schema = t.inputSchema ?? {};
    const desc = t.description ?? '';
    return { name: t.name, tokens: estimateTokens(t.name) + estimateTokens(desc) + estimateTokens(stringifyContent(schema)) };
  });
  const toolTokens = toolBreakdown.reduce((a, b) => a + b.tokens, 0);
  const messageBreakdown = input.messages.map((m, i) => ({
    index: i, role: m.role, tokens: messageTokens(m.content), preview: messagePreview(m.content),
  }));
  const msgTokens = messageBreakdown.reduce((a, b) => a + b.tokens, 0);
  return {
    total: sysTokens + toolTokens + msgTokens,
    systemPrompt: sysTokens,
    tools: { total: toolTokens, count: input.tools.length, breakdown: toolBreakdown },
    messages: { total: msgTokens, count: input.messages.length, breakdown: messageBreakdown },
  };
}

// ── Cost computation helpers (inlined from @wrongstack/webui/server/usage-cost.ts) ──

/** Per-1,000,000-token pricing, normalized to numbers (0 when unpriced). */
interface CostRates {
  input: number;
  output: number;
  cacheRead: number;
}

/** Token counts for a turn/session. */
interface TokenUsage {
  input: number;
  output: number;
  cacheRead?: number | undefined;
}

function getCostRates(model: unknown): CostRates {
  const cost = (
    model as { cost?: { input?: number | undefined; output?: number | undefined; cache_read?: number | undefined } } | null | undefined
  )?.cost;
  return {
    input: cost?.input ?? 0,
    output: cost?.output ?? 0,
    cacheRead: cost?.cache_read ?? 0,
  };
}

function computeUsageCost(usage: TokenUsage, rates: CostRates): number {
  return (
    (usage.input * rates.input +
      usage.output * rates.output +
      (usage.cacheRead ?? 0) * rates.cacheRead) /
    1_000_000
  );
}

// Re-export types from webui for type checking
// At runtime, the actual types are resolved via workspace resolution

// WSServerMessage and WSClientMessage types (mirrors packages/webui/src/types.ts)
export interface WSServerMessage {
  type: string;
  payload: unknown;
}

export interface WSClientMessage {
  type: string;
  payload?: unknown | undefined;
}

interface WebUIOptions {
  agent: Agent;
  events: EventBus;
  session: SessionWriter;
  /** WebSocket backend port. Defaults to 3457 (auto-advances if taken). */
  port?: number | undefined;
  /** HTTP port serving the React frontend. Defaults to 3456 (auto-advances). */
  httpPort?: number | undefined;
  /** Project root — recorded in the running-instance registry. */
  projectRoot?: string | undefined;
  /** Pop the browser open to the served URL once the frontend is ready. */
  open?: boolean | undefined;
  /**
   * Fired once the WebSocket server is accepting connections. Useful for
   * callers (and tests) that must not connect before the server is ready —
   * port resolution now makes startup asynchronous, so a synchronous bind can
   * no longer be assumed.
   */
  onListening?: (info: { httpPort: number; wsPort: number; host: string }) => void;
  modelsRegistry?: ModelsRegistry | undefined;
  globalConfigPath?: string | undefined;
  /**
   * Subscribe to live per-iteration events from the eternal-autonomy
   * engine. When provided, the WebUI broadcasts each iteration to every
   * connected client. Observability-only — starting the loop still goes
   * through REPL/TUI or the `--eternal` flag (the WebUI has no slash
   * command dispatch surface yet).
   */
  subscribeEternalIteration?:
    | ((fn: (entry: import('@wrongstack/core').JournalEntry) => void) => () => void)
    | undefined;
  /** Callback to invoke when the WebUI is shut down by a client request. */
  onExit?: (() => void) | undefined;
  /** Session store — enables session.resume and session.delete from the WebUI. */
  sessionStore?: SessionStore | undefined;
  /**
   * Absolute path to the project's sessions directory (wpaths.projectSessions).
   * Used by checkpoint/rewind handlers to locate session JSONL files. When
   * absent, falls back to the legacy <projectRoot>/.wrongstack/sessions path.
   */
  sessionsDir?: string | undefined;
  /**
   * Called after session.resume swaps the active writer, with the new session
   * id. The host uses this to re-point crash-recovery state (active.json) at
   * the session that is now actually being written.
   */
  onSessionSwapped?: ((newSessionId: string) => void) | undefined;
  /** Memory store — enables the MemoryPanel (memory.list, memory.remember, memory.forget). */
  memoryStore?: MemoryStore | undefined;
  /** Skill loader — enables the SkillsPanel (skills.list). */
  skillLoader?: SkillLoader | undefined;
  /** Mode store — enables the ModePicker (modes.list, mode.switch). */
  modeStore?: ModeStore | undefined;
  /** Active agent mode id passed to the frontend via session.start. */
  modeId?: string | undefined;
  /** When true, the frontend shows a provider/model setup screen instead of the chat. */
  needsSetup?: boolean | undefined;
}

interface ConnectedClient {
  ws: WebSocket;
  sessionId: string | null;
}

export async function runWebUI(opts: WebUIOptions): Promise<void> {
  const host = '127.0.0.1';
  const requestedWsPort = opts.port ?? 3457;
  const requestedHttpPort = opts.httpPort ?? 3456;
  // Auto-advance past busy ports (unless WEBUI_STRICT_PORT) so this works
  // alongside other WebUI instances. HTTP resolved first → tidy adjacent pairs.
  const strictPort =
    process.env['WEBUI_STRICT_PORT'] === '1' || process.env['WEBUI_STRICT_PORT'] === 'true';
  let httpPort = requestedHttpPort;
  let wsPort = requestedWsPort;
  if (!strictPort) {
    httpPort = await findFreePort(host, requestedHttpPort);
    wsPort = await findFreePort(host, requestedWsPort, { exclude: new Set([httpPort]) });
  }
  const port = wsPort; // existing WS code below refers to `port`
  // Per-connection message rate limit. OFF by default — this is a local,
  // single-user tool and the limit (which counted pings/list calls too) was
  // tripping during normal use. Opt back in by setting WEBUI_RATE_LIMIT to a
  // positive messages-per-60s number (useful only when exposing on a LAN).
  const rateLimitMax = Number.parseInt(process.env['WEBUI_RATE_LIMIT'] ?? '0', 10);
  const clients = new Map<WebSocket, ConnectedClient>();
  // Pending permission confirmations keyed by toolUseId. When the agent emits
  // tool.confirm_needed, we stash its resolver here and forward the prompt to
  // the browser; the client's tool.confirm_result resolves it. This is what
  // makes approvals appear in the WebUI instead of the terminal.
  const pendingConfirms = new Map<string, (d: 'yes' | 'no' | 'always' | 'deny') => void>();
  const secretScrubber = new DefaultSecretScrubber();
  let abortController: AbortController | null = null;

  // AutoPhase handler — manages AutoPhase lifecycle via WS messages.
  // Initialized here so it can be used in the connection handler and message switch.
  const autoPhaseStoreDir = opts.projectRoot
    ? path.join(opts.projectRoot, '.wrongstack', 'autophase')
    : path.join(os.tmpdir(), '.wrongstack', 'autophase');
  const autoPhaseHandler = new AutoPhaseWebSocketHandler(
    opts.agent,
    opts.agent.ctx as Context,
    consoleLogger,
    autoPhaseStoreDir,
    opts.events,
    opts.projectRoot,
  );

  // Generate a random auth token to prevent unauthorized local connections.
  // The WebUI frontend reads this from the session.start payload and uses it
  // for subsequent reconnections. Loopback connections are exempt for
  // convenience (matches standalone WebUI server behavior).
  const authToken = crypto.randomBytes(16).toString('hex');
  // Captured once at startup so stats.get can report elapsed time since the
  // session was opened, rather than the hardcoded 0 it used to send.
  const sessionStartedAt = Date.now();

  /**
   * Build a session.start payload enriched with per-model cost rates and
   * max-context cap. Used by the initial connect handler and every
   * broadcast path (model.switch, mode.switch, session.resume, etc.) so
   * the frontend always has the correct cost rates for live computation.
   *
   * Callers pass optional overrides for fields that vary per context
   * (reset, mode, replayMessages, etc.). The connection handler adds
   * wsToken on top.
   */
  async function buildSessionStartPayload(overrides?: Record<string, unknown>, needsSetup = false) {
    let maxContext = 0;
    let inputCost = 0;
    let outputCost = 0;
    let cacheReadCost = 0;
    try {
      if (opts.modelsRegistry) {
        const m = await opts.modelsRegistry.getModel(
          (opts.agent.ctx.provider as { id: string }).id,
          opts.agent.ctx.model,
        );
        maxContext =
          (m as { capabilities?: { maxContext?: number } } | null)?.capabilities
            ?.maxContext ?? 0;
        const rates = getCostRates(m);
        inputCost = rates.input;
        outputCost = rates.output;
        cacheReadCost = rates.cacheRead;
      }
    } catch {
      /* best-effort; cost stays $0 */
    }
    return {
      sessionId: opts.session.id,
      model: opts.agent.ctx.model,
      provider: (opts.agent.ctx.provider as { id: string }).id,
      mode: opts.modeId ?? 'default',
      projectName: opts.projectRoot ? path.basename(opts.projectRoot) : undefined,
      cwd: opts.projectRoot ?? (opts.agent.ctx as { projectRoot?: string }).projectRoot ?? '',
      needsSetup, // true when provider/model not configured and running in --webui mode
      contextMode: String(
        opts.agent.ctx.meta?.['contextWindowMode'] ?? DEFAULT_CONTEXT_WINDOW_MODE_ID,
      ),
      maxContext,
      inputCost,
      outputCost,
      cacheReadCost,
      ...overrides,
    };
  }

  const wss = new WebSocketServer({ port, host, maxPayload: 1 * 1024 * 1024 });

  console.log(`[WebUI] WebSocket server starting on ws://${host}:${port}`);

  // Serve the React frontend over HTTP so `wrongstack --webui` is a one-command
  // launch (open the printed URL) instead of only a WS bridge. The static
  // serve + WS-port injection live in @wrongstack/webui; we resolve its built
  // dist via the package entry. If the webui package isn't built, we degrade
  // gracefully to WS-only (the original behavior).
  let httpServer: import('node:http').Server | null = null;
  try {
    const requireFromHere = createRequire(import.meta.url);
    const serverEntry = requireFromHere.resolve('@wrongstack/webui/server');
    const distDir = path.resolve(path.dirname(serverEntry), '..'); // .../dist
    httpServer = createHttpServer({
      host,
      distDir,
      wsPort,
      globalRoot: path.dirname(opts.globalConfigPath ?? ''),
    });
    const openUrl = `http://${host}:${httpPort}`;
    httpServer?.listen(httpPort, host, () => {
      console.log(
        `\n  ▸ WebUI ready — open \x1b[1m${openUrl}\x1b[0m in your browser` +
          `\n    (same agent as this terminal · ws:${wsPort})\n`,
      );
      if (opts.open) openBrowser(openUrl);
    });
  } catch (err) {
    console.warn(
      `[WebUI] Frontend not served (run \`pnpm --filter @wrongstack/webui build\`): ` +
        `${err instanceof Error ? err.message : String(err)}. WS bridge still active on ws://${host}:${wsPort}.`,
    );
  }

  // Record this instance so it shows up in `webui --list` /
  // ~/.wrongstack/webui-instances.json alongside standalone instances.
  const registryBaseDir = opts.globalConfigPath ? path.dirname(opts.globalConfigPath) : undefined;
  if (opts.projectRoot) {
    void registerInstance(
      {
        pid: process.pid,
        httpPort,
        wsPort,
        host,
        projectRoot: opts.projectRoot,
        projectName: path.basename(opts.projectRoot) || opts.projectRoot,
        startedAt: new Date().toISOString(),
        url: `http://${host}:${httpPort}`,
      },
      registryBaseDir,
    ).catch(() => {});
  }
  // Auth token is sent to clients via the session.start payload — do NOT log it.

  // Subscribe to events once
  const eventUnsubscribers: Array<() => void> = [];

  function setupEvents() {
    // Clear any existing subscriptions
    for (const unsub of eventUnsubscribers) unsub();
    eventUnsubscribers.length = 0;

    // iteration.started
    eventUnsubscribers.push(
      opts.events.on('iteration.started', (e) => {
        broadcast({
          type: 'iteration.started',
          payload: { index: e.index },
        });
      }),
    );

    // provider.text_delta
    eventUnsubscribers.push(
      opts.events.on('provider.text_delta', (e) => {
        broadcast({
          type: 'provider.text_delta',
          payload: { text: e.text, messageId: 'current' },
        });
      }),
    );

    // provider.thinking_delta — extended-thinking deltas. The WebUI renders a
    // transient "Thinking…" chip from these; clears the moment text_delta /
    // tool.started / provider.response / run.result lands so the chip never
    // pollutes the persisted transcript.
    eventUnsubscribers.push(
      opts.events.on('provider.thinking_delta', (e) => {
        broadcast({
          type: 'provider.thinking_delta',
          payload: { text: e.text },
        });
      }),
    );

    // tool.started
    eventUnsubscribers.push(
      opts.events.on('tool.started', (e) => {
        broadcast({
          type: 'tool.started',
          payload: {
            id: e.id,
            name: e.name,
            input: secretScrubber.scrubObject(e.input),
            messageId: `tool_${e.id}`,
          },
        });
      }),
    );

    // tool.progress
    eventUnsubscribers.push(
      opts.events.on('tool.progress', (e) => {
        broadcast({
          type: 'tool.progress',
          payload: {
            name: e.name,
            id: e.id,
            event: e.event,
          },
        });
      }),
    );

    // tool.executed
    eventUnsubscribers.push(
      opts.events.on('tool.executed', (e) => {
        broadcast({
          type: 'tool.executed',
          payload: {
            // Forward the tool_use id so the WebUI can correlate this with
            // the matching tool.started bubble for parallel tool calls.
            id: e.id,
            name: e.name,
            durationMs: e.durationMs,
            ok: e.ok,
            input: secretScrubber.scrubObject(e.input),
            output: secretScrubber.scrubObject(e.output),
          },
        });

        // Always broadcast current todos so the panel stays in sync.
        broadcast({
          type: 'todos.updated',
          payload: { todos: [...opts.agent.ctx.todos] },
        });

        // After task/plan/todo tool executions, also broadcast those snapshots.
        if (e.name === 'task' || e.name === 'plan' || e.name === 'todo') {
          void (async () => {
            try {
              const taskPath = (opts.agent.ctx.meta as Record<string, unknown>)['task.path'];
              if (typeof taskPath === 'string' && taskPath) {
                const { loadTasks } = await import('@wrongstack/core');
                const file = await loadTasks(taskPath);
                broadcast({
                  type: 'tasks.updated',
                  payload: { tasks: file?.tasks ?? [] },
                });
              }
            } catch { /* best-effort */ }
            try {
              const planPath = (opts.agent.ctx.meta as Record<string, unknown>)['plan.path'];
              if (typeof planPath === 'string' && planPath) {
                const { loadPlan } = await import('@wrongstack/core');
                const plan = await loadPlan(planPath);
                broadcast({
                  type: 'plan.updated',
                  payload: {
                    plan: plan ?? {
                      version: 1,
                      sessionId: opts.session.id,
                      updatedAt: new Date().toISOString(),
                      items: [],
                    },
                  },
                });
              }
            } catch { /* best-effort */ }
          })();
        }
      }),
    );

    // provider.response
    eventUnsubscribers.push(
      opts.events.on('provider.response', (e) => {
        broadcast({
          type: 'provider.response',
          payload: {
            usage: e.usage,
            stopReason: e.stopReason,
            messageId: 'current',
          },
        });
      }),
    );

    // error
    eventUnsubscribers.push(
      opts.events.on('error', (e) => {
        broadcast({
          type: 'error',
          payload: {
            phase: e.phase,
            message: e.err instanceof Error ? e.err.message : String(e.err),
          },
        });
      }),
    );

    // tool.confirm_needed — forward permission prompts to the browser so the
    // user approves/denies in the WebUI rather than the terminal. Requires the
    // agent to be in event-driven confirmation mode (the --webui launch path
    // calls disableInteractiveConfirmation()).
    eventUnsubscribers.push(
      opts.events.on('tool.confirm_needed', (e) => {
        const id = e.toolUseId ?? `confirm_${Date.now()}`;
        pendingConfirms.set(id, e.resolve);
        broadcast({
          type: 'tool.confirm_needed',
          payload: {
            id,
            toolName: e.tool?.name ?? 'unknown',
            input: secretScrubber.scrubObject(e.input),
            suggestedPattern: e.suggestedPattern,
          },
        });
      }),
    );

    // Subagent fleet lifecycle. The kernel emits a rich subagent.* catalog on
    // the host bus (spawn → task → per-tool → periodic summary → completion).
    // We flatten the relevant ones into a single `subagent.event` stream with a
    // `kind` discriminator so the WebUI can render a live fleet roster (the
    // nickname'd leader/worker agents) without subscribing to the director-only
    // FleetBus. No tool inputs/outputs are forwarded here — only names + counts
    // — so there's nothing to scrub.
    const forwardSubagent = (kind: string, payload: Record<string, unknown>) =>
      broadcast({ type: 'subagent.event', payload: { kind, ...payload } });
    eventUnsubscribers.push(
      opts.events.on('subagent.spawned', (e) =>
        forwardSubagent('spawned', {
          subagentId: e.subagentId,
          taskId: e.taskId,
          name: e.name,
          provider: e.provider,
          model: e.model,
          description: e.description,
        }),
      ),
      opts.events.on('subagent.task_started', (e) =>
        forwardSubagent('task_started', {
          subagentId: e.subagentId,
          taskId: e.taskId,
          description: e.description,
        }),
      ),
      opts.events.on('subagent.tool_executed', (e) =>
        forwardSubagent('tool_executed', {
          subagentId: e.subagentId,
          toolName: e.name,
          durationMs: e.durationMs,
          ok: e.ok,
        }),
      ),
      opts.events.on('subagent.iteration_summary', (e) =>
        forwardSubagent('iteration_summary', {
          subagentId: e.subagentId,
          iteration: e.iteration,
          toolCalls: e.toolCalls,
          costUsd: e.costUsd,
          currentTool: e.currentTool,
        }),
      ),
      opts.events.on('subagent.budget_extended', (e) =>
        forwardSubagent('budget_extended', {
          subagentId: e.subagentId,
          totalExtensions: e.totalExtensions,
        }),
      ),
      opts.events.on('subagent.ctx_pct', (e) =>
        forwardSubagent('ctx_pct', {
          subagentId: e.subagentId,
          load: e.load,
          tokens: e.tokens,
          maxContext: e.maxContext,
        }),
      ),
      opts.events.on('subagent.task_completed', (e) =>
        forwardSubagent('task_completed', {
          subagentId: e.subagentId,
          status: e.status,
          iterations: e.iterations,
          toolCalls: e.toolCalls,
          error: e.error ? { kind: e.error.kind, message: e.error.message } : undefined,
        }),
      ),
    );

    // eternal-autonomy iteration events. Each iteration the engine
    // completes lands here and is fanned out to every connected client
    // so the frontend can render a live timeline of the autonomous loop.
    // The unsubscribe is collected into eventUnsubscribers so a reconnect
    // or shutdown tears it down cleanly with the rest of the subscriptions.
    if (opts.subscribeEternalIteration) {
      eventUnsubscribers.push(
        opts.subscribeEternalIteration((entry) => {
          broadcast({
            type: 'eternal.iteration',
            payload: {
              iteration: entry.iteration,
              at: entry.at,
              source: entry.source,
              task: entry.task,
              status: entry.status,
              note: entry.note,
              tokens: entry.tokens,
              costUsd: entry.costUsd,
            },
          });
        }),
      );
    }

    // ── Mailbox events — broadcast to WebUI for real-time per-project visibility ──
    // Enables the WebUI to update its online agent count and mailbox panel without polling.
    eventUnsubscribers.push(
      opts.events.onPattern('mailbox.*', (eventName, payload) => {
        broadcast({ type: 'mailbox.event', payload: { event: eventName, ...payload as Record<string, unknown> } });
      }),
    );

    // ── Brain events — decisions + proactive interventions, live in the browser ──
    eventUnsubscribers.push(
      opts.events.onPattern('brain.*', (eventName, payload) => {
        broadcast({ type: 'brain.event', payload: { event: eventName, ...payload as Record<string, unknown> } });
      }),
    );
  }

  return new Promise<void>((resolve) => {
    wss.on('listening', () => {
      console.log(`[WebUI] WebSocket server running on ws://${host}:${port}`);
      setupEvents();
      opts.onListening?.({ httpPort, wsPort, host });

      // ── Live session status poll ──────────────────────────────────
      // Periodically read the cross-process SessionRegistry and push
      // live agent/session status to all connected WebSocket clients.
      // This keeps the WebUI session panel in sync even when agents
      // run in background (project switches, multiple processes).
      const globalRoot = opts.globalConfigPath
        ? path.dirname(opts.globalConfigPath)
        : undefined;
      if (globalRoot) {
        const statusInterval = setInterval(async () => {
          try {
            // Lazy import to avoid bundling core into the webui runtime
            const { SessionRegistry } = await import('@wrongstack/core');
            const registry = new SessionRegistry(globalRoot);
            const sessions = await registry.list();
            const live = sessions
              .filter((s) => s.status !== 'stale')
              .map((s) => ({
                sessionId: s.sessionId,
                projectName: s.projectName,
                projectSlug: s.projectSlug,
                projectRoot: s.projectRoot,
                workingDir: s.workingDir,
                gitBranch: s.gitBranch,
                status: s.status,
                pid: s.pid,
                startedAt: s.startedAt,
                agentCount: s.agentCount,
                agents: s.agents.map((a) => ({
                  id: a.id,
                  name: a.name,
                  status: a.status,
                  currentTool: a.currentTool,
                  iterations: a.iterations,
                  toolCalls: a.toolCalls,
                  lastActivityAt: a.lastActivityAt,
                })),
              }));
            broadcast({ type: 'sessions.status_update', payload: { sessions: live } });
          } catch {
            // Best-effort — never crash the WebSocket relay for status errors
          }
        }, 5_000);
        if (statusInterval.unref) statusInterval.unref();
        eventUnsubscribers.push(() => clearInterval(statusInterval));
      }
    });

    wss.on('connection', async (ws, req) => {
      // --- Auth token + Origin validation ---
      // Loopback connections (from the WebUI frontend on localhost) are
      // allowed without a token for convenience. Non-loopback connections
      // require the token passed as ?token=<authToken>.
      const isLoopback = (hostname: string) =>
        hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]';

      // Constant-time token compare (length mismatch short-circuits).
      const tokenMatches = (provided: string | null): boolean => {
        if (!provided) return false;
        const a = Buffer.from(provided);
        const b = Buffer.from(authToken);
        return a.length === b.length && crypto.timingSafeEqual(a, b);
      };

      try {
        const url = new URL(req.url ?? '/', `http://localhost:${port}`);
        const token = url.searchParams.get('token');
        const tokenOk = tokenMatches(token);

        // DNS-rebinding defense: the server is bound to loopback, so the Host
        // header of any legitimate client is a loopback name. A rebound
        // attacker page sends `Host: <attacker-domain>` even though the socket
        // peer is 127.0.0.1 — reject it.
        const hostHeader = (req.headers.host ?? '').trim();
        let hostOk = false;
        try {
          hostOk = !!hostHeader && isLoopback(new URL(`http://${hostHeader}`).hostname);
        } catch {
          hostOk = false;
        }
        if (!hostOk) {
          ws.close(4003, 'Forbidden: non-loopback Host header');
          return;
        }

        // Origin validation
        const origin = req.headers.origin;
        if (origin) {
          try {
            const { hostname } = new URL(origin);
            if (!isLoopback(hostname) && !tokenOk) {
              ws.close(4003, 'Forbidden: non-loopback origin requires auth token');
              return;
            }
          } catch {
            ws.close(4003, 'Forbidden: invalid origin');
            return;
          }
        } else {
          // Non-browser client (no origin header): require token for
          // defense-in-depth. Even though we bind to 127.0.0.1, a
          // compromised local process or DNS rebinding attack could
          // connect without an origin.
          if (!tokenOk) {
            ws.close(4003, 'Forbidden: auth token required for non-browser clients');
            return;
          }
        }
      } catch {
        ws.close(4001, 'Unauthorized: malformed request');
        return;
      }

      const client: ConnectedClient = { ws, sessionId: opts.session.id };
      clients.set(ws, client);

      // Register this client with the AutoPhase handler so it receives phase events
      autoPhaseHandler.addClient(ws);

      // Per-connection rate limiting — disabled unless WEBUI_RATE_LIMIT > 0.
      let msgCount = 0;
      let windowResetAt = Date.now() + 60_000;

      ws.on('message', async (data) => {
        if (rateLimitMax > 0) {
          const now = Date.now();
          if (now > windowResetAt) {
            msgCount = 0;
            windowResetAt = now + 60_000;
          }
          if (++msgCount > rateLimitMax) {
            send(ws, {
              type: 'error',
              payload: { phase: 'rate_limit', message: 'Too many messages. Please wait.' },
            });
            return;
          }
        }
        try {
          const msg = JSON.parse(data.toString()) as WSClientMessage;
          await handleMessage(ws, client, msg);
        } catch (err) {
          console.error(JSON.stringify({
            level: 'error',
            event: 'webui_server.message_parse_failed',
            message: err instanceof Error ? err.message : String(err),
            timestamp: new Date().toISOString(),
          }));
        }
      });

      ws.on('close', () => {
        clients.delete(ws);
        // If the last client leaves while a permission prompt is pending, deny
        // it so the agent loop doesn't hang waiting for an answer that will
        // never arrive (the terminal no longer prompts in --webui mode).
        if (clients.size === 0 && pendingConfirms.size > 0) {
          for (const [id, resolve] of pendingConfirms) {
            resolve('no');
            pendingConfirms.delete(id);
          }
        }
      });

      // Send session.start to the new client — includes wsToken for
      // reconnection, plus per-model cost rates and context-window cap
      // so the frontend can compute accurate live costs.
      const base = await buildSessionStartPayload({}, opts.needsSetup ?? false);
      send(ws, {
        type: 'session.start',
        payload: { ...base, wsToken: authToken },
      });
    });

    wss.on('error', (err) => {
      console.error(JSON.stringify({
        level: 'error',
        event: 'webui_server.error',
        message: err instanceof Error ? err.message : String(err),
        timestamp: new Date().toISOString(),
      }));
    });

    // Graceful shutdown
    function shutdown() {
      console.log('[WebUI] Shutting down...');
      for (const unsub of eventUnsubscribers) unsub();
      for (const [ws] of clients) {
        ws.close();
      }
      clients.clear();
      // Best-effort: drop ourselves from the running-instance registry and
      // stop the frontend HTTP server before the WS server resolves the run.
      void unregisterInstance(process.pid, registryBaseDir).catch((err: unknown) => console.debug(`[webui-server] unregister failed: ${err}`));
      httpServer?.close();
      wss.close(() => {
        console.log('[WebUI] Server stopped');
        resolve();
      });
    }

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  });

  async function handleMessage(
    ws: WebSocket,
    client: ConnectedClient,
    msg: WSClientMessage,
  ): Promise<void> {
    switch (msg.type) {
      case 'user_message':
        await handleUserMessage(
          ws,
          client,
          (msg as { payload: { content: string } }).payload.content,
        );
        break;

      case 'abort':
        abortController?.abort();
        broadcast({
          type: 'error',
          payload: { phase: 'abort', message: 'User aborted' },
        });
        break;

      case 'ping':
        send(ws, { type: 'pong', payload: {} });
        break;

      case 'tool.confirm_result': {
        const { id, decision } = (
          msg as { payload: { id: string; decision: 'yes' | 'no' | 'always' | 'deny' } }
        ).payload;
        const resolve = pendingConfirms.get(id);
        if (resolve) {
          pendingConfirms.delete(id);
          resolve(decision);
        }
        break;
      }

      case 'providers.list':
        await handleProvidersList(ws);
        break;

      case 'provider.models':
        await handleProviderModels(
          ws,
          (msg as { payload: { providerId: string } }).payload.providerId,
        );
        break;

      case 'providers.saved':
        await handleProvidersSaved(ws);
        break;

      case 'key.add':
      case 'key.update': {
        const m = msg as { payload: { providerId: string; label: string; apiKey: string } };
        await handleKeyUpsert(ws, m.payload.providerId, m.payload.label, m.payload.apiKey);
        break;
      }

      case 'key.delete': {
        const m = msg as { payload: { providerId: string; label: string } };
        await handleKeyDelete(ws, m.payload.providerId, m.payload.label);
        break;
      }

      case 'key.set_active': {
        const m = msg as { payload: { providerId: string; label: string } };
        await handleKeySetActive(ws, m.payload.providerId, m.payload.label);
        break;
      }

      case 'provider.add': {
        const m = msg as {
          payload: { id: string; family: string; baseUrl?: string | undefined; apiKey?: string | undefined };
        };
        await handleProviderAdd(ws, m.payload);
        break;
      }

      case 'provider.remove': {
        const m = msg as { payload: { providerId: string } };
        await handleProviderRemove(ws, m.payload.providerId);
        break;
      }

      case 'todos.get': {
        // On-demand snapshot — sends the live todo list from agent ctx.
        // Mirrors the standalone server's handler.
        send(ws, {
          type: 'todos.updated',
          payload: { todos: [...opts.agent.ctx.todos] },
        });
        break;
      }

      case 'goal.get': {
        // Read goal.json from disk and broadcast to all connected clients.
        // The frontend polls this periodically; we serve the latest snapshot.
        const projectRoot = opts.projectRoot ?? opts.agent.ctx.projectRoot;
        try {
          const goalPath = path.join(projectRoot, '.wrongstack', 'goal.json');
          const raw = await fs.readFile(goalPath, 'utf8');
          const goal = JSON.parse(raw);
          broadcast({ type: 'goal.updated', payload: goal });
        } catch {
          broadcast({ type: 'goal.updated', payload: null });
        }
        break;
      }

      case 'sessions.list': {
        // Prefer the wired SessionStore (the real ~/.wrongstack/projects/<hash>/
        // sessions location). The transient store at <projectRoot>/.wrongstack/
        // sessions is a legacy fallback only — real sessions never live there.
        const limit = (msg as { payload?: { limit?: number | undefined } }).payload?.limit ?? 50;
        try {
          const store =
            opts.sessionStore ??
            new DefaultSessionStore({
              dir: path.join(
                opts.projectRoot ?? opts.agent.ctx.projectRoot,
                '.wrongstack',
                'sessions',
              ),
            });
          const list = await store.list(limit);
          const currentId = opts.agent.ctx.session?.id ?? opts.session.id;
          send(ws, {
            type: 'sessions.list',
            payload: {
              sessions: list.map((s) => ({
                id: s.id,
                title: s.title,
                startedAt: s.startedAt,
                model: s.model,
                provider: s.provider,
                tokenTotal: s.tokenTotal,
                isCurrent: s.id === currentId,
              })),
            },
          });
        } catch (err) {
          send(ws, {
            type: 'sessions.list',
            payload: { sessions: [], error: err instanceof Error ? err.message : String(err) },
          });
        }
        break;
      }

      case 'session.new': {
        // CLI-mode session reset: wipe in-memory state (messages, todos,
        // read-files, mtime cache) and broadcast session.start with reset=true.
        // Unlike the standalone server, we do NOT create a new on-disk session
        // — the CLI session lifecycle is managed by wiring/session.ts and a
        // full reset requires the SessionStore (not wired into this path).
        // This handles the visible UI cleanup the frontend expects.
        const ctx = opts.agent.ctx;
        ctx.state.replaceMessages([]);
        ctx.state.replaceTodos([]);
        ctx.readFiles.clear();
        ctx.fileMtimes.clear();
        const sessNewP = await buildSessionStartPayload({ reset: true });
        broadcast({ type: 'session.start', payload: sessNewP });
        break;
      }

      case 'todos.clear': {
        // Manual override — clear the todo list without losing context.
        opts.agent.ctx.state.replaceTodos([]);
        sendResult(ws, true, 'Todos cleared');
        broadcast({ type: 'todos.updated', payload: { todos: [] } });
        break;
      }

      case 'todos.remove': {
        const payload = msg.payload as
          | { id?: string | undefined; index?: number | undefined }
          | undefined;
        if (!payload) {
          sendResult(ws, false, 'Missing id or index');
          break;
        }
        const { id, index } = payload;
        const todos = opts.agent.ctx.todos;
        let targetIdx = -1;
        if (typeof id === 'string') {
          targetIdx = todos.findIndex((t) => t.id === id);
        } else if (typeof index === 'number' && index > 0) {
          targetIdx = index - 1;
        }
        if (targetIdx < 0 || !todos[targetIdx]) {
          sendResult(ws, false, 'Todo not found');
          break;
        }
        const removed = expectDefined(todos[targetIdx]);
        const next = [...todos.slice(0, targetIdx), ...todos.slice(targetIdx + 1)];
        opts.agent.ctx.state.replaceTodos(next);
        sendResult(ws, true, `Removed: ${removed.content}`);
        broadcast({ type: 'todos.updated', payload: { todos: next } });
        break;
      }

      case 'todo.update': {
        // Update a todo's status and/or activeForm in agent context.
        const payload = msg.payload as {
          id: string;
          status?: TodoItem['status'] | undefined;
          activeForm?: string | undefined;
        };
        const todos = opts.agent.ctx.todos;
        const idx = todos.findIndex((t) => t.id === payload.id);
        if (idx === -1) {
          sendResult(ws, false, 'Todo not found');
          break;
        }
        const next = [...todos];
        const existing = expectDefined(next[idx]);
        next[idx] = {
          ...existing,
          status: payload.status ?? existing.status,
          activeForm: payload.activeForm !== undefined ? payload.activeForm : existing.activeForm,
        };
        opts.agent.ctx.state.replaceTodos(next);
        sendResult(ws, true, `Todo "${existing.content}" updated`);
        broadcast({ type: 'todos.updated', payload: { todos: next } });
        break;
      }

      case 'context.clear': {
        // In-memory wipe — same as session.new but reuses the current session.
        const ctx = opts.agent.ctx;
        ctx.state.replaceMessages([]);
        ctx.state.replaceTodos([]);
        ctx.readFiles.clear();
        ctx.fileMtimes.clear();
        sendResult(ws, true, 'Context cleared');
        const ctxClearP = await buildSessionStartPayload({ reset: true });
        broadcast({ type: 'session.start', payload: ctxClearP });
        break;
      }

      case 'process.list': {
        try {
          const { getProcessRegistry } = await import('@wrongstack/tools');
          const procs = getProcessRegistry().list();
          send(ws, {
            type: 'process.list',
            payload: {
              processes: procs.map((p) => ({
                pid: p.pid,
                command: p.command,
                tool: p.name,
                startedAt: p.startedAt,
                status: p.killed ? ('killed' as const) : ('running' as const),
                protected: p.protected,
              })),
            },
          });
        } catch {
          send(ws, { type: 'process.list', payload: { processes: [] } });
        }
        break;
      }

      case 'process.kill': {
        const { pid } = (msg as { payload: { pid: number } }).payload;
        try {
          const { getProcessRegistry } = await import('@wrongstack/tools');
          const proc = getProcessRegistry().get(pid);
          if (proc?.protected) {
            sendResult(ws, false, `Cannot kill protected process (PID ${pid})`);
            break;
          }
          getProcessRegistry().kill(pid);
          sendResult(ws, true, `Killed PID ${pid}`);
        } catch (err) {
          sendResult(ws, false, err instanceof Error ? err.message : String(err));
        }
        break;
      }

      case 'process.killAll': {
        try {
          const { getProcessRegistry } = await import('@wrongstack/tools');
          getProcessRegistry().killAll();
          sendResult(ws, true, 'All processes killed');
        } catch (err) {
          sendResult(ws, false, err instanceof Error ? err.message : String(err));
        }
        break;
      }

      case 'diag.get': {
        // Snapshot of key metrics — mirrors the standalone server's handler
        // and the CLI /diag output. Uses the agent context for live state.
        const ctx = opts.agent.ctx;
        const tools = opts.agent.tools.list();
        send(ws, {
          type: 'diag.get',
          payload: {
            provider: (ctx.provider as { id: string }).id,
            model: ctx.model,
            cwd: opts.projectRoot ?? ctx.projectRoot,
            sessionId: opts.session.id,
            tools: {
              count: tools.length,
              names: tools.map((t) => t.name),
            },
            features: {},
            mode: 'default',
            usage: ctx.tokenCounter.total(),
            messages: ctx.messages.length,
            todos: ctx.todos.length,
          },
        });
        break;
      }

      case 'stats.get': {
        // Detailed session usage stats, mirroring the CLI /stats.
        const ctx = opts.agent.ctx;
        const usage = ctx.tokenCounter.total();
        const cacheStats = ctx.tokenCounter.cacheStats();
        let cost: number | null = null;
        try {
          if (opts.modelsRegistry) {
            const model = await opts.modelsRegistry.getModel(
              (ctx.provider as { id: string }).id,
              ctx.model,
            );
            const rates = getCostRates(model);
            cost = computeUsageCost(
              { input: usage.input, output: usage.output, cacheRead: cacheStats.readTokens },
              rates,
            );
          }
        } catch { /* cost stays null */ }
        send(ws, {
          type: 'stats.get',
          payload: {
            sessionId: opts.session.id,
            provider: (ctx.provider as { id: string }).id,
            model: ctx.model,
            usage,
            cache: cacheStats,
            cost,
            messages: ctx.messages.length,
            readFiles: ctx.readFiles.size,
            tools: opts.agent.tools.list().length,
            elapsedMs: Date.now() - sessionStartedAt,
          },
        });
        break;
      }

      case 'autonomy.switch': {
        const { mode } = (msg as { payload: { mode: string } }).payload;
        opts.agent.ctx.meta['autonomy'] = mode;
        sendResult(ws, true, `Autonomy mode set to "${mode}"`);
        break;
      }

      case 'tools.list': {
        const list = opts.agent.tools.list().map((t) => {
          const schema =
            (t as { inputSchema?: { properties?: Record<string, unknown> } }).inputSchema ?? {};
          const params = schema.properties ? Object.keys(schema.properties) : [];
          return {
            name: t.name,
            description: (t as { description?: string | undefined }).description ?? '',
            params,
          };
        });
        send(ws, { type: 'tools.list', payload: { tools: list } });
        break;
      }

      case 'session.checkpoints': {
        const projectRoot = opts.projectRoot ?? opts.agent.ctx.projectRoot;
        try {
          const { DefaultSessionRewinder } = await import('@wrongstack/core');
          const rewinder = new DefaultSessionRewinder(
            opts.sessionsDir ?? path.join(projectRoot, '.wrongstack', 'sessions'),
            projectRoot,
          );
          // Use the LIVE writer's id — after an in-app resume the active
          // session is agent.ctx.session, not the startup one.
          const liveId = opts.agent.ctx.session?.id ?? opts.session.id;
          const checkpoints = await rewinder.listCheckpoints(liveId);
          send(ws, {
            type: 'session.checkpoints',
            payload: { checkpoints },
          });
        } catch {
          send(ws, {
            type: 'session.checkpoints',
            payload: { checkpoints: [] },
          });
        }
        break;
      }

      case 'session.rewind': {
        const { checkpointIndex } = (msg as { payload: { checkpointIndex: number } }).payload;
        const projectRoot = opts.projectRoot ?? opts.agent.ctx.projectRoot;
        try {
          const { DefaultSessionRewinder } = await import('@wrongstack/core');
          const rewinder = new DefaultSessionRewinder(
            opts.sessionsDir ?? path.join(projectRoot, '.wrongstack', 'sessions'),
            projectRoot,
          );
          // Rewind the LIVE session — both the file reverts (rewinder) and
          // the JSONL truncation (writer) must target the same session.
          const liveSession = opts.agent.ctx.session ?? opts.session;
          await rewinder.rewindToCheckpoint(liveSession.id, checkpointIndex);
          await liveSession.truncateToCheckpoint(checkpointIndex);
          sendResult(ws, true, `Rewound to checkpoint ${checkpointIndex}`);
          const rewindP = await buildSessionStartPayload({ reset: true });
          broadcast({ type: 'session.start', payload: rewindP });
        } catch (err) {
          sendResult(ws, false, err instanceof Error ? err.message : String(err));
        }
        break;
      }

      // ── File operations — delegated to shared handlers (file-handlers.ts) ──
      // These handlers are also used by the standalone WebUI server. When
      // adding or modifying file-operation WebSocket messages, update
      // file-handlers.ts — NOT these case blocks individually.
      case 'files.list': {
        const projectRoot = opts.projectRoot ?? opts.agent.ctx.projectRoot;
        return handleFilesList(ws, msg, projectRoot);
      }
      case 'files.tree': {
        const projectRoot = opts.projectRoot ?? opts.agent.ctx.projectRoot;
        return handleFilesTree(ws, msg, projectRoot);
      }
      case 'files.read': {
        const projectRoot = opts.projectRoot ?? opts.agent.ctx.projectRoot;
        return handleFilesRead(ws, msg, projectRoot);
      }
      case 'files.write': {
        const projectRoot = opts.projectRoot ?? opts.agent.ctx.projectRoot;
        return handleFilesWrite(ws, msg, projectRoot);
      }

      case 'session.delete': {
        const { id } = (msg as { payload: { id: string } }).payload;
        // Guard against the CURRENT writer — after an in-app resume the
        // active session is agent.ctx.session, not the startup one.
        if (id === (opts.agent.ctx.session?.id ?? opts.session.id)) {
          sendResult(ws, false, 'Cannot delete the active session');
          break;
        }
        try {
          // Prefer the wired SessionStore (real sessions location); the
          // transient <projectRoot>/.wrongstack/sessions store is legacy-only.
          const store =
            opts.sessionStore ??
            new DefaultSessionStore({
              dir: path.join(
                opts.projectRoot ?? opts.agent.ctx.projectRoot,
                '.wrongstack',
                'sessions',
              ),
            });
          await store.delete(id);
          sendResult(ws, true, `Session ${id} deleted`);
        } catch (err) {
          sendResult(ws, false, err instanceof Error ? err.message : String(err));
        }
        break;
      }

      case 'session.save':
        // SessionWriter auto-flushes — confirm for UI habit parity.
        sendResult(ws, true, `Session ${opts.session.id} is auto-saved`);
        break;

      case 'plan.get': {
        // On-demand plan snapshot from context.meta.
        const planPath = (opts.agent.ctx.meta as Record<string, unknown>)['plan.path'];
        if (typeof planPath === 'string' && planPath) {
          try {
            const { loadPlan } = await import('@wrongstack/core');
            const plan = await loadPlan(planPath);
            send(ws, {
              type: 'plan.updated',
              payload: {
                plan: plan ?? {
                  version: 1,
                  sessionId: opts.session.id,
                  updatedAt: new Date().toISOString(),
                  items: [],
                },
              },
            });
          } catch {
            send(ws, {
              type: 'plan.updated',
              payload: {
                plan: {
                  version: 1,
                  sessionId: opts.session.id,
                  updatedAt: new Date().toISOString(),
                  items: [],
                },
              },
            });
          }
        } else {
          send(ws, {
            type: 'plan.updated',
            payload: { plan: null, error: 'Plan storage is not configured for this session.' },
          });
        }
        break;
      }

      case 'plan.template_use': {
        const { template } = (msg as { payload: { template: string } }).payload;
        const planPath = (opts.agent.ctx.meta as Record<string, unknown>)['plan.path'];
        if (typeof planPath !== 'string' || !planPath) {
          sendResult(ws, false, 'Plan storage is not configured for this session.');
          break;
        }
        try {
          const { getPlanTemplate, loadPlan, savePlan, emptyPlan, addPlanItem } = await import(
            '@wrongstack/core'
          );
          const tpl = getPlanTemplate(template);
          if (!tpl) {
            sendResult(ws, false, `Unknown template "${template}".`);
            break;
          }
          let plan = (await loadPlan(planPath)) ?? emptyPlan(opts.session.id);
          for (const item of tpl.items) {
            ({ plan } = addPlanItem(plan, item.title, item.details));
          }
          await savePlan(planPath, plan);
          sendResult(ws, true, `Applied template "${tpl.name}" — ${tpl.items.length} items added.`);
          broadcast({
            type: 'plan.updated',
            payload: { plan },
          });
        } catch (err) {
          sendResult(ws, false, err instanceof Error ? err.message : String(err));
        }
        break;
      }

      case 'plan.item.update': {
        // Update a single plan item's status and broadcast.
        const planPath = (opts.agent.ctx.meta as Record<string, unknown>)['plan.path'];
        if (typeof planPath !== 'string' || !planPath) {
          sendResult(ws, false, 'Plan storage is not configured for this session.');
          break;
        }
        const payload = msg.payload as {
          target: string;
          status: 'open' | 'in_progress' | 'done';
        };
        try {
          const sessionId = opts.session.id;
          let changed = false;
          const plan = await mutatePlan(planPath, sessionId, async (p) => {
            const before = p.updatedAt;
            const next = setPlanItemStatus(p, payload.target, payload.status);
            changed = next.updatedAt !== before;
            return next;
          });
          if (!changed) {
            sendResult(ws, false, `No plan item matched "${payload.target}".`);
            break;
          }
          sendResult(ws, true, `Plan item status updated to "${payload.status}".`);
          broadcast({ type: 'plan.updated', payload: { plan } });
        } catch (err) {
          sendResult(ws, false, err instanceof Error ? err.message : String(err));
        }
        break;
      }

      // ── Memory operations — delegated to shared handlers (memory-handlers.ts) ──
      case 'memory.list': {
        if (!opts.memoryStore) {
          send(ws, { type: 'memory.list', payload: { text: '', error: 'Memory store not available' } });
          break;
        }
        return handleMemoryList(ws, opts.memoryStore);
      }
      case 'memory.remember': {
        if (!opts.memoryStore) {
          sendResult(ws, false, 'Memory store not available');
          break;
        }
        return handleMemoryRemember(ws, msg, opts.memoryStore);
      }
      case 'memory.forget': {
        if (!opts.memoryStore) {
          sendResult(ws, false, 'Memory store not available');
          break;
        }
        return handleMemoryForget(ws, msg, opts.memoryStore);
      }

      case 'skills.list': {
        if (!opts.skillLoader) {
          send(ws, { type: 'skills.list', payload: { skills: [], enabled: false } });
          break;
        }
        try {
          const manifests = await opts.skillLoader.list();
          const entries = await opts.skillLoader.listEntries();
          const byName = new Map(entries.map((e) => [e.name, e]));
          send(ws, {
            type: 'skills.list',
            payload: {
              enabled: true,
              skills: manifests.map((m) => ({
                name: m.name,
                description: m.description,
                version: m.version ?? '',
                source: m.source,
                path: m.path,
                trigger: byName.get(m.name)?.trigger ?? '',
                scope: byName.get(m.name)?.scope ?? [],
              })),
            },
          });
        } catch (err) {
          send(ws, {
            type: 'skills.list',
            payload: { skills: [], enabled: true, error: err instanceof Error ? err.message : String(err) },
          });
        }
        break;
      }

      case 'modes.list': {
        if (!opts.modeStore) {
          send(ws, {
            type: 'modes.list',
            payload: { modes: [], activeId: 'default', error: 'Mode store not available' },
          });
          break;
        }
        try {
          const modes = await opts.modeStore.listModes();
          const active = await opts.modeStore.getActiveMode();
          send(ws, {
            type: 'modes.list',
            payload: {
              modes: modes.map((m) => ({
                id: m.id,
                name: m.name,
                description: m.description,
                isActive: m.id === (active?.id ?? 'default'),
              })),
              activeId: active?.id ?? 'default',
            },
          });
        } catch (err) {
          send(ws, {
            type: 'modes.list',
            payload: { modes: [], activeId: 'default', error: err instanceof Error ? err.message : String(err) },
          });
        }
        break;
      }

      case 'mode.switch': {
        if (!opts.modeStore) {
          sendResult(ws, false, 'Mode store not available');
          break;
        }
        const { id } = (msg as { payload: { id: string } }).payload;
        try {
          if (id === 'default') {
            await opts.modeStore.setActiveMode(null);
          } else {
            const found = await opts.modeStore.getMode(id);
            if (!found) throw new Error(`Unknown mode "${id}"`);
            await opts.modeStore.setActiveMode(id);
          }
          // Store the mode in context.meta so the agent sees it on the next turn.
          opts.agent.ctx.meta['mode'] = id;
          sendResult(ws, true, `Switched to mode "${id}"`);
          const modeSwP = await buildSessionStartPayload({ mode: id });
          broadcast({ type: 'session.start', payload: modeSwP });
        } catch (err) {
          sendResult(ws, false, err instanceof Error ? err.message : String(err));
        }
        break;
      }

      case 'model.switch': {
        const { provider: newProvider, model: newModel } = (
          msg as { payload: { provider: string; model: string } }
        ).payload;
        try {
          // Update context
          const ctx = opts.agent.ctx;
          ctx.model = newModel;

          // Create a new provider instance from the saved config
          const { makeProviderFromConfig } = await import('@wrongstack/providers');
          const { loadConfigProviders } = await import('./provider-config-utils.js');
          const saved = opts.globalConfigPath ? await loadConfigProviders(opts.globalConfigPath, getVault()) : {};
          const providerCfg = saved[newProvider] ?? { type: newProvider };
          const newProv = makeProviderFromConfig(newProvider, providerCfg);
          ctx.provider = newProv;

          send(ws, {
            type: 'key.operation_result',
            payload: { success: true, message: `Switched to ${newProvider} / ${newModel}` },
          });
          const modelSwP = await buildSessionStartPayload();
          broadcast({ type: 'session.start', payload: modelSwP });
        } catch (err) {
          send(ws, {
            type: 'key.operation_result',
            payload: {
              success: false,
              message: `Switch failed: ${err instanceof Error ? err.message : String(err)}`,
            },
          });
        }
        break;
      }

      case 'session.resume': {
        if (!opts.sessionStore) {
          sendResult(ws, false, 'Session store not available');
          break;
        }
        const { id } = (msg as { payload: { id: string } }).payload;
        try {
          // Compare against the CURRENT writer — after a prior in-app resume
          // the active session is agent.ctx.session, not the startup one.
          const ctx = opts.agent.ctx;
          if (id === (ctx.session?.id ?? opts.session.id)) {
            sendResult(ws, false, 'Session is already active');
            break;
          }
          const resumed = await opts.sessionStore.resume(id);
          // Finalize the writer we are leaving (session_end + flush + summary
          // sidecar), then swap the context to the resumed writer so all new
          // events land in the resumed session's JSONL. Without the swap,
          // the conversation kept recording into the old session's log and
          // the resumed writer leaked an open file handle.
          const oldWriter = ctx.session;
          if (oldWriter && oldWriter !== resumed.writer) {
            const oldUsage = ctx.tokenCounter.total();
            void (async () => {
              await oldWriter.append({
                type: 'session_end',
                ts: new Date().toISOString(),
                usage: oldUsage,
              }).catch(() => undefined);
              await oldWriter.close().catch(() => undefined);
            })();
          }
          ctx.session = resumed.writer;
          // Let the host re-point crash-recovery state (active.json) at the
          // session that is now actually being written.
          opts.onSessionSwapped?.(resumed.writer.id);
          // Hydrate the context with the old session's messages.
          ctx.state.replaceMessages(resumed.data.messages);
          ctx.state.replaceTodos([]);
          ctx.readFiles.clear();
          ctx.fileMtimes.clear();
          ctx.tokenCounter.reset();
          // Replay usage so the topbar shows accurate totals.
          ctx.tokenCounter.account(resumed.data.usage, ctx.model);
          const resumeP = await buildSessionStartPayload({
            reset: true,
            replayMessages: resumed.data.messages,
            replayUsage: resumed.data.usage,
          });
          broadcast({ type: 'session.start', payload: resumeP });
          sendResult(ws, true, `Resumed session ${id}`);
        } catch (err) {
          sendResult(ws, false, err instanceof Error ? err.message : String(err));
        }
        break;
      }

      case 'context.debug': {
        // Per-section token estimate so users can see what's eating the context window.
        const ctx = opts.agent.ctx;
        const breakdown = estimateContextBreakdown({
          systemPrompt: ctx.systemPrompt as ReadonlyArray<PromptBlock>,
          tools: opts.agent.tools.list() as ReadonlyArray<ToolLike>,
          messages: ctx.messages as ReadonlyArray<MessageLike>,
        });
        send(ws, {
          type: 'context.debug',
          payload: {
            ...breakdown,
            mode: (ctx.meta['contextWindowMode'] as string) ?? DEFAULT_CONTEXT_WINDOW_MODE_ID,
            policy: ctx.meta['contextWindowPolicy'] ?? null,
          },
        });
        break;
      }

      case 'context.compact': {
        const aggressive = !!(msg as { payload?: { aggressive?: boolean | undefined } }).payload
          ?.aggressive;
        try {
          const compactor = opts.agent.container.resolve(TOKENS.Compactor);
          if (!compactor) {
            sendResult(ws, false, 'Compactor not available');
            break;
          }
          const before = opts.agent.ctx.tokenCounter.total();
          const report = await compactor.compact(opts.agent.ctx, { aggressive });
          const after = opts.agent.ctx.tokenCounter.total();
          send(ws, {
            type: 'context.compacted',
            payload: {
              before: before.input + before.output,
              after: after.input + after.output,
              saved: Math.max(0, before.input + before.output - after.input - after.output),
              reductions: report.reductions ?? [],
              repaired: report.repaired ?? false,
            },
          });
          sendResult(
            ws,
            true,
            `Compacted: ${before.input + before.output} → ${after.input + after.output} tokens`,
          );
        } catch (err) {
          sendResult(ws, false, err instanceof Error ? err.message : String(err));
        }
        break;
      }

      case 'context.repair': {
        const ctx = opts.agent.ctx;
        const beforeMessages = ctx.messages.length;
        const repaired = repairToolUseAdjacency(ctx.messages);
        if (repaired.report.changed) {
          ctx.state.replaceMessages(repaired.messages);
        }
        const payload = {
          removedToolUses: repaired.report.removedToolUses,
          removedToolResults: repaired.report.removedToolResults,
          removedMessages: repaired.report.removedMessages,
          beforeMessages,
          afterMessages: ctx.messages.length,
        };
        broadcast({ type: 'context.repaired', payload });
        const removed =
          payload.removedToolUses.length +
          payload.removedToolResults.length +
          payload.removedMessages;
        sendResult(
          ws,
          true,
          removed > 0
            ? `Context repaired: removed ${removed} orphan protocol item(s)`
            : 'Context repair found no orphan protocol blocks',
        );
        break;
      }

      case 'context.modes.list': {
        const active = String(
          opts.agent.ctx.meta['contextWindowMode'] ?? DEFAULT_CONTEXT_WINDOW_MODE_ID,
        );
        send(ws, {
          type: 'context.modes.list',
          payload: {
            activeId: active,
            modes: listContextWindowModes().map((m) => ({
              id: m.id,
              name: m.name,
              description: m.description,
              isActive: m.id === active,
              thresholds: m.thresholds,
              preserveK: m.preserveK,
              eliseThreshold: m.eliseThreshold,
            })),
          },
        });
        break;
      }

      case 'context.mode.switch': {
        const { id } = (msg as { payload: { id: string } }).payload;
        const policy = resolveContextWindowPolicy({}, id);
        if (policy.id !== id) {
          sendResult(ws, false, `Unknown context mode "${id}"`);
          break;
        }
        opts.agent.ctx.meta['contextWindowMode'] = policy.id;
        opts.agent.ctx.meta['contextWindowPolicy'] = policy;
        sendResult(ws, true, `Context mode switched to ${policy.id}`);
        broadcast({
          type: 'context.mode.changed',
          payload: { id: policy.id, name: policy.name, policy },
        });
        break;
      }

      // ── Preferences ──────────────────────────────────────────

      case 'prefs.get': {
        // Return the current pref snapshot from context.meta so the
        // frontend can seed its local-prefs store from the server's truth.
        const prefKeys = [
          'autonomy', 'autonomyDelayMs', 'yolo', 'maxIterations',
          'confirmExit', 'streamFleet', 'nextPrediction',
          'featureMcp', 'featurePlugins', 'featureMemory', 'featureSkills',
          'featureModelsRegistry', 'indexOnStart',
          'contextAutoCompact', 'contextStrategy', 'logLevel', 'auditLevel',
        ];
        const snapshot: Record<string, unknown> = {};
        for (const k of prefKeys) {
          if (k in opts.agent.ctx.meta) snapshot[k] = opts.agent.ctx.meta[k];
        }
        send(ws, { type: 'prefs.updated', payload: snapshot });
        break;
      }

      case 'prefs.update': {
        // Batch preference update. Merges arbitrary key/value pairs into
        // context.meta so the runtime can read them immediately, and
        // broadcasts the full pref snapshot to every connected client so
        // all browser tabs stay in sync.
        const payload = (msg as { payload: Record<string, unknown> }).payload;
        for (const [key, val] of Object.entries(payload)) {
          opts.agent.ctx.meta[key] = val;
        }

        // Broadcast the current snapshot.
        const prefKeys = [
          'autonomy', 'autonomyDelayMs', 'yolo', 'maxIterations',
          'confirmExit', 'streamFleet', 'nextPrediction',
          'featureMcp', 'featurePlugins', 'featureMemory', 'featureSkills',
          'featureModelsRegistry', 'indexOnStart',
          'contextAutoCompact', 'contextStrategy', 'logLevel', 'auditLevel',
        ];
        const snapshot: Record<string, unknown> = {};
        for (const k of prefKeys) {
          if (k in opts.agent.ctx.meta) snapshot[k] = opts.agent.ctx.meta[k];
        }
        broadcast({ type: 'prefs.updated', payload: snapshot });
        break;
      }

      // ── Tasks ───────────────────────────────────────────────

      case 'tasks.get': {
        // On-demand task snapshot — loads from <sessionId>.tasks.json
        const taskPath = (opts.agent.ctx.meta as Record<string, unknown>)['task.path'];
        if (typeof taskPath === 'string' && taskPath) {
          try {
            const { loadTasks } = await import('@wrongstack/core');
            const file = await loadTasks(taskPath);
            send(ws, {
              type: 'tasks.updated',
              payload: { tasks: file?.tasks ?? [] },
            });
          } catch {
            send(ws, { type: 'tasks.updated', payload: { tasks: [] } });
          }
        } else {
          send(ws, { type: 'tasks.updated', payload: { tasks: [], error: 'Task storage not configured.' } });
        }
        break;
      }

      case 'task.update': {
        // Update a task's status in the task file and broadcast.
        const taskPath = (opts.agent.ctx.meta as Record<string, unknown>)['task.path'];
        if (typeof taskPath !== 'string' || !taskPath) {
          sendResult(ws, false, 'Task storage not configured.');
          break;
        }
        const payload = msg.payload as {
          id: string;
          status: 'pending' | 'in_progress' | 'blocked' | 'failed' | 'review' | 'completed';
        };
        try {
          const sessionId = opts.session.id;
          const file = await mutateTasks(taskPath, sessionId, async (f) => {
            const task = f.tasks.find((t) => t.id === payload.id);
            if (!task) return f;
            task.status = payload.status;
            task.updatedAt = new Date().toISOString();
            return f;
          });
          sendResult(ws, true, `Task status updated to "${payload.status}".`);
          broadcast({
            type: 'tasks.updated',
            payload: { tasks: file.tasks },
          });
        } catch (err) {
          sendResult(ws, false, err instanceof Error ? err.message : String(err));
        }
        break;
      }

      // Collaboration messages — the CLI webui-server doesn't run a
      // full collab hub; silently acknowledge and ignore.
      case 'collab.join':
      case 'collab.leave':
      case 'collab.annotate':
      case 'collab.resolve':
        break;

      case 'projects.list': {
        // Read the project manifest from ~/.wrongstack/projects.json
        const projectsBase = opts.globalConfigPath
          ? path.resolve(path.dirname(opts.globalConfigPath))
          : path.resolve(os.homedir(), '.wrongstack');
        const manifestPath = path.join(projectsBase, 'projects.json');
        try {
          const raw = await fs.readFile(manifestPath, 'utf8');
          const manifest = JSON.parse(raw) as { projects: Array<{ name: string; root: string; slug: string; lastSeen?: string }> };
          send(ws, {
            type: 'projects.list',
            payload: { projects: manifest.projects ?? [] },
          });
        } catch {
          send(ws, { type: 'projects.list', payload: { projects: [] } });
        }
        break;
      }

      case 'projects.select': {
        // Spawn a new wstack session in the chosen project directory
        const { root, name: projectName } = (
          msg as { payload: { root: string; name?: string | undefined } }
        ).payload;
        try {
          // Find the CLI entry point
          let cliPath: string;
          try {
            const { createRequire } = await import('node:module');
            const req = createRequire(import.meta.url);
            const pkg = req.resolve('@wrongstack/cli/package.json');
            cliPath = path.join(path.dirname(pkg), 'dist', 'index.js');
            await fs.access(cliPath);
          } catch {
            cliPath = process.argv[1] ?? '';
            if (!cliPath) throw new Error('CLI entry not found');
          }
          const { spawn } = await import('node:child_process');
          const child = spawn(process.execPath, [cliPath, '--no-interactive'], {
            cwd: root,
            stdio: 'inherit',
            detached: false,
          });
          child.unref();
          send(ws, {
            type: 'projects.selected',
            payload: {
              root,
              name: projectName ?? path.basename(root),
              message: `Spawning wstack in ${root} ...`,
            },
          });
        } catch (err) {
          sendResult(ws, false, err instanceof Error ? err.message : String(err));
        }
        break;
      }

      case 'model.refine': {
        const { text } = (msg as { payload: { text: string } }).payload;
        if (!text?.trim()) {
          send(ws, {
            type: 'model.refine_result',
            payload: { refined: '', english: '', error: 'Empty text' },
          });
          break;
        }
        try {
          const ctx = opts.agent.ctx;
          const history = recentTextTurns(ctx.messages);
          const result = await enhanceUserPrompt({
            provider: ctx.provider,
            model: ctx.model,
            text,
            history,
            timeoutMs: 90000,
            onError: (reason) => {
              console.warn(JSON.stringify({
                level: 'warn',
                event: 'model.refine_failed',
                reason,
                timestamp: new Date().toISOString(),
              }));
            },
          });
          if (result) {
            send(ws, {
              type: 'model.refine_result',
              payload: { refined: result.refined, english: result.english },
            });
          } else {
            send(ws, {
              type: 'model.refine_result',
              payload: { refined: text, english: text, error: 'Refinement returned no result' },
            });
          }
        } catch (err) {
          send(ws, {
            type: 'model.refine_result',
            payload: { refined: text, english: text, error: err instanceof Error ? err.message : String(err) },
          });
        }
        break;
      }

      case 'webui.shutdown':
        console.log('[WebUI] Shutdown requested from client');
        shutdown();
        break;

      // ── Mailbox operations — project-level inter-agent messaging ────
      case 'mailbox.messages': {
        const projectRoot = opts.projectRoot ?? (opts.agent.ctx as { projectRoot?: string }).projectRoot ?? '';
        const globalRoot = opts.globalConfigPath ? path.dirname(opts.globalConfigPath) : '';
        if (!projectRoot || !globalRoot) {
          send(ws, { type: 'mailbox.messages', payload: { messages: [], error: 'No project root available' } });
          break;
        }
        try {
          const mbDir = path.join(globalRoot, 'projects',
            `${((path.basename(projectRoot) || 'project').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40) || 'project')}-${crypto.createHash('sha256').update(path.resolve(projectRoot)).digest('hex').slice(0, 6)}`);
          const mb = new GlobalMailbox(mbDir);
          const payload = (msg as { payload?: { limit?: number; agentId?: string; unreadOnly?: boolean } }).payload;
          const messages = await mb.query({
            limit: payload?.limit ?? 30,
            to: payload?.agentId,
            unreadBy: payload?.unreadOnly ? payload.agentId : undefined,
          });
          send(ws, {
            type: 'mailbox.messages',
            payload: {
              messages: messages.map((m) => ({
                id: m.id, from: m.from, to: m.to, type: m.type,
                subject: m.subject, body: m.body, priority: m.priority,
                readBy: m.readBy, readByCount: Object.keys(m.readBy).length,
                completed: m.completed, completedBy: m.completedBy,
                outcome: m.outcome, timestamp: m.timestamp,
                replyTo: m.replyTo, senderSessionId: m.senderSessionId,
              })),
            },
          });
        } catch (err) {
          send(ws, { type: 'mailbox.messages', payload: { messages: [], error: err instanceof Error ? err.message : String(err) } });
        }
        break;
      }

      case 'mailbox.agents': {
        const projectRoot = opts.projectRoot ?? (opts.agent.ctx as { projectRoot?: string }).projectRoot ?? '';
        const globalRoot = opts.globalConfigPath ? path.dirname(opts.globalConfigPath) : '';
        if (!projectRoot || !globalRoot) {
          send(ws, { type: 'mailbox.agents', payload: { agents: [], error: 'No project root available' } });
          break;
        }
        try {
          const mbDir = path.join(globalRoot, 'projects',
            `${((path.basename(projectRoot) || 'project').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40) || 'project')}-${crypto.createHash('sha256').update(path.resolve(projectRoot)).digest('hex').slice(0, 6)}`);
          const mb = new GlobalMailbox(mbDir);
          const payload = (msg as { payload?: { onlineOnly?: boolean } }).payload;
          const agents = payload?.onlineOnly
            ? await mb.getOnlineAgents()
            : await mb.getAgentStatuses();
          send(ws, {
            type: 'mailbox.agents',
            payload: {
              agents: agents.map((a) => ({
                agentId: a.agentId, name: a.name, role: a.role,
                sessionId: a.sessionId, status: a.status,
                currentTool: a.currentTool, currentTask: a.currentTask,
                iterations: a.iterations, toolCalls: a.toolCalls,
                lastSeenAt: a.lastSeenAt, online: a.online,
                pid: a.pid, source: a.source,
              })),
            },
          });
        } catch (err) {
          send(ws, { type: 'mailbox.agents', payload: { agents: [], error: err instanceof Error ? err.message : String(err) } });
        }
        break;
      }

      default: {
        // Delegate AutoPhase lifecycle messages to the AutoPhase handler.
        // If the message type starts with 'autophase.', forward it; otherwise
        // log it as unhandled.
        const msgType = (msg as { type: string }).type;
        if (msgType.startsWith('autophase.')) {
          await autoPhaseHandler.handleMessage(
            msg as { type: string; payload?: Record<string, unknown> },
          );
        } else {
          console.debug(`[WebUI] Unhandled message type: ${msgType}`);
        }
        break;
      }
    }
  }

  async function handleUserMessage(
    ws: WebSocket,
    _client: ConnectedClient,
    content: string,
  ): Promise<void> {
    // Guard against overlapping runs on the same Agent instance. Two
    // rapid user messages would otherwise start a second agent.run()
    // before the first one's cleanup settles, corrupting context state.
    if (abortController) {
      send(ws, {
        type: 'error',
        payload: { phase: 'agent.run', message: 'A run is already in progress. Abort it first.' },
      });
      return;
    }

    // Abort any existing run (safety net; the guard above makes this
    // unreachable in the overlapping case, but direct abort requests
    // from the client still need the controller reference).
    abortController = new AbortController();

    try {
      const result = await opts.agent.run(content, {
        signal: abortController.signal,
      });

      send(ws, {
        type: 'run.result',
        payload: {
          status: result.status,
          iterations: result.iterations,
          finalText: result.finalText,
          error: result.error
            ? {
                code: result.error.code,
                message: result.error.message,
                recoverable: result.error.recoverable,
              }
            : undefined,
        },
      });
    } catch (err) {
      send(ws, {
        type: 'error',
        payload: {
          phase: 'agent.run',
          message: err instanceof Error ? err.message : String(err),
        },
      });
    } finally {
      abortController = null;
    }
  }

  function send(ws: WebSocket, msg: WSServerMessage): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }

  function shutdown(): void {
    console.log('[WebUI] Shutting down...');
    httpServer?.close();
    opts.onExit?.();
  }

  function broadcast(msg: WSServerMessage): void {
    const data = JSON.stringify(msg);
    for (const [ws] of clients) {
      if (ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(data);
        } catch {
          // Client disconnected between the readyState check and the send
          // — let the 'close' handler remove it from the map naturally.
        }
      }
    }
  }

  // ---- Provider/Model/Key management handlers ----

  async function handleProvidersList(ws: WebSocket): Promise<void> {
    if (!opts.modelsRegistry) {
      sendResult(ws, false, 'Models registry not available');
      return;
    }
    try {
      const providers = await opts.modelsRegistry.listProviders();
      const savedProviders = await loadSavedProviders();
      const savedIds = new Set(Object.keys(savedProviders));

      send(ws, {
        type: 'provider.catalog',
        payload: {
          providers: providers.map((p) => ({
            id: p.id,
            name: p.name,
            family: p.family,
            apiBase: p.apiBase,
            envVars: p.envVars,
            modelCount: p.models.length,
            hasApiKey: savedIds.has(p.id) || p.envVars.some((v) => !!process.env[v]),
          })),
        },
      });
    } catch (err) {
      sendResult(ws, false, err instanceof Error ? err.message : String(err));
    }
  }

  async function handleProviderModels(ws: WebSocket, providerId: string): Promise<void> {
    if (!opts.modelsRegistry) {
      sendResult(ws, false, 'Models registry not available');
      return;
    }
    try {
      const provider = await opts.modelsRegistry.getProvider(providerId);
      if (!provider) {
        sendResult(ws, false, `Provider "${providerId}" not found in catalog`);
        return;
      }
      send(ws, {
        type: 'provider.models',
        payload: {
          provider: providerId,
          models: provider.models.map((m) => ({
            id: m.id,
            name: m.name,
            releaseDate: m.release_date,
            contextWindow: m.limit?.context,
            inputCost: m.cost?.input,
            outputCost: m.cost?.output,
            capabilities: [
              ...(m.tool_call ? ['tools'] : []),
              ...(m.reasoning ? ['reasoning'] : []),
              ...(m.modalities?.input?.includes('image') ? ['vision'] : []),
              ...(m.open_weights ? ['open_weights'] : []),
            ],
          })),
        },
      });
    } catch (err) {
      sendResult(ws, false, err instanceof Error ? err.message : String(err));
    }
  }

  async function handleProvidersSaved(ws: WebSocket): Promise<void> {
    try {
      const providers = await loadSavedProviders();
      send(ws, {
        type: 'providers.saved',
        payload: {
          providers: Object.entries(providers).map(([id, cfg]) => ({
            id,
            family: cfg.family,
            baseUrl: cfg.baseUrl,
            apiKeys: normalizeKeys(cfg).map((k) => ({
              label: k.label,
              maskedKey: maskedKey(k.apiKey),
              isActive: k.label === cfg.activeKey,
              createdAt: k.createdAt,
            })),
          })),
        },
      });
    } catch (err) {
      sendResult(ws, false, err instanceof Error ? err.message : String(err));
    }
  }

  async function handleKeyUpsert(
    ws: WebSocket,
    providerId: string,
    label: string,
    apiKey: string,
  ): Promise<void> {
    try {
      const providers = await loadSavedProviders();
      const existing = providers[providerId] ?? { type: providerId };
      const keys = normalizeKeys(existing);

      // Check if label exists
      const existingIdx = keys.findIndex((k) => k.label === label);
      if (existingIdx >= 0) {
        keys[existingIdx] = { ...expectDefined(keys[existingIdx]), apiKey, createdAt: nowIso() };
      } else {
        keys.push({ label, apiKey, createdAt: nowIso() });
      }

      writeKeysBack(existing, keys);
      if (!existing.activeKey) existing.activeKey = label;
      providers[providerId] = existing;

      await saveProviders(providers);
      sendResult(ws, true, `Key "${label}" saved for ${providerId}`);
    } catch (err) {
      sendResult(ws, false, err instanceof Error ? err.message : String(err));
    }
  }

  async function handleKeyDelete(ws: WebSocket, providerId: string, label: string): Promise<void> {
    try {
      const providers = await loadSavedProviders();
      const existing = providers[providerId];
      if (!existing) {
        sendResult(ws, false, `Provider "${providerId}" not found`);
        return;
      }
      const keys = normalizeKeys(existing).filter((k) => k.label !== label);
      if (keys.length === 0) {
        delete providers[providerId];
      } else {
        writeKeysBack(existing, keys);
        if (existing.activeKey === label) {
          existing.activeKey = keys[0]?.label;
        }
        providers[providerId] = existing;
      }
      await saveProviders(providers);
      sendResult(ws, true, `Key "${label}" deleted from ${providerId}`);
    } catch (err) {
      sendResult(ws, false, err instanceof Error ? err.message : String(err));
    }
  }

  async function handleKeySetActive(
    ws: WebSocket,
    providerId: string,
    label: string,
  ): Promise<void> {
    try {
      const providers = await loadSavedProviders();
      const existing = providers[providerId];
      if (!existing) {
        sendResult(ws, false, `Provider "${providerId}" not found`);
        return;
      }
      existing.activeKey = label;
      writeKeysBack(existing, normalizeKeys(existing));
      providers[providerId] = existing;
      await saveProviders(providers);
      sendResult(ws, true, `Active key for ${providerId} set to "${label}"`);
    } catch (err) {
      sendResult(ws, false, err instanceof Error ? err.message : String(err));
    }
  }

  async function handleProviderAdd(
    ws: WebSocket,
    payload: { id: string; family: string; baseUrl?: string | undefined; apiKey?: string | undefined },
  ): Promise<void> {
    try {
      const providers = await loadSavedProviders();
      if (providers[payload.id]) {
        sendResult(ws, false, `Provider "${payload.id}" already exists. Use key.add to add a key.`);
        return;
      }
      const newProv: ProviderConfig = {
        type: payload.id,
        family: payload.family as ProviderConfig['family'],
        baseUrl: payload.baseUrl,
      };
      if (payload.apiKey) {
        newProv.apiKeys = [{ label: 'default', apiKey: payload.apiKey, createdAt: nowIso() }];
        newProv.activeKey = 'default';
      }
      providers[payload.id] = newProv;
      await saveProviders(providers);
      sendResult(ws, true, `Provider "${payload.id}" added`);
    } catch (err) {
      sendResult(ws, false, err instanceof Error ? err.message : String(err));
    }
  }

  async function handleProviderRemove(ws: WebSocket, providerId: string): Promise<void> {
    try {
      const providers = await loadSavedProviders();
      if (!providers[providerId]) {
        sendResult(ws, false, `Provider "${providerId}" not found`);
        return;
      }
      delete providers[providerId];
      await saveProviders(providers);
      sendResult(ws, true, `Provider "${providerId}" removed`);
    } catch (err) {
      sendResult(ws, false, err instanceof Error ? err.message : String(err));
    }
  }

  // ---- Config I/O helpers (delegated to shared provider-config-utils) ----

  function getVault(): DefaultSecretVault {
    const keyFile = path.join(path.dirname(opts.globalConfigPath ?? ''), '.key');
    return new DefaultSecretVault({ keyFile });
  }

  async function loadSavedProviders(): Promise<Record<string, ProviderConfig>> {
    if (!opts.globalConfigPath) return {};
    return loadConfigProviders(opts.globalConfigPath, getVault());
  }

  async function saveProviders(providers: Record<string, ProviderConfig>): Promise<void> {
    if (!opts.globalConfigPath) return;
    await mutateConfigProviders(opts.globalConfigPath, getVault(), (existing) => {
      // Replace the entire providers map.
      for (const key of Object.keys(existing)) delete existing[key];
      Object.assign(existing, providers);
    });
  }

  function sendResult(ws: WebSocket, success: boolean, message: string): void {
    send(ws, { type: 'key.operation_result', payload: { success, message } });
  }
} // end of runWebUI
