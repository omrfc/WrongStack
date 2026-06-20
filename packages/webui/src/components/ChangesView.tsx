/**
 * ChangesView — the main-pane diff surface for the Changes (source-control)
 * activity. The file list lives in the SidePanel (ChangesPanel); selecting a
 * row populates the git-changes store, and this view renders the resolved
 * before/after content through the shared DiffView.
 */

import { FileDiff, Loader2 } from 'lucide-react';
import { useGitChangesStore } from '@/stores';
import { cn } from '@/lib/utils';
import { DiffView } from './DiffView';

export function ChangesView({ className }: { className?: string }) {
  const selectedPath = useGitChangesStore((s) => s.selectedPath);
  const diff = useGitChangesStore((s) => s.diff);
  const loadingDiff = useGitChangesStore((s) => s.loadingDiff);

  if (!selectedPath) {
    return (
      <div className={cn('flex-1 flex flex-col items-center justify-center gap-3 text-muted-foreground', className)}>
        <FileDiff className="h-10 w-10 opacity-30" />
        <p className="text-sm">Select a changed file to view its diff.</p>
      </div>
    );
  }

  return (
    <div className={cn('flex-1 flex flex-col overflow-hidden p-3', className)}>
      {loadingDiff || !diff ? (
        <div className="flex-1 flex items-center justify-center text-muted-foreground gap-2 text-sm">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading diff…
        </div>
      ) : diff.error ? (
        <div className="flex-1 flex items-center justify-center text-sm text-rose-500">
          {diff.error}
        </div>
      ) : diff.binary ? (
        <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground">
          Binary file — diff not shown.
        </div>
      ) : diff.tooLarge ? (
        <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground">
          File too large to diff.
        </div>
      ) : (
        <DiffView oldText={diff.oldText} newText={diff.newText} caption={diff.path} fill />
      )}
    </div>
  );
}
