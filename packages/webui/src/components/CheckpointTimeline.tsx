import { cn } from '@/lib/utils';
import { useWebSocket } from '@/hooks/useWebSocket';
import { Clock, History, Rewind, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

// ── Types ──────────────────────────────────────────────────────────────────

interface CheckpointInfo {
  index: number;
  iteration: number;
  timestamp: string;
  /** Human-readable label — first user message, tool name, etc. */
  label: string;
  /** Message count at this point. */
  messageCount: number;
  /** Token count at this point. */
  tokens: number;
}

// ── Component ──────────────────────────────────────────────────────────────

export interface CheckpointTimelineProps {
  open: boolean;
  onClose: () => void;
  className?: string | undefined;
}

export function CheckpointTimeline({
  open,
  onClose,
  className,
}: CheckpointTimelineProps): React.ReactElement | null {
  const [checkpoints, setCheckpoints] = useState<CheckpointInfo[]>([]);
  const [rewinding, setRewinding] = useState(false);
  const ws = useWebSocket();
  const offRef = useRef<(() => void) | null>(null);

  // Fetch checkpoints when opened
  useEffect(() => {
    if (!open || !ws.client?.isConnected) return;

    ws.client.send?.({ type: 'session.checkpoints' });

    offRef.current =
      ws.client.on?.('session.checkpoints', (msg: unknown) => {
        const payload = (msg as { payload?: { checkpoints?: CheckpointInfo[] } })?.payload;
        if (payload?.checkpoints) setCheckpoints(payload.checkpoints);
      }) ?? null;

    return () => {
      offRef.current?.();
    };
  }, [open, ws.client]);

  const handleRewind = useCallback(
    async (index: number) => {
      setRewinding(true);
      ws.client.send?.({ type: 'session.rewind', payload: { checkpointIndex: index } });
      setTimeout(() => {
        onClose();
        setRewinding(false);
      }, 800);
    },
    [ws.client, onClose],
  );

  if (!open) return null;

  return (
    <div
      className={cn(
        'fixed inset-0 z-50 flex items-start justify-center pt-[10dvh] bg-black/40 backdrop-blur-sm',
        className,
      )}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="w-full max-w-md rounded-xl border bg-card shadow-2xl max-h-[75dvh] flex flex-col animate-in fade-in zoom-in-95">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b shrink-0">
          <div className="flex items-center gap-2.5">
            <span className="flex items-center justify-center w-8 h-8 rounded-lg bg-violet-500/10 text-violet-600 dark:text-violet-400">
              <History className="h-4 w-4" />
            </span>
            <div>
              <h2 className="text-sm font-semibold">Session Checkpoints</h2>
              <span className="text-[10px] text-muted-foreground tabular-nums">
                {checkpoints.length} checkpoint{checkpoints.length === 1 ? '' : 's'}
              </span>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-md hover:bg-muted transition-colors"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Description bar */}
        <div className="px-4 py-2.5 border-b bg-muted/20 text-[10px] text-muted-foreground leading-relaxed">
          Rewind the session to any checkpoint. Messages and file changes revert to that
          point — the LLM continues from there as if nothing happened after.
        </div>

        {/* Checkpoint timeline */}
        <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">
          {checkpoints.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 gap-3 text-muted-foreground">
              <Clock className="h-10 w-10 opacity-15" />
              <p className="text-sm font-medium">No checkpoints yet</p>
              <p className="text-xs text-center max-w-xs">
                Checkpoints are automatically created each time you send a message.
                Send a few messages and come back.
              </p>
            </div>
          ) : (
            <div className="py-1">
              {[...checkpoints].reverse().map((cp, i) => {
                const isLatest = i === 0;
                return (
                  <button
                    key={cp.index}
                    type="button"
                    onClick={() => handleRewind(cp.index)}
                    disabled={rewinding}
                    className={cn(
                      'w-full flex items-start gap-3 px-4 py-3 text-left transition-colors group',
                      isLatest
                        ? 'bg-primary/5 hover:bg-primary/10'
                        : 'hover:bg-accent/40',
                      rewinding && 'opacity-50 pointer-events-none',
                    )}
                  >
                    {/* Timeline dot + line */}
                    <div className="flex flex-col items-center mt-1.5">
                      <div
                        className={cn(
                          'w-2.5 h-2.5 rounded-full border-2 shrink-0 transition-colors',
                          isLatest
                            ? 'border-primary bg-primary/20 shadow-[0_0_0_3px_hsl(var(--primary)/0.25)]'
                            : 'border-muted-foreground/30 bg-background group-hover:border-primary/40',
                        )}
                      />
                      {i < checkpoints.length - 1 && (
                        <div className="w-px flex-1 min-h-[20px] bg-border/50" />
                      )}
                    </div>

                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-mono text-muted-foreground tabular-nums shrink-0">
                          #{cp.index}
                        </span>
                        <span className="text-xs font-medium truncate">{cp.label}</span>
                        {isLatest && (
                          <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-primary/10 text-primary font-medium shrink-0">
                            latest
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-2 mt-1 text-[10px] text-muted-foreground">
                        <span className="tabular-nums">
                          {cp.messageCount} msg{cp.messageCount === 1 ? '' : 's'}
                        </span>
                        <span className="opacity-50">·</span>
                        <span className="tabular-nums">~{cp.tokens.toLocaleString()} tok</span>
                        <span className="opacity-50">·</span>
                        <span className="tabular-nums">iter {cp.iteration}</span>
                      </div>
                    </div>

                    <span className="shrink-0 mt-1.5 opacity-0 group-hover:opacity-100 transition-opacity">
                      <Rewind className="h-4 w-4 text-violet-500" />
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* Footer hint */}
        <div className="border-t px-4 py-2 text-[10px] text-muted-foreground text-center shrink-0">
          Click any checkpoint to rewind ·{' '}
          <kbd className="px-1 py-0.5 rounded bg-muted font-mono text-[9px]">Esc</kbd> to close
        </div>
      </div>
    </div>
  );
}
