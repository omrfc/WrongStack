import { expectDefined } from '@wrongstack/core';
import { useWebSocket } from '@/hooks/useWebSocket';
import { cn } from '@/lib/utils';
import { useChatStore, useSessionStore, useUIStore } from '@/stores';
import { Pencil, Send, Square, Sparkles } from 'lucide-react';
import type React from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { downloadChatAsMarkdown } from './CommandPalette';
import { FilePicker } from './FilePicker';
import { Button } from './ui/button';

import { type SlashCommandDef, SLASH_COMMANDS, SLASH_CATEGORY_ORDER, matchSlash, detectAtMention } from './ChatInput/slash-commands.js';
import { autoFenceCode } from './ChatInput/code-detect.js';
import { RefinePanel } from './RefinePanel.js';

export function ChatInput({
  onOpenBreakdown,
}: {
  onOpenBreakdown?: (() => void) | undefined;
} = {}) {
  const { isLoading, setLoading, addMessage, clearMessages } = useChatStore();
  const queue = useChatStore((s) => s.queue);
  const enqueue = useChatStore((s) => s.enqueue);
  const removeQueued = useChatStore((s) => s.removeQueued);
  const clearQueue = useChatStore((s) => s.clearQueue);
  const { setCurrentView } = useUIStore();
  const pushPrompt = useUIStore((s) => s.pushPrompt);
  const promptHistory = useUIStore((s) => s.promptHistory);
  const ws = useWebSocket();
  const { sendMessage, sendAbort, client, refineModel } = ws;
  const refineEnabled = useUIStore((s) => s.refineEnabled);
  const refinePanel = useUIStore((s) => s.refinePanel);
  const toggleRefineEnabled = useUIStore((s) => s.toggleRefineEnabled);
  const setRefinePanel = useUIStore((s) => s.setRefinePanel);
  /** Live context-budget signals — drive the token-estimate chip beside
   *  the character counter. The estimate uses the universal 4-char-per-token
   *  heuristic which is wrong by ±25% for natural prose but accurate enough
   *  to warn the user before they paste a 100k-char file into a 200k window.
   *  The chip only renders past the threshold so short drafts stay clean. */
  const lastInputTokens = useSessionStore((s) => s.lastInputTokens);
  const maxContext = useSessionStore((s) => s.maxContext);
  const [input, setInput] = useState('');
  const [slashIndex, setSlashIndex] = useState(0);
  /** Cursor into promptHistory. -1 = "live input, not browsing history".
   *  Reset to -1 whenever the user types something that's NOT a history
   *  navigation. */
  const [historyIdx, setHistoryIdx] = useState(-1);
  /** Open `@`-mention picker state. We track the starting position of the
   *  `@` in the textarea so on pick we can replace the partial token
   *  (`@compa`) with the chosen path. Null = closed. */
  const [atMention, setAtMention] = useState<{ start: number; query: string } | null>(null);
  /** Transient hint shown after a large paste. The user can read it for a
   *  few seconds then it auto-dismisses. We only surface it for genuinely
   *  big drops (>800 chars) — smaller pastes don't need a callout.
   *  When `lang` is set, the paste was auto-fenced as code. */
  const [pasteHint, setPasteHint] = useState<{
    chars: number;
    lines: number;
    /** Detected language if code was auto-fenced. */
    lang?: string | undefined;
    /** If set, the fenced version can be undone via this callback. */
    undoFence?: (() => void) | undefined;
  } | null>(null);
  /** True while an OS-drag is hovering over the input area. Triggers the
   *  drop overlay so the user gets visual confirmation they're about to
   *  attach. Browsers don't expose full filesystem paths from drops for
   *  security reasons, so we seed the @-mention picker with the file's
   *  basename and let the user confirm the resolved workspace path. */
  const [draggingOver, setDraggingOver] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const runSlashCommand = useCallback(
    (raw: string): boolean => {
      const trimmed = raw.trim();
      // Split into head (with leading slash) + the rest. Lowercase the
      // head so `/Todos` and `/TODOS` route the same; preserve case on
      // the args because the user might be inserting a content string.
      const sp = trimmed.indexOf(' ');
      const head = (sp === -1 ? trimmed : trimmed.slice(0, sp)).toLowerCase();
      const args = sp === -1 ? '' : trimmed.slice(sp + 1).trim();
      const cmd = head;
      switch (cmd) {
        case '/help': {
          // Render the registry inline as an assistant message.
          const lines = [
            '📖 **Slash commands**',
            '',
            ...SLASH_COMMANDS.map(
              (c) =>
                `• \`${c.name}\`${c.aliases?.length ? ` (${c.aliases.map((a) => `\`${a}\``).join(', ')})` : ''} — ${c.description}`,
            ),
          ];
          addMessage({ role: 'assistant', content: lines.join('\n') });
          return true;
        }
        case '/clear':
          clearMessages();
          client?.clearContext?.();
          return true;
        case '/new':
          client?.newSession?.();
          return true;
        case '/exit':
          client?.send?.({ type: 'webui.shutdown' as never, payload: {} });
          addMessage({ role: 'assistant', content: '👋 Shutting down WebUI server…' });
          return true;
        case '/compact':
        case '/compact!':
          client?.compactContext?.(cmd === '/compact!');
          return true;
        case '/repair':
          client?.repairContext?.();
          return true;
        case '/debug':
        case '/context':
          onOpenBreakdown?.();
          return true;
        case '/tools':
          ws.listTools();
          return true;
        case '/memory':
          ws.listMemory();
          return true;
        case '/skill':
        case '/skills':
          ws.listSkills();
          return true;
        case '/diag':
          ws.getDiag();
          return true;
        case '/stats':
          ws.getStats();
          return true;
        case '/save':
          ws.saveSession();
          return true;
        case '/load':
        case '/resume':
          ws.listSessions(50);
          setCurrentView('sessions');
          return true;
        case '/agents':
          setCurrentView('agents');
          return true;
        case '/brain': {
          // Mirrors the CLI's /brain: status (default), risk <level>, ask <question>.
          const [sub, ...rest] = args.split(/\s+/).filter(Boolean);
          const subcmd = (sub ?? '').toLowerCase();
          if (subcmd === 'risk') {
            client?.send?.({ type: 'brain.risk', payload: { level: (rest[0] ?? '').toLowerCase() } });
          } else if (subcmd === 'ask') {
            const question = rest.join(' ').trim();
            if (!question) {
              addMessage({ role: 'assistant', content: 'Usage: `/brain ask <question>`' });
            } else {
              client?.send?.({ type: 'brain.ask', payload: { question } });
            }
          } else {
            client?.send?.({ type: 'brain.status' });
          }
          return true;
        }
        case '/plan':
          ws.getPlan();
          setCurrentView('chat');
          // Surface the Work section of the dock strip above the chat.
          useUIStore.getState().setDockSection('work');
          return true;
        case '/todos': {
          // Sub-commands: `/todos` (default = list), `/todos clear`. We
          // pull live state from the session store so the rendered output
          // matches what the sidebar already shows — no separate fetch.
          const sub = args.toLowerCase();
          if (sub === 'clear') {
            client?.clearTodos?.();
            return true;
          }
          const list = useSessionStore.getState().todos;
          if (list.length === 0) {
            addMessage({
              role: 'assistant',
              content:
                "✅ **Todos** — _empty. Ask the agent to plan something and they'll show up here._",
            });
            return true;
          }
          const lines: string[] = [
            `✅ **Todos** (${list.filter((t) => t.status === 'completed').length}/${list.length} done)`,
            '',
          ];
          for (const t of list) {
            const mark =
              t.status === 'completed' ? '[x]' : t.status === 'in_progress' ? '[~]' : '[ ]';
            const text = t.status === 'in_progress' && t.activeForm ? t.activeForm : t.content;
            lines.push(`- ${mark} ${text}`);
          }
          lines.push('', '_Use `/todos clear` to wipe the list._');
          addMessage({ role: 'assistant', content: lines.join('\n') });
          return true;
        }
        case '/export':
          downloadChatAsMarkdown();
          addMessage({ role: 'assistant', content: '📥 Chat exported to your downloads folder.' });
          return true;
        case '/interrupt':
        case '/abort':
        case '/stop':
        case '/int':
          sendAbort();
          setLoading(false);
          return true;
        case '/settings':
        case '/model':
          setCurrentView('settings');
          return true;
        case '/enhance': {
          const enabled = !useUIStore.getState().refineEnabled;
          toggleRefineEnabled();
          addMessage({
            role: 'assistant',
            content: `Prompt refinement ${enabled ? 'enabled' : 'disabled'}.`,
          });
          return true;
        }
        case '/suggest':
        case '/next-steps':
          // Ask the agent to suggest next steps
          sendMsg('What are the next steps I should take? Be specific and actionable.');
          return true;
        case '/next': {
          const narg = args.trim().toLowerCase();
          if (!narg || narg === 'list' || narg === 'ls' || narg === 'show') return handleNextList();
          if (narg === 'clear' || narg === 'reset') {
            addMessage({ role: 'assistant', content: '💡 _Suggestion list cleared._' });
            return true;
          }
          return handleNextSelect(args.trim());
        }
        default:
          return false;
      }
    },
    [
      addMessage,
      clearMessages,
      client,
      sendAbort,
      setLoading,
      setCurrentView,
      toggleRefineEnabled,
      ws,
      onOpenBreakdown,
    ],
  );

  // ── /next helpers ──────────────────────────────────────────────────

  /** Regex matching "💡 Next steps" heading + numbered items. */
  const NEXT_STEPS_RE = /💡\s*Next steps?\s*\n+((?:\d+\.\s+.+\n?)+)/i;

  function parseNextStepsFromContent(content: string): Array<{ index: number; text: string }> {
    const match = NEXT_STEPS_RE.exec(content);
    if (!match?.[1]) return [];
    const steps: Array<{ index: number; text: string }> = [];
    for (const line of match[1].split('\n').filter(Boolean)) {
      const m = /^(\d+)\.\s+(.+)$/.exec(line.trim());
      if (m) steps.push({ index: Number.parseInt(m[1]!, 10), text: m[2]!.trim() });
    }
    return steps.slice(0, 6);
  }

  function parseNextStepsFromLastAssistant(): Array<{ index: number; text: string }> {
    const all = useChatStore.getState().messages;
    for (let i = all.length - 1; i >= 0; i--) {
      const m = all[i];
      if (m?.role === 'assistant' && m.content) {
        return parseNextStepsFromContent(m.content);
      }
    }
    return [];
  }

  /** Send a user message through the agent. */
  function sendMsg(content: string) {
    if (isLoading) {
      enqueue(content);
      return;
    }
    addMessage({ role: 'user', content });
    const id = sendMessage(content);
    if (id) setLoading(true);
  }

  /** Parse 💡 Next steps from the last assistant message and show them. */
  function handleNextList(): true {
    const all = useChatStore.getState().messages;
    let lastAssistant = '';
    for (let i = all.length - 1; i >= 0; i--) {
      const m = all[i];
      if (m?.role === 'assistant' && m.content) { lastAssistant = m.content; break; }
    }
    const steps = parseNextStepsFromContent(lastAssistant);
    if (steps.length === 0) {
      addMessage({ role: 'assistant', content: '💡 _No next-step suggestions found. Use `/suggest` to generate some._' });
      return true;
    }
    const lines = ['💡 **Next steps**', ''];
    for (const s of steps) lines.push(`${s.index}. ${s.text}`);
    lines.push('', '_Use `/next 1`, `/next 1 2 3` to execute._');
    addMessage({ role: 'assistant', content: lines.join('\n') });
    return true;
  }

  /** Parse 💡 Next steps and execute the selected item(s). */
  function handleNextSelect(input: string): true {
    const steps = parseNextStepsFromLastAssistant();
    if (steps.length === 0) {
      addMessage({ role: 'assistant', content: '💡 _No suggestions available. Use `/suggest` first._' });
      return true;
    }
    const parts = input.split(/[\s,]+/).filter(Boolean);
    const indices = parts.map((p) => Number.parseInt(p, 10)).filter((n) => !Number.isNaN(n) && n > 0);
    if (indices.length === 0) {
      addMessage({ role: 'assistant', content: '💡 _No valid suggestion numbers._' });
      return true;
    }
    const invalid = indices.filter((i) => i > steps.length);
    if (invalid.length > 0) {
      addMessage({ role: 'assistant', content: `💡 _Invalid suggestion(s): ${invalid.join(', ')}. Valid range: 1–${steps.length}._` });
      return true;
    }
    for (const i of indices) {
      const s = steps[i - 1];
      if (s) sendMsg(s.text);
    }
    return true;
  }

  // Suggest slash commands as the user types. Only when the buffer is
  // exactly a slash command head — `/foo bar` shouldn't open the popup.
  const slashSuggestions = input.startsWith('/') && !input.includes(' ') ? matchSlash(input) : [];

  // Reset the highlight when the visible list changes so ↑/↓ always starts
  // from the top of the new matches.
  useEffect(() => {
    if (slashIndex >= slashSuggestions.length) setSlashIndex(0);
  }, [slashSuggestions.length, slashIndex]);

  /** Direct textarea DOM clear — bypasses useState so the UI updates
   *  even when React batches the state update. */
  const _clearTextarea = useCallback(() => {
    const ta = textareaRef.current;
    if (ta) {
      ta.value = '';
      ta.style.height = 'auto';
      ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
      if (!isLoading) { ta.focus(); }
    }
  }, [isLoading]);

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (!input.trim()) return;

      const content = input.trim();

      if (content.startsWith('/') && runSlashCommand(content)) {
        pushPrompt(content);
        setInput('');
        setHistoryIdx(-1);
        _clearTextarea();
        return;
      }

      setInput('');
      setHistoryIdx(-1);
      _clearTextarea();
      pushPrompt(content);
      _clearTextarea(); // ensure textarea is cleared even if batching delays state

      // If the agent is still running, queue the follow-up instead of
      // dropping it. The run.result handler in useWebSocket drains the
      // queue one message at a time. We also enable the textarea while
      // running so this code path is reachable.
      if (isLoading) {
        enqueue(content);
        return;
      }

      try {
        if (client?.isConnected) {
          // If refine is enabled, trigger the refinement flow instead of sending directly
          if (refineEnabled && refineModel) {
            // Show the refine panel with the original text; the backend will return refined + english
            // We use the original text as both refined and english for now — the backend will update
            setRefinePanel({
              original: content,
              refined: content, // Will be replaced when backend responds
              english: content,
              resolve: (decision) => {
                // This is called when the refine panel is decided
              },
            });
            // Send the text to the backend for refinement
            refineModel(content);
          } else {
            addMessage({ role: 'user', content });
            setLoading(true);
            sendMessage(content);
          }
        } else {
          console.warn(JSON.stringify({ level: 'warn', event: 'ws_send_failed', reason: 'not_connected', timestamp: new Date().toISOString() }));
        }
      } catch (err) {
        console.warn(JSON.stringify({ level: 'warn', event: 'ws_send_error', error: err instanceof Error ? err.message : String(err), timestamp: new Date().toISOString() }));
        setLoading(false);
      }
    },
    [
      input,
      isLoading,
      enqueue,
      client,
      sendMessage,
      refineModel,
      refineEnabled,
      setRefinePanel,
      addMessage,
      setLoading,
      runSlashCommand,
      pushPrompt,
      _clearTextarea,
    ],
  );

  const handleAbort = useCallback(() => {
    sendAbort();
    setLoading(false);
  }, [sendAbort, setLoading]);

  /** "Stop & edit" — abort the in-flight run, then pull the last user
   *  message back into the input so the user can rewrite the prompt and
   *  resend. Saves the two-step dance of clicking Abort, waiting for the
   *  agent to settle, then hunting for the original prompt. */
  const handleStopAndEdit = useCallback(() => {
    sendAbort();
    setLoading(false);
    const all = useChatStore.getState().messages;
    for (let i = all.length - 1; i >= 0; i--) {
      const m = expectDefined(all[i]);
      if (m.role === 'user' && m.content) {
        setInput(m.content);
        requestAnimationFrame(() => {
          const ta = textareaRef.current;
          if (ta) {
            ta.style.height = 'auto';
            ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
            ta.focus();
            ta.setSelectionRange(m.content.length, m.content.length);
          }
        });
        return;
      }
    }
  }, [sendAbort, setLoading]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      // Terminal-style prompt history: ↑ pulls the previous user prompt,
      // ↓ steps forward. Only active when both popups are closed AND the
      // input is empty OR already showing a history entry. We keep the cursor
      // ergonomic — once the user starts editing, we drop out of history mode.
      if (slashSuggestions.length === 0 && !atMention && promptHistory.length > 0) {
        if (e.key === 'ArrowUp') {
          const ta = e.currentTarget;
          // Only steal ↑ if we're on the first line (so multi-line editing
          // can still navigate within the textarea naturally).
          const beforeCursor = ta.value.slice(0, ta.selectionStart);
          if (historyIdx >= 0 || beforeCursor.indexOf('\n') === -1) {
            e.preventDefault();
            const next = Math.min(promptHistory.length - 1, historyIdx + 1);
            setHistoryIdx(next);
            const text = promptHistory[next] ?? '';
            setInput(text);
            requestAnimationFrame(() => {
              const el = textareaRef.current;
              if (el) {
                el.style.height = 'auto';
                el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
                el.setSelectionRange(text.length, text.length);
              }
            });
            return;
          }
        }
        if (e.key === 'ArrowDown' && historyIdx >= 0) {
          e.preventDefault();
          const next = historyIdx - 1;
          if (next < 0) {
            setHistoryIdx(-1);
            setInput('');
          } else {
            setHistoryIdx(next);
            const text = promptHistory[next] ?? '';
            setInput(text);
            requestAnimationFrame(() => {
              const el = textareaRef.current;
              if (el) {
                el.style.height = 'auto';
                el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
                el.setSelectionRange(text.length, text.length);
              }
            });
          }
          return;
        }
      }

      // Slash popup keyboard navigation: ↑/↓ to select, Tab/Enter to commit,
      // Esc to dismiss. Matches the TUI's slash menu UX one-for-one so users
      // moving between surfaces don't have to relearn anything.
      if (slashSuggestions.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSlashIndex((i) => (i + 1) % slashSuggestions.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSlashIndex((i) => (i - 1 + slashSuggestions.length) % slashSuggestions.length);
        return;
      }
      if (e.key === 'Tab') {
        e.preventDefault();
        const pick = slashSuggestions[slashIndex];
        if (pick) {
          setInput(pick.name + ' ');
          setSlashIndex(0);
        }
        return;
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        // Commit the highlighted suggestion if there's an exact match below
        // the cursor (or the user hasn't typed a full name yet). Otherwise
        // fall through to normal submit.
        const pick = slashSuggestions[slashIndex];
        if (pick && pick.name !== input.toLowerCase().trim()) {
          e.preventDefault();
          setInput('');
          runSlashCommand(pick.name);
          return;
        }
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setInput('');
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(e);
    }
    },
    [slashSuggestions, slashIndex, atMention, promptHistory, historyIdx, input, runSlashCommand, handleSubmit],
  );

  const adjustTextareaHeight = () => {
    const textarea = textareaRef.current;
    if (textarea) {
      textarea.style.height = 'auto';
      textarea.style.height = `${Math.min(textarea.scrollHeight, 200)}px`;
    }
  };

  return (
    <div className="flex flex-col gap-2">
      {/* Smart paste hint — shows when code is auto-fenced (with undo)
          or when a large text block is pasted. Auto-dismisses. */}
      {pasteHint && (
        <div className={cn(
          'rounded-md border px-2.5 py-1.5 text-xs flex items-center justify-between gap-2 animate-message',
          pasteHint.lang
            ? 'border-emerald-500/30 bg-emerald-500/5 text-emerald-700 dark:text-emerald-300'
            : 'border-amber-500/30 bg-amber-500/5 text-amber-700 dark:text-amber-300',
        )}>
          <span>
            {pasteHint.lang ? (
              <>
                Auto-fenced as{' '}
                <span className="font-mono font-semibold">{pasteHint.lang}</span>
                {' — '}
                <span className="font-mono tabular-nums">{pasteHint.chars.toLocaleString()}</span> chars
                {' ('}<span className="font-mono tabular-nums">{pasteHint.lines}</span> lines)
              </>
            ) : (
              <>
                Pasted{' '}
                <span className="font-mono tabular-nums">{pasteHint.chars.toLocaleString()}</span> chars
                {' ('}<span className="font-mono tabular-nums">{pasteHint.lines}</span> lines) — fenced code
                blocks render best with <span className="font-mono">```</span>.
              </>
            )}
          </span>
          <div className="flex items-center gap-1.5 shrink-0">
            {pasteHint.undoFence && (
              <button
                type="button"
                onClick={pasteHint.undoFence}
                className="underline underline-offset-2 hover:opacity-80"
                title="Remove fences and restore raw text"
              >
                Undo
              </button>
            )}
            <button
              type="button"
              onClick={() => setPasteHint(null)}
              className="opacity-60 hover:opacity-100 shrink-0"
              title="Dismiss"
            >
              ×
            </button>
          </div>
        </div>
      )}
      {/* Queue visualization — shows messages the user stacked while the
          agent was still running. Each row has a remove button; the whole
          queue can be cleared. The hook below drains them after run.result. */}
      {queue.length > 0 && (
        <div className="rounded-lg border bg-muted/30 p-2 text-xs">
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">
              Queued ({queue.length})
            </span>
            <button
              type="button"
              onClick={clearQueue}
              className="text-muted-foreground hover:text-destructive text-xs"
            >
              Clear all
            </button>
          </div>
          <ul className="space-y-1">
            {queue.map((q, i) => (
              <li
                // biome-ignore lint/suspicious/noArrayIndexKey: queue has stable order
                key={i}
                className="flex items-start justify-between gap-2 rounded bg-background/60 border px-2 py-1"
              >
                <span className="truncate flex-1 min-w-0">{q}</span>
                <button
                  type="button"
                  onClick={() => removeQueued(i)}
                  className="text-muted-foreground hover:text-destructive shrink-0"
                  title="Remove from queue"
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Prompt-refinement panel — shown when the user submits and refine is enabled */}
      {refinePanel && (
        <RefinePanel
          original={refinePanel.original}
          refined={refinePanel.refined}
          english={refinePanel.english}
          onDecision={(decision) => {
            const { original, refined, english } = refinePanel;
            let text = original;
            if (decision === 'refined') text = refined;
            else if (decision === 'english') text = english;
            else if (decision === 'edit') text = refined;

            // Send the chosen text as a user message
            if (decision === 'edit') {
              // For edit, the panel handles it differently — set input to refined text
              setInput(refined);
              return;
            }

            // For refined/english/original, proceed to send
            setRefinePanel(null);
            if (client?.isConnected) {
              addMessage({ role: 'user', content: text });
              setLoading(true);
              sendMessage(text);
            }
          }}
        />
      )}

      <form
        onSubmit={handleSubmit}
        onDragEnter={(e) => {
          // Only react to drags carrying files — text/uri-list drags from
          // other parts of the page shouldn't trip the overlay.
          if (!e.dataTransfer || !Array.from(e.dataTransfer.types).includes('Files')) return;
          e.preventDefault();
          setDraggingOver(true);
        }}
        onDragOver={(e) => {
          if (!e.dataTransfer || !Array.from(e.dataTransfer.types).includes('Files')) return;
          // preventDefault on dragover is what makes the area a valid drop
          // target — without it the browser navigates to the file instead.
          e.preventDefault();
          e.dataTransfer.dropEffect = 'copy';
        }}
        onDragLeave={(e) => {
          // dragleave fires when crossing child boundaries too; only clear if
          // the cursor genuinely left the form (relatedTarget outside or null).
          if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
          setDraggingOver(false);
        }}
        onDrop={(e) => {
          if (!e.dataTransfer) return;
          const files = Array.from(e.dataTransfer.files ?? []);
          if (files.length === 0) {
            setDraggingOver(false);
            return;
          }
          e.preventDefault();
          setDraggingOver(false);
          // Insert `@<filename>` per dropped file at the current cursor, with
          // spaces between them. Browsers strip the full path for security, so
          // we use the basename only — the FilePicker (opened by setting
          // atMention to the last inserted handle) will resolve it against
          // the workspace tree.
          const ta = textareaRef.current;
          const insertPos = ta?.selectionStart ?? input.length;
          const before = input.slice(0, insertPos);
          const after = input.slice(insertPos);
          const needsLeadingSpace = before.length > 0 && !/\s$/.test(before);
          const lead = needsLeadingSpace ? ' ' : '';
          const tokens = files.map((f) => `@${f.name}`);
          const joined = tokens.join(' ');
          // Trailing space only when there isn't already one — keeps the
          // cursor neatly between insert and following text.
          const needsTrailingSpace = after.length === 0 || !/^\s/.test(after);
          const trail = needsTrailingSpace ? ' ' : '';
          const insertion = `${lead}${joined}${trail}`;
          const next = before + insertion + after;
          setInput(next);
          // Open the FilePicker against the LAST dropped basename so the user
          // can replace the basename with the correctly-resolved workspace
          // path. Position the @-mention start at the `@` of the last token.
          const lastTokenStart =
            before.length +
            lead.length +
            tokens.slice(0, -1).join(' ').length +
            (tokens.length > 1 ? 1 : 0);
          const lastBasename = files[files.length - 1]?.name;
          requestAnimationFrame(() => {
            if (ta) {
              const cur = before.length + insertion.length - trail.length;
              ta.focus();
              ta.setSelectionRange(cur, cur);
              ta.style.height = 'auto';
              ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
            }
            setAtMention({ start: lastTokenStart, query: lastBasename });
          });
        }}
        className={cn(
          'flex items-end gap-2 relative rounded-lg transition-colors',
          draggingOver && 'ring-2 ring-primary ring-offset-2 ring-offset-background bg-primary/5',
        )}
      >
        {draggingOver && (
          <div className="absolute inset-0 z-20 flex items-center justify-center pointer-events-none rounded-lg bg-primary/10 text-primary text-sm font-medium">
            Drop file{`(s)`} to attach as @-mention
          </div>
        )}
        <div className="relative flex-1">
          {/* @-mention file picker — takes priority over the slash popup
            since `@` and `/` can't both be active at the cursor. */}
          {atMention && (
            <FilePicker
              query={atMention.query}
              onClose={() => setAtMention(null)}
              onPick={(p) => {
                // Replace the partial `@query` with `@<path> `, then move
                // the cursor after the inserted space so typing continues
                // naturally.
                const before = input.slice(0, atMention.start);
                const after = input.slice(atMention.start + 1 + atMention.query.length);
                const inserted = `@${p} `;
                const next = before + inserted + after;
                setInput(next);
                setAtMention(null);
                requestAnimationFrame(() => {
                  const ta = textareaRef.current;
                  if (ta) {
                    const pos = before.length + inserted.length;
                    ta.focus();
                    ta.setSelectionRange(pos, pos);
                    ta.style.height = 'auto';
                    ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
                  }
                });
              }}
            />
          )}

          {/* Slash command popup — descriptions inline, ↑/↓ to select, Tab to
            autocomplete, Enter to dispatch directly. Click also works. */}
          {!atMention &&
            slashSuggestions.length > 0 &&
            (() => {
              // Bucket the suggestions by category and preserve the global
              // index across categories — the keyboard navigation (↑/↓) tracks
              // a flat index, so each rendered row needs to map back to its
              // position in the un-grouped `slashSuggestions` array.
              const byCategory: Record<string, Array<{ cmd: SlashCommandDef; idx: number }>> = {};
              slashSuggestions.forEach((cmd, idx) => {
                if (!byCategory[cmd.category]) byCategory[cmd.category] = [];
                byCategory[cmd.category]?.push({ cmd, idx });
              });
              const orderedCategories = SLASH_CATEGORY_ORDER.filter((c) => byCategory[c]?.length);
              return (
                <div className="absolute bottom-full left-0 right-0 mb-2 rounded-lg border bg-popover shadow-md p-1 text-sm max-h-72 overflow-auto">
                  <div className="px-3 py-1 text-[10px] uppercase tracking-wider text-muted-foreground border-b mb-1">
                    ↑/↓ select · Tab complete · Enter dispatch · Esc dismiss
                  </div>
                  {orderedCategories.map((cat) => (
                    <div key={cat} className="mb-1">
                      <div className="px-3 pt-1 pb-0.5 text-[10px] uppercase tracking-wider text-muted-foreground/70 font-semibold">
                        {cat}
                      </div>
                      {byCategory[cat]?.map(({ cmd, idx }) => (
                        <button
                          type="button"
                          key={cmd.name}
                          onClick={() => {
                            setInput('');
                            runSlashCommand(cmd.name);
                          }}
                          onMouseEnter={() => setSlashIndex(idx)}
                          className={cn(
                            'w-full text-left px-3 py-1.5 rounded transition-colors flex items-center gap-3',
                            idx === slashIndex
                              ? 'bg-accent text-accent-foreground'
                              : 'hover:bg-accent/40',
                          )}
                        >
                          <span className="font-mono shrink-0">{cmd.name}</span>
                          {cmd.aliases?.length ? (
                            <span className="text-xs text-muted-foreground/70 font-mono shrink-0">
                              ({cmd.aliases.join(', ')})
                            </span>
                          ) : null}
                          <span className="text-xs text-muted-foreground truncate">
                            — {cmd.description}
                          </span>
                        </button>
                      ))}
                    </div>
                  ))}
                </div>
              );
            })()}
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => {
              const v = e.target.value;
              setInput(v);
              adjustTextareaHeight();
              // Manual typing drops us out of history mode so the next
              // Enter sends the user's edits, not a stale history entry.
              if (historyIdx >= 0) setHistoryIdx(-1);
              // Detect / refresh @-mention based on cursor position.
              const cur = e.target.selectionStart ?? v.length;
              setAtMention(detectAtMention(v, cur));
            }}
            onSelect={(e) => {
              const ta = e.currentTarget;
              setAtMention(detectAtMention(ta.value, ta.selectionStart));
            }}
            onKeyDown={handleKeyDown}
            onPaste={(e) => {
              const text = e.clipboardData?.getData('text') ?? '';
              if (!text) return;

              // ── Code detection & auto-fencing ──
              // Check if the pasted content looks like source code.
              // If it does and isn't already fenced, auto-wrap in ``` fences
              // so the markdown renderer shows syntax highlighting.
              const result = autoFenceCode(text);
              if (result) {
                e.preventDefault();
                const ta = textareaRef.current;
                if (!ta) return;
                const start = ta.selectionStart;
                const end = ta.selectionEnd;
                const before = input.slice(0, start);
                const after = input.slice(end);
                const fenced = result.fenced;
                const next = before + fenced + after;
                setInput(next);
                const lines = text.split('\n').length;
                // Store undo callback — replaces the paste with the raw text
                const undo = () => {
                  const raw = before + text + after;
                  setInput(raw);
                  setPasteHint(null);
                  requestAnimationFrame(() => {
                    if (ta) {
                      ta.focus();
                      ta.style.height = 'auto';
                      ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
                    }
                  });
                };
                setPasteHint({
                  chars: text.length,
                  lines,
                  lang: result.lang,
                  undoFence: undo,
                });
                setTimeout(() => setPasteHint(null), 6000);
                requestAnimationFrame(() => {
                  ta.style.height = 'auto';
                  ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
                  // Place cursor after the closing ```
                  const newPos = before.length + fenced.length;
                  ta.setSelectionRange(newPos, newPos);
                });
                // Exit — don't run the large-paste hint
                return;
              }

              // ── Large paste hint (non-code) ──
              // Surface a tiny hint when the user drops a chunky payload —
              // helps them realize they pasted the wrong thing (e.g. an
              // entire file when they meant a snippet). 4-second TTL.
              if (text.length > 800) {
                const lines = text.split('\n').length;
                setPasteHint({ chars: text.length, lines });
                setTimeout(() => setPasteHint(null), 4000);
              }
            }}
            placeholder={
              !client?.isConnected
                ? 'Connect to server first…'
                : isLoading
                  ? 'Agent is running — type to queue a follow-up…'
                  : 'Message the agent… (type / for commands, @ for files)'
            }
            className={cn(
              'flex min-h-[44px] w-full resize-none rounded-lg border border-input bg-background px-4 py-3 pr-12',
              'text-sm ring-offset-background placeholder:text-muted-foreground',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
              'disabled:cursor-not-allowed disabled:opacity-50',
              'scrollbar-thin',
            )}
            rows={1}
            disabled={!client?.isConnected}
          />

          {input.length > 0 &&
            (() => {
              // Hide the token estimate until the draft is non-trivial — small
              // messages aren't worth a context warning, and the chip would
              // otherwise just flicker as the user types each character.
              const showTokens = input.length >= 400;
              const estTokens = Math.ceil(input.length / 4);
              // Project the next request's context usage: last sent + draft +
              // small overhead. If that crosses 85% of the configured window,
              // tint amber; past 100% turns red. Falls through to muted when
              // we don't have the window size yet (e.g. before first request).
              let tone = 'text-muted-foreground';
              let title: string | undefined;
              if (maxContext > 0 && showTokens) {
                const projected = lastInputTokens + estTokens + 64;
                const pct = (projected / maxContext) * 100;
                if (pct >= 100) {
                  tone = 'text-red-600 dark:text-red-400 font-medium';
                  title = `Projected ${Math.round(pct)}% of ${maxContext.toLocaleString()} ctx — will likely error or compact.`;
                } else if (pct >= 85) {
                  tone = 'text-amber-600 dark:text-amber-400 font-medium';
                  title = `Projected ${Math.round(pct)}% of ${maxContext.toLocaleString()} ctx — getting tight.`;
                } else {
                  title = `≈ ${estTokens.toLocaleString()} tokens · projected ${Math.round(pct)}% of ${maxContext.toLocaleString()} ctx.`;
                }
              } else if (showTokens) {
                title = `≈ ${estTokens.toLocaleString()} tokens (4-char heuristic)`;
              }
              return (
                <span
                  className={cn('absolute bottom-1.5 right-12 text-xs tabular-nums', tone)}
                  title={title}
                >
                  {input.length}
                  {showTokens && (
                    <span className="ml-1 opacity-70">
                      · ≈{estTokens >= 1000 ? `${(estTokens / 1000).toFixed(1)}k` : estTokens}t
                    </span>
                  )}
                </span>
              );
            })()}
        </div>

        <div className="flex gap-1">
          {isLoading ? (
            <>
              <Button
                type="button"
                size="icon"
                variant="outline"
                onClick={handleStopAndEdit}
                className="h-[44px] w-[44px] rounded-lg"
                title="Stop run and edit the last prompt (reuse + rewrite)"
              >
                <Pencil className="h-4 w-4" />
              </Button>
              <Button
                type="button"
                size="icon"
                variant="destructive"
                onClick={handleAbort}
                className="h-[44px] w-[44px] rounded-lg"
                title="Abort the current run"
              >
                <Square className="h-4 w-4 fill-current" />
              </Button>
            </>
          ) : (
            <>
              <Button
                type="button"
                size="icon"
                variant={refineEnabled ? 'default' : 'outline'}
                disabled={!client?.isConnected}
                onClick={toggleRefineEnabled}
                className={cn(
                  'h-[44px] w-[44px] rounded-lg transition-colors',
                  refineEnabled && 'bg-yellow-500/20 hover:bg-yellow-500/30 text-yellow-600 dark:text-yellow-400 border-yellow-500/50',
                )}
                title={refineEnabled ? 'Refining enabled — click to disable' : 'Refining disabled — click to enable'}
              >
                <Sparkles className="h-4 w-4" />
              </Button>
              <Button
                type="submit"
                size="icon"
                disabled={!input.trim() || !client?.isConnected}
                className="h-[44px] w-[44px] rounded-lg"
              >
                <Send className="h-4 w-4" />
              </Button>
            </>
          )}
        </div>
      </form>
    </div>
  );
}
