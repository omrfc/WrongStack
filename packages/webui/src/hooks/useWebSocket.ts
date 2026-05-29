import { toast } from '@/components/Toaster';
import { playCompletionChime, playPermissionChime } from '@/lib/chime';
import { installFaviconVisibilityReset, setFaviconStatus } from '@/lib/favicon';
import { ensureNotificationPermission, notifyIfHidden } from '@/lib/notify';
import { type WrongStackWebSocketClient, getWSClient } from '@/lib/ws-client';
import {
  type SessionHistoryEntry,
  useChatStore,
  useConfigStore,
  useHistoryStore,
  useSessionStore,
  useUIStore,
  useWorktreeStore,
} from '@/stores';
import type { WorktreeHandleView, WSServerMessage } from '@/types';
import { useCallback, useEffect, useRef } from 'react';

/**
 * One-shot WebSocket handler installation.
 *
 * Critical: this is called by `useWebSocketBootstrap` from App.tsx EXACTLY
 * ONCE per page. Every other component that needs to talk to the backend uses
 * `useWebSocket()` (below) which only returns action methods — it does NOT
 * register handlers.
 *
 * The earlier design had every component that imported `useWebSocket()`
 * register its own copy of the handlers via `ws.on(type, handler)`. With
 * ChatInput + ConfirmDialog + SettingsPanel all using the hook, every
 * incoming WS message was processed three times — three identical tool
 * bubbles, three appends of the same text_delta, three clearMessages on
 * session.start. That's the "duplicate tool bubble / repeated text" bug
 * the user kept hitting. Singleton install fixes it at the root.
 */
function installHandlers(ws: WrongStackWebSocketClient): () => void {
  const offs: Array<() => void> = [];

  const on = (type: string, fn: (msg: WSServerMessage) => void) => {
    offs.push(ws.on(type, fn));
  };

  on('session.start', (msg) => {
    const payload = msg.payload as {
      sessionId: string;
      model: string;
      provider: string;
      maxContext?: number;
      projectName?: string;
      cwd?: string;
      mode?: string;
      contextMode?: string;
      inputCost?: number;
      outputCost?: number;
      cacheReadCost?: number;
      /** Backend tells us "the whole context was wiped on my side, mirror
       *  that in the UI". Sent by context.clear so the chat empties even
       *  though the sessionId is unchanged. */
      reset?: boolean;
    };
    const prev = useSessionStore.getState().session?.id;
    const isNew = !prev || prev !== payload.sessionId;
    useSessionStore.getState().startSession({
      id: payload.sessionId,
      startedAt: Date.now(),
      model: payload.model,
      provider: payload.provider,
    });
    useSessionStore.getState().setEnv({
      maxContext: payload.maxContext,
      projectName: payload.projectName,
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
    if (isNew || payload.reset) useChatStore.getState().clearMessages();

    // Resume hydration: rebuild the chat from the on-disk transcript so the
    // user can pick up exactly where they left off. We translate each
    // Message into the simpler ChatMessage shape the UI store expects.
    const replay = (payload as { replayMessages?: Array<{ role: string; content: unknown }> })
      .replayMessages;
    if (replay && replay.length > 0) {
      const chat = useChatStore.getState();
      for (const m of replay) {
        if (m.role === 'user' || m.role === 'assistant' || m.role === 'system') {
          let text = '';
          if (typeof m.content === 'string') {
            text = m.content;
          } else if (Array.isArray(m.content)) {
            for (const b of m.content as Array<Record<string, unknown>>) {
              if (b.type === 'text' && typeof b.text === 'string') {
                text += (text ? '\n' : '') + b.text;
              } else if (b.type === 'tool_use') {
                // Flush any accumulated text before emitting the tool_use
                // so assistant messages that mix text + tool_use don't lose
                // their text portion.
                if (text) {
                  chat.addMessage({ role: m.role as 'user' | 'assistant', content: text });
                  text = '';
                }
                chat.addMessage({
                  role: 'tool',
                  content: '',
                  toolName: String(b.name ?? 'tool'),
                  toolInput: b.input,
                  toolUseId: String(b.id ?? ''),
                });
              } else if (b.type === 'tool_result') {
                const all = useChatStore.getState().messages;
                let last: { id: string } | undefined;
                for (let i = all.length - 1; i >= 0; i--) {
                  if (all[i]!.toolUseId === String(b.tool_use_id ?? '')) {
                    last = all[i]!;
                    break;
                  }
                }
                if (last) {
                  chat.setToolResult(
                    last.id,
                    typeof b.content === 'string' ? b.content : JSON.stringify(b.content),
                    !b.is_error,
                  );
                }
              }
            }
          }
          if (text) {
            chat.addMessage({ role: m.role as 'user' | 'assistant', content: text });
          }
        }
      }
    }
  });

  on('context.debug', (msg) => {
    const p = msg.payload as {
      total: number;
      systemPrompt: number;
      tools: {
        total: number;
        count: number;
        breakdown: Array<{ name: string; tokens: number }>;
      };
      messages: {
        total: number;
        count: number;
        breakdown: Array<{ index: number; role: string; tokens: number; preview: string }>;
      };
    };
    const fmt = (n: number) => n.toLocaleString();
    // Sort tools+messages by size descending so the top consumers float up.
    const topTools = [...p.tools.breakdown].sort((a, b) => b.tokens - a.tokens).slice(0, 8);
    const topMsgs = [...p.messages.breakdown].sort((a, b) => b.tokens - a.tokens).slice(0, 8);
    const lines = [
      `📊 **Context breakdown** (heuristic — 4 chars/token)`,
      ``,
      `**Total estimate:** ${fmt(p.total)} tokens`,
      `• System prompt: ${fmt(p.systemPrompt)}`,
      `• Tool schemas: ${fmt(p.tools.total)} (${p.tools.count} tools)`,
      `• Messages: ${fmt(p.messages.total)} (${p.messages.count} messages)`,
      ``,
      `**Top tool schemas:**`,
      ...topTools.map((t) => `  · ${t.name}: ${fmt(t.tokens)}`),
      ``,
      `**Top messages:**`,
      ...topMsgs.map(
        (m) => `  · #${m.index} ${m.role}: ${fmt(m.tokens)} — ${m.preview || '(empty)'}`,
      ),
    ];
    useChatStore.getState().addMessage({
      role: 'assistant',
      content: lines.join('\n'),
    });
  });

  on('key.operation_result', (msg) => {
    // Provider/key/model.switch operations report back here. Toast is the
    // right surface — these are transient acks/errors, not chat content.
    const p = msg.payload as { success: boolean; message: string };
    if (p.success) toast.success(p.message);
    else toast.error(p.message);
  });

  on('context.compacted', (msg) => {
    const payload = msg.payload as {
      before: number;
      after: number;
      saved: number;
      reductions: Array<{ phase: string; saved: number }>;
      repaired?: {
        removedToolUses: string[];
        removedToolResults: string[];
        removedMessages: number;
      };
    };
    // Inline notice in the chat — the model just shed ~N tokens of history,
    // user should see what happened so the next reply context isn't a
    // surprise. Not an error; rendered as a subdued assistant note.
    let summary = payload.reductions.length
      ? payload.reductions.map((r) => `${r.phase}: ${r.saved}`).join(', ')
      : 'no-op';
    if (payload.repaired) {
      summary += `; repaired ${payload.repaired.removedToolUses.length} tool_use, ${payload.repaired.removedToolResults.length} tool_result, ${payload.repaired.removedMessages} empty messages`;
    }
    useChatStore.getState().addMessage({
      role: 'assistant',
      content: `🗜️ Context compacted: ${payload.before} → ${payload.after} tokens (saved ~${payload.saved}). ${summary}`,
    });
    // The new context size is the de-facto next input — reflect it in the
    // topbar so the ctx % chip updates immediately.
    useSessionStore.setState({ lastInputTokens: payload.after });
  });

  on('provider.response', (msg) => {
    const payload = msg.payload as {
      usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
    };
    const u = payload?.usage;
    if (!u) return;
    // Update lastInputTokens = the next-turn projected context size.
    // input + cacheWrite = cost of building prefix cache for next turn.
    // cacheRead = saved by the cache. The effective new-context size
    // is input + cacheWrite - cacheRead (cache-read bytes are NOT
    // re-sent, so they don't count toward the next input).
    const delta =
      (u.input ?? 0) + (u.cacheWrite ?? 0) - (u.cacheRead ?? 0);
    if (delta > 0) {
      useSessionStore.setState({ lastInputTokens: delta });
    }
  });

  on('context.repaired', (msg) => {
    const payload = msg.payload as {
      removedToolUses: string[];
      removedToolResults: string[];
      removedMessages: number;
      beforeMessages?: number;
      afterMessages?: number;
    };
    const removed =
      payload.removedToolUses.length + payload.removedToolResults.length + payload.removedMessages;
    const msgCount =
      payload.beforeMessages !== undefined && payload.afterMessages !== undefined
        ? ` Messages: ${payload.beforeMessages} -> ${payload.afterMessages}.`
        : '';
    useChatStore.getState().addMessage({
      role: 'assistant',
      content:
        `Context repaired: removed ${removed} orphan protocol item(s).` +
        `${msgCount} tool_use ${payload.removedToolUses.length}, tool_result ${payload.removedToolResults.length}.`,
    });
  });

  on('session.end', () => {
    useConfigStore.getState().setWsConnected(false);
  });

  on('iteration.started', (msg) => {
    const payload = msg.payload as { index: number; maxIterations?: number };
    useSessionStore.getState().setIteration({
      index: payload.index,
      max: payload.maxIterations ?? 0,
    });
    // Defensive: a new iteration means the agent is actively working.
    // Make sure the running indicator stays visible even if some earlier
    // event dropped isLoading prematurely.
    useChatStore.getState().setLoading(true);
    if (typeof document !== 'undefined' && document.hidden) {
      setFaviconStatus('running');
    }
    // First iteration of a fresh run — snapshot start time + cost so
    // run.result can compute a per-turn summary (duration, cost delta).
    // Subsequent iterations in the same loop preserve the original start.
    if (useChatStore.getState().runStart === null) {
      useChatStore.getState().setRunStart({
        at: Date.now(),
        cost: useSessionStore.getState().cost,
      });
    }
    // Don't pre-create an empty assistant bubble — text_delta lazy-creates
    // one when the model actually writes something.
    useChatStore.getState().setCurrentAssistantMessage(null);
  });

  on('provider.text_delta', (msg) => {
    const payload = msg.payload as { text: string; messageId: string };
    // Model has moved from internal reasoning to user-facing output — the
    // transient thinking buffer is no longer current.
    useChatStore.getState().clearThinking();
    let id = useChatStore.getState().currentAssistantMessageId;
    if (!id) {
      id = useChatStore.getState().addMessage({ role: 'assistant', content: '', streaming: true });
      useChatStore.getState().setCurrentAssistantMessage(id);
    }
    useChatStore.getState().appendToMessage(id, payload.text);
  });

  on('provider.thinking_delta', (msg) => {
    const payload = msg.payload as { text: string };
    if (!payload.text) return;
    useChatStore.getState().appendThinking(payload.text);
  });

  on('tool.started', (msg) => {
    const payload = msg.payload as {
      id: string;
      name: string;
      input?: unknown;
      messageId: string;
    };
    // Guard against duplicate tool.started for the same backend id. Could
    // happen if the agent retries / re-emits, and we definitely don't want a
    // second bubble for the same tool_use.
    const existing = useChatStore.getState().messages.find((m) => m.toolUseId === payload.id);
    if (existing) {
      useChatStore.getState().setCurrentToolId(existing.id);
      return;
    }
    // Model is acting, not still reasoning — drop the transient thinking.
    useChatStore.getState().clearThinking();
    useChatStore.getState().setCurrentAssistantMessage(null);
    const id = useChatStore.getState().addMessage({
      role: 'tool',
      content: '',
      toolName: payload.name,
      toolInput: payload.input,
      toolUseId: payload.id,
    });
    useChatStore.getState().setCurrentToolId(id);
    useChatStore.getState().addExecution({
      id: payload.id,
      name: payload.name,
      input: payload.input,
      ok: true,
      startedAt: Date.now(),
    });
  });

  on('tool.progress', (msg) => {
    const payload = msg.payload as {
      id: string;
      name: string;
      event: {
        type: 'log' | 'warning' | 'metric' | 'file_changed' | 'partial_output';
        text?: string;
      };
    };
    const text = (payload.event?.text ?? '').trim();
    if (!text) return;
    const messages = useChatStore.getState().messages;
    const owner = messages.find((m) => m.toolUseId === payload.id);
    if (!owner) return;
    const prefix = payload.event?.type === 'warning' ? '⚠ ' : '';
    useChatStore.getState().appendToolProgress(owner.id, prefix + text);
  });

  on('tool.executed', (msg) => {
    const payload = msg.payload as {
      id?: string;
      name: string;
      durationMs: number;
      ok: boolean;
      input?: unknown;
      output?: string;
    };
    const { messages, currentToolId } = useChatStore.getState();
    // Prefer matching on backend tool_use id (works for parallel tools).
    // Fall back to currentToolId only when id is missing (legacy emitters).
    const owner = payload.id
      ? messages.find((m) => m.toolUseId === payload.id)
      : currentToolId
        ? messages.find((m) => m.id === currentToolId)
        : undefined;
    // Guard against duplicate tool.executed (backend delivery retry).
    if (owner?.toolResult !== undefined) return;
    if (owner) {
      useChatStore.getState().setToolResult(owner.id, payload.output ?? '', payload.ok);
      useChatStore.getState().updateMessage(owner.id, { toolDurationMs: payload.durationMs });
    }
    if (payload.id) {
      useChatStore.getState().updateExecution(payload.id, {
        completedAt: Date.now(),
        durationMs: payload.durationMs,
        output: payload.output,
        ok: payload.ok,
      });
    }
    if (currentToolId && owner && owner.id === currentToolId) {
      useChatStore.getState().setCurrentToolId(null);
    }
  });

  on('provider.response', (msg) => {
    const payload = msg.payload as {
      usage: {
        input: number;
        output: number;
        cacheRead?: number;
        cacheWrite?: number;
      };
      stopReason: string;
      messageId: string;
    };
    useSessionStore.getState().updateUsage(payload.usage);
    const { inputCost, outputCost, cacheReadCost } = useSessionStore.getState();
    const dCost =
      (payload.usage.input * inputCost +
        payload.usage.output * outputCost +
        (payload.usage.cacheRead ?? 0) * cacheReadCost) /
      1_000_000;
    if (dCost > 0) useSessionStore.getState().addCost(dCost);
    // Run is NOT done if the provider stopped to use tools — the agent will
    // execute them and loop. Keep isLoading true so the Thinking/Running
    // indicator stays visible between iterations. The terminal flip happens
    // in run.result.
    if (payload.stopReason !== 'tool_use' && payload.stopReason !== 'tool_call') {
      useChatStore.getState().setLoading(false);
    }
    // Close out the current streaming bubble either way — finalize the text
    // (collapse model-emitted duplicate paragraphs) and drop the streaming
    // flag so a fresh iteration starts a new bubble.
    const id = useChatStore.getState().currentAssistantMessageId;
    if (id) {
      useChatStore.getState().finalizeMessage(id);
      // Attribute the run's usage to this bubble so the user can see what
      // each answer cost. Iterations that loop on tool_use don't get an
      // attribution here — `usage` from a mid-loop response covers tool
      // arguments, not user-visible content. Only the terminal response
      // (or any with real output) gets the badge.
      if (payload.usage.output > 0) {
        useChatStore.getState().updateMessage(id, { usage: payload.usage });
      }
    }
    useChatStore.getState().setCurrentAssistantMessage(null);
    // Belt-and-suspenders: response landed → no more thinking for this turn.
    useChatStore.getState().clearThinking();
  });

  on('tool.confirm_needed', (msg) => {
    const payload = msg.payload as {
      id: string;
      toolName: string;
      input: unknown;
      suggestedPattern: string;
    };
    useUIStore.getState().showConfirm({
      id: payload.id,
      toolName: payload.toolName,
      input: payload.input,
      suggestedPattern: payload.suggestedPattern,
    });
    // Always play the permission chime — the agent is blocked until the
    // user responds, so awareness is critical regardless of sound prefs.
    try {
      playPermissionChime();
    } catch {
      /* audio policy may block */
    }
    // Lazy permission ask — request on the first confirm_needed event,
    // not just after the first run completes, so the notification is
    // available the very first time the agent needs approval.
    void ensureNotificationPermission();
    // Browser notification when tab is hidden — the agent can't proceed
    // until the user approves, so they need to know even if they alt-tabbed.
    // Uses a separate tag + requireInteraction so it doesn't get swallowed
    // by run-completion notifications and stays visible until the user acts.
    notifyIfHidden(
      'WrongStack needs approval',
      `Tool "${payload.toolName}" is waiting for your decision.`,
      'wrongstack-confirm',
    );
    // Also update the favicon so the user sees the attention state in
    // their tab bar even without a browser notification.
    if (typeof document !== 'undefined' && document.hidden) {
      setFaviconStatus('attention');
    }
  });

  on('run.result', (msg) => {
    const payload = msg.payload as {
      status: string;
      iterations: number;
      finalText?: string;
      error?: { code: string; message: string; recoverable: boolean };
    };
    useSessionStore.getState().setIteration(null);
    useChatStore.getState().setLoading(false);
    useChatStore.getState().setCurrentAssistantMessage(null);
    useChatStore.getState().clearThinking();
    // Compute a per-turn summary and attach it to the last assistant
    // message of this run, then clear runStart for the next turn. Tools
    // are counted by walking the chat backwards for tool bubbles whose
    // timestamp is after runStart.at.
    const runStart = useChatStore.getState().runStart;
    if (runStart && payload.status === 'done') {
      const all = useChatStore.getState().messages;
      let lastAssistantIdx = -1;
      let toolCount = 0;
      for (let i = all.length - 1; i >= 0; i--) {
        const m = all[i]!;
        if (m.role === 'assistant' && lastAssistantIdx === -1 && m.content) {
          lastAssistantIdx = i;
        }
        if (m.role === 'tool' && m.timestamp >= runStart.at) {
          toolCount += 1;
        }
        // Stop walking when we cross the user message that started this run.
        if (m.role === 'user' && m.timestamp <= runStart.at) break;
      }
      if (lastAssistantIdx !== -1) {
        const sessionCost = useSessionStore.getState().cost;
        useChatStore.getState().updateMessage(all[lastAssistantIdx]!.id, {
          runSummary: {
            iterations: payload.iterations,
            tools: toolCount,
            durationMs: Date.now() - runStart.at,
            costDelta: Math.max(0, sessionCost - runStart.cost),
          },
        });
      }
    }
    useChatStore.getState().setRunStart(null);
    if (payload.status !== 'done' && payload.error) {
      useChatStore.getState().addMessage({
        role: 'assistant',
        content: `Error: ${payload.error.message}`,
        isError: true,
      });
      toast.error(`Run ended: ${payload.error.message}`);
      notifyIfHidden('WrongStack run failed', payload.error.message);
      if (typeof document !== 'undefined' && document.hidden) {
        setFaviconStatus('error');
      }
    } else if (payload.status === 'done') {
      // Two-pronged "you can come back now" signal:
      //   • Toast: lands in-page when the user returns, no permission needed.
      //   • OS notification: only when the tab is actually hidden AND the
      //     user previously granted permission. Cheap if neither applies.
      if (typeof document !== 'undefined' && document.hidden) {
        toast.success(
          `Run completed in ${payload.iterations} iteration${payload.iterations === 1 ? '' : 's'}`,
        );
        notifyIfHidden(
          'WrongStack run finished',
          `Completed in ${payload.iterations} iteration${payload.iterations === 1 ? '' : 's'}.`,
        );
        setFaviconStatus('ready');
      }
      // Lazy permission ask — only after the first successful run, so a
      // user who never sticks around long enough for one doesn't see a
      // permission prompt on mount.
      void ensureNotificationPermission();
      // Optional chime — fires regardless of tab visibility because users
      // often want the audible cue specifically when their attention is
      // elsewhere. Synthesized via Web Audio, see lib/chime.ts. Off by
      // default; user opts in via Command Palette.
      if (useConfigStore.getState().soundOnComplete) {
        try {
          playCompletionChime();
        } catch {
          /* audio policy may block */
        }
      }
    }
    // Drain a queued follow-up if the user typed while we were running.
    // We pull one message at a time so the queue doesn't all fire as a
    // single mega-prompt — each one starts its own iteration loop.
    const next = useChatStore.getState().dequeue();
    if (next) {
      const client = getWSClient(useConfigStore.getState().wsUrl);
      useChatStore.getState().addMessage({ role: 'user', content: next });
      useChatStore.getState().setLoading(true);
      client.sendMessage(next);
    }
  });

  on('tools.list', (msg) => {
    const p = msg.payload as {
      tools: Array<{ name: string; description: string; params: string[] }>;
    };
    const lines = [
      `🛠️ **Registered tools** (${p.tools.length})`,
      '',
      ...p.tools.map(
        (t) =>
          `• \`${t.name}\`${t.params.length ? ` (${t.params.join(', ')})` : ''} — ${t.description || '_no description_'}`,
      ),
    ];
    useChatStore.getState().addMessage({ role: 'assistant', content: lines.join('\n') });
  });

  on('memory.list', (msg) => {
    const p = msg.payload as { text: string; error?: string };
    const body = p.text?.trim();
    useChatStore.getState().addMessage({
      role: 'assistant',
      content: p.error
        ? `Memory read failed: ${p.error}`
        : body
          ? `🧠 **Memory** \n\n${body}`
          : '🧠 **Memory** \n\n_empty — nothing remembered yet_',
    });
  });

  on('skills.list', (msg) => {
    const p = msg.payload as {
      enabled: boolean;
      error?: string;
      skills: Array<{
        name: string;
        description: string;
        version: string;
        source: string;
        path: string;
        trigger: string;
        scope: string[];
      }>;
    };
    if (!p.enabled) {
      useChatStore.getState().addMessage({
        role: 'assistant',
        content: '🎯 **Skills** \n\n_disabled (config.features.skills = false)_',
      });
      return;
    }
    const lines = [
      `🎯 **Skills** (${p.skills.length})`,
      '',
      ...(p.skills.length === 0
        ? ['_none registered_']
        : p.skills.map(
            (s) =>
              `• \`${s.name}\`${s.version ? ` v${s.version}` : ''} _(${s.source})_ — ${s.description || s.trigger || '_no description_'}`,
          )),
    ];
    if (p.error) lines.push('', `⚠ ${p.error}`);
    useChatStore.getState().addMessage({ role: 'assistant', content: lines.join('\n') });
  });

  on('diag.get', (msg) => {
    const p = msg.payload as {
      provider: string;
      model: string;
      cwd: string;
      sessionId: string;
      tools: { count: number; names: string[] };
      features: { memory: boolean; skills: boolean; modelsRegistry: boolean };
      mode: string;
      usage: { input: number; output: number; cacheRead?: number };
      messages: number;
      todos: number;
    };
    const lines = [
      '🩺 **Runtime diagnostics**',
      '',
      `**Provider:** \`${p.provider}\` / \`${p.model}\``,
      `**Mode:** \`${p.mode}\``,
      `**Session:** \`${p.sessionId}\``,
      `**CWD:** \`${p.cwd}\``,
      '',
      `**Tools:** ${p.tools.count}`,
      `**Messages:** ${p.messages}  ·  **Todos:** ${p.todos}`,
      `**Usage:** ${p.usage.input.toLocaleString()} in · ${p.usage.output.toLocaleString()} out${p.usage.cacheRead ? ` · ${p.usage.cacheRead.toLocaleString()} cache` : ''}`,
      '',
      `**Features:** memory=${p.features.memory ? '✓' : '✗'} · skills=${p.features.skills ? '✓' : '✗'} · modelsRegistry=${p.features.modelsRegistry ? '✓' : '✗'}`,
    ];
    useChatStore.getState().addMessage({ role: 'assistant', content: lines.join('\n') });
  });

  on('stats.get', (msg) => {
    const p = msg.payload as {
      sessionId: string;
      provider: string;
      model: string;
      usage: { input: number; output: number; cacheRead?: number; cacheWrite?: number };
      cache: { readTokens: number; writeTokens: number; hitRatio: number } | null;
      cost: number;
      messages: number;
      readFiles: number;
      tools: number;
      elapsedMs: number;
    };
    const elapsedSec = Math.floor(p.elapsedMs / 1000);
    const elapsed =
      elapsedSec < 60
        ? `${elapsedSec}s`
        : elapsedSec < 3600
          ? `${Math.floor(elapsedSec / 60)}m ${elapsedSec % 60}s`
          : `${Math.floor(elapsedSec / 3600)}h ${Math.floor((elapsedSec % 3600) / 60)}m`;
    const lines = [
      '📈 **Session stats**',
      '',
      `**Session:** \`${p.sessionId}\``,
      `**Provider/Model:** \`${p.provider}\` / \`${p.model}\``,
      `**Elapsed:** ${elapsed}`,
      '',
      `**Usage:** ${p.usage.input.toLocaleString()} in · ${p.usage.output.toLocaleString()} out`,
      ...(p.cache && p.cache.readTokens > 0
        ? [
            `**Cache:** ${p.cache.readTokens.toLocaleString()} read · ${p.cache.writeTokens.toLocaleString()} write · hit ratio ${(p.cache.hitRatio * 100).toFixed(1)}%`,
          ]
        : []),
      `**Cost:** $${p.cost.toFixed(4)}`,
      '',
      `**Messages:** ${p.messages}  ·  **Files read:** ${p.readFiles}  ·  **Tools available:** ${p.tools}`,
    ];
    useChatStore.getState().addMessage({ role: 'assistant', content: lines.join('\n') });
  });

  on('todos.updated', (msg) => {
    const p = msg.payload as {
      todos: Array<{
        id: string;
        content: string;
        status: 'pending' | 'in_progress' | 'completed';
        activeForm?: string;
      }>;
    };
    useSessionStore.getState().setTodos(p.todos ?? []);
  });

  on('modes.list', (msg) => {
    const p = msg.payload as {
      modes: Array<{ id: string; name: string; description: string; isActive: boolean }>;
      activeId: string;
    };
    useSessionStore
      .getState()
      .setModes(p.modes.map((m) => ({ id: m.id, name: m.name, description: m.description })));
    useSessionStore.getState().setEnv({ mode: p.activeId });
  });

  on('context.modes.list', (msg) => {
    const p = msg.payload as {
      activeId: string;
      modes: Array<{
        id: string;
        name: string;
        description: string;
        isActive: boolean;
        thresholds?: { warn: number; soft: number; hard: number };
        preserveK?: number;
        eliseThreshold?: number;
      }>;
    };
    useSessionStore.getState().setContextModes(
      p.modes.map((m) => ({
        id: m.id,
        name: m.name,
        description: m.description,
        thresholds: m.thresholds,
        preserveK: m.preserveK,
        eliseThreshold: m.eliseThreshold,
      })),
    );
    useSessionStore.getState().setEnv({ contextMode: p.activeId });
  });

  on('context.mode.changed', (msg) => {
    const p = msg.payload as { id: string; name?: string };
    useSessionStore.getState().setEnv({ contextMode: p.id });
  });

  on('sessions.list', (msg) => {
    const payload = msg.payload as {
      sessions: SessionHistoryEntry[];
      error?: string;
    };
    useHistoryStore.getState().setEntries(payload.sessions ?? [], payload.error ?? null);
  });

  on('error', (msg) => {
    const payload = msg.payload as { phase: string; message: string };
    useChatStore.getState().addMessage({
      role: 'assistant',
      content: `[${payload.phase}] ${payload.message}`,
      isError: true,
    });
    useChatStore.getState().setLoading(false);
  });

  // ── Worktree isolation lanes ──────────────────────────────────────────────
  on('worktree.state', (msg) => {
    const p = msg.payload as { worktrees: WorktreeHandleView[]; baseBranch: string };
    useWorktreeStore.getState().setSnapshot(p.worktrees ?? [], p.baseBranch ?? '');
  });
  on('worktree.event', (msg) => {
    const p = msg.payload as { kind: string; handleId: string; text: string; at: number };
    useWorktreeStore.getState().pushEvent(p);
  });

  return () => {
    for (const off of offs) off();
  };
}

/**
 * Mounts the WebSocket connection and installs event handlers EXACTLY ONCE.
 * Call this from App.tsx (top of the tree) and nowhere else.
 */
export function useWebSocketBootstrap(): void {
  const { autoConnect, wsUrl } = useConfigStore();
  const setWsStatus = useConfigStore((s) => s.setWsStatus);
  const installed = useRef(false);

  useEffect(() => {
    if (!autoConnect) return;
    installFaviconVisibilityReset();
    const ws = getWSClient(wsUrl);

    // Subscribe to fine-grained status — the topbar uses this to flip
    // between "Connecting…", "Connected", "Reconnecting (attempt 3, retrying in 8s)",
    // and the terminal "Disconnected" with the last error.
    const offStatus = ws.onStatus((s) => setWsStatus(s));

    ws.connect().catch((err) => {
      // eslint-disable-next-line no-console
      console.error('[WS] Connection failed:', err);
    });

    // installed.current guards against React StrictMode's double-mount in dev
    // and any other re-render that would re-run the effect. Only install once.
    if (installed.current) {
      return () => {
        offStatus();
      };
    }
    installed.current = true;
    const off = installHandlers(ws);
    return () => {
      off();
      offStatus();
      // installed.current stays true — this is a one-shot bootstrap.
    };
  }, [autoConnect, wsUrl, setWsStatus]);
}

/**
 * Cheap accessor for the singleton WS client and its imperative action
 * methods. Components call this freely; it does NOT register handlers.
 */
export function useWebSocket() {
  const { wsUrl } = useConfigStore();
  const client = getWSClient(wsUrl);

  const sendMessage = useCallback(
    (content: string) => {
      if (client.isConnected) return client.sendMessage(content);
      return null;
    },
    [client],
  );

  const sendAbort = useCallback(() => client.sendAbort(), [client]);

  const { hideConfirm } = useUIStore();
  const sendConfirm = useCallback(
    (id: string, decision: 'yes' | 'no' | 'always' | 'deny') => {
      client.sendConfirm(id, decision);
      hideConfirm();
    },
    [client, hideConfirm],
  );

  const switchModel = useCallback(
    (provider: string, model: string) => client.switchModel(provider, model),
    [client],
  );

  const listProviders = useCallback(() => client.listProviders(), [client]);
  const listProviderModels = useCallback(
    (providerId: string) => client.listProviderModels(providerId),
    [client],
  );
  const listSavedProviders = useCallback(() => client.listSavedProviders(), [client]);
  const addKey = useCallback(
    (providerId: string, label: string, apiKey: string) => client.addKey(providerId, label, apiKey),
    [client],
  );
  const updateKey = useCallback(
    (providerId: string, label: string, apiKey: string) =>
      client.updateKey(providerId, label, apiKey),
    [client],
  );
  const deleteKey = useCallback(
    (providerId: string, label: string) => client.deleteKey(providerId, label),
    [client],
  );
  const setActiveKey = useCallback(
    (providerId: string, label: string) => client.setActiveKey(providerId, label),
    [client],
  );
  const addProvider = useCallback(
    (id: string, family: string, baseUrl?: string, apiKey?: string) =>
      client.addProvider(id, family, baseUrl, apiKey),
    [client],
  );
  const removeProvider = useCallback(
    (providerId: string) => client.removeProvider(providerId),
    [client],
  );

  const listSessions = useCallback(
    (limit?: number) => {
      useHistoryStore.getState().setLoading(true);
      client.listSessions(limit);
    },
    [client],
  );
  const deleteSession = useCallback(
    (id: string) => {
      useHistoryStore.getState().removeEntry(id);
      client.deleteSession(id);
    },
    [client],
  );
  const resumeSession = useCallback((id: string) => client.resumeSessionById(id), [client]);
  const saveSession = useCallback(() => client.saveSession(), [client]);
  const listTools = useCallback(() => client.listTools(), [client]);
  const listMemory = useCallback(() => client.listMemory(), [client]);
  const listSkills = useCallback(() => client.listSkills(), [client]);
  const getDiag = useCallback(() => client.getDiag(), [client]);
  const getStats = useCallback(() => client.getStats(), [client]);
  const listModes = useCallback(() => client.listModes(), [client]);
  const switchMode = useCallback((id: string) => client.switchMode(id), [client]);
  const listContextModes = useCallback(() => client.listContextModes(), [client]);
  const switchContextMode = useCallback((id: string) => client.switchContextMode(id), [client]);
  const repairContext = useCallback(() => client.repairContext(), [client]);

  // ── AutoPhase ───────────────────────────────────────────────────────────────

  /**
   * Toggle autonomous mode on/off for the active AutoPhase session.
   */
  const toggleAutoPhaseAutonomous = useCallback(
    (autonomous: boolean) => {
      client.send({ type: 'autophase.toggleAutonomous', payload: { autonomous } });
    },
    [client],
  );

  /**
   * Start a new AutoPhase session.
   */
  const startAutoPhase = useCallback(
    (title: string, phases?: unknown[], autonomous = true) => {
      client.send({ type: 'autophase.start', payload: { title, phases, autonomous } });
    },
    [client],
  );

  /**
   * Pause the running AutoPhase session.
   */
  const pauseAutoPhase = useCallback(() => {
    client.send({ type: 'autophase.pause', payload: {} });
  }, [client]);

  /**
   * Resume a paused AutoPhase session.
   */
  const resumeAutoPhase = useCallback(() => {
    client.send({ type: 'autophase.resume', payload: {} });
  }, [client]);

  /**
   * Stop the AutoPhase session.
   */
  const stopAutoPhase = useCallback(() => {
    client.send({ type: 'autophase.stop', payload: {} });
  }, [client]);

  /**
   * Select a phase to view its tasks.
   */
  const selectAutoPhase = useCallback(
    (phaseId: string) => {
      client.send({ type: 'autophase.selectPhase', payload: { phaseId } });
    },
    [client],
  );

  return {
    client,
    sendMessage,
    sendAbort,
    sendConfirm,
    switchModel,
    listProviders,
    listProviderModels,
    listSavedProviders,
    addKey,
    updateKey,
    deleteKey,
    setActiveKey,
    addProvider,
    removeProvider,
    listSessions,
    deleteSession,
    resumeSession,
    saveSession,
    listTools,
    listMemory,
    listSkills,
    getDiag,
    getStats,
    listModes,
    switchMode,
    listContextModes,
    switchContextMode,
    repairContext,
    toggleAutoPhaseAutonomous,
    startAutoPhase,
    pauseAutoPhase,
    resumeAutoPhase,
    stopAutoPhase,
    selectAutoPhase,
  };
}
