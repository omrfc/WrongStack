import { toast } from '@/components/Toaster';
import { setFaviconStatus } from '@/lib/favicon';
import { getWSClient } from '@/lib/ws-client';
import { streamCoalescer } from '@/lib/stream-coalescer';
import type { ChatMessage, SessionHistoryEntry, SubagentView } from '@/stores';
import { useChatStore, useConfigStore, useFileStore, useFleetStore, useHistoryStore, useSessionStore, useUIStore } from '@/stores';
import { useVizStore, wsToVizEvent } from '@/stores/viz-store';
import type { WSServerMessage } from '@/types';

interface ReplayMessage {
  role: string | undefined;
  content: unknown;
  ts?: string | undefined;
}

function replayTimestamp(ts: string | undefined): number {
  if (typeof ts !== 'string') return Date.now();
  const parsed = Date.parse(ts);
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function replayMessageId(index: number): string {
  return `replay_${Date.now()}_${index}`;
}

function contentToToolResult(content: unknown): string {
  return typeof content === 'string' ? content : JSON.stringify(content);
}

function hydrateReplayMessages(replay: ReplayMessage[]): ChatMessage[] {
  const messages: ChatMessage[] = [];
  const toolMessagesByUseId = new Map<string, ChatMessage>();

  const pushText = (role: 'user' | 'assistant' | 'system', content: string, timestamp: number) => {
    if (!content) return;
    messages.push({ id: replayMessageId(messages.length), role, content, timestamp });
  };

  for (const m of replay) {
    if (m.role !== 'user' && m.role !== 'assistant' && m.role !== 'system') continue;
    const role = m.role;
    const timestamp = replayTimestamp(m.ts);
    if (typeof m.content === 'string') {
      pushText(role, m.content, timestamp);
      continue;
    }
    if (!Array.isArray(m.content)) continue;

    let text = '';
    for (const block of m.content as Array<Record<string, unknown>>) {
      if (block.type === 'text' && typeof block.text === 'string') {
        text += (text ? '\n' : '') + block.text;
        continue;
      }
      if (block.type === 'tool_use') {
        pushText(role, text, timestamp);
        text = '';
        const toolUseId = String(block.id ?? '');
        const toolMessage: ChatMessage = {
          id: replayMessageId(messages.length),
          role: 'tool',
          content: '',
          toolName: String(block.name ?? 'tool'),
          toolInput: block.input,
          toolUseId,
          timestamp,
        };
        messages.push(toolMessage);
        if (toolUseId) toolMessagesByUseId.set(toolUseId, toolMessage);
        continue;
      }
      if (block.type === 'tool_result') {
        const toolUseId = String(block.tool_use_id ?? '');
        const toolMessage = toolMessagesByUseId.get(toolUseId);
        if (toolMessage) {
          toolMessage.toolResult = contentToToolResult(block.content);
          toolMessage.isError = Boolean(block.is_error);
        }
      }
    }
    pushText(role, text, timestamp);
  }

  return messages;
}

function pipeViz(msg: WSServerMessage) {
  const vizEv = wsToVizEvent(msg.type, msg.payload as Record<string, unknown>);
  if (vizEv) {
    useVizStore.getState().pushEvent(vizEv);
    useVizStore.getState().setActive(true);
  }
}

export function handleSessionStart(msg: WSServerMessage) {
  const vizStart = wsToVizEvent('session.start', msg.payload as Record<string, unknown>);
  if (vizStart) {
    useVizStore.getState().pushEvent(vizStart);
    useVizStore.getState().setActive(true);
  }

  const payload = msg.payload as {
    sessionId: string;
    model: string;
    provider: string;
    maxContext?: number | undefined;
    projectName?: string | undefined;
    cwd?: string | undefined;
    mode?: string | undefined;
    contextMode?: string | undefined;
    inputCost?: number | undefined;
    outputCost?: number | undefined;
    cacheReadCost?: number | undefined;
    reset?: boolean | undefined;
    clearedSessionId?: string | undefined;
    needsSetup?: boolean | undefined;
  };
  const prev = useSessionStore.getState().session?.id;
  const isNew = !prev || prev !== payload.sessionId;
  const isReset = isNew || payload.reset;

  if (payload.needsSetup) {
    useUIStore.getState().setCurrentView('setup');
  }

  if (isReset) {
    useSessionStore.getState().startSession({
      id: payload.sessionId,
      startedAt: Date.now(),
      model: payload.model,
      provider: payload.provider,
    });
  } else {
    useSessionStore.getState().setSession({
      id: payload.sessionId,
      startedAt: useSessionStore.getState().session?.startedAt ?? Date.now(),
      model: payload.model,
      provider: payload.provider,
    });
  }

  useSessionStore.getState().setEnv({
    maxContext: payload.maxContext,
    projectRoot: (payload as { projectRoot?: string }).projectRoot ?? '',
    projectName: payload.projectName,
    cwd: payload.cwd,
    mode: payload.mode,
    contextMode: payload.contextMode,
    inputCost: payload.inputCost,
    outputCost: payload.outputCost,
    cacheReadCost: payload.cacheReadCost,
  });
  useConfigStore.getState().setConfig({
    provider: payload.provider,
    model: payload.model,
  });
  if (isReset) {
    useChatStore.getState().clearMessages();
    useChatStore.getState().setLoading(false);
    useSessionStore.setState({ todos: [] });
    setFaviconStatus('ready');

    const fleet = useFleetStore.getState();
    if (payload.clearedSessionId) {
      const survivors = new Map<string, SubagentView>();
      for (const [id, agent] of fleet.agents) {
        if (agent.sessionId !== payload.clearedSessionId) {
          survivors.set(id, agent);
        }
      }
      useFleetStore.setState({ agents: survivors });
    } else {
      fleet.clear();
    }

    useFileStore.getState().setTreeLoading(true);
    getWSClient().send({ type: 'files.tree', payload: { path: useSessionStore.getState().cwd } });
  }
  const replay = (payload as { replayMessages?: ReplayMessage[] }).replayMessages;
  if (replay && replay.length > 0) {
    useChatStore.getState().setMessages(hydrateReplayMessages(replay));
  }
  if (replay) {
    const usage = (payload as {
      replayUsage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
    }).replayUsage;
    if (usage) {
      const rates = useSessionStore.getState();
      const input = usage.input ?? 0;
      const output = usage.output ?? 0;
      const cacheRead = usage.cacheRead ?? 0;
      const cacheWrite = usage.cacheWrite ?? 0;
      useSessionStore.setState({
        totalTokens: { input, output, cacheRead, cacheWrite },
        cost: (input * rates.inputCost + output * rates.outputCost + cacheRead * rates.cacheReadCost) / 1_000_000,
      });
    }
    if (useUIStore.getState().currentView !== 'chat') {
      useUIStore.getState().setCurrentView('chat');
    }
    if (typeof window !== 'undefined' && window.matchMedia?.('(max-width: 768px)').matches) {
      useUIStore.getState().setSidebarOpen(false);
    }
  }
}

export function handleContextDebug(msg: WSServerMessage) {
  const p = msg.payload as {
    total: number; systemPrompt: number;
    tools: { total: number; count: number; breakdown: Array<{ name: string; tokens: number }> };
    messages: { total: number; count: number; breakdown: Array<{ index: number; role: string; tokens: number; preview: string }> };
  };
  const fmt = (n: number) => n.toLocaleString();
  const topTools = [...p.tools.breakdown].sort((a, b) => b.tokens - a.tokens).slice(0, 8);
  const topMsgs = [...p.messages.breakdown].sort((a, b) => b.tokens - a.tokens).slice(0, 8);
  useChatStore.getState().addMessage({ role: 'assistant', content: [
    `📊 **Context breakdown** (heuristic — 4 chars/token)`, '',
    `**Total estimate:** ${fmt(p.total)} tokens`,
    `• System prompt: ${fmt(p.systemPrompt)}`,
    `• Tool schemas: ${fmt(p.tools.total)} (${p.tools.count} tools)`,
    `• Messages: ${fmt(p.messages.total)} (${p.messages.count} messages)`, '',
    `**Top tool schemas:**`, ...topTools.map((t) => `  · ${t.name}: ${fmt(t.tokens)}`), '',
    `**Top messages:**`, ...topMsgs.map((m) => `  · #${m.index} ${m.role}: ${fmt(m.tokens)} — ${m.preview || '(empty)'}`),
  ].join('\n') });
}

export function handleKeyOperationResult(msg: WSServerMessage) {
  const p = msg.payload as { success: boolean; message: string };
  if (p.success) toast.success(p.message);
  else toast.error(p.message);
  const client = getWSClient(useConfigStore.getState().wsUrl);
  client.listSavedProviders();
}

export function handleContextCompacted(msg: WSServerMessage) {
  pipeViz(msg);
  const payload = msg.payload as {
    before: number; after: number; saved: number;
    reductions: Array<{ phase: string; saved: number }>;
    repaired?: { removedToolUses: string[] | undefined; removedToolResults: string[]; removedMessages: number };
  };
  let summary = payload.reductions.length ? payload.reductions.map((r) => `${r.phase}: ${r.saved}`).join(', ') : 'no-op';
  if (payload.repaired) summary += `; repaired ${payload.repaired.removedToolUses?.length ?? 0} tool_use, ${payload.repaired.removedToolResults?.length ?? 0} tool_result, ${payload.repaired.removedMessages} empty messages`;
  useChatStore.getState().addMessage({ role: 'assistant', content: `🗜️ Context compacted: ${payload.before} → ${payload.after} tokens (saved ~${payload.saved}). ${summary}` });
  useSessionStore.setState({ lastInputTokens: payload.after });
}

export function handleProviderResponse(msg: WSServerMessage) {
  pipeViz(msg);
  const payload = msg.payload as { usage: { input: number; output: number; cacheRead?: number | undefined; cacheWrite?: number | undefined }; stopReason: string; messageId: string };

  const u = payload.usage;
  const delta = (u.input ?? 0) + (u.cacheWrite ?? 0) - (u.cacheRead ?? 0);
  if (delta > 0) useSessionStore.setState({ lastInputTokens: delta });

  useSessionStore.getState().updateUsage(payload.usage);
  const { inputCost, outputCost, cacheReadCost } = useSessionStore.getState();
  const dCost = (payload.usage.input * inputCost + payload.usage.output * outputCost + (payload.usage.cacheRead ?? 0) * cacheReadCost) / 1_000_000;
  if (dCost > 0) useSessionStore.getState().addCost(dCost);
  if (payload.stopReason !== 'tool_use' && payload.stopReason !== 'tool_call') useChatStore.getState().setLoading(false);
  const id = useChatStore.getState().currentAssistantMessageId;
  if (id) {
    streamCoalescer.flush(id);
    useChatStore.getState().finalizeMessage(id);
    if (payload.usage.output > 0) useChatStore.getState().updateMessage(id, { usage: payload.usage });
  }
  useChatStore.getState().setCurrentAssistantMessage(null);
  useChatStore.getState().clearThinking();
}

export function handleContextRepaired(msg: WSServerMessage) {
  pipeViz(msg);
  const payload = msg.payload as { removedToolUses: string[]; removedToolResults: string[]; removedMessages: number; beforeMessages?: number | undefined; afterMessages?: number | undefined };
  const removed = payload.removedToolUses.length + payload.removedToolResults.length + payload.removedMessages;
  const msgCount = payload.beforeMessages !== undefined && payload.afterMessages !== undefined ? ` Messages: ${payload.beforeMessages} -> ${payload.afterMessages}.` : '';
  useChatStore.getState().addMessage({ role: 'assistant', content: `Context repaired: removed ${removed} orphan protocol item(s).${msgCount} tool_use ${payload.removedToolUses.length}, tool_result ${payload.removedToolResults.length}.` });
}

export function handleSessionEnd() {
  useConfigStore.getState().setWsConnected(false);
}

export function handleContextModesList(msg: WSServerMessage) {
  const p = msg.payload as { activeId: string; modes: Array<{ id: string; name: string; description: string; isActive: boolean; thresholds?: { warn: number | undefined; soft: number; hard: number }; preserveK?: number | undefined; eliseThreshold?: number | undefined; custom?: boolean | undefined }> };
  useSessionStore.getState().setContextModes(p.modes.map((m) => ({ id: m.id, name: m.name, description: m.description, thresholds: m.thresholds, preserveK: m.preserveK, eliseThreshold: m.eliseThreshold, custom: m.custom })));
  useSessionStore.getState().setEnv({ contextMode: p.activeId });
}

export function handleContextModeChanged(msg: WSServerMessage) {
  const p = msg.payload as { id: string; name?: string | undefined };
  useSessionStore.getState().setEnv({ contextMode: p.id });
}

export function handleSessionsList(msg: WSServerMessage) {
  const payload = msg.payload as { sessions: SessionHistoryEntry[]; error?: string | undefined };
  useHistoryStore.getState().setEntries(payload.sessions ?? [], payload.error ?? null);
}

export function handleError(msg: WSServerMessage) {
  const payload = msg.payload as { phase: string; message: string };
  useChatStore.getState().addMessage({ role: 'assistant', content: `[${payload.phase}] ${payload.message}`, isError: true });
  useChatStore.getState().setLoading(false);
}

export const sessionHandlerMap: Partial<Record<string, (msg: WSServerMessage) => void>> = {
  'context.debug': handleContextDebug,
  'key.operation_result': handleKeyOperationResult,
  'context.compacted': handleContextCompacted,
  'provider.response': handleProviderResponse,
  'context.repaired': handleContextRepaired,
  'session.end': handleSessionEnd,
  'context.modes.list': handleContextModesList,
  'context.mode.changed': handleContextModeChanged,
  'sessions.list': handleSessionsList,
  'error': handleError,
};
