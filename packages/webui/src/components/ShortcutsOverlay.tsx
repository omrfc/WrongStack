import { useEffect } from 'react';
import { useUIStore } from '@/stores';
import { Keyboard, X } from 'lucide-react';

interface Shortcut {
  keys: string[];
  description: string;
}

const SHORTCUTS: Array<{ section: string; items: Shortcut[] }> = [
  {
    section: 'Global',
    items: [
      { keys: ['Ctrl', 'K'], description: 'Open command palette' },
      { keys: ['?'], description: 'Show this shortcuts overlay' },
      { keys: ['Ctrl', '\\'], description: 'Toggle sidebar' },
      { keys: ['Ctrl', '/'], description: 'Focus the message input' },
    ],
  },
  {
    section: 'Chat input',
    items: [
      { keys: ['Enter'], description: 'Send message' },
      { keys: ['Shift', 'Enter'], description: 'Insert a newline' },
      { keys: ['↑'], description: 'Recall previous prompt (in empty input)' },
      { keys: ['↓'], description: 'Recall next prompt' },
      { keys: ['/'], description: 'Open slash command popup' },
      { keys: ['Tab'], description: 'Autocomplete highlighted command' },
      { keys: ['Esc'], description: 'Dismiss popup / clear input' },
    ],
  },
  {
    section: 'Chat',
    items: [
      { keys: ['Ctrl', 'F'], description: 'Search within current chat' },
      { keys: ['Ctrl', 'L'], description: 'Clear context (same as /clear)' },
      { keys: ['Ctrl', 'N'], description: 'Start a new session (same as /new)' },
      { keys: ['Ctrl', 'E'], description: 'Export chat as markdown' },
      { keys: ['Ctrl', 'M'], description: 'Quick model switcher overlay' },
      { keys: ['Ctrl', 'Shift', 'D'], description: 'Toggle compact UI density' },
      { keys: ['Esc'], description: 'Abort the current run (when running)' },
    ],
  },
  {
    section: 'Chat navigation (when not typing)',
    items: [
      { keys: ['j'], description: 'Focus next message (alias: ↓)' },
      { keys: ['k'], description: 'Focus previous message (alias: ↑)' },
      { keys: ['g'], description: 'Jump to first message' },
      { keys: ['Shift', 'G'], description: 'Jump to last message' },
      { keys: ['c'], description: 'Copy focused message text' },
      { keys: ['Esc'], description: 'Clear focused message' },
    ],
  },
];

export function ShortcutsOverlay() {
  const open = useUIStore((s) => s.shortcutsOpen);
  const setOpen = useUIStore((s) => s.setShortcutsOpen);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // "?" — but only when the user isn't typing in an input. Otherwise
      // typing a literal "?" into the chat would open this overlay.
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName?.toLowerCase();
      const isTyping = tag === 'input' || tag === 'textarea' || target?.isContentEditable;
      if (!isTyping && e.key === '?' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        setOpen(!useUIStore.getState().shortcutsOpen);
        return;
      }
      if (e.key === 'Escape' && useUIStore.getState().shortcutsOpen) {
        e.preventDefault();
        setOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setOpen]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 bg-background/60 backdrop-blur-sm flex items-center justify-center px-4"
      onClick={() => setOpen(false)}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-2xl rounded-xl border bg-popover shadow-2xl overflow-hidden flex flex-col max-h-[80vh]"
      >
        <div className="flex items-center justify-between px-5 py-4 border-b">
          <div className="flex items-center gap-2">
            <Keyboard className="h-4 w-4 text-muted-foreground" />
            <h2 className="text-sm font-semibold">Keyboard shortcuts</h2>
          </div>
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="text-muted-foreground hover:text-foreground p-1 rounded hover:bg-muted"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="overflow-y-auto px-5 py-4 space-y-6">
          {SHORTCUTS.map((group) => (
            <div key={group.section}>
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-2">
                {group.section}
              </div>
              <div className="grid grid-cols-1 gap-1.5">
                {group.items.map((s) => (
                  <div
                    key={s.description}
                    className="flex items-center justify-between gap-3 text-sm px-2 py-1.5 rounded hover:bg-muted/40"
                  >
                    <span className="text-foreground/80">{s.description}</span>
                    <span className="flex items-center gap-1 shrink-0">
                      {s.keys.map((k, i) => (
                        <span key={i} className="flex items-center gap-1">
                          {i > 0 && <span className="text-muted-foreground/40 text-xs">+</span>}
                          <kbd className="font-mono text-[10px] border rounded px-1.5 py-0.5 bg-background">
                            {k}
                          </kbd>
                        </span>
                      ))}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
        <div className="border-t px-5 py-3 text-xs text-muted-foreground">
          Press <kbd className="font-mono text-[10px] border rounded px-1 py-0.5 bg-background">?</kbd> any time to reopen this list.
        </div>
      </div>
    </div>
  );
}
