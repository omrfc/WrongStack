import type { EventBus, Context } from '@wrongstack/core';
import type { WebSocket } from 'ws';
import type { ConnectedClient, WSServerMessage } from './types.js';

import * as path from 'node:path';

export interface SetupEventsDeps {
  events: EventBus;
  broadcast: (clients: Map<WebSocket, ConnectedClient>, msg: WSServerMessage) => void;
  clients: Map<WebSocket, ConnectedClient>;
  config: { tools?: { maxIterations?: number | undefined } };
  context: Context;
  pendingConfirms: Map<string, (d: 'yes' | 'no' | 'always' | 'deny') => void>;
  /** Optional global config dir (~/.wrongstack) — enables SessionRegistry poll for fleet view. */
  globalConfigPath?: string | undefined;
}

export function setupEvents(deps: SetupEventsDeps): void {
  const { events, broadcast, clients, config, context, pendingConfirms, globalConfigPath } = deps;

  events.on('iteration.started', (e) => {
    // Read maxIterations from context.meta so the UI reflects the
    // webui setting, falling back to the startup config default.
    const maxIt = typeof context.meta['maxIterations'] === 'number'
      ? context.meta['maxIterations']
      : config.tools?.maxIterations ?? 100;
    broadcast(clients, {
      type: 'iteration.started',
      payload: { index: e.index, maxIterations: maxIt },
    });
  });

  events.on('provider.text_delta', (e) => {
    broadcast(clients, { type: 'provider.text_delta', payload: { text: e.text, messageId: 'current' } });
  });

  events.on('provider.thinking_delta', (e) => {
    broadcast(clients, { type: 'provider.thinking_delta', payload: { text: e.text } });
  });

  events.on('tool.started', (e) => {
    broadcast(clients, {
      type: 'tool.started',
      payload: { id: e.id, name: e.name, input: e.input, messageId: `tool_${e.id}` },
    });
  });

  events.on('tool.progress', (e) => {
    broadcast(clients, {
      type: 'tool.progress',
      payload: { id: e.id, name: e.name, eventType: e.event.type, text: e.event.text },
    });
  });

  events.on('tool.executed', (e) => {
    broadcast(clients, {
      type: 'tool.executed',
      payload: { id: e.id, name: e.name, durationMs: e.durationMs, ok: e.ok, input: e.input, output: e.output },
    });
    broadcast(clients, { type: 'todos.updated', payload: { todos: [...context.todos] } });

    // Broadcast task/plan updates after task/plan/todo tool executions.
    if (e.name === 'task' || e.name === 'plan' || e.name === 'todo') {
      void (async () => {
        try {
          const taskPath = (context.meta as Record<string, unknown>)['task.path'];
          if (typeof taskPath === 'string' && taskPath) {
            const { loadTasks } = await import('@wrongstack/core');
            const file = await loadTasks(taskPath);
            broadcast(clients, { type: 'tasks.updated', payload: { tasks: file?.tasks ?? [] } });
          }
        } catch { /* best-effort */ }
        try {
          const planPath = (context.meta as Record<string, unknown>)['plan.path'];
          if (typeof planPath === 'string' && planPath) {
            const { loadPlan } = await import('@wrongstack/core');
            const plan = await loadPlan(planPath);
            broadcast(clients, { type: 'plan.updated', payload: { plan: plan ?? { version: 1, sessionId: context.session?.id ?? '', updatedAt: new Date().toISOString(), items: [] } } });
          }
        } catch { /* best-effort */ }
      })();
    }
  });

  events.on('provider.response', (e) => {
    broadcast(clients, { type: 'provider.response', payload: { usage: e.usage, stopReason: e.stopReason, messageId: 'current' } });
  });

  events.on('context.repaired', (e) => {
    broadcast(clients, { type: 'context.repaired', payload: { removedToolUses: e.removedToolUses, removedToolResults: e.removedToolResults, removedMessages: e.removedMessages } });
  });

  events.on('tool.confirm_needed', (e) => {
    const id = e.toolUseId ?? `confirm_${Date.now()}`;
    pendingConfirms.set(id, e.resolve);
    broadcast(clients, { type: 'tool.confirm_needed', payload: { id, toolName: e.tool?.name ?? 'unknown', input: e.input, suggestedPattern: e.suggestedPattern } });
  });

  events.on('error', (e) => {
    broadcast(clients, { type: 'error', payload: { phase: e.phase, message: e.err instanceof Error ? e.err.message : String(e.err) } });
  });

  // Subagent fleet lifecycle
  const forwardSubagent = (kind: string, payload: Record<string, unknown>) =>
    broadcast(clients, { type: 'subagent.event', payload: { kind, sessionId: context.session.id, ...payload } });

  events.on('subagent.spawned', (e) => forwardSubagent('spawned', { subagentId: e.subagentId, taskId: e.taskId, name: e.name, provider: e.provider, model: e.model, description: e.description }));
  events.on('subagent.task_started', (e) => forwardSubagent('task_started', { subagentId: e.subagentId, taskId: e.taskId, description: e.description }));
  events.on('subagent.tool_executed', (e) => forwardSubagent('tool_executed', { subagentId: e.subagentId, toolName: e.name, durationMs: e.durationMs, ok: e.ok }));
  events.on('subagent.iteration_summary', (e) => forwardSubagent('iteration_summary', { subagentId: e.subagentId, iteration: e.iteration, toolCalls: e.toolCalls, costUsd: e.costUsd, currentTool: e.currentTool, partialText: e.partialText }));
  events.on('subagent.budget_extended', (e) => forwardSubagent('budget_extended', { subagentId: e.subagentId, totalExtensions: e.totalExtensions }));
  events.on('subagent.ctx_pct', (e) => forwardSubagent('ctx_pct', { subagentId: e.subagentId, load: e.load, tokens: e.tokens, maxContext: e.maxContext }));
  events.on('subagent.task_completed', (e) => forwardSubagent('task_completed', { subagentId: e.subagentId, status: e.status, iterations: e.iterations, toolCalls: e.toolCalls, finalText: (e as Record<string, unknown>).finalText as string | undefined, error: e.error ? { kind: e.error.kind, message: e.error.message } : undefined }));

  // ── Leader (main session) events — forwarded as subagent.event with subagentId 'leader' ──
  // These give the AgentsPage a live leader row with real-time tool tracking,
  // context pressure — matching the TUI's leader entry.
  // Iteration counts, cost, and overall status come from the sessionStore on the frontend.

  // Leader spawned: sent on first iteration so the frontend creates the leader row.
  let leaderSpawned = false;
  events.on('iteration.started', () => {
    if (!leaderSpawned) {
      leaderSpawned = true;
      const provider = (context.provider as { id?: string } | undefined)?.id ?? 'unknown';
      forwardSubagent('spawned', {
        subagentId: 'leader',
        name: 'LEADER',
        provider,
        model: context.model,
        description: `Main agent session (${context.session.id})`,
      });
    }
  });

  // Leader tool execution: emitted on every tool.executed in the main session.
  events.on('tool.executed', (e) => {
    forwardSubagent('tool_executed', {
      subagentId: 'leader',
      toolName: e.name,
      durationMs: e.durationMs,
      ok: e.ok,
    });
  });

  // Leader context pressure + cost: emitted on every provider response.
  events.on('provider.response', (e) => {
    if (e.usage?.input != null) {
      const maxCtx = context.provider.capabilities.maxContext;
      const pct = maxCtx > 0 ? e.usage.input / maxCtx : 0;
      const costUsd = context.tokenCounter.estimateCost().total;
      forwardSubagent('ctx_pct', {
        subagentId: 'leader',
        load: pct,
        tokens: e.usage.input,
        maxContext: maxCtx,
        costUsd,
      });
    }
  });

  // Leader iteration updates: we already track iteration started above.
  // The frontend uses sessionStore for accurate cost/iteration counts.
  // When the run completes, the frontend's run.result handler resets isLoading,
  // making the leader go idle. We reset leader state on iteration.started.
  events.on('iteration.completed', () => {
    // Respawn leader if it was cleared (e.g., on session resume).
    if (!leaderSpawned) {
      leaderSpawned = true;
      const provider = (context.provider as { id?: string } | undefined)?.id ?? 'unknown';
      forwardSubagent('spawned', {
        subagentId: 'leader',
        name: 'LEADER',
        provider,
        model: context.model,
        description: `Main agent session (${context.session.id})`,
      });
    }
  });

  // ── Mailbox events — broadcast to WebUI for real-time per-project visibility ──
  events.onPattern('mailbox.*', (eventName, payload) => {
    broadcast(clients, { type: 'mailbox.event', payload: { event: eventName, ...payload as Record<string, unknown> } });
  });

  // ── Cross-process session / fleet status poll ──
  // Periodically read the SessionRegistry and broadcast live session+agent status
  // to all connected clients. Gives the AgentFlowViz a project-level overview of
  // how many sessions are active, what agents are doing, costs, and context usage.
  const globalRoot = globalConfigPath ? path.dirname(globalConfigPath) : undefined;
  if (globalRoot) {
    const statusInterval = setInterval(async () => {
      try {
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
            agents: (s.agents ?? []).map((a) => ({
              id: a.id,
              name: a.name,
              status: a.status,
              currentTool: a.currentTool,
              iterations: a.iterations,
              toolCalls: a.toolCalls,
              lastActivityAt: a.lastActivityAt,
            })),
          }));
        broadcast(clients, { type: 'sessions.status_update', payload: { sessions: live } });
      } catch {
        // Best-effort — never crash for status polling errors
      }
    }, 5_000);
    if (statusInterval.unref) statusInterval.unref();
  }
}
