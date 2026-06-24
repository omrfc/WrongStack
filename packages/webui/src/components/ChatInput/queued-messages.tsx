interface QueuedMessagesProps {
  queue: readonly string[];
  onClear: () => void;
  onRemove: (index: number) => void;
}

export function QueuedMessages({ queue, onClear, onRemove }: QueuedMessagesProps) {
  if (queue.length === 0) return null;

  return (
    <div className="rounded-lg border bg-muted/30 p-2 text-xs">
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">
          Queued ({queue.length})
        </span>
        <button
          type="button"
          onClick={onClear}
          className="text-muted-foreground hover:text-destructive text-xs"
        >
          Clear all
        </button>
      </div>
      <ul className="space-y-1">
        {queue.map((item, index) => (
          <li
            key={index}
            className="flex items-start justify-between gap-2 rounded bg-background/60 border px-2 py-1"
          >
            <span className="truncate flex-1 min-w-0">{item}</span>
            <button
              type="button"
              onClick={() => onRemove(index)}
              className="text-muted-foreground hover:text-destructive shrink-0"
              title="Remove from queue"
            >
              ×
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
