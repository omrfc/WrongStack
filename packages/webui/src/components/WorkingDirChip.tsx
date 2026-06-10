import { cn } from '@/lib/utils';
import { getWSClient } from '@/lib/ws-client';
import { useSessionStore } from '@/stores';
import { FolderOpen, FolderTree, Loader2 } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from './Toaster';
import { Button } from './ui/button';
import { Input } from './ui/input';

/**
 * WorkingDirChip — compact topbar chip showing the current working
 * directory relative to the project root.
 *
 * - Displays the relative path (or project name if at root).
 * - Click to open an inline editor where you can type a relative
 *   path and switch to it via `working_dir.set`.
 * - Press Enter or click ✓ to commit, Esc or click ✕ to cancel.
 */
export function WorkingDirChip() {
  const cwd = useSessionStore((s) => s.cwd);
  const projectRoot = useSessionStore((s) => s.projectRoot);
  const projectName = useSessionStore((s) => s.projectName);

  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState('');
  const [sending, setSending] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Compute display path using the actual projectRoot
  const displayPath = computeDisplayPath(cwd, projectName);

  const openEditor = useCallback(() => {
    setValue('');
    setEditing(true);
    // Focus the input on the next frame
    requestAnimationFrame(() => inputRef.current?.focus());
  }, []);

  const cancel = useCallback(() => {
    setEditing(false);
    setValue('');
  }, []);

  const commit = useCallback(() => {
    const trimmed = value.trim();
    if (!trimmed) {
      cancel();
      return;
    }
    setSending(true);
    const ws = getWSClient();
    ws.send({ type: 'working_dir.set', payload: { path: trimmed } });

    let settled = false;
    const cleanup = () => {
      offRes();
      offErr();
    };

    // Success: working_dir.changed is broadcast to all clients
    const offRes = ws.on('working_dir.changed', () => {
      if (settled) return;
      settled = true;
      cleanup();
      setSending(false);
      setEditing(false);
      setValue('');
    });

    // Error: server sends key.operation_result with success: false
    const offErr = ws.on('key.operation_result', (msg: unknown) => {
      if (settled) return;
      const p = msg as { success?: boolean; message?: string };
      if (p?.success === false) {
        settled = true;
        cleanup();
        setSending(false);
        toast.error(p.message ?? 'Failed to change directory');
      }
    });

    // Timeout fallback (5s)
    setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      setSending(false);
      setEditing(false);
    }, 5000);
  }, [value, cancel]);

  // Close on Escape
  useEffect(() => {
    if (!editing) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') cancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [editing, cancel]);

  // If no cwd, don't render
  if (!cwd) return null;

  return (
    <div className="flex items-center gap-0.5 shrink-0">
      {editing ? (
        <div className="flex items-center gap-1">
          <FolderTree className="h-3 w-3 shrink-0 text-muted-foreground" />
          <Input
            ref={inputRef}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commit();
              if (e.key === 'Escape') cancel();
            }}
            placeholder={displayPath}
            className="h-5 px-1.5 py-0 text-[11px] w-28 rounded border-border/60 bg-background"
            disabled={sending}
          />
          <Button
            variant="ghost"
            size="icon"
            className="h-5 w-5 shrink-0"
            onClick={commit}
            disabled={sending}
            title="Apply"
          >
            {sending ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <span className="text-[10px] leading-none">✓</span>
            )}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-5 w-5 shrink-0"
            onClick={cancel}
            disabled={sending}
            title="Cancel"
          >
            <span className="text-[10px] leading-none">✕</span>
          </Button>
        </div>
      ) : (
        <button
          type="button"
          onClick={openEditor}
          className={cn(
            'flex items-center gap-1 text-[11px] text-muted-foreground shrink-0 min-w-0',
            'hover:text-foreground transition-colors',
            'px-1.5 py-0.5 rounded hover:bg-accent/50',
          )}
          title={`Working directory: ${cwd}\nClick to change`}
        >
          <FolderOpen className="h-3 w-3 shrink-0" />
          <span className="truncate max-w-[10rem]">{displayPath}</span>
        </button>
      )}
    </div>
  );
}

/**
 * Compute a human-friendly display path from the full cwd.
 * - If cwd is the project root (or close to it), show "." or the project name.
 * - Otherwise show the relative portion.
 *
 * We approximate projectRoot detection: if the project name appears as
 * the last segment of cwd and there's no deeper nesting, we're at root.
 */
function computeDisplayPath(cwd: string, projectName: string): string {
  if (!cwd) return '';

  // Normalize separators
  const norm = cwd.replace(/\\/g, '/');
  const segments = norm.split('/').filter(Boolean);

  if (segments.length === 0) return '.';

  const last = segments[segments.length - 1] ?? '';

  // If the last segment matches projectName, we're likely at project root
  if (projectName && last.toLowerCase() === projectName.toLowerCase()) {
    return '.';
  }

  // Show just the last 2 path segments for brevity
  if (segments.length <= 2) return last || '.';
  return `…/${segments[segments.length - 2]}/${last}`;
}
