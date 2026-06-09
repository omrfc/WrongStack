import type { EventBus, Context } from '@wrongstack/core';
import type { WebSocket } from 'ws';
import type { ConnectedClient, WSServerMessage } from './types.js';

export interface SetupEventsDeps {
  events: EventBus;
  broadcast: (clients: Map<WebSocket, ConnectedClient>, msg: WSServerMessage) => void;
  clients: Map<WebSocket, ConnectedClient>;
  config: { tools?: { maxIterations?: number | undefined } };
  context: Context;
  pendingConfirms: Map<string, (d: 'yes' | 'no' | 'always' | 'deny') => void>;
}

export function setupEvents(deps: SetupEventsDeps): void {
  const { events, broadcast, clients, config, context, pendingConfirms } = deps;

  events.on('iteration.started', (e) => {
    broadcast(clients, {
      type: 'iteration.started',
      payload: { index: e.index, maxIterations: config.tools?.maxIterations ?? 100 },
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
    broadcast(clients, { type: 'subagent.event', payload: { kind, ...payload } });

  events.on('subagent.spawned', (e) => forwardSubagent('spawned', { subagentId: e.subagentId, taskId: e.taskId, name: e.name, provider: e.provider, model: e.model, description: e.description }));
  events.on('subagent.task_started', (e) => forwardSubagent('task_started', { subagentId: e.subagentId, taskId: e.taskId, description: e.description }));
  events.on('subagent.tool_executed', (e) => forwardSubagent('tool_executed', { subagentId: e.subagentId, toolName: e.name, durationMs: e.durationMs, ok: e.ok }));
  events.on('subagent.iteration_summary', (e) => forwardSubagent('iteration_summary', { subagentId: e.subagentId, iteration: e.iteration, toolCalls: e.toolCalls, costUsd: e.costUsd, currentTool: e.currentTool, partialText: e.partialText }));
  events.on('subagent.budget_extended', (e) => forwardSubagent('budget_extended', { subagentId: e.subagentId, totalExtensions: e.totalExtensions }));
  events.on('subagent.ctx_pct', (e) => forwardSubagent('ctx_pct', { subagentId: e.subagentId, load: e.load, tokens: e.tokens, maxContext: e.maxContext }));
  events.on('subagent.task_completed', (e) => forwardSubagent('task_completed', { subagentId: e.subagentId, status: e.status, iterations: e.iterations, toolCalls: e.toolCalls, finalText: (e as Record<string, unknown>).finalText as string | undefined, error: e.error ? { kind: e.error.kind, message: e.error.message } : undefined }));
}
