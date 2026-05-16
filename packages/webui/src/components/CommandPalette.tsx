import { useWebSocket } from '@/hooks/useWebSocket';
import { playCompletionChime } from '@/lib/chime';
import { cn } from '@/lib/utils';
import {
  useChatStore,
  useConfigStore,
  useHistoryStore,
  useSessionStore,
  useUIStore,
} from '@/stores';
import {
  ArchiveRestore,
  BarChart3,
  Brain,
  Cpu,
  Database,
  Download,
  Hash,
  History as HistoryIcon,
  type LucideIcon,
  Maximize2,
  Monitor,
  Moon,
  RotateCcw,
  Search,
  Settings as SettingsIcon,
  Sparkles,
  Stethoscope,
  Sun,
  Trash2,
  Volume2,
  VolumeX,
  Wrench,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';

/**
 * Cross-cut search-everything overlay invoked with Ctrl/Cmd+K. Mirrors the
 * pattern from VS Code / Linear / Slack — one keyboard shortcut, one fuzzy
 * search input, one list of every action the user might want. Each entry
 * names its category (Command / Session / Theme) and an icon, plus an
 * inline "↵" hint on the highlighted row. Closes on Esc, Enter, or click.
 */
interface PaletteItem {
  id: string;
  category: 'Command' | 'Session' | 'Theme' | 'Tool';
  label: string;
  hint?: string;
  icon: LucideIcon;
  keywords?: string[];
  run: () => void;
}

export function CommandPalette() {
  const open = useUIStore((s) => s.paletteOpen);
  const setOpen = useUIStore((s) => s.setPaletteOpen);
  const setCurrentView = useUIStore((s) => s.setCurrentView);
  const setTheme = useConfigStore((s) => s.setTheme);
  const { entries: historyEntries } = useHistoryStore();
  const { addMessage, clearMessages } = useChatStore();
  const ws = useWebSocket();

  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // Focus the search input every time we open. Defer to the next tick so
  // it actually grabs focus after the dialog has mounted.
  useEffect(() => {
    if (open) {
      setQuery('');
      setIndex(0);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  // Global Ctrl/Cmd+K to toggle, Esc to dismiss. Bound at body level so it
  // works from anywhere in the app, not just when the palette has focus.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen(!useUIStore.getState().paletteOpen);
        return;
      }
      if (e.key === 'Escape' && useUIStore.getState().paletteOpen) {
        e.preventDefault();
        setOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setOpen]);

  const items = useMemo<PaletteItem[]>(() => {
    const base: PaletteItem[] = [
      // Commands
      {
        id: 'help',
        category: 'Command',
        label: 'Show slash commands',
        icon: Hash,
        keywords: ['help', 'commands', '?'],
        run: () => {
          addMessage({
            role: 'assistant',
            content: 'Type `/` in the message box to see every slash command.',
          });
        },
      },
      {
        id: 'tools',
        category: 'Command',
        label: 'List tools',
        icon: Wrench,
        keywords: ['tools', 'list'],
        run: () => ws.listTools(),
      },
      {
        id: 'memory',
        category: 'Command',
        label: 'Show memory',
        icon: Brain,
        keywords: ['memory', 'remember', 'notes'],
        run: () => ws.listMemory(),
      },
      {
        id: 'skills',
        category: 'Command',
        label: 'List skills',
        icon: Sparkles,
        keywords: ['skills'],
        run: () => ws.listSkills(),
      },
      {
        id: 'diag',
        category: 'Command',
        label: 'Runtime diagnostics',
        icon: Stethoscope,
        keywords: ['diag', 'diagnostics', 'debug'],
        run: () => ws.getDiag(),
      },
      {
        id: 'stats',
        category: 'Command',
        label: 'Session stats (tokens, cache, cost)',
        icon: BarChart3,
        keywords: ['stats', 'tokens', 'cost', 'cache'],
        run: () => ws.getStats(),
      },
      // Session actions
      {
        id: 'clear',
        category: 'Session',
        label: 'Clear context',
        hint: 'Wipe in-memory context, keep session id',
        icon: Trash2,
        keywords: ['clear', 'reset', 'wipe'],
        run: () => {
          clearMessages();
          ws.client?.clearContext?.();
        },
      },
      {
        id: 'new',
        category: 'Session',
        label: 'New session',
        hint: 'Brand-new on disk + memory',
        icon: RotateCcw,
        keywords: ['new', 'fresh', 'session'],
        run: () => ws.client?.newSession?.(),
      },
      {
        id: 'compact',
        category: 'Session',
        label: 'Compact context',
        icon: Database,
        keywords: ['compact', 'shrink', 'context'],
        run: () => ws.client?.compactContext?.(),
      },
      {
        id: 'export',
        category: 'Session',
        label: 'Export chat as markdown',
        icon: Download,
        keywords: ['export', 'save', 'markdown', 'download'],
        run: () => downloadChatAsMarkdown(),
      },
      {
        id: 'export-html',
        category: 'Session',
        label: 'Export chat as HTML',
        hint: 'Self-contained, opens in any browser',
        icon: Download,
        keywords: ['export', 'html', 'download', 'archive'],
        run: () => downloadChatAsHtml(),
      },
      // Navigation
      {
        id: 'history',
        category: 'Command',
        label: 'Open history',
        icon: HistoryIcon,
        keywords: ['history', 'sessions'],
        run: () => setCurrentView('history'),
      },
      {
        id: 'settings',
        category: 'Command',
        label: 'Open settings',
        icon: SettingsIcon,
        keywords: ['settings', 'config'],
        run: () => setCurrentView('settings'),
      },
      {
        id: 'model',
        category: 'Command',
        label: 'Change provider/model',
        icon: Cpu,
        keywords: ['model', 'provider', 'change'],
        run: () => setCurrentView('settings'),
      },
      // Theme
      {
        id: 'theme-light',
        category: 'Theme',
        label: 'Theme: Light',
        icon: Sun,
        keywords: ['theme', 'light', 'mode'],
        run: () => setTheme('light'),
      },
      {
        id: 'theme-dark',
        category: 'Theme',
        label: 'Theme: Dark',
        icon: Moon,
        keywords: ['theme', 'dark', 'mode'],
        run: () => setTheme('dark'),
      },
      {
        id: 'theme-system',
        category: 'Theme',
        label: 'Theme: Follow system',
        icon: Monitor,
        keywords: ['theme', 'system', 'auto'],
        run: () => setTheme('system'),
      },
      {
        id: 'compact-toggle',
        category: 'Command',
        label: 'Toggle compact density',
        icon: Maximize2,
        hint: 'Ctrl+Shift+D',
        keywords: ['compact', 'dense', 'density', 'size'],
        run: () => useUIStore.getState().toggleCompactMode(),
      },
      {
        id: 'sound-toggle',
        category: 'Command',
        label: useConfigStore.getState().soundOnComplete
          ? 'Sound on completion: ON — turn off'
          : 'Sound on completion: OFF — turn on',
        icon: useConfigStore.getState().soundOnComplete ? Volume2 : VolumeX,
        hint: 'Chime when a run finishes',
        keywords: ['sound', 'audio', 'chime', 'notify', 'beep'],
        run: () => {
          const next = !useConfigStore.getState().soundOnComplete;
          useConfigStore.getState().setSoundOnComplete(next);
          // Play once immediately when enabling so the user hears what
          // they just signed up for (and so Web Audio gets the gesture
          // permission unlocked).
          if (next) {
            playCompletionChime();
          }
        },
      },
    ];

    // Append recent sessions so the palette doubles as a "switch to
    // session" picker — the killer feature for multi-project use.
    for (const entry of historyEntries.slice(0, 10)) {
      if (entry.isCurrent) continue;
      base.push({
        id: `resume-${entry.id}`,
        category: 'Session',
        label: `Resume: ${entry.title || '(empty)'}`,
        hint: `${entry.provider}/${entry.model}`,
        icon: ArchiveRestore,
        keywords: ['resume', entry.title, entry.id, entry.provider, entry.model],
        run: () => ws.resumeSession(entry.id),
      });
    }
    return base;
  }, [historyEntries, ws, setCurrentView, setTheme, addMessage, clearMessages]);

  const filtered = useMemo(() => {
    const q = query.toLowerCase().trim();
    if (!q) return items;
    return items.filter((it) => {
      const hay = [it.label, it.hint ?? '', it.category, ...(it.keywords ?? [])]
        .join(' ')
        .toLowerCase();
      return hay.includes(q);
    });
  }, [items, query]);

  useEffect(() => {
    if (index >= filtered.length) setIndex(0);
  }, [filtered.length, index]);

  if (!open) return null;

  const dispatchPick = (item: PaletteItem | undefined) => {
    if (!item) return;
    setOpen(false);
    item.run();
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-background/60 backdrop-blur-sm flex items-start justify-center pt-[14vh] px-4"
      onClick={() => setOpen(false)}
      onKeyDown={(e) => {
        if (e.key === 'Escape') setOpen(false);
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
        className="w-full max-w-2xl rounded-xl border bg-popover shadow-2xl overflow-hidden flex flex-col"
      >
        <div className="flex items-center gap-2 px-4 py-3 border-b">
          <Search className="h-4 w-4 text-muted-foreground" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search commands, sessions, settings…"
            className="flex-1 bg-transparent outline-none text-sm placeholder:text-muted-foreground"
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setIndex((i) => (i + 1) % Math.max(1, filtered.length));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setIndex(
                  (i) => (i - 1 + Math.max(1, filtered.length)) % Math.max(1, filtered.length),
                );
              } else if (e.key === 'Enter') {
                e.preventDefault();
                dispatchPick(filtered[index]);
              }
            }}
          />
          <kbd className="text-[10px] text-muted-foreground border rounded px-1.5 py-0.5">Esc</kbd>
        </div>

        <div className="max-h-[60vh] overflow-y-auto">
          {filtered.length === 0 ? (
            <div className="px-4 py-8 text-center text-sm text-muted-foreground">
              No matches for "{query}"
            </div>
          ) : (
            renderGroupedList(filtered, index, dispatchPick, setIndex)
          )}
        </div>

        <div className="border-t px-4 py-2 text-[10px] uppercase tracking-wider text-muted-foreground flex items-center gap-3">
          <span>↑↓ navigate</span>
          <span>↵ select</span>
          <span>Esc dismiss</span>
        </div>
      </div>
    </div>
  );
}

function renderGroupedList(
  filtered: PaletteItem[],
  index: number,
  dispatch: (it: PaletteItem) => void,
  setIndex: (i: number) => void,
) {
  // Maintain global filtered-index as we walk, so the highlighted row
  // matches what arrow keys point at. Grouping is visual sugar only.
  const groups: Record<string, Array<{ item: PaletteItem; globalIdx: number }>> = {};
  filtered.forEach((it, i) => {
    if (!groups[it.category]) groups[it.category] = [];
    groups[it.category]!.push({ item: it, globalIdx: i });
  });
  return (
    <div className="p-1">
      {Object.entries(groups).map(([cat, rows]) => (
        <div key={cat}>
          <div className="px-3 pt-2 pb-1 text-[10px] uppercase tracking-wider text-muted-foreground">
            {cat}
          </div>
          {rows.map(({ item, globalIdx }) => {
            const Icon = item.icon;
            const active = globalIdx === index;
            return (
              <button
                type="button"
                key={item.id}
                onMouseEnter={() => setIndex(globalIdx)}
                onClick={() => dispatch(item)}
                className={cn(
                  'w-full flex items-center gap-3 px-3 py-2 rounded text-left text-sm transition-colors',
                  active ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/40',
                )}
              >
                <Icon className="h-4 w-4 text-muted-foreground shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="truncate">{item.label}</div>
                  {item.hint && (
                    <div className="text-xs text-muted-foreground truncate">{item.hint}</div>
                  )}
                </div>
                {active && <span className="text-[10px] text-muted-foreground">↵</span>}
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}

/**
 * Build a markdown export of the current chat and trigger a browser
 * download. Includes user/assistant turns and a compact summary of tool
 * calls inline so the transcript stays readable but you can still see
 * which tools the agent invoked.
 */
export function downloadChatAsMarkdown(): void {
  const messages = useChatStore.getState().messages;
  const session = useChatStore.getState();
  void session;
  const lines: string[] = [];
  const now = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  lines.push(`# WrongStack chat export`);
  lines.push(`*Exported: ${new Date().toISOString()}*`);
  lines.push('');
  for (const m of messages) {
    if (m.role === 'user') {
      lines.push(`## 👤 User`);
      lines.push('');
      lines.push(m.content);
      lines.push('');
    } else if (m.role === 'assistant') {
      lines.push(`## 🤖 Assistant`);
      lines.push('');
      lines.push(m.content);
      lines.push('');
    } else if (m.role === 'tool') {
      const status = m.isError ? '❌' : m.toolResult !== undefined ? '✅' : '⏳';
      lines.push(`### 🔧 Tool: \`${m.toolName ?? 'unknown'}\` ${status}`);
      if (m.toolInput !== undefined) {
        lines.push('```json');
        lines.push(JSON.stringify(m.toolInput, null, 2));
        lines.push('```');
      }
      if (m.toolResult) {
        lines.push('<details><summary>Output</summary>');
        lines.push('');
        lines.push('```');
        lines.push(m.toolResult);
        lines.push('```');
        lines.push('</details>');
      }
      lines.push('');
    }
  }
  const blob = new Blob([lines.join('\n')], { type: 'text/markdown' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `wrongstack-chat-${now}.md`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/**
 * Build a stand-alone HTML export of the current chat. Self-contained
 * (inline CSS, no external assets) so the file opens cleanly anywhere
 * and survives being emailed / pasted into a wiki / archived offline.
 * Code-block highlighting is intentionally not included — would require
 * shipping a syntax highlighter, and the export is already readable
 * with the basic monospace styling.
 */
export function downloadChatAsHtml(): void {
  const messages = useChatStore.getState().messages;
  const session = useSessionStore.getState();
  const now = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const escapeHtml = (s: string) =>
    s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');

  const turns = messages.map((m) => {
    if (m.role === 'tool') {
      const status = m.isError ? '❌' : m.toolResult !== undefined ? '✅' : '⏳';
      return `
        <section class="bubble tool ${m.isError ? 'error' : ''}">
          <header><span class="icon">🔧</span><code>${escapeHtml(m.toolName ?? 'tool')}</code> ${status}</header>
          ${
            m.toolInput !== undefined
              ? `<details><summary>Input</summary><pre>${escapeHtml(JSON.stringify(m.toolInput, null, 2))}</pre></details>`
              : ''
          }
          ${
            m.toolResult
              ? `<details><summary>Output</summary><pre>${escapeHtml(m.toolResult)}</pre></details>`
              : ''
          }
        </section>`;
    }
    const cls = m.role === 'user' ? 'user' : 'assistant';
    const icon = m.role === 'user' ? '👤' : '🤖';
    const role = m.role === 'user' ? 'User' : 'Assistant';
    // Keep newlines but escape everything — we deliberately don't render
    // markdown here. Static HTML with preserved whitespace is faithful to
    // what the user actually saw, and dodges the whole "rendered markdown
    // syntax-highlighting drift" problem.
    return `
      <section class="bubble ${cls}">
        <header><span class="icon">${icon}</span><strong>${role}</strong></header>
        <pre class="content">${escape(m.content)}</pre>
      </section>`;
  });

  const html = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<title>WrongStack chat — ${escape(session.session?.title || session.projectName || 'export')}</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 14px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; max-width: 920px; margin: 24px auto; padding: 0 16px; }
  h1 { font-size: 20px; margin-bottom: 4px; }
  .meta { color: #666; font-size: 12px; margin-bottom: 24px; }
  .bubble { margin: 12px 0; padding: 10px 14px; border-radius: 10px; border: 1px solid #ddd; }
  .bubble header { font-size: 11px; text-transform: uppercase; letter-spacing: .05em; color: #666; margin-bottom: 6px; }
  .bubble header .icon { margin-right: 4px; }
  .bubble.user { background: #eef4ff; border-color: #c8d8f5; }
  .bubble.assistant { background: #fff; }
  .bubble.tool { background: #fafafa; }
  .bubble.tool.error { background: #fff5f5; border-color: #f5c8c8; }
  pre.content, .bubble pre { white-space: pre-wrap; word-break: break-word; font: 12px/1.5 ui-monospace, Menlo, Consolas, monospace; margin: 0; }
  details summary { cursor: pointer; color: #555; font-size: 12px; }
  details pre { margin-top: 6px; background: #f4f4f4; padding: 8px; border-radius: 6px; max-height: 360px; overflow: auto; }
  @media (prefers-color-scheme: dark) {
    body { background: #0d0d0f; color: #e6e6e6; }
    .bubble { border-color: #2a2a2e; }
    .bubble.user { background: #16213a; border-color: #2a3d6b; }
    .bubble.assistant { background: #161618; }
    .bubble.tool { background: #131315; }
    .bubble.tool.error { background: #2a1717; border-color: #5c2a2a; }
    details pre { background: #1a1a1c; }
    .meta, .bubble header, details summary { color: #999; }
  }
</style>
</head><body>
<h1>WrongStack chat — ${escape(session.session?.title || session.projectName || 'export')}</h1>
<div class="meta">
  Exported ${new Date().toISOString()}${session.session?.provider ? ` · ${escape(session.session.provider)}/${escape(session.session.model)}` : ''} · ${messages.length} message${messages.length === 1 ? '' : 's'}
</div>
${turns.join('')}
</body></html>`;
  const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `wrongstack-chat-${now}.html`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
