import { ArrowDownAZ, ArrowUpAZ, ListOrdered, Trash2, X } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';
import { cn } from '@/lib/utils';
import { useChatStore } from '@/stores';
import type { QueuedItem, QueueMode } from '@/stores/chat-store';

type SortDir = 'oldest' | 'newest';

const MODE_META: Record<QueueMode, { label: string; title: string; tone: string }> = {
  btw: {
    label: 'btw',
    title: 'By-the-way — sent as follow-up without interrupting the running agent',
    tone: 'bg-sky-500/10 text-sky-700 dark:text-sky-300 border-sky-500/30',
  },
  steer: {
    label: 'steer',
    title: 'Steer — interrupts the running agent and redirects it with this message',
    tone: 'bg-amber-500/10 text-amber-700 dark:text-amber-300 border-amber-500/30',
  },
  queue: {
    label: 'queue',
    title: 'Queued — held until the current agent run completes, then sent in order',
    tone: 'bg-indigo-500/10 text-indigo-700 dark:text-indigo-300 border-indigo-500/30',
  },
};

/** Queue Panel overlay — triggered by /queue slash command.
 *  Shows the pending message queue and lets users dequeue or clear items. */
export interface QueuePanelProps {
  open: boolean;
  onClose: () => void;
  className?: string;
}

export function QueuePanel({
  open,
  onClose,
  className,
}: QueuePanelProps): React.ReactElement | null {
  const queue = useChatStore((s) => s.queue);
  const removeQueued = useChatStore((s) => s.removeQueued);
  const clearQueue = useChatStore((s) => s.clearQueue);
  const [sortDir, setSortDir] = useState<SortDir>('oldest');

  const handleRemove = useCallback(
    (index: number) => {
      removeQueued(index);
    },
    [removeQueued],
  );

  // Display the queue in the user's chosen order. Sorting never mutates
  // the underlying store — we only reorder a local copy for rendering.
  // The store keeps items in arrival order; only this view flips them.
  //
  // Thread the source index alongside each item so the render loop can use
  // it directly for removal without an O(n) `indexOf` per row. Without
  // this, the render loop is O(n²) for queue length.
  const sortedQueue = useMemo(() => {
    // Copy first because Array#sort mutates in place, and the store array
    // is shared by reference with the rest of the app. Pair each item
    // with its index in the ORIGINAL array so removal still targets the
    // correct entry after sort.
    const indexed = queue.map((item, sourceIdx) => ({ item, sourceIdx }));
    indexed.sort((a, b) =>
      sortDir === 'newest' ? b.item.addedAt - a.item.addedAt : a.item.addedAt - b.item.addedAt,
    );
    return indexed;
  }, [queue, sortDir]);

  if (!open) return null;

  return (
    <div
      className={cn(
        'fixed inset-0 z-50 flex items-start justify-center pt-[10dvh] bg-black/40 backdrop-blur-sm',
        className,
      )}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="flex max-h-[70dvh] min-h-0 w-full max-w-lg flex-col rounded-xl border bg-card shadow-2xl animate-in fade-in zoom-in-95">
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
            <button
              type="button"
              onClick={() => setSortDir((d) => (d === 'newest' ? 'oldest' : 'newest'))}
              className={cn(
                'flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs transition-colors font-medium',
                'text-muted-foreground hover:bg-muted hover:text-foreground',
              )}
              title={
                sortDir === 'newest'
                  ? 'Sorted newest first — click to sort oldest first'
                  : 'Sorted oldest first — click to sort newest first'
              }
              data-testid="queue-sort-toggle"
            >
              {sortDir === 'newest' ? (
                <ArrowDownAZ className="h-3 w-3" />
              ) : (
                <ArrowUpAZ className="h-3 w-3" />
              )}
              {sortDir === 'newest' ? 'Newest' : 'Oldest'}
            </button>
            {queue.length > 0 && (
              <button
                type="button"
                onClick={() => clearQueue()}
                className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs text-destructive hover:bg-destructive/10 transition-colors font-medium"
                title="Clear all queued messages"
                data-testid="queue-clear-all"
              >
                <Trash2 className="h-3 w-3" />
                Clear
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              className="p-1.5 rounded-md hover:bg-muted transition-colors"
              title="Close"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* Queue list */}
        <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">
          {queue.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 gap-3 text-muted-foreground">
              <ListOrdered className="h-10 w-10 opacity-15" />
              <p className="text-sm font-medium">Queue is empty</p>
              <p className="text-xs text-center max-w-xs">
                Use the <span className="font-mono">btw</span> /{' '}
                <span className="font-mono">steer</span> /{' '}
                <span className="font-mono">add queue</span> buttons beside the input to add
                messages. Queued items are sent in order when the current agent run completes.
              </p>
            </div>
          ) : (
            <ul className="divide-y" data-testid="queue-list">
              {sortedQueue.map(({ item, sourceIdx }, idx) => {
                // sourceIdx was threaded through the sort so removal
                // targets the correct entry in the underlying store.
                const meta = MODE_META[item.mode];
                return (
                  <li
                    key={`${item.addedAt}-${sourceIdx}`}
                    className="flex items-start justify-between px-4 py-3 text-xs hover:bg-muted/30 transition-colors gap-3"
                    data-testid="queue-item"
                  >
                    <div className="flex items-start gap-3 min-w-0 flex-1">
                      <span className="mt-1 text-[10px] font-mono text-muted-foreground shrink-0 w-5 text-right tabular-nums">
                        {idx + 1}.
                      </span>
                      <span
                        className={cn(
                          'shrink-0 inline-flex items-center justify-center text-[10px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded border',
                          meta.tone,
                        )}
                        title={meta.title}
                        data-testid={`queue-mode-${item.mode}`}
                      >
                        {meta.label}
                      </span>
                      <p className="text-sm text-foreground leading-relaxed min-w-0 break-words">
                        {item.text.length > 120 ? `${item.text.slice(0, 117)}…` : item.text}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => handleRemove(sourceIdx)}
                      className="ml-1 p-1.5 rounded-md shrink-0 hover:bg-destructive/10 hover:text-destructive transition-colors"
                      title="Remove from queue"
                      data-testid={`queue-remove-${sourceIdx}`}
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {/* Footer hint */}
        {queue.length > 0 && (
          <div className="px-4 py-2.5 border-t shrink-0">
            <p className="text-[10px] text-muted-foreground text-center">
              Messages are sent in arrival order when the current agent run completes. Use the sort
              toggle to view newest-first.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

// Re-export for tests that want to inspect the item shape without
// importing the store directly.
export type { QueuedItem };
