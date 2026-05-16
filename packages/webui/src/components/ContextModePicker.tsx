import { useWebSocket } from '@/hooks/useWebSocket';
import { cn } from '@/lib/utils';
import { useSessionStore } from '@/stores';
import { Check, ChevronDown, Gauge } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

const FALLBACK_MODES = [
  {
    id: 'balanced',
    name: 'Balanced',
    description: 'Default rolling compaction',
    thresholds: { warn: 0.6, soft: 0.75, hard: 0.9 },
    preserveK: 10,
    eliseThreshold: 2000,
  },
];

export function ContextModePicker() {
  const contextMode = useSessionStore((s) => s.contextMode);
  const contextModes = useSessionStore((s) => s.contextModes);
  const { listContextModes, switchContextMode } = useWebSocket();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) listContextModes();
  }, [open, listContextModes]);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const items = contextModes.length > 0 ? contextModes : FALLBACK_MODES;
  const active = items.find((m) => m.id === contextMode) ?? items[0]!;

  return (
    <div ref={rootRef} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          'flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium',
          'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-500/15 transition-colors border border-transparent hover:border-emerald-500/30',
        )}
        title="Context-window mode"
      >
        <Gauge className="h-3 w-3" />
        ctx: <span className="font-mono">{contextMode || active.id}</span>
        <ChevronDown className="h-3 w-3 opacity-60" />
      </button>
      {open && (
        <div className="absolute top-full left-0 mt-1 w-80 rounded-md border bg-popover shadow-lg z-30 py-1">
          <div className="px-3 py-1.5 text-[10px] uppercase tracking-wider text-muted-foreground border-b">
            Context Window
          </div>
          {items.map((m) => (
            <button
              key={m.id}
              type="button"
              onClick={() => {
                switchContextMode(m.id);
                setOpen(false);
              }}
              className={cn(
                'w-full text-left px-3 py-2 hover:bg-accent/40 flex items-start gap-2',
                m.id === contextMode && 'bg-accent/30',
              )}
            >
              <Check
                className={cn(
                  'h-3.5 w-3.5 mt-0.5 shrink-0',
                  m.id === contextMode ? 'opacity-100 text-primary' : 'opacity-0',
                )}
              />
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-mono">{m.id}</span>
                  {m.thresholds && (
                    <span className="text-[10px] text-muted-foreground tabular-nums">
                      {Math.round(m.thresholds.warn * 100)}/{Math.round(m.thresholds.soft * 100)}/
                      {Math.round(m.thresholds.hard * 100)}%
                    </span>
                  )}
                </div>
                <div className="text-[11px] text-muted-foreground leading-snug">
                  {m.description}
                </div>
                {(m.preserveK || m.eliseThreshold) && (
                  <div className="mt-1 text-[10px] text-muted-foreground/80">
                    keep {m.preserveK ?? '-'} recent · elide {m.eliseThreshold ?? '-'}+ tokens
                  </div>
                )}
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
