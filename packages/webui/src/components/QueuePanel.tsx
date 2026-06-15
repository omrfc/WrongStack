import { ListOrdered, Trash2, X } from 'lucide-react';
import { useCallback } from 'react';
import { cn } from '@/lib/utils';
import { useChatStore } from '@/stores';

/** Queue Panel overlay — triggered by /queue slash command.
 *  Shows the pending message queue and lets users dequeue or clear items. */
export interface QueuePanelProps {
  open: boolean;
  onClose: () => void;
  className?: string;
}

export function QueuePanel({ open, onClose, className }: QueuePanelProps): React.ReactElement | null {
  const queue = useChatStore((s) => s.queue);
  const removeQueued = useChatStore((s) => s.removeQueued);
  const clearQueue = useChatStore((s) => s.clearQueue);

  const handleRemove = useCallback(
    (index: number) => {
      removeQueued(index);
    },
    [removeQueued],
  );

  if (!open) return null;

  return (
    <div
      className={cn(
        'fixed inset-0 z-50 flex items-start justify-center pt-[10vh] bg-black/40 backdrop-blur-sm',
        className,
      )}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-lg rounded-xl border bg-card shadow-2xl max-h-[70vh] flex flex-col animate-in fade-in zoom-in-95">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b shrink-0">
          <div className="flex items-center gap-2.5">
            <span className="flex items-center justify-center w-8 h-8 rounded-lg bg-indigo-500/10 text-indigo-600 dark:text-indigo-400">
              <ListOrdered className="h-4 w-4" />
            </span>
            <div>
              <h2 className="text-sm font-semibold">Message Queue</h2>
              <span className="text-[10px] text-muted-foreground tabular-nums">
                {queue.length} queued · messages sent before the agent finishes
              </span>
            </div>
          </div>
          <div className="flex items-center gap-1">
            {queue.length > 0 && (
              <button
                type="button"
                onClick={() => clearQueue()}
                className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs text-destructive hover:bg-destructive/10 transition-colors font-medium"
                title="Clear all queued messages"
              >
                <Trash2 className="h-3 w-3" />
                Clear
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              className="p-1.5 rounded-md hover:bg-muted transition-colors"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* Queue list */}
        <div className="flex-1 overflow-y-auto">
          {queue.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 gap-3 text-muted-foreground">
              <ListOrdered className="h-10 w-10 opacity-15" />
              <p className="text-sm font-medium">Queue is empty</p>
              <p className="text-xs text-center max-w-xs">
                Type messages while the agent is running to queue them.
                Queued messages are sent automatically when the agent finishes.
              </p>
            </div>
          ) : (
            <div className="divide-y">
              {queue.map((item, idx) => (
                <div
                  key={idx}
                  className="flex items-start justify-between px-4 py-3 text-xs hover:bg-muted/30 transition-colors"
                >
                  <div className="flex items-start gap-3 min-w-0 flex-1">
                    <span className="mt-0.5 text-[10px] font-mono text-muted-foreground shrink-0 w-5 text-right">
                      {idx + 1}.
                    </span>
                    <p className="text-sm text-foreground leading-relaxed min-w-0 break-words">
                      {item.length > 120 ? `${item.slice(0, 117)}…` : item}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => handleRemove(idx)}
                    className="ml-3 p-1.5 rounded-md shrink-0 hover:bg-destructive/10 hover:text-destructive transition-colors"
                    title="Remove from queue"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Footer hint */}
        {queue.length > 0 && (
          <div className="px-4 py-2.5 border-t shrink-0">
            <p className="text-[10px] text-muted-foreground text-center">
              Messages are sent in order when the current agent run completes.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
