import { expectDefined } from '@wrongstack/core';
import { toast } from '@/components/Toaster';
import { playCompletionChime, playPermissionChime } from '@/lib/chime';
import { setFaviconStatus } from '@/lib/favicon';
import { ensureNotificationPermission, notifyIfHidden } from '@/lib/notify';
import { getWSClient } from '@/lib/ws-client';
import { streamCoalescer } from '@/lib/stream-coalescer';
import { useChatStore, useConfigStore, useSessionStore, useUIStore } from '@/stores';
import { useVizStore, wsToVizEvent } from '@/stores/viz-store';
import type { WSServerMessage } from '@/types';

function pipeViz(msg: WSServerMessage) {
  const vizEv = wsToVizEvent(msg.type, msg.payload as Record<string, unknown>);
  if (vizEv) {
    useVizStore.getState().pushEvent(vizEv);
    useVizStore.getState().setActive(true);
  }
}

export const chatHandlers = {
  handleIterationStarted,
  handleTextDelta,
  handleThinkingDelta,
  handleToolStarted,
  handleToolProgress,
  handleToolExecuted,
  handleToolConfirmNeeded,
  handleRunResult,
};

export const chatHandlerMap: Partial<Record<string, (msg: WSServerMessage) => void>> = {
  'iteration.started': handleIterationStarted,
  'provider.text_delta': handleTextDelta,
  'provider.thinking_delta': handleThinkingDelta,
  'tool.started': handleToolStarted,
  'tool.progress': handleToolProgress,
  'tool.executed': handleToolExecuted,
  'tool.confirm_needed': handleToolConfirmNeeded,
  'run.result': handleRunResult,
};

export function handleIterationStarted(msg: WSServerMessage) {
  pipeViz(msg);
  const payload = msg.payload as { index: number; maxIterations?: number | undefined };
  useSessionStore.getState().setIteration({ index: payload.index, max: payload.maxIterations ?? 0 });
  useChatStore.getState().setLoading(true);
  if (typeof document !== 'undefined' && document.hidden) setFaviconStatus('running');
  if (useChatStore.getState().runStart === null) {
    useChatStore.getState().setRunStart({ at: Date.now(), cost: useSessionStore.getState().cost });
  }
  useChatStore.getState().setCurrentAssistantMessage(null);
}

export function handleTextDelta(msg: WSServerMessage) {
  pipeViz(msg);
  const payload = msg.payload as { text: string; messageId: string };
  useChatStore.getState().clearThinking();
  streamCoalescer.drop('__thinking__');
  let id = useChatStore.getState().currentAssistantMessageId;
  if (!id) {
    id = useChatStore.getState().addMessage({ role: 'assistant', content: '', streaming: true });
    useChatStore.getState().setCurrentAssistantMessage(id);
  }
  streamCoalescer.push(id, payload.text, (mid, text) =>
    useChatStore.getState().appendToMessage(mid, text),
  );
}

export function handleThinkingDelta(msg: WSServerMessage) {
  pipeViz(msg);
  const payload = msg.payload as { text: string };
  if (!payload.text) return;
  streamCoalescer.push('__thinking__', payload.text, (_k, text) =>
    useChatStore.getState().appendThinking(text),
  );
}

export function handleToolStarted(msg: WSServerMessage) {
  pipeViz(msg);
  const payload = msg.payload as { id: string; name: string; input?: unknown | undefined; messageId: string };
  const existingId = useChatStore.getState().getToolMessageId(payload.id);
  if (existingId) { useChatStore.getState().setCurrentToolId(existingId); return; }
  useChatStore.getState().clearThinking();
  streamCoalescer.drop('__thinking__');
  useChatStore.getState().setCurrentAssistantMessage(null);
  const id = useChatStore.getState().addMessage({ role: 'tool', content: '', toolName: payload.name, toolInput: payload.input, toolUseId: payload.id });
  useChatStore.getState().setCurrentToolId(id);
  useChatStore.getState().addExecution({ id: payload.id, name: payload.name, input: payload.input, ok: true, startedAt: Date.now() });
}

export function handleToolProgress(msg: WSServerMessage) {
  const payload = msg.payload as { id: string; name: string; event: { type: string; text?: string | undefined } };
  const text = (payload.event?.text ?? '').trim();
  if (!text) return;
  const ownerId = useChatStore.getState().getToolMessageId(payload.id);
  if (!ownerId) return;
  const prefix = payload.event?.type === 'warning' ? '⚠ ' : '';
  streamCoalescer.push(ownerId, `${prefix}${text}\n`, (_oid, buffered) =>
    useChatStore.getState().appendToolProgressLinesByUseId(
      payload.id,
      buffered.split('\n').filter((l) => l.length > 0),
    ),
  );
}

export function handleToolExecuted(msg: WSServerMessage) {
  pipeViz(msg);
  const payload = msg.payload as { id?: string | undefined; name: string; durationMs: number; ok: boolean; input?: unknown | undefined; output?: string | undefined };
  const { currentToolId } = useChatStore.getState();
  const ownerId = payload.id ? useChatStore.getState().getToolMessageId(payload.id) : currentToolId;
  if (ownerId) {
    streamCoalescer.drop(ownerId);
    if (payload.id) {
      useChatStore.getState().setToolResultByUseId(payload.id, payload.output ?? '', payload.ok);
    } else {
      useChatStore.getState().setToolResult(ownerId, payload.output ?? '', payload.ok);
    }
    useChatStore.getState().updateMessage(ownerId, { toolDurationMs: payload.durationMs });
  }
  if (payload.id) useChatStore.getState().updateExecution(payload.id, { completedAt: Date.now(), durationMs: payload.durationMs, output: payload.output, ok: payload.ok });
  if (currentToolId && ownerId === currentToolId) useChatStore.getState().setCurrentToolId(null);
}

export function handleToolConfirmNeeded(msg: WSServerMessage) {
  const payload = msg.payload as { id: string; toolName: string; input: unknown; suggestedPattern: string };
  useUIStore.getState().showConfirm({ id: payload.id, toolName: payload.toolName, input: payload.input, suggestedPattern: payload.suggestedPattern });
  try { playPermissionChime(); } catch { /* audio policy */ }
  void ensureNotificationPermission();
  const label = useSessionStore.getState().projectName || 'Agent';
  notifyIfHidden(`${label} needs approval`, `Tool "${payload.toolName}" is waiting for your decision.`, 'agent-confirm');
  if (typeof document !== 'undefined' && document.hidden) setFaviconStatus('attention');
}

export function handleRunResult(msg: WSServerMessage) {
  const payload = msg.payload as { status: string; iterations: number; finalText?: string | undefined; error?: { code: string | undefined; message: string; recoverable: boolean } };
  streamCoalescer.flushAll();
  useSessionStore.getState().setIteration(null);
  useChatStore.getState().setLoading(false);
  useChatStore.getState().setCurrentAssistantMessage(null);
  useChatStore.getState().clearThinking();
  const runStart = useChatStore.getState().runStart;
  if (runStart && payload.status === 'done') {
    const all = useChatStore.getState().messages;
    let lastAssistantIdx = -1;
    let toolCount = 0;
    for (let i = all.length - 1; i >= 0; i--) {
      const m = expectDefined(all[i]);
      if (m.role === 'assistant' && lastAssistantIdx === -1 && m.content) lastAssistantIdx = i;
      if (m.role === 'tool' && m.timestamp >= runStart.at) toolCount += 1;
      if (m.role === 'user' && m.timestamp <= runStart.at) break;
    }
    if (lastAssistantIdx !== -1) {
      const sessionCost = useSessionStore.getState().cost;
      useChatStore.getState().updateMessage(all[lastAssistantIdx]?.id, { runSummary: { iterations: payload.iterations, tools: toolCount, durationMs: Date.now() - runStart.at, costDelta: Math.max(0, sessionCost - runStart.cost) } });
    }
  }
  useChatStore.getState().setRunStart(null);
  if (payload.status !== 'done' && payload.error) {
    useChatStore.getState().addMessage({ role: 'assistant', content: `Error: ${payload.error.message}`, isError: true });
    toast.error(`Run ended: ${payload.error.message}`);
    notifyIfHidden(`${useSessionStore.getState().projectName || 'Agent'} run failed`, payload.error.message);
    if (typeof document !== 'undefined' && document.hidden) setFaviconStatus('error');
  } else if (payload.status === 'done') {
    if (typeof document !== 'undefined' && document.hidden) {
      toast.success(`Run completed in ${payload.iterations} iteration${payload.iterations === 1 ? '' : 's'}`);
      notifyIfHidden(`${useSessionStore.getState().projectName || 'Agent'} run finished`, `Completed in ${payload.iterations} iteration${payload.iterations === 1 ? '' : 's'}.`);
      setFaviconStatus('ready');
    }
    void ensureNotificationPermission();
    if (useConfigStore.getState().soundOnComplete) {
      try { playCompletionChime(); } catch { /* audio policy */ }
    }
  }
  const next = useChatStore.getState().dequeue();
  if (next) {
    const client = getWSClient(useConfigStore.getState().wsUrl);
    useChatStore.getState().addMessage({ role: 'user', content: next });
    useChatStore.getState().setLoading(true);
    client.sendMessage(next);
  }
}
