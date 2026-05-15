import { useWebSocket } from '@/hooks/useWebSocket';
import { useUIStore } from '@/stores';
import { AlertTriangle, FileEdit, Globe, ShieldAlert, Terminal, Wrench } from 'lucide-react';
import { useEffect } from 'react';
import { DiffView, diffFromToolInput } from './DiffView';
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
 * Pick the right hero icon for the tool being confirmed. Helps the user
 * see at a glance "is this a file edit, a shell run, a network call?".
 */
function pickToolIcon(toolName: string) {
  if (/edit|write|create|patch/i.test(toolName)) return FileEdit;
  if (/bash|shell|exec|run|command/i.test(toolName)) return Terminal;
  if (/fetch|http|web|curl|request/i.test(toolName)) return Globe;
  return Wrench;
}

/**
 * Render the tool input intelligently. For edit/write we drop the JSON
 * dump and show a proper diff. For shell-like tools we surface the
 * command as a single mono line. Everything else falls back to JSON.
 */
function SmartInputPreview({
  toolName,
  input,
}: {
  toolName: string;
  input: unknown;
}) {
  const diffArgs = diffFromToolInput(toolName, input);
  if (diffArgs) {
    return (
      <div className="rounded-lg overflow-hidden border">
        <DiffView
          oldText={diffArgs.oldText}
          newText={diffArgs.newText}
          caption={diffArgs.caption}
        />
      </div>
    );
  }

  // Shell-like: pull out the command string so it shows as a real terminal
  // line instead of a JSON envelope.
  if (typeof input === 'object' && input !== null) {
    const obj = input as Record<string, unknown>;
    const cmd = (obj.command ?? obj.cmd ?? obj.script) as string | undefined;
    if (typeof cmd === 'string' && cmd.trim().length > 0) {
      return (
        <div className="rounded-lg border bg-background/40 overflow-hidden">
          <div className="px-3 py-1.5 text-[10px] uppercase tracking-wider text-muted-foreground border-b bg-muted/40 flex items-center gap-1.5">
            <Terminal className="h-3 w-3" />
            <span>Command</span>
          </div>
          <pre className="px-3 py-2 text-xs font-mono whitespace-pre-wrap break-all max-h-40 overflow-auto">
            ${cmd}
          </pre>
        </div>
      );
    }
    // url + method for fetch-like calls
    const url = obj.url as string | undefined;
    if (typeof url === 'string') {
      const method = (obj.method as string | undefined) ?? 'GET';
      return (
        <div className="rounded-lg border bg-background/40 px-3 py-2 text-xs font-mono">
          <span className="text-muted-foreground">{method.toUpperCase()}</span>{' '}
          <span className="break-all">{url}</span>
        </div>
      );
    }
  }

  return (
    <div className="p-3 rounded-lg bg-muted/50 border text-xs font-mono">
      <div className="text-muted-foreground mb-2">Input:</div>
      <pre className="whitespace-pre-wrap break-all max-h-60 overflow-auto">
        {JSON.stringify(input, null, 2)}
      </pre>
    </div>
  );
}

export function ConfirmDialog() {
  const { showConfirmDialog, confirmInfo, hideConfirm } = useUIStore();
  const { sendConfirm } = useWebSocket();

  const handleConfirm = (decision: 'yes' | 'no' | 'always' | 'deny') => {
    if (confirmInfo) {
      sendConfirm(confirmInfo.id, decision);
    }
    hideConfirm();
  };

  // Keyboard shortcuts inside the dialog: y = yes, n = no, a = always,
  // Esc = no (dismiss). Matches the CLI permission prompt so habits
  // transfer directly.
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyboard handler; handleConfirm stable
  useEffect(() => {
    if (!showConfirmDialog) return;
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName?.toLowerCase();
      if (tag === 'input' || tag === 'textarea') return;
      if (e.key === 'y' || e.key === 'Y') {
        e.preventDefault();
        handleConfirm('yes');
      } else if (e.key === 'n' || e.key === 'N' || e.key === 'Escape') {
        e.preventDefault();
        handleConfirm('no');
      } else if (e.key === 'a' || e.key === 'A') {
        e.preventDefault();
        handleConfirm('always');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showConfirmDialog, confirmInfo?.id]);

  if (!confirmInfo) {
    return (
      <Dialog open={showConfirmDialog} onOpenChange={() => hideConfirm()}>
        <DialogContent />
      </Dialog>
    );
  }

  const Icon = pickToolIcon(confirmInfo.toolName);
  const isEdit = /edit|write/i.test(confirmInfo.toolName);

  return (
    <Dialog open={showConfirmDialog} onOpenChange={() => hideConfirm()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldAlert className="h-5 w-5 text-yellow-500" />
            Confirm: {confirmInfo.toolName}
          </DialogTitle>
          <DialogDescription>
            The agent wants to {isEdit ? 'modify a file' : 'run this tool'}. Review the request
            below and decide whether to proceed.
          </DialogDescription>
        </DialogHeader>

        <div className="py-2 space-y-3">
          <div className="flex items-center gap-3 p-3 rounded-lg bg-muted">
            <Icon className="h-5 w-5 text-muted-foreground" />
            <div className="min-w-0">
              <div className="font-medium font-mono truncate">{confirmInfo.toolName}</div>
              <div className="text-xs text-muted-foreground">
                {isEdit ? 'File modification' : 'Tool execution'} — preview below
              </div>
            </div>
          </div>

          {confirmInfo.input !== undefined && (
            <SmartInputPreview toolName={confirmInfo.toolName} input={confirmInfo.input} />
          )}

          {confirmInfo.suggestedPattern && (
            <div className="flex items-start gap-2 p-3 rounded-lg bg-yellow-500/10 border border-yellow-500/20">
              <AlertTriangle className="h-4 w-4 text-yellow-600 mt-0.5 shrink-0" />
              <div className="text-sm min-w-0">
                <div className="font-medium text-yellow-800 dark:text-yellow-200">
                  Trust pattern suggestion
                </div>
                <div className="font-mono text-xs mt-1 break-all">
                  {confirmInfo.suggestedPattern}
                </div>
                <div className="text-xs text-muted-foreground mt-1">
                  Picking <span className="font-medium">Always</span> will whitelist matching calls
                  for this project.
                </div>
              </div>
            </div>
          )}
        </div>

        <DialogFooter className="gap-2 sm:gap-2 flex-wrap">
          <Button
            variant="outline"
            size="sm"
            onClick={() => handleConfirm('deny')}
            title="Reject this and all future calls matching the pattern"
          >
            Deny always
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => handleConfirm('no')}
            title="Reject this single call (Esc / n)"
          >
            No <kbd className="ml-1 text-[10px] border rounded px-1 bg-background">n</kbd>
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => handleConfirm('always')}
            title="Approve and remember the pattern for the project (a)"
          >
            Always <kbd className="ml-1 text-[10px] border rounded px-1 bg-background">a</kbd>
          </Button>
          <Button
            size="sm"
            onClick={() => handleConfirm('yes')}
            title="Approve this single call (y)"
          >
            Yes <kbd className="ml-1 text-[10px] border rounded px-1 bg-background/80">y</kbd>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
