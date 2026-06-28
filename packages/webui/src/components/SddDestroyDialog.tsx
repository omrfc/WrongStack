import { AlertTriangle, Loader2, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { SddBoardSnapshotUI } from '@/stores';
import { Button } from './ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './ui/dialog';

/**
 * SddDestroyDialog — the "give up entirely" confirmation. Spells out exactly
 * what a destroy does so it is never a surprise: stop the run, force-remove
 * every worktree + branch (including un-merged work), optionally revert merged
 * commits, and delete all on-disk SDD artifacts. Irreversible apart from the
 * merged-commit revert (which is history-preserving).
 */
export function SddDestroyDialog({
  open,
  onOpenChange,
  snapshot,
  busy,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  snapshot: SddBoardSnapshotUI | null;
  busy: boolean;
  onConfirm: (revertMerged: boolean) => void;
}): React.ReactElement {
  const mergedCount = snapshot?.mergedCommits?.length ?? 0;
  const baseBranch = snapshot?.baseBranch;
  const [revertMerged, setRevertMerged] = useState(false);

  // Reset the checkbox each time the dialog opens (default = leave merged commits).
  useEffect(() => {
    if (open) setRevertMerged(false);
  }, [open]);

  const isActive = snapshot?.status === 'running' || snapshot?.status === 'paused';
  const worktreeCount = useMemo(() => {
    const s = new Set<string>();
    for (const t of snapshot?.tasks ?? []) if (t.worktreeBranch) s.add(t.worktreeBranch);
    return s.size;
  }, [snapshot?.tasks]);
  const runningAgents = useMemo(() => {
    const s = new Set<string>();
    for (const t of snapshot?.tasks ?? [])
      if (t.displayStatus === 'in_progress' && t.agentName) s.add(t.agentName);
    return s.size;
  }, [snapshot?.tasks]);

  return (
    <Dialog open={open} onOpenChange={(v) => !busy && onOpenChange(v)}>
      <DialogContent className="sm:max-w-lg border-red-500/50">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Trash2 className="h-5 w-5 text-red-500" />
            Destroy SDD project?
          </DialogTitle>
          <DialogDescription>
            This wipes the run and its work. It cannot be undone (the optional commit revert is
            history-preserving).
          </DialogDescription>
        </DialogHeader>

        <ul className="space-y-1.5 py-1 text-sm">
          {isActive && (
            <li className="flex items-start gap-2">
              <span className="mt-0.5 text-red-500">■</span>
              <span>
                Stop the run{runningAgents > 0 ? ` (${runningAgents} agent${runningAgents === 1 ? '' : 's'} working)` : ''}
              </span>
            </li>
          )}
          <li className="flex items-start gap-2">
            <span className="mt-0.5 text-red-500">■</span>
            <span>
              Remove {worktreeCount > 0 ? `${worktreeCount} ` : 'all '}git worktree
              {worktreeCount === 1 ? '' : 's'} + <code className="text-xs">wstack/ap/*</code> branches —{' '}
              <span className="text-muted-foreground">including un-merged work</span>
            </span>
          </li>
          <li className="flex items-start gap-2">
            <span className="mt-0.5 text-red-500">■</span>
            <span>Delete all SDD artifacts (specs, task graph, board, session)</span>
          </li>
        </ul>

        {mergedCount > 0 && (
          <label className="flex cursor-pointer items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 p-2.5 text-sm">
            <input
              type="checkbox"
              checked={revertMerged}
              onChange={(e) => setRevertMerged(e.target.checked)}
              className="mt-0.5 h-4 w-4 accent-amber-500"
            />
            <span>
              Also <span className="font-medium">revert {mergedCount} merged commit{mergedCount === 1 ? '' : 's'}</span>{' '}
              on <code className="text-xs">{baseBranch ?? 'the base branch'}</code>
              <span className="block text-xs text-muted-foreground">
                Adds revert commits (history preserved). Refused if the working tree is dirty.
              </span>
            </span>
          </label>
        )}

        <div className="flex items-start gap-2 rounded-md bg-muted/50 p-2 text-xs text-muted-foreground">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-500" />
          {mergedCount > 0 && !revertMerged
            ? 'Merged commits will be left on the base branch. Tick the box above to undo them too.'
            : 'Make sure you really want to abandon this run.'}
        </div>

        <DialogFooter className="gap-2 sm:gap-2">
          <Button variant="outline" size="sm" disabled={busy} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            size="sm"
            disabled={busy}
            onClick={() => onConfirm(revertMerged)}
            className="bg-red-600 text-white hover:bg-red-700"
          >
            {busy ? (
              <>
                <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> Destroying…
              </>
            ) : (
              <>
                <Trash2 className="mr-1 h-3.5 w-3.5" /> Destroy everything
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
