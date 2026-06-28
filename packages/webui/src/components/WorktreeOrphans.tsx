import { AlertTriangle, Eraser, Loader2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useWebSocket } from '@/hooks/useWebSocket';
import { useWorktreeStore } from '@/stores';
import { confirmModal } from './ConfirmModal';

const shortBranch = (b?: string) => (b ? b.replace(/^wstack\/ap\//, '') : '');

/**
 * WorktreeOrphans — surfaces git worktrees/branches left behind by previous or
 * crashed runs (scanned from disk) and offers a guarded one-click cleanup. Self-
 * contained: scans on mount, reads the worktree store, and sends scan/cleanup WS
 * messages. Renders nothing when there is nothing to show, so it stays out of the
 * way in a clean project. Drop it next to <WorktreeLanes />.
 */
export function WorktreeOrphans(): React.ReactElement | null {
  const { client } = useWebSocket();
  const orphans = useWorktreeStore((s) => s.orphans);
  const canClean = useWorktreeStore((s) => s.canClean);
  const blockedReason = useWorktreeStore((s) => s.cleanBlockedReason);
  const cleanResult = useWorktreeStore((s) => s.cleanResult);
  const [cleaning, setCleaning] = useState(false);

  // Scan once on mount (and whenever the socket reconnects).
  useEffect(() => {
    client?.send?.({ type: 'worktree.scan' });
  }, [client]);

  // Clear the local "cleaning" spinner once a result lands.
  useEffect(() => {
    if (cleanResult) setCleaning(false);
  }, [cleanResult]);

  const onClean = async () => {
    const n = orphans.length;
    const ok = await confirmModal({
      title: `Clean ${n} orphaned worktree${n === 1 ? '' : 's'}?`,
      message:
        'Force-removes every leftover git worktree + wstack/ap branch from previous runs. Un-merged work in them is discarded.',
      confirmLabel: 'Clean orphans',
      danger: true,
    });
    if (!ok) return;
    setCleaning(true);
    client?.send?.({ type: 'worktree.cleanup' });
  };

  if (orphans.length === 0 && !cleanResult) return null;

  return (
    <div className="rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs">
      {orphans.length > 0 ? (
        <div className="flex items-start gap-2">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
          <div className="min-w-0 flex-1">
            <div className="font-medium text-amber-700 dark:text-amber-300">
              {orphans.length} orphaned worktree{orphans.length === 1 ? '' : 's'} from previous runs
            </div>
            <div className="mt-0.5 max-h-16 overflow-auto font-mono text-[10px] text-muted-foreground">
              {orphans.slice(0, 8).map((o, i) => (
                <div key={`${o.kind}-${o.branch ?? o.dir ?? i}`} className="truncate">
                  {o.kind === 'branch' ? '⌥ ' : '▢ '}
                  {shortBranch(o.branch) || o.dir}
                </div>
              ))}
              {orphans.length > 8 && <div>…and {orphans.length - 8} more</div>}
            </div>
          </div>
          <button
            type="button"
            disabled={!canClean || cleaning}
            onClick={onClean}
            title={canClean ? 'Force-remove all orphaned worktrees + branches' : blockedReason}
            className="inline-flex shrink-0 items-center gap-1 rounded bg-amber-600/90 px-2 py-1 font-medium text-white hover:bg-amber-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {cleaning ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Eraser className="h-3.5 w-3.5" />
            )}
            Clean orphans
          </button>
        </div>
      ) : null}
      {cleanResult && (
        <div
          className={cleanResult.ok ? 'mt-1 text-emerald-600 dark:text-emerald-400' : 'mt-1 text-rose-500'}
        >
          {cleanResult.ok
            ? `✓ Removed ${cleanResult.removed} orphaned worktree${cleanResult.removed === 1 ? '' : 's'}.`
            : `✗ ${cleanResult.reason ?? 'cleanup failed'}`}
        </div>
      )}
    </div>
  );
}
