/**
 * WebSocket message router for the CLI WebUI bridge.
 *
 * A declarative route table keyed by `WSClientMessage['type']`, replacing
 * the former 112-case switch statement. Each route is a closure that calls
 * the matching `handleXxx(ctx, ws, ...)` from the shared ws-handlers groups
 * (or, for file/mcp/skills/prompts/design/shell, the handlers shared with
 * the standalone `@wrongstack/webui/server`). Prefix-based message types
 * (`autophase.*`, `specs.*`, `sdd.board.*`, `sdd.spec.*`/`sdd.run.*`,
 * `worktree.*`) fall through to their dedicated handler instance instead of
 * a route-table entry.
 *
 * `createMessageRouter(deps)` receives every per-group context object
 * already constructed by the caller (`webui-server.ts`) — it does not build
 * any wiring itself, only routes.
 *
 * PR 15 of Issue #30: extracted from `webui-server.ts`.
 */
import type { TodoItem } from '@wrongstack/core';
import type {
  AutoPhaseWebSocketHandler,
  DesignContext,
  PromptsContext,
  SddBoardWebSocketHandler,
  SddWizardWebSocketHandler,
  SkillsContext,
  SpecsWebSocketHandler,
  WorktreeWebSocketHandler,
} from '@wrongstack/webui/server';
import {
  createToolLspCompletionSource,
  handleCompletionRequest,
  handleDesignList,
  handleDesignMaterialize,
  handleDesignSet,
  handleDesignState,
  handleDesignUse,
  handleDesignVerify,
  handleFilesList,
  handleFilesRead,
  handleFilesTree,
  handleFilesWrite,
  handleGitChanges,
  handleGitDiff,
  handleGitInfo,
  handleMcpAdd,
  handleMcpDisable,
  handleMcpDiscover,
  handleMcpEnable,
  handleMcpList,
  handleMcpRemove,
  handleMcpRestart,
  handleMcpSleep,
  handleMcpUpdate,
  handleMcpWake,
  handleMemoryForget,
  handleMemoryList,
  handleMemoryRemember,
  handlePromptsContent,
  handlePromptsCreate,
  handlePromptsFavorite,
  handlePromptsList,
  handlePromptsRecent,
  handlePromptsSearch,
  handlePromptsUsed,
  handleShellOpen,
  handleSkillsContent,
  handleSkillsCreate,
  handleSkillsEdit,
  handleSkillsExport,
  handleSkillsInstall,
  handleSkillsUninstall,
  handleSkillsUpdate,
} from '@wrongstack/webui/server';
import type { WebSocket } from 'ws';
import { consoleLogger } from './logger-shim.js';
import type { ConnectedClient } from './connection-handler.js';
import type {
  AgentConfigContext,
  BrainHandlerContext,
  ConnectionContext,
  ContextHandlerContext,
  IntrospectionContext,
  MailboxContext,
  PrefsContext,
  ProjectsContext,
  SessionsContext,
  WorklistContext,
  WsCommon,
  WsHandlerContext,
} from './ws-handlers/index.js';
import {
  handleAbort,
  handleAutonomySwitch,
  handleBrainAsk,
  handleBrainRisk,
  handleBrainStatus,
  handleContextClear,
  handleContextCompact,
  handleContextDebug,
  handleContextModeCreate,
  handleContextModeDelete,
  handleContextModeSwitch,
  handleContextModesList,
  handleContextModeUpdate,
  handleContextRepair,
  handleDiagGet,
  handleGoalGet,
  handleKeyDelete,
  handleKeySetActive,
  handleKeyUpsert,
  handleModeSwitch,
  handleModelRefine,
  handleModelSwitch,
  handleModesList,
  handleOAuthCancel,
  handleOAuthCode,
  handleOAuthStart,
  handlePing,
  handlePlanGet,
  handlePlanItemUpdate,
  handlePlanTemplateUse,
  handlePrefsGet,
  handlePrefsUpdate,
  handleProcessKill,
  handleProcessKillAll,
  handleProcessList,
  handleProjectsAdd,
  handleProjectsList,
  handleProjectsSelect,
  handleProviderAdd,
  handleProviderClearModels,
  handleProviderModels,
  handleProviderProbe,
  handleProviderRemove,
  handleProviderUndoClear,
  handleProviderUpdate,
  handleProvidersList,
  handleProvidersSaved,
  handleSessionCheckpoints,
  handleSessionDelete,
  handleSessionNew,
  handleSessionResume,
  handleSessionRewind,
  handleSessionSave,
  handleSessionsList,
  handleSkillsList,
  handleStatsGet,
  handleTaskUpdate,
  handleTasksGet,
  handleTodoUpdate,
  handleTodosClear,
  handleTodosGet,
  handleTodosRemove,
  handleToolConfirmResult,
  handleToolsList,
  handleUserMessage,
  handleWorkingDirSet,
} from './ws-handlers/index.js';
import { handleMailboxAgents, handleMailboxClear, handleMailboxMessages, handleMailboxPurge } from './ws-handlers/mailbox.js';
import type { CliWebUIOptions, WSClientMessage, WSServerMessage } from '../webui-server.js';

export interface MessageRouterDeps {
  opts: CliWebUIOptions;
  send: (ws: WebSocket, msg: WSServerMessage) => void;
  sendResult: (ws: WebSocket, success: boolean, message: string) => void;
  sessionPayload: <T extends Record<string, unknown>>(payload: T) => T & { sessionId: string };
  currentSessionId: () => string;
  shutdown: () => void;

  wsHandlerCtx: WsHandlerContext;
  brainCtx: BrainHandlerContext;
  introspectionCtx: IntrospectionContext;
  skillsCtx: SkillsContext;
  promptsCtx: PromptsContext;
  designCtx: DesignContext;
  worklistCtx: WorklistContext;
  agentConfigCtx: AgentConfigContext;
  prefsCtx: PrefsContext;
  projectsCtx: ProjectsContext;
  contextHandlerCtx: ContextHandlerContext;
  wsCommon: WsCommon;
  mailboxCtx: MailboxContext;
  sessionsCtx: SessionsContext;
  connectionCtx: ConnectionContext;

  autoPhaseHandler: AutoPhaseWebSocketHandler;
  specsHandler: SpecsWebSocketHandler;
  sddBoardHandler: SddBoardWebSocketHandler;
  sddWizardHandler: SddWizardWebSocketHandler | null;
  worktreeHandler: WorktreeWebSocketHandler;
}

export type MessageRouter = (
  ws: WebSocket,
  client: ConnectedClient,
  msg: WSClientMessage,
) => Promise<void>;

export function createMessageRouter(deps: MessageRouterDeps): MessageRouter {
  const {
    opts,
    send,
    sendResult,
    sessionPayload,
    currentSessionId,
    shutdown,
    wsHandlerCtx,
    brainCtx,
    introspectionCtx,
    skillsCtx,
    promptsCtx,
    designCtx,
    worklistCtx,
    agentConfigCtx,
    prefsCtx,
    projectsCtx,
    contextHandlerCtx,
    wsCommon,
    mailboxCtx,
    sessionsCtx,
    connectionCtx,
    autoPhaseHandler,
    specsHandler,
    sddBoardHandler,
    sddWizardHandler,
    worktreeHandler,
  } = deps;

  type WsRouteHandler = (msg: WSClientMessage, ws: WebSocket) => void | Promise<void>;
  const noop = () => {};
  const sessionBoundRouteTypes = new Set<string>([
    'user_message',
    'abort',
    'tool.confirm_result',
    'diag.get',
    'stats.get',
    'side_effects.list',
    'session.new',
    'session.resume',
    'session.save',
    'session.checkpoints',
    'session.rewind',
    'context.clear',
    'context.compact',
    'context.repair',
    'context.debug',
    'context.modes.list',
    'context.mode.switch',
    'context.mode.create',
    'context.mode.update',
    'context.mode.delete',
    'todos.get',
    'todos.clear',
    'todos.remove',
    'todo.update',
    'tasks.get',
    'task.update',
    'plan.get',
    'plan.template_use',
    'plan.item.update',
  ]);

  const requestedSessionId = (msg: WSClientMessage): string | undefined => {
    const payload = msg.payload;
    return payload && typeof payload === 'object' && typeof (payload as { sessionId?: unknown }).sessionId === 'string'
      ? (payload as { sessionId: string }).sessionId
      : undefined;
  };

  const ensureRouteSession = (ws: WebSocket, msg: WSClientMessage): boolean => {
    if (!sessionBoundRouteTypes.has(msg.type)) return true;
    const requested = requestedSessionId(msg);
    const current = currentSessionId();
    if (!requested || requested === current) return true;
    send(ws, {
      type: 'error',
      payload: sessionPayload({
        phase: msg.type,
        message: `Request targeted session ${requested}, but this WebUI runtime is currently on ${current}.`,
        requestedSessionId: requested,
      }),
    });
    return false;
  };

  const projectRootFor = () =>
    opts.projectRoot ?? (opts.agent.ctx as { projectRoot?: string }).projectRoot ?? '';

  /** Validate an `auth.oauth.*` message's `kind` field. */
  const oauthKindOf = (msg: unknown): 'chatgpt' | 'claude' | 'copilot' | null => {
    const kind = (msg as { payload?: { kind?: unknown } })?.payload?.kind;
    return kind === 'chatgpt' || kind === 'claude' || kind === 'copilot' ? kind : null;
  };

  const wsRoutes: Record<string, WsRouteHandler> = {
    // ── Core connection ──
    user_message: (msg, ws) =>
      handleUserMessage(
        connectionCtx,
        ws,
        (msg as { payload: { content: string } }).payload.content,
        (msg as { payload?: { sessionId?: string } }).payload?.sessionId,
      ),
    abort: (msg, ws) =>
      handleAbort(connectionCtx, ws, (msg as { payload?: { sessionId?: string } }).payload?.sessionId),
    ping: (_msg, ws) => handlePing(connectionCtx, ws),
    'tool.confirm_result': (msg, _ws) => {
      const { id, decision } = (
        msg as { payload: { id: string; decision: 'yes' | 'no' | 'always' | 'deny'; sessionId?: string } }
      ).payload;
      handleToolConfirmResult(
        connectionCtx,
        id,
        decision,
        (msg as { payload: { sessionId?: string } }).payload.sessionId,
      );
    },
    'webui.shutdown': () => {
      console.log('[WebUI] Shutdown requested from client');
      shutdown();
    },

    // ── Providers / keys ──
    'providers.list': (_msg, ws) => handleProvidersList(wsHandlerCtx, ws),
    'provider.models': (msg, ws) =>
      handleProviderModels(
        wsHandlerCtx,
        ws,
        (msg as { payload: { providerId: string } }).payload.providerId,
      ),
    'providers.saved': (_msg, ws) => handleProvidersSaved(wsHandlerCtx, ws),
    'key.add': (msg, ws) => {
      const m = msg as { payload: { providerId: string; label: string; apiKey: string } };
      handleKeyUpsert(wsHandlerCtx, ws, m.payload.providerId, m.payload.label, m.payload.apiKey);
    },
    'key.update': (msg, ws) => {
      const m = msg as { payload: { providerId: string; label: string; apiKey: string } };
      handleKeyUpsert(wsHandlerCtx, ws, m.payload.providerId, m.payload.label, m.payload.apiKey);
    },
    'key.delete': (msg, ws) => {
      const m = msg as { payload: { providerId: string; label: string } };
      handleKeyDelete(wsHandlerCtx, ws, m.payload.providerId, m.payload.label);
    },
    'key.set_active': (msg, ws) => {
      const m = msg as { payload: { providerId: string; label: string } };
      handleKeySetActive(wsHandlerCtx, ws, m.payload.providerId, m.payload.label);
    },
    'provider.add': (msg, ws) =>
      handleProviderAdd(
        wsHandlerCtx,
        ws,
        (msg as { payload: { id: string; family: string; baseUrl?: string; apiKey?: string } })
          .payload,
      ),
    'provider.remove': (msg, ws) =>
      handleProviderRemove(
        wsHandlerCtx,
        ws,
        (msg as { payload: { providerId: string } }).payload.providerId,
      ),
    'provider.clear_models': (msg, ws) =>
      handleProviderClearModels(
        wsHandlerCtx,
        ws,
        (msg as { payload: { providerId: string } }).payload.providerId,
      ),
    'provider.undo_clear': (msg, ws) => {
      const m = msg as { payload: { providerId: string; previousModels: string[] } };
      handleProviderUndoClear(wsHandlerCtx, ws, m.payload.providerId, m.payload.previousModels);
    },
    'provider.update': (msg, ws) =>
      handleProviderUpdate(
        wsHandlerCtx,
        ws,
        (
          msg as {
            payload: {
              id: string;
              family?: string;
              baseUrl?: string;
              envVars?: string[];
              models?: string[];
            };
          }
        ).payload,
      ),
    'provider.probe': (msg, ws) => {
      const m = msg as { payload: { providerId: string; timeoutMs?: number } };
      handleProviderProbe(wsHandlerCtx, ws, m.payload.providerId, m.payload.timeoutMs);
    },

    // ── Subscription OAuth login (ChatGPT / Claude / Copilot) ──
    'auth.oauth.start': (msg, ws) => {
      const kind = oauthKindOf(msg);
      if (kind) void handleOAuthStart(wsHandlerCtx, ws, kind);
    },
    'auth.oauth.code': (msg, ws) => {
      const kind = oauthKindOf(msg);
      const input = (msg as { payload?: { input?: unknown } }).payload?.input;
      if (kind && typeof input === 'string' && input.trim()) {
        void handleOAuthCode(wsHandlerCtx, ws, kind, input);
      }
    },
    'auth.oauth.cancel': (msg, ws) => {
      const kind = oauthKindOf(msg);
      if (kind) handleOAuthCancel(wsHandlerCtx, ws, kind);
    },

    // ── Todos / goals / plans / tasks ──
    'todos.get': (_msg, ws) => handleTodosGet(worklistCtx, ws),
    'todos.clear': (_msg, ws) => handleTodosClear(worklistCtx, ws),
    'todos.remove': (msg, ws) =>
      handleTodosRemove(
        worklistCtx,
        ws,
        msg.payload as { id?: string; index?: number } | undefined,
      ),
    'todo.update': (msg, ws) =>
      handleTodoUpdate(
        worklistCtx,
        ws,
        msg.payload as { id: string; status?: TodoItem['status']; activeForm?: string },
      ),
    'goal.get': (_msg, ws) => handleGoalGet(sessionsCtx, ws),
    'plan.get': (_msg, ws) => handlePlanGet(worklistCtx, ws),
    'plan.template_use': (msg, ws) =>
      handlePlanTemplateUse(
        worklistCtx,
        ws,
        (msg as { payload: { template: string } }).payload.template,
      ),
    'plan.item.update': (msg, ws) =>
      handlePlanItemUpdate(
        worklistCtx,
        ws,
        msg.payload as { target: string; status: 'open' | 'in_progress' | 'done' },
      ),
    'tasks.get': (_msg, ws) => handleTasksGet(worklistCtx, ws),
    'task.update': (msg, ws) =>
      handleTaskUpdate(
        worklistCtx,
        ws,
        msg.payload as {
          id: string;
          status: 'pending' | 'in_progress' | 'blocked' | 'failed' | 'review' | 'completed';
        },
      ),

    // ── Sessions ──
    'sessions.list': (msg, ws) =>
      handleSessionsList(
        sessionsCtx,
        ws,
        (msg as { payload?: { limit?: number } }).payload?.limit ?? 50,
      ),
    'session.new': (_msg, ws) => handleSessionNew(sessionsCtx, ws),
    'session.delete': (msg, ws) =>
      handleSessionDelete(sessionsCtx, ws, (msg as { payload: { id: string } }).payload.id),
    'session.save': (_msg, ws) => handleSessionSave(sessionsCtx, ws),
    'session.resume': (msg, ws) =>
      handleSessionResume(sessionsCtx, ws, (msg as { payload: { id: string } }).payload.id),
    'session.checkpoints': (_msg, ws) => handleSessionCheckpoints(sessionsCtx, ws),
    'session.rewind': (msg, ws) =>
      handleSessionRewind(
        sessionsCtx,
        ws,
        (msg as { payload: { checkpointIndex: number } }).payload.checkpointIndex,
      ),

    // ── Context ──
    'context.clear': (_msg, ws) => handleContextClear(contextHandlerCtx, ws),
    'context.debug': (_msg, ws) => handleContextDebug(contextHandlerCtx, ws),
    'context.compact': (msg, ws) =>
      handleContextCompact(
        contextHandlerCtx,
        ws,
        !!(msg as { payload?: { aggressive?: boolean } }).payload?.aggressive,
      ),
    'context.repair': (_msg, ws) => handleContextRepair(contextHandlerCtx, ws),
    'context.modes.list': (_msg, ws) => handleContextModesList(contextHandlerCtx, ws),
    'context.mode.switch': (msg, ws) =>
      handleContextModeSwitch(
        contextHandlerCtx,
        ws,
        (msg as { payload: { id: string } }).payload.id,
      ),
    'context.mode.create': (msg, ws) =>
      handleContextModeCreate(
        contextHandlerCtx,
        ws,
        (
          msg as {
            payload: {
              id: string;
              name: string;
              description: string;
              thresholds: { warn: number; soft: number; hard: number };
              preserveK: number;
              eliseThreshold: number;
            };
          }
        ).payload,
      ),
    'context.mode.update': (msg, ws) =>
      handleContextModeUpdate(
        contextHandlerCtx,
        ws,
        (
          msg as {
            payload: {
              id: string;
              name?: string;
              description?: string;
              thresholds?: { warn?: number; soft?: number; hard?: number };
              preserveK?: number;
              eliseThreshold?: number;
            };
          }
        ).payload,
      ),
    'context.mode.delete': (msg, ws) =>
      handleContextModeDelete(
        contextHandlerCtx,
        ws,
        (msg as { payload: { id: string } }).payload.id,
      ),

    // ── Agent config: modes / models ──
    'modes.list': (_msg, ws) => handleModesList(agentConfigCtx, ws),
    'mode.switch': (msg, ws) =>
      handleModeSwitch(agentConfigCtx, ws, (msg as { payload: { id: string } }).payload.id),
    'model.switch': (msg, ws) =>
      handleModelSwitch(
        agentConfigCtx,
        ws,
        (msg as { payload: { provider: string; model: string } }).payload,
      ),
    'model.refine': (msg, ws) =>
      handleModelRefine(agentConfigCtx, ws, (msg as { payload: { text: string } }).payload.text),

    // ── Process management ──
    'process.list': (_msg, ws) => handleProcessList(wsCommon, ws),
    'process.kill': (msg, ws) =>
      handleProcessKill(wsCommon, ws, (msg as { payload: { pid: number } }).payload.pid),
    'process.killAll': (_msg, ws) => handleProcessKillAll(wsCommon, ws),

    // ── Diagnostics / introspection ──
    'diag.get': (_msg, ws) => handleDiagGet(introspectionCtx, ws),
    'stats.get': (_msg, ws) => handleStatsGet(introspectionCtx, ws),
    'side_effects.list': (_msg, ws) => {
      const sideEffects = opts.agent.ctx.sideEffects ?? [];
      send(ws, {
        type: 'side_effects',
        payload: sessionPayload({
          sideEffects: sideEffects.slice(-50).map((se) => ({
            toolUseId: se.toolUseId,
            toolName: se.toolName,
            ts: se.ts,
            input: se.input,
            outcome: se.outcome,
            risk: se.risk,
          })),
        }),
      });
    },
    'tools.list': (_msg, ws) => handleToolsList(introspectionCtx, ws),

    // ── Autonomy ──
    'autonomy.switch': (msg, ws) =>
      handleAutonomySwitch(prefsCtx, ws, (msg as { payload: { mode: string } }).payload.mode),

    // ── Brain ──
    'brain.status': (_msg, ws) => handleBrainStatus(brainCtx, ws),
    'brain.risk': (msg, ws) =>
      handleBrainRisk(brainCtx, ws, (msg as { payload?: { level?: string } }).payload?.level ?? ''),
    'brain.ask': (msg, ws) =>
      handleBrainAsk(brainCtx, ws, (msg as { payload?: { question?: string } }).payload?.question),

    // ── Preferences ──
    'prefs.get': (_msg, ws) => handlePrefsGet(prefsCtx, ws),
    'prefs.update': (msg, ws) =>
      handlePrefsUpdate(prefsCtx, ws, (msg as { payload: Record<string, unknown> }).payload),

    // ── File operations (delegated to shared file-handlers.ts) ──
    'files.list': (msg, ws) => handleFilesList(ws, msg, projectRootFor()),
    'files.tree': (msg, ws) => handleFilesTree(ws, msg, projectRootFor()),
    'files.read': (msg, ws) => handleFilesRead(ws, msg, projectRootFor()),
    'files.write': (msg, ws) => handleFilesWrite(ws, msg, projectRootFor()),
    'completion.request': (msg, ws) =>
      handleCompletionRequest(ws, msg, {
        projectRoot: projectRootFor(),
        provider: opts.agent.ctx.provider,
        model: opts.agent.ctx.model,
        indexDir:
          typeof opts.agent.ctx.meta['codebaseIndexDir'] === 'string'
            ? opts.agent.ctx.meta['codebaseIndexDir']
            : undefined,
        lspCompletion: createToolLspCompletionSource(
          opts.agent.ctx.tools.find((tool) => tool.name === 'lsp_completion'),
          opts.agent.ctx,
        ),
      }),

    // ── Memory (guarded — opts.memoryStore may be undefined) ──
    'memory.list': (_msg, ws) => {
      if (!opts.memoryStore) {
        send(ws, {
          type: 'memory.list',
          payload: { text: '', error: 'Memory store not available' },
        });
        return;
      }
      return handleMemoryList(ws, opts.memoryStore);
    },
    'memory.remember': (msg, ws) => {
      if (!opts.memoryStore) {
        sendResult(ws, false, 'Memory store not available');
        return;
      }
      return handleMemoryRemember(ws, msg, opts.memoryStore);
    },
    'memory.forget': (msg, ws) => {
      if (!opts.memoryStore) {
        sendResult(ws, false, 'Memory store not available');
        return;
      }
      return handleMemoryForget(ws, msg, opts.memoryStore);
    },

    // ── MCP operations (shared handlers from @wrongstack/webui/server) ──
    'mcp.list': (msg, ws) => handleMcpList(ws, msg, opts.globalConfigPath ?? '', opts.mcpRegistry),
    'mcp.add': (msg, ws) => handleMcpAdd(ws, msg, opts.globalConfigPath ?? '', opts.mcpRegistry),
    'mcp.remove': (msg, ws) =>
      handleMcpRemove(ws, msg, opts.globalConfigPath ?? '', opts.mcpRegistry),
    'mcp.update': (msg, ws) =>
      handleMcpUpdate(ws, msg, opts.globalConfigPath ?? '', opts.mcpRegistry),
    'mcp.wake': (msg, ws) => handleMcpWake(ws, msg, opts.globalConfigPath ?? '', opts.mcpRegistry),
    'mcp.sleep': (msg, ws) =>
      handleMcpSleep(ws, msg, opts.globalConfigPath ?? '', opts.mcpRegistry),
    'mcp.discover': (msg, ws) =>
      handleMcpDiscover(ws, msg, opts.globalConfigPath ?? '', opts.mcpRegistry),
    'mcp.enable': (msg, ws) =>
      handleMcpEnable(ws, msg, opts.globalConfigPath ?? '', opts.mcpRegistry),
    'mcp.disable': (msg, ws) =>
      handleMcpDisable(ws, msg, opts.globalConfigPath ?? '', opts.mcpRegistry),
    'mcp.restart': (msg, ws) =>
      handleMcpRestart(ws, msg, opts.globalConfigPath ?? '', opts.mcpRegistry),

    // ── Skills ──
    'skills.list': (_msg, ws) => handleSkillsList(introspectionCtx, ws),
    'skills.content': (msg, ws) => handleSkillsContent(ws, skillsCtx, msg),
    'skills.install': (msg, ws) => handleSkillsInstall(ws, skillsCtx, msg),
    'skills.uninstall': (msg, ws) => handleSkillsUninstall(ws, skillsCtx, msg),
    'skills.update': (msg, ws) => handleSkillsUpdate(ws, skillsCtx, msg),
    'skills.create': (msg, ws) => handleSkillsCreate(ws, skillsCtx, msg),
    'skills.edit': (msg, ws) => handleSkillsEdit(ws, skillsCtx, msg),
    'skills.export': (_msg, ws) => handleSkillsExport(ws, skillsCtx),

    // ── Prompt library ──
    'prompts.list': (_msg, ws) => handlePromptsList(ws, promptsCtx),
    'prompts.search': (msg, ws) => handlePromptsSearch(ws, promptsCtx, msg),
    'prompts.content': (msg, ws) => handlePromptsContent(ws, promptsCtx, msg),
    'prompts.favorite': (msg, ws) => handlePromptsFavorite(ws, promptsCtx, msg),
    'prompts.create': (msg, ws) => handlePromptsCreate(ws, promptsCtx, msg),
    'prompts.used': (msg, ws) => handlePromptsUsed(ws, promptsCtx, msg),
    'prompts.recent': (_msg, ws) => handlePromptsRecent(ws, promptsCtx),

    // ── Design Studio ──
    'design.list': (_msg, ws) => handleDesignList(ws, designCtx),
    'design.use': (msg, ws) => handleDesignUse(ws, designCtx, msg),
    'design.state': (_msg, ws) => handleDesignState(ws, designCtx),
    'design.set': (msg, ws) => handleDesignSet(ws, designCtx, msg),
    'design.materialize': (msg, ws) => handleDesignMaterialize(ws, designCtx, msg),
    'design.verify': (_msg, ws) => handleDesignVerify(ws, designCtx),

    // ── Projects / working dir ──
    'projects.list': (_msg, ws) => handleProjectsList(projectsCtx, ws),
    'projects.select': (msg, ws) =>
      handleProjectsSelect(
        projectsCtx,
        ws,
        (msg as { payload: { root: string; name?: string } }).payload,
      ),
    'projects.add': (msg, ws) =>
      handleProjectsAdd(
        projectsCtx,
        ws,
        (msg as { payload: { root: string; name?: string } }).payload,
      ),
    'working_dir.set': (msg, ws) =>
      handleWorkingDirSet(projectsCtx, ws, (msg as { payload: { path: string } }).payload.path),

    // ── Git ──
    'git.changes': (_msg, ws) => handleGitChanges(ws, projectRootFor()),
    'git.diff': (msg, ws) =>
      handleGitDiff(
        ws,
        projectRootFor(),
        (msg as { payload?: { path?: string } }).payload?.path ?? '',
      ),
    'git.info': (_msg, ws) => handleGitInfo(ws, projectRootFor()),

    // ── Shell ──
    'shell.open': async (msg, ws) => {
      const result = await handleShellOpen(
        msg.payload as Parameters<typeof handleShellOpen>[0],
        consoleLogger,
      );
      sendResult(ws, result.success, result.message);
    },

    // ── Mailbox ──
    'mailbox.messages': (msg, ws) =>
      handleMailboxMessages(mailboxCtx, msg as Parameters<typeof handleMailboxMessages>[1], ws),
    'mailbox.agents': (msg, ws) =>
      handleMailboxAgents(mailboxCtx, msg as Parameters<typeof handleMailboxAgents>[1], ws),
    'mailbox.clear': (_msg, ws) => handleMailboxClear(mailboxCtx, ws),
    'mailbox.purge': (msg, ws) =>
      handleMailboxPurge(mailboxCtx, msg as Parameters<typeof handleMailboxPurge>[1], ws),

    // ── Silent no-ops (standalone server wires real handlers) ──
    'collab.join': noop,
    'collab.leave': noop,
    'collab.annotate': noop,
    'collab.resolve': noop,
    'collab.request_pause': noop,
    'collab.resume': noop,
    'collab.grant_control': noop,
    'collab.inject_tool': noop,
    'terminal.create': noop,
    'terminal.input': noop,
    'terminal.resize': noop,
    'terminal.close': noop,
  };

  return async function handleMessage(
    ws: WebSocket,
    _client: ConnectedClient,
    msg: WSClientMessage,
  ): Promise<void> {
    if (!ensureRouteSession(ws, msg)) return;
    const handler = wsRoutes[msg.type];
    if (handler) {
      await handler(msg, ws);
      return;
    }
    // ── Prefix-based fallback for delegated handlers ──
    const msgType = (msg as { type: string }).type;
    if (msgType.startsWith('autophase.')) {
      await autoPhaseHandler.handleMessage(
        msg as { type: string; payload?: Record<string, unknown> },
      );
    } else if (msgType.startsWith('specs.')) {
      await specsHandler.handleMessage(msg as { type: string; payload?: Record<string, unknown> });
    } else if (msgType.startsWith('sdd.board.')) {
      await sddBoardHandler.handleMessage(
        msg as { type: string; payload?: Record<string, unknown> },
      );
    } else if (msgType.startsWith('sdd.spec.') || msgType.startsWith('sdd.run.')) {
      await sddWizardHandler?.handleMessage(
        msg as { type: string; payload?: Record<string, unknown> },
      );
    } else if (msgType.startsWith('worktree.')) {
      await worktreeHandler.handleMessage(msg as { type: string; payload?: Record<string, unknown> });
    } else {
      console.debug(`[WebUI] Unhandled message type: ${msgType}`);
    }
  };
}
